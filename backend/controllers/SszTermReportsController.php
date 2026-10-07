<?php
declare(strict_types=1);

namespace Baranguard\Controllers;

use Baranguard\Lib\ApiError;
use Baranguard\Lib\ApprovalAuthority;
use Baranguard\Lib\Audit;
use Baranguard\Lib\Http;
use Baranguard\Lib\PaperApproval;
use Baranguard\Middleware\AuthMiddleware;
use PDO;

/**
 * Safer School Zones Annex D term report (docs/FEATURE_CONTRACT_2026-10.md
 * section 7, migration 0033).
 *
 *   POST  /ssz-term-reports               admin|secretary: create draft + snapshot
 *   GET   /ssz-term-reports               admin|secretary|punong_barangay
 *   GET   /ssz-term-reports/:id           admin|secretary|punong_barangay
 *   PATCH /ssz-term-reports/:id           admin|secretary, only while draft
 *   POST  /ssz-term-reports/:id/prepare   PREPARE_ANNEX_D: draft -> prepared (recompute)
 *   POST  /ssz-term-reports/:id/approve   APPROVE_ANNEX_D: prepared -> approved,
 *                                         never by the preparer
 *   POST  /ssz-term-reports/:id/mark-submitted
 *                                         admin|secretary: approved -> submitted
 *   POST  /ssz-term-reports/:id/paper-signature
 *                                         admin|secretary: record the date on the
 *                                         signed paper of an APPROVED report
 *   POST  /ssz-term-reports/:id/record-paper-approval
 *                                         admin|secretary: prepared -> approved,
 *                                         recorded from paper (signer holds
 *                                         approve_annex_d, never the preparer)
 *
 * Every write needs an Idempotency-Key. `POST` stores it in
 * `client_request_id` (a retry returns the original, 200). The state-changing
 * writes replay off `audit_log.idempotency_key` (migration 0019): a retry of
 * an already-applied key returns the report as it now stands (200) instead of
 * failing with 409 on the transition it already made. An illegal transition
 * with a NEW key is 409.
 *
 * ANNEX D COMPUTATION ({@see self::compute()}) -- all day-bucketing is done
 * in PHP against a fixed +08:00 (Rule 11), never CONVERT_TZ():
 *   - total_tanods            active users with role tanod in the barangay
 *   - total_schools           active schools
 *   - total_deployment_days   DISTINCT Manila dates of school_checkin.checked_in_at
 *   - total_incidents         incidents with school_id NOT NULL created in range
 *   - referral columns        count INCIDENTS with >= 1 referral mapping to the
 *                             column, so the columns may sum above the total:
 *                             pnp->pnp, bfp->bfp, higher_lgu+social_welfare->
 *                             higher_lgu, doh->doh, dpwh->dpwh, other->
 *                             other_agencies, ambulance_ems->other_agencies by
 *                             default or doh when system_settings
 *                             `annex_d.ambulance_ems_maps_to` = 'doh'.
 *                             barangay_official and vaw_desk are barangay-level.
 *   - incidents_barangay_only school incidents with NO external referral
 *   - other_institutions      distinct referral other_text (+ 'Ambulance/EMS'
 *                             when mapped to other), '; '-joined, <= 500 chars
 *
 * The snapshot is an Annex D ROW: counts only, no person, narrative,
 * coordinates or contact data. Audit metadata is {report_id, status}
 * (+ the idempotency key) -- never counts of a person.
 *
 * `other_institutions` and re-prepare: PATCH may hand-edit it while draft.
 * `prepare` recomputes every count, and recomputes `other_institutions` too
 * unless the report was already edited (version > 1), in which case the
 * preparer's wording is kept.
 */
final class SszTermReportsController
{
    public const AMBULANCE_MAPPING_SETTING = 'annex_d.ambulance_ems_maps_to';
    private const DEFAULT_LIMIT = 25;
    private const MAX_LIMIT = 100;
    /** Longest term (inclusive Manila days) a report or live computation may span. */
    public const MAX_TERM_DAYS = 366;
    private const STATUSES = ['draft', 'prepared', 'approved', 'submitted'];
    private const OTHER_INSTITUTIONS_MAX = 500;

    private const EXTERNAL = ['pnp', 'bfp', 'ambulance_ems', 'social_welfare', 'higher_lgu', 'doh', 'dpwh', 'other'];

    private const COUNT_COLUMNS = [
        'total_tanods', 'total_schools', 'total_deployment_days', 'total_incidents', 'incidents_barangay_only',
        'incidents_pnp', 'incidents_bfp', 'incidents_higher_lgu', 'incidents_doh', 'incidents_dpwh',
        'incidents_other_agencies',
    ];

    /** @param array{user_id:int,barangay_id:int,role:string} $identity */
    public static function create(PDO $pdo, array $identity): void
    {
        AuthMiddleware::requireRole($identity, ['admin', 'secretary']);
        $key = self::requireIdempotencyKey();
        $body = Http::jsonBody();

        $label = $body['term_label'] ?? null;
        if (!is_string($label) || trim($label) === '' || mb_strlen(trim($label)) > 40) {
            throw new ApiError(400, 'VALIDATION_ERROR', 'term_label is required (1-40 characters).');
        }
        $label = trim($label);
        $start = self::requireDate($body['term_start'] ?? null, 'term_start');
        $end = self::requireDate($body['term_end'] ?? null, 'term_end');
        if ($start > $end) {
            throw new ApiError(400, 'VALIDATION_ERROR', 'term_start must not be after term_end.');
        }
        $spanDays = (int) ((self::manilaDayStartUtc($end, 'term_end')->getTimestamp() - self::manilaDayStartUtc($start, 'term_start')->getTimestamp()) / 86400) + 1;
        if ($spanDays > self::MAX_TERM_DAYS) {
            throw new ApiError(400, 'VALIDATION_ERROR', 'The term cannot span more than ' . self::MAX_TERM_DAYS . ' days.');
        }
        $remarks = self::optionalText($body, 'remarks', 1000);

        $find = $pdo->prepare('SELECT * FROM ssz_term_report WHERE client_request_id = :k AND barangay_id = :b LIMIT 1');
        $find->execute(['k' => $key, 'b' => $identity['barangay_id']]);
        $existing = $find->fetch(PDO::FETCH_ASSOC);
        if ($existing !== false) {
            Http::send(200, self::mapReport($pdo, $existing));
        }

        $computed = self::compute($pdo, $identity['barangay_id'], $start, $end);

        try {
            $pdo->prepare(
                'INSERT INTO ssz_term_report
                    (barangay_id, term_label, term_start, term_end, status,
                     total_tanods, total_schools, total_deployment_days, total_incidents, incidents_barangay_only,
                     incidents_pnp, incidents_bfp, incidents_higher_lgu, incidents_doh, incidents_dpwh,
                     incidents_other_agencies, other_institutions, remarks, version, created_by,
                     client_request_id, created_at, updated_at)
                 VALUES
                    (:barangay_id, :term_label, :term_start, :term_end, \'draft\',
                     :total_tanods, :total_schools, :total_deployment_days, :total_incidents, :incidents_barangay_only,
                     :incidents_pnp, :incidents_bfp, :incidents_higher_lgu, :incidents_doh, :incidents_dpwh,
                     :incidents_other_agencies, :other_institutions, :remarks, 1, :created_by,
                     :k, UTC_TIMESTAMP(), UTC_TIMESTAMP())'
            )->execute([
                'barangay_id' => $identity['barangay_id'],
                'term_label' => $label,
                'term_start' => $start,
                'term_end' => $end,
                'total_tanods' => $computed['total_tanods'],
                'total_schools' => $computed['total_schools'],
                'total_deployment_days' => $computed['total_deployment_days'],
                'total_incidents' => $computed['total_incidents'],
                'incidents_barangay_only' => $computed['incidents_barangay_only'],
                'incidents_pnp' => $computed['incidents_pnp'],
                'incidents_bfp' => $computed['incidents_bfp'],
                'incidents_higher_lgu' => $computed['incidents_higher_lgu'],
                'incidents_doh' => $computed['incidents_doh'],
                'incidents_dpwh' => $computed['incidents_dpwh'],
                'incidents_other_agencies' => $computed['incidents_other_agencies'],
                'other_institutions' => $computed['other_institutions'],
                'remarks' => $remarks,
                'created_by' => $identity['user_id'],
                'k' => $key,
            ]);
        } catch (\PDOException $e) {
            if ($e->getCode() === '23000') {
                $find->execute(['k' => $key, 'b' => $identity['barangay_id']]);
                $row = $find->fetch(PDO::FETCH_ASSOC);
                if ($row !== false) {
                    Http::send(200, self::mapReport($pdo, $row));
                }
                throw new ApiError(409, 'CONFLICT', 'This Idempotency-Key was already used.');
            }
            throw $e;
        }
        $reportId = (int) $pdo->lastInsertId();

        Audit::record($pdo, $identity['barangay_id'], $identity['user_id'], 'ssz_term_report_created', 'ssz_term_report', $reportId, [
            'report_id' => $reportId,
            'status' => 'draft',
        ]);

        Http::send(201, self::mapReport($pdo, self::fetchRow($pdo, $reportId) ?? []));
    }

    /** @param array{user_id:int,barangay_id:int,role:string} $identity */
    public static function index(PDO $pdo, array $identity): void
    {
        AuthMiddleware::requireRole($identity, ['admin', 'secretary', 'punong_barangay']);

        $where = ['barangay_id = :barangay_id'];
        $params = ['barangay_id' => $identity['barangay_id']];
        $status = Http::query('status');
        if ($status !== null) {
            if (!in_array($status, self::STATUSES, true)) {
                throw new ApiError(400, 'VALIDATION_ERROR', 'status must be one of: ' . implode(', ', self::STATUSES) . '.');
            }
            $where[] = 'status = :status';
            $params['status'] = $status;
        }
        $whereSql = implode(' AND ', $where);

        $page = max(1, (int) (Http::query('page') ?? '1'));
        $limit = (int) (Http::query('limit') ?? (string) self::DEFAULT_LIMIT);
        if ($limit < 1) {
            $limit = self::DEFAULT_LIMIT;
        }
        $limit = min($limit, self::MAX_LIMIT);
        $offset = ($page - 1) * $limit;

        $countStmt = $pdo->prepare("SELECT COUNT(*) FROM ssz_term_report WHERE {$whereSql}");
        $countStmt->execute($params);
        $total = (int) $countStmt->fetchColumn();

        $stmt = $pdo->prepare(
            "SELECT * FROM ssz_term_report WHERE {$whereSql} ORDER BY term_start DESC, report_id DESC LIMIT :limit OFFSET :offset"
        );
        foreach ($params as $key => $value) {
            $stmt->bindValue(':' . $key, $value);
        }
        $stmt->bindValue(':limit', $limit, PDO::PARAM_INT);
        $stmt->bindValue(':offset', $offset, PDO::PARAM_INT);
        $stmt->execute();

        Http::send(200, [
            'items' => array_map(static fn (array $r): array => self::mapReport($pdo, $r), $stmt->fetchAll(PDO::FETCH_ASSOC)),
            'page' => $page,
            'limit' => $limit,
            'total' => $total,
        ]);
    }

    /** @param array{user_id:int,barangay_id:int,role:string} $identity */
    public static function show(PDO $pdo, array $identity, string $reportIdParam): void
    {
        AuthMiddleware::requireRole($identity, ['admin', 'secretary', 'punong_barangay']);
        $row = self::loadOrFail($pdo, $identity, $reportIdParam, false);
        Http::send(200, self::mapReport($pdo, $row));
    }

    /** @param array{user_id:int,barangay_id:int,role:string} $identity */
    public static function update(PDO $pdo, array $identity, string $reportIdParam): void
    {
        AuthMiddleware::requireRole($identity, ['admin', 'secretary']);
        $key = self::requireIdempotencyKey();
        $body = Http::jsonBody();

        $pdo->beginTransaction();
        try {
            $row = self::loadOrFail($pdo, $identity, $reportIdParam, true);
            $reportId = (int) $row['report_id'];

            if (self::isReplay($pdo, $identity['barangay_id'], 'ssz_term_report_updated', $reportId, $key)) {
                $pdo->commit();
                Http::send(200, self::mapReport($pdo, $row));
            }
            if ($row['status'] !== 'draft') {
                throw new ApiError(409, 'CONFLICT', 'A term report can only be edited while it is a draft.');
            }
            if (array_key_exists('version', $body)) {
                if (!is_int($body['version']) && !(is_string($body['version']) && ctype_digit($body['version']))) {
                    throw new ApiError(400, 'VALIDATION_ERROR', 'version must be an integer.');
                }
                if ((int) $body['version'] !== (int) $row['version']) {
                    throw new ApiError(409, 'CONFLICT', 'This report was changed by someone else - reload and try again.');
                }
            }

            $sets = [];
            $params = ['id' => $reportId];
            $changed = [];
            if (array_key_exists('remarks', $body)) {
                $sets[] = 'remarks = :remarks';
                $params['remarks'] = self::optionalText($body, 'remarks', 1000);
                $changed[] = 'remarks';
            }
            if (array_key_exists('other_institutions', $body)) {
                $sets[] = 'other_institutions = :other_institutions';
                $params['other_institutions'] = self::optionalText($body, 'other_institutions', self::OTHER_INSTITUTIONS_MAX);
                $changed[] = 'other_institutions';
            }
            if ($sets === []) {
                throw new ApiError(400, 'VALIDATION_ERROR', 'Only remarks and other_institutions may be edited.');
            }
            $sets[] = 'version = version + 1';
            $sets[] = 'updated_at = UTC_TIMESTAMP()';
            $pdo->prepare('UPDATE ssz_term_report SET ' . implode(', ', $sets) . ' WHERE report_id = :id')->execute($params);

            Audit::record($pdo, $identity['barangay_id'], $identity['user_id'], 'ssz_term_report_updated', 'ssz_term_report', $reportId, [
                'report_id' => $reportId,
                'status' => 'draft',
                'fields' => $changed,
                'idempotency_key' => $key,
            ]);
            $pdo->commit();
        } catch (\Throwable $e) {
            if ($pdo->inTransaction()) {
                $pdo->rollBack();
            }
            throw $e;
        }

        Http::send(200, self::mapReport($pdo, self::fetchRow($pdo, $reportId) ?? []));
    }

    /** @param array{user_id:int,barangay_id:int,role:string} $identity */
    public static function prepare(PDO $pdo, array $identity, string $reportIdParam): void
    {
        ApprovalAuthority::require($pdo, $identity, ApprovalAuthority::PREPARE_ANNEX_D);
        $key = self::requireIdempotencyKey();

        $pdo->beginTransaction();
        try {
            $row = self::loadOrFail($pdo, $identity, $reportIdParam, true);
            $reportId = (int) $row['report_id'];

            if (self::isReplay($pdo, $identity['barangay_id'], 'ssz_term_report_prepared', $reportId, $key)) {
                $pdo->commit();
                Http::send(200, self::mapReport($pdo, $row));
            }
            if ($row['status'] !== 'draft') {
                throw new ApiError(409, 'CONFLICT', 'Only a draft term report can be prepared.');
            }

            $computed = self::compute($pdo, $identity['barangay_id'], (string) $row['term_start'], (string) $row['term_end']);
            $sets = [];
            $params = ['id' => $reportId, 'by' => $identity['user_id']];
            foreach (self::COUNT_COLUMNS as $column) {
                $sets[] = "{$column} = :{$column}";
                $params[$column] = $computed[$column];
            }
            if ((int) $row['version'] <= 1) {
                $sets[] = 'other_institutions = :other_institutions';
                $params['other_institutions'] = $computed['other_institutions'];
            }
            $sets[] = "status = 'prepared'";
            $sets[] = 'prepared_by = :by';
            $sets[] = 'prepared_at = UTC_TIMESTAMP()';
            $sets[] = 'version = version + 1';
            $sets[] = 'updated_at = UTC_TIMESTAMP()';
            $pdo->prepare('UPDATE ssz_term_report SET ' . implode(', ', $sets) . ' WHERE report_id = :id')->execute($params);

            Audit::record($pdo, $identity['barangay_id'], $identity['user_id'], 'ssz_term_report_prepared', 'ssz_term_report', $reportId, [
                'report_id' => $reportId,
                'status' => 'prepared',
                'idempotency_key' => $key,
            ]);
            $pdo->commit();
        } catch (\Throwable $e) {
            if ($pdo->inTransaction()) {
                $pdo->rollBack();
            }
            throw $e;
        }

        Http::send(200, self::mapReport($pdo, self::fetchRow($pdo, $reportId) ?? []));
    }

    /** @param array{user_id:int,barangay_id:int,role:string} $identity */
    public static function approve(PDO $pdo, array $identity, string $reportIdParam): void
    {
        ApprovalAuthority::require($pdo, $identity, ApprovalAuthority::APPROVE_ANNEX_D);
        $key = self::requireIdempotencyKey();

        $pdo->beginTransaction();
        try {
            $row = self::loadOrFail($pdo, $identity, $reportIdParam, true);
            $reportId = (int) $row['report_id'];

            if (self::isReplay($pdo, $identity['barangay_id'], 'ssz_term_report_approved', $reportId, $key)) {
                $pdo->commit();
                Http::send(200, self::mapReport($pdo, $row));
            }
            if ($row['status'] !== 'prepared') {
                throw new ApiError(409, 'CONFLICT', 'Only a prepared term report can be approved.');
            }
            ApprovalAuthority::assertNotPreparer($identity['user_id'], (int) $row['prepared_by']);

            $pdo->prepare(
                "UPDATE ssz_term_report
                 SET status = 'approved', approved_by = :by, approved_at = UTC_TIMESTAMP(),
                     version = version + 1, updated_at = UTC_TIMESTAMP()
                 WHERE report_id = :id"
            )->execute(['by' => $identity['user_id'], 'id' => $reportId]);

            Audit::record($pdo, $identity['barangay_id'], $identity['user_id'], 'ssz_term_report_approved', 'ssz_term_report', $reportId, [
                'report_id' => $reportId,
                'status' => 'approved',
                'idempotency_key' => $key,
            ]);
            $pdo->commit();
        } catch (\Throwable $e) {
            if ($pdo->inTransaction()) {
                $pdo->rollBack();
            }
            throw $e;
        }

        Http::send(200, self::mapReport($pdo, self::fetchRow($pdo, $reportId) ?? []));
    }

    /** @param array{user_id:int,barangay_id:int,role:string} $identity */
    public static function markSubmitted(PDO $pdo, array $identity, string $reportIdParam): void
    {
        AuthMiddleware::requireRole($identity, ['admin', 'secretary']);
        $key = self::requireIdempotencyKey();
        $body = Http::jsonBody();

        $pdo->beginTransaction();
        try {
            $row = self::loadOrFail($pdo, $identity, $reportIdParam, true);
            $reportId = (int) $row['report_id'];

            if (self::isReplay($pdo, $identity['barangay_id'], 'ssz_term_report_submitted', $reportId, $key)) {
                $pdo->commit();
                Http::send(200, self::mapReport($pdo, $row));
            }
            if ($row['status'] !== 'approved') {
                throw new ApiError(409, 'CONFLICT', 'Only an approved term report can be marked as submitted.');
            }

            $mayorBy = $body['mayor_office_received_by'] ?? null;
            if (!is_string($mayorBy) || trim($mayorBy) === '' || mb_strlen(trim($mayorBy)) > 120) {
                throw new ApiError(400, 'VALIDATION_ERROR', 'mayor_office_received_by is required (1-120 characters).');
            }
            $mayorAt = self::requireDate($body['mayor_office_received_at'] ?? null, 'mayor_office_received_at');
            $dilgBy = self::optionalText($body, 'dilg_received_by', 120);
            $dilgAt = null;
            if (array_key_exists('dilg_date_received', $body) && $body['dilg_date_received'] !== null) {
                $dilgAt = self::requireDate($body['dilg_date_received'], 'dilg_date_received');
            }

            $pdo->prepare(
                "UPDATE ssz_term_report
                 SET status = 'submitted', mayor_office_received_by = :mayor_by, mayor_office_received_at = :mayor_at,
                     dilg_received_by = :dilg_by, dilg_date_received = :dilg_at,
                     version = version + 1, updated_at = UTC_TIMESTAMP()
                 WHERE report_id = :id"
            )->execute([
                'mayor_by' => trim($mayorBy),
                'mayor_at' => $mayorAt,
                'dilg_by' => $dilgBy,
                'dilg_at' => $dilgAt,
                'id' => $reportId,
            ]);

            Audit::record($pdo, $identity['barangay_id'], $identity['user_id'], 'ssz_term_report_submitted', 'ssz_term_report', $reportId, [
                'report_id' => $reportId,
                'status' => 'submitted',
                'idempotency_key' => $key,
            ]);
            $pdo->commit();
        } catch (\Throwable $e) {
            if ($pdo->inTransaction()) {
                $pdo->rollBack();
            }
            throw $e;
        }

        Http::send(200, self::mapReport($pdo, self::fetchRow($pdo, $reportId) ?? []));
    }

    /**
     * POST /ssz-term-reports/:id/paper-signature - admin|secretary. Records
     * (or overwrites) the date written on the signed paper of an APPROVED
     * term report (409 in any other status, including `submitted`). Touches
     * no count or content, so an approved report stays locked. Order: 403 ->
     * 400 (key/body) -> 404 -> idempotent replay -> 409.
     *
     * @param array{user_id:int,barangay_id:int,role:string} $identity
     */
    public static function paperSignature(PDO $pdo, array $identity, string $reportIdParam): void
    {
        AuthMiddleware::requireRole($identity, ['admin', 'secretary']);
        if (!ctype_digit($reportIdParam)) {
            throw new ApiError(404, 'NOT_FOUND', 'Term report not found.');
        }
        $key = self::requireIdempotencyKey();
        $body = Http::jsonBody();
        $signedOn = PaperApproval::requirePastOrTodayDate($body['paper_signed_on'] ?? null, 'paper_signed_on');

        $pdo->beginTransaction();
        try {
            $row = self::loadOrFail($pdo, $identity, $reportIdParam, true);
            $reportId = (int) $row['report_id'];

            if (PaperApproval::isReplay($pdo, $identity['barangay_id'], 'paper_signature_recorded', 'ssz_term_report', $reportId, $key)) {
                $pdo->commit();
                Http::send(200, self::mapReport($pdo, self::fetchRow($pdo, $reportId) ?? $row));
            }
            if ($row['status'] !== 'approved') {
                throw new ApiError(409, 'CONFLICT', 'A paper signature can only be recorded on an approved term report.');
            }
            $pdo->prepare(
                'UPDATE ssz_term_report
                    SET paper_signed_on = :signed_on, paper_recorded_by = :actor, paper_recorded_at = UTC_TIMESTAMP(),
                        version = version + 1, updated_at = UTC_TIMESTAMP()
                  WHERE report_id = :id'
            )->execute(['signed_on' => $signedOn, 'actor' => $identity['user_id'], 'id' => $reportId]);
            Audit::record($pdo, $identity['barangay_id'], $identity['user_id'], 'paper_signature_recorded', 'ssz_term_report', $reportId, [
                'report_id' => $reportId,
                'status' => 'approved',
                'idempotency_key' => $key,
            ]);
            $pdo->commit();
        } catch (\Throwable $e) {
            if ($pdo->inTransaction()) {
                $pdo->rollBack();
            }
            throw $e;
        }

        Http::send(200, self::mapReport($pdo, self::fetchRow($pdo, $reportId) ?? []));
    }

    /**
     * POST /ssz-term-reports/:id/record-paper-approval - admin|secretary.
     * Body {"signer_user_id", "signed_on"}. Records an approval that
     * happened on paper: `prepared` -> `approved`, `approved_by` = the signer
     * (an active same-barangay user holding `approve_annex_d`, never the
     * preparer), `approval_mode` = 'recorded_from_paper'. Order: 403 -> 400
     * -> 404 (report / cross-tenant) -> idempotent replay -> 409 (not
     * prepared) -> 409 (signer is the preparer) -> 404 (signer in another
     * barangay) -> 422 (signer cannot approve).
     *
     * @param array{user_id:int,barangay_id:int,role:string} $identity
     */
    public static function recordPaperApproval(PDO $pdo, array $identity, string $reportIdParam): void
    {
        AuthMiddleware::requireRole($identity, ['admin', 'secretary']);
        if (!ctype_digit($reportIdParam)) {
            throw new ApiError(404, 'NOT_FOUND', 'Term report not found.');
        }
        $key = self::requireIdempotencyKey();
        $body = Http::jsonBody();
        $signerId = PaperApproval::requirePositiveInt($body['signer_user_id'] ?? null, 'signer_user_id');
        $signedOn = PaperApproval::requirePastOrTodayDate($body['signed_on'] ?? null, 'signed_on');

        $pdo->beginTransaction();
        try {
            $row = self::loadOrFail($pdo, $identity, $reportIdParam, true);
            $reportId = (int) $row['report_id'];

            if (PaperApproval::isReplay($pdo, $identity['barangay_id'], 'approval_recorded_from_paper', 'ssz_term_report', $reportId, $key)) {
                $pdo->commit();
                Http::send(200, self::mapReport($pdo, self::fetchRow($pdo, $reportId) ?? $row));
            }
            if ($row['status'] !== 'prepared') {
                throw new ApiError(409, 'CONFLICT', 'Only a prepared term report can have a paper approval recorded.');
            }
            ApprovalAuthority::assertNotPreparer($signerId, (int) $row['prepared_by']);
            PaperApproval::requireSigner($pdo, $identity['barangay_id'], $signerId, ApprovalAuthority::APPROVE_ANNEX_D);

            $pdo->prepare(
                "UPDATE ssz_term_report
                    SET status = 'approved', approved_by = :signer, approved_at = UTC_TIMESTAMP(),
                        approval_mode = 'recorded_from_paper', paper_signed_on = :signed_on,
                        paper_recorded_by = :actor, paper_recorded_at = UTC_TIMESTAMP(),
                        version = version + 1, updated_at = UTC_TIMESTAMP()
                  WHERE report_id = :id"
            )->execute(['signer' => $signerId, 'signed_on' => $signedOn, 'actor' => $identity['user_id'], 'id' => $reportId]);
            Audit::record($pdo, $identity['barangay_id'], $identity['user_id'], 'approval_recorded_from_paper', 'ssz_term_report', $reportId, [
                'report_id' => $reportId,
                'status' => 'approved',
                'signer_user_id' => $signerId,
                'idempotency_key' => $key,
            ]);
            $pdo->commit();
        } catch (\Throwable $e) {
            if ($pdo->inTransaction()) {
                $pdo->rollBack();
            }
            throw $e;
        }

        Http::send(200, self::mapReport($pdo, self::fetchRow($pdo, $reportId) ?? []));
    }

    /**
     * The Annex D computation (see the class doc). `$termStart`/`$termEnd`
     * are Manila calendar dates 'YYYY-MM-DD', end INCLUSIVE.
     *
     * @return array<string,int|string|null> the eleven count columns plus
     *         `other_institutions` (null when there is nothing to list).
     */
    public static function compute(PDO $pdo, int $barangayId, string $termStart, string $termEnd): array
    {
        $startUtc = self::manilaDayStartUtc($termStart, 'term_start');
        $endUtc = self::manilaDayStartUtc($termEnd, 'term_end')->modify('+1 day');
        if ($startUtc >= $endUtc) {
            throw new ApiError(400, 'VALIDATION_ERROR', 'term_start must not be after term_end.');
        }
        // Every caller (create, prepare, GET /reports/school-term) passes
        // through here, so the cap lives here: a school term is months, and an
        // unbounded range would let one request scan the whole history.
        if (($endUtc->getTimestamp() - $startUtc->getTimestamp()) > self::MAX_TERM_DAYS * 86400) {
            throw new ApiError(400, 'VALIDATION_ERROR', 'The term cannot span more than ' . self::MAX_TERM_DAYS . ' days.');
        }
        $range = ['b' => $barangayId, 's' => $startUtc->format('Y-m-d H:i:s'), 'e' => $endUtc->format('Y-m-d H:i:s')];

        $scalar = static function (string $sql, array $params) use ($pdo): int {
            $stmt = $pdo->prepare($sql);
            $stmt->execute($params);
            return (int) $stmt->fetchColumn();
        };

        $totalTanods = $scalar("SELECT COUNT(*) FROM user WHERE barangay_id = :b AND role = 'tanod' AND is_active = 1", ['b' => $barangayId]);
        $totalSchools = $scalar('SELECT COUNT(*) FROM school WHERE barangay_id = :b AND is_active = 1', ['b' => $barangayId]);

        // Deployment days: bucketed by Manila date IN PHP (fixed +08:00).
        $inStmt = $pdo->prepare(
            'SELECT checked_in_at FROM school_checkin WHERE barangay_id = :b AND checked_in_at >= :s AND checked_in_at < :e'
        );
        $inStmt->execute($range);
        $manila = new \DateTimeZone('+08:00');
        $utc = new \DateTimeZone('UTC');
        $days = [];
        foreach ($inStmt->fetchAll(PDO::FETCH_COLUMN) as $checkedInAt) {
            $days[(new \DateTimeImmutable((string) $checkedInAt, $utc))->setTimezone($manila)->format('Y-m-d')] = true;
        }

        $totalIncidents = $scalar(
            'SELECT COUNT(*) FROM incident WHERE barangay_id = :b AND school_id IS NOT NULL AND created_at >= :s AND created_at < :e',
            $range
        );

        $ambulanceTo = self::ambulanceMapping($pdo);
        $refStmt = $pdo->prepare(
            'SELECT r.incident_id, r.referred_to, r.other_text
             FROM incident_referral r
             JOIN incident i ON i.incident_id = r.incident_id
             WHERE i.barangay_id = :b AND i.school_id IS NOT NULL AND i.created_at >= :s AND i.created_at < :e'
        );
        $refStmt->execute($range);

        // Set of incident ids per Annex D column, so an incident with two
        // referrals to the same column counts once.
        $perColumn = ['pnp' => [], 'bfp' => [], 'higher_lgu' => [], 'doh' => [], 'dpwh' => [], 'other_agencies' => []];
        $external = [];
        $institutions = [];
        $ambulanceMappedToOther = false;
        foreach ($refStmt->fetchAll(PDO::FETCH_ASSOC) as $ref) {
            $incidentId = (int) $ref['incident_id'];
            $to = (string) $ref['referred_to'];
            $column = match ($to) {
                'pnp' => 'pnp',
                'bfp' => 'bfp',
                'higher_lgu', 'social_welfare' => 'higher_lgu',
                'doh' => 'doh',
                'dpwh' => 'dpwh',
                'other' => 'other_agencies',
                'ambulance_ems' => $ambulanceTo === 'doh' ? 'doh' : 'other_agencies',
                default => null, // barangay_official, vaw_desk: barangay-level
            };
            if ($column !== null) {
                $perColumn[$column][$incidentId] = true;
            }
            if (in_array($to, self::EXTERNAL, true)) {
                $external[$incidentId] = true;
            }
            if ($to === 'ambulance_ems' && $ambulanceTo !== 'doh') {
                $ambulanceMappedToOther = true;
            }
            $text = is_string($ref['other_text']) ? trim($ref['other_text']) : '';
            if ($text !== '') {
                $institutions[$text] = true;
            }
        }
        if ($ambulanceMappedToOther) {
            $institutions['Ambulance/EMS'] = true;
        }

        $names = array_keys($institutions);
        sort($names, SORT_STRING | SORT_FLAG_CASE);
        $otherInstitutions = '';
        foreach ($names as $name) {
            $next = $otherInstitutions === '' ? (string) $name : $otherInstitutions . '; ' . $name;
            if (mb_strlen($next) > self::OTHER_INSTITUTIONS_MAX) {
                break;
            }
            $otherInstitutions = $next;
        }

        return [
            'total_tanods' => $totalTanods,
            'total_schools' => $totalSchools,
            'total_deployment_days' => count($days),
            'total_incidents' => $totalIncidents,
            'incidents_barangay_only' => max(0, $totalIncidents - count($external)),
            'incidents_pnp' => count($perColumn['pnp']),
            'incidents_bfp' => count($perColumn['bfp']),
            'incidents_higher_lgu' => count($perColumn['higher_lgu']),
            'incidents_doh' => count($perColumn['doh']),
            'incidents_dpwh' => count($perColumn['dpwh']),
            'incidents_other_agencies' => count($perColumn['other_agencies']),
            'other_institutions' => $otherInstitutions === '' ? null : $otherInstitutions,
        ];
    }

    /** Manila midnight of a 'YYYY-MM-DD' date, as a UTC instant (fixed +08:00). */
    public static function manilaDayStartUtc(string $date, string $field): \DateTimeImmutable
    {
        $parsed = \DateTimeImmutable::createFromFormat('!Y-m-d', $date, new \DateTimeZone('+08:00'));
        $errors = \DateTimeImmutable::getLastErrors();
        if ($parsed === false || ($errors !== false && ($errors['warning_count'] > 0 || $errors['error_count'] > 0))
            || $parsed->format('Y-m-d') !== $date) {
            throw new ApiError(400, 'VALIDATION_ERROR', "{$field} must be a valid date (YYYY-MM-DD).");
        }
        return $parsed->setTimezone(new \DateTimeZone('UTC'));
    }

    private static function ambulanceMapping(PDO $pdo): string
    {
        $stmt = $pdo->prepare('SELECT setting_value FROM system_settings WHERE setting_key = :k LIMIT 1');
        $stmt->execute(['k' => self::AMBULANCE_MAPPING_SETTING]);
        $value = $stmt->fetchColumn();
        return $value === 'doh' ? 'doh' : 'other';
    }

    /**
     * Loads (optionally FOR UPDATE) and tenant-checks a report; 404 for a
     * non-numeric id, a missing row and another barangay's row alike.
     *
     * @return array<string,mixed>
     */
    private static function loadOrFail(PDO $pdo, array $identity, string $reportIdParam, bool $forUpdate): array
    {
        if (!ctype_digit($reportIdParam)) {
            throw new ApiError(404, 'NOT_FOUND', 'Term report not found.');
        }
        $stmt = $pdo->prepare('SELECT * FROM ssz_term_report WHERE report_id = :id' . ($forUpdate ? ' FOR UPDATE' : ''));
        $stmt->execute(['id' => (int) $reportIdParam]);
        $row = $stmt->fetch(PDO::FETCH_ASSOC);
        if ($row === false) {
            throw new ApiError(404, 'NOT_FOUND', 'Term report not found.');
        }
        AuthMiddleware::requireTenant($identity, (int) $row['barangay_id']);
        return $row;
    }

    private static function isReplay(PDO $pdo, int $barangayId, string $action, int $reportId, string $key): bool
    {
        $stmt = $pdo->prepare(
            'SELECT 1 FROM audit_log WHERE barangay_id = :b AND action = :a AND entity_id = :e AND idempotency_key = :k LIMIT 1'
        );
        $stmt->execute(['b' => $barangayId, 'a' => $action, 'e' => $reportId, 'k' => $key]);
        return $stmt->fetchColumn() !== false;
    }

    private static function requireIdempotencyKey(): string
    {
        $key = Http::header('Idempotency-Key');
        if ($key === null || !preg_match(IncidentsController::UUID_PATTERN, $key)) {
            throw new ApiError(400, 'VALIDATION_ERROR', 'Idempotency-Key header must be a UUID.');
        }
        return $key;
    }

    private static function requireDate(mixed $value, string $field): string
    {
        if (!is_string($value)) {
            throw new ApiError(400, 'VALIDATION_ERROR', "{$field} is required (YYYY-MM-DD).");
        }
        self::manilaDayStartUtc($value, $field); // validates
        return $value;
    }

    /** @param array<string,mixed> $body */
    private static function optionalText(array $body, string $key, int $max): ?string
    {
        $value = $body[$key] ?? null;
        if ($value === null) {
            return null;
        }
        if (!is_string($value)) {
            throw new ApiError(400, 'VALIDATION_ERROR', "{$key} must be a string.");
        }
        $value = trim($value);
        if ($value === '') {
            return null;
        }
        if (mb_strlen($value) > $max) {
            throw new ApiError(400, 'VALIDATION_ERROR', "{$key} must be at most {$max} characters.");
        }
        return $value;
    }

    /** @return array<string,mixed>|null */
    private static function fetchRow(PDO $pdo, int $reportId): ?array
    {
        $stmt = $pdo->prepare('SELECT * FROM ssz_term_report WHERE report_id = :id');
        $stmt->execute(['id' => $reportId]);
        $row = $stmt->fetch(PDO::FETCH_ASSOC);
        return $row === false ? null : $row;
    }

    /** @param array<string,mixed> $row @return array<string,mixed> */
    private static function mapReport(PDO $pdo, array $row): array
    {
        // The signature page must show who prepared/approved even to a role
        // that cannot read other users (Punong Barangay, Secretary), so the
        // names and printed titles are joined here, server-side. Same barangay
        // by construction (the preparer/approver acted on this report).
        $names = [];
        $ids = array_values(array_unique(array_filter([
            (int) ($row['prepared_by'] ?? 0),
            (int) ($row['approved_by'] ?? 0),
            (int) ($row['paper_recorded_by'] ?? 0),
        ])));
        if ($ids !== []) {
            $in = implode(',', array_fill(0, count($ids), '?'));
            $nameStmt = $pdo->prepare("SELECT user_id, full_name, official_title FROM user WHERE user_id IN ({$in})");
            $nameStmt->execute($ids);
            foreach ($nameStmt->fetchAll(PDO::FETCH_ASSOC) as $u) {
                $names[(int) $u['user_id']] = $u;
            }
        }
        $preparer = $names[(int) ($row['prepared_by'] ?? 0)] ?? null;
        $approver = $names[(int) ($row['approved_by'] ?? 0)] ?? null;
        $recorder = $names[(int) ($row['paper_recorded_by'] ?? 0)] ?? null;
        $iso = static fn (mixed $v): ?string => $v === null
            ? null
            : (new \DateTimeImmutable((string) $v, new \DateTimeZone('UTC')))->format('Y-m-d\TH:i:s\Z');
        $out = [
            'report_id' => (int) $row['report_id'],
            'barangay_id' => (int) $row['barangay_id'],
            'term_label' => $row['term_label'],
            'term_start' => $row['term_start'],
            'term_end' => $row['term_end'],
            'status' => $row['status'],
        ];
        foreach (self::COUNT_COLUMNS as $column) {
            $out[$column] = (int) $row[$column];
        }
        return $out + [
            'other_institutions' => $row['other_institutions'],
            'remarks' => $row['remarks'],
            'prepared_by' => $row['prepared_by'] !== null ? (int) $row['prepared_by'] : null,
            'prepared_by_name' => $preparer['full_name'] ?? null,
            'prepared_by_title' => $preparer['official_title'] ?? null,
            'prepared_at' => $iso($row['prepared_at']),
            'approved_by' => $row['approved_by'] !== null ? (int) $row['approved_by'] : null,
            'approved_by_name' => $approver['full_name'] ?? null,
            'approved_by_title' => $approver['official_title'] ?? null,
            'approved_at' => $iso($row['approved_at']),
            'mayor_office_received_by' => $row['mayor_office_received_by'],
            'mayor_office_received_at' => $row['mayor_office_received_at'],
            'dilg_received_by' => $row['dilg_received_by'],
            'dilg_date_received' => $row['dilg_date_received'],
            'version' => (int) $row['version'],
            'created_at' => $iso($row['created_at']),
            'updated_at' => $iso($row['updated_at']),
        ] + PaperApproval::fields($row, isset($recorder['full_name']) ? (string) $recorder['full_name'] : null);
    }
}
