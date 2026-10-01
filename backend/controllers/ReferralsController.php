<?php
declare(strict_types=1);

namespace Baranguard\Controllers;

use Baranguard\Lib\ApiError;
use Baranguard\Lib\Audit;
use Baranguard\Lib\DeviceSignature;
use Baranguard\Lib\Http;
use Baranguard\Middleware\AuthMiddleware;
use DateTimeImmutable;
use DateTimeZone;
use PDO;

/**
 * Incident referrals ("Delegated to") — docs/FEATURE_CONTRACT_2026-10.md §5,
 * migration 0032, table `incident_referral`.
 *
 * A referral records that an incident was handed to another agency/office.
 * It is a DELEGATION LOG, not a case registry:
 *   - It never changes the incident's or any dispatch's status.
 *   - `contact_name` is the receiving responder/unit/official, NEVER a
 *     citizen; no complainant/respondent data is stored or returned here.
 *   - `GET /referrals` returns aggregate-friendly rows only (no narrative,
 *     names, contacts or coordinates).
 *
 * Endpoints
 *   POST /incidents/:id/referrals  tanod (own incident) | admin | secretary
 *   GET  /incidents/:id/referrals  tanod (own scope) | admin | secretary | punong_barangay
 *   GET  /referrals                admin | secretary | punong_barangay
 *
 * Authorization (Rule 2): role -> tenant (cross-tenant is 404, never 403)
 * -> Tanod ownership (reported the incident, or has/had a dispatch on it;
 * anything else is 404 as well, so existence is never confirmed).
 *
 * Idempotency (Rule 3, the two mechanisms are not interchangeable):
 *   - Tanod/mobile/sync: body `client_event_id` (+ `X-Device-Id`, ownership
 *     verified server-side).
 *   - Admin/Secretary/web: `Idempotency-Key` UUID header. It is stored in
 *     the same `client_event_id` column (same precedent as
 *     IncidentsController::createWeb()); UNIQUE(created_by, client_event_id)
 *     makes a retry return the original row, never a second one.
 *
 * `createItem()` is the sync entry point (POST /sync/batch `referrals[]`).
 * A sync item may carry `incident_client_event_id` instead of `incident_id`
 * for an incident created offline earlier in the same batch; it is resolved
 * through `incident.device_id` + `incident.client_event_id` of the SAME
 * device. A unique-key race is deliberately left to SyncController, which
 * maps SQLSTATE 23000 to a 'duplicate' result.
 *
 * Audit `incident_referral_created`, metadata `{incident_id, referred_to}`
 * only (Rule 8: never the free-text labels, contact or reference number).
 */
final class ReferralsController
{
    private const UUID_PATTERN = '/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i';
    private const DEFAULT_LIMIT = 25;
    private const MAX_LIMIT = 100;
    /** Tolerated device-clock skew for a client-supplied referred_at. */
    private const FUTURE_SKEW_SECONDS = 300;

    public const REFERRED_TO = [
        'pnp', 'bfp', 'ambulance_ems', 'barangay_official', 'vaw_desk',
        'social_welfare', 'higher_lgu', 'doh', 'dpwh', 'other',
    ];

    /**
     * POST /incidents/:id/referrals
     *
     * @param array{user_id:int,barangay_id:int,role:string} $identity
     */
    public static function create(PDO $pdo, array $identity, string $incidentIdParam): void
    {
        AuthMiddleware::requireRole($identity, ['tanod', 'admin', 'secretary']);
        if (!ctype_digit($incidentIdParam)) {
            throw new ApiError(404, 'NOT_FOUND', 'Incident not found.');
        }
        $incidentId = (int) $incidentIdParam;

        $body = Http::jsonBody();
        $deviceId = null;

        if ($identity['role'] === 'tanod') {
            $deviceId = Http::header('X-Device-Id');
            if ($deviceId === null) {
                throw new ApiError(400, 'VALIDATION_ERROR', 'X-Device-Id header is required.');
            }
            self::assertDeviceOwnership($pdo, $identity, $deviceId);
            // H-09: no-op for a device that has no registered Keystore key.
            DeviceSignature::verifyOrReject($pdo, $deviceId, $identity['user_id']);
            $clientEventId = $body['client_event_id'] ?? null;
            if (!is_string($clientEventId) || !preg_match(self::UUID_PATTERN, $clientEventId)) {
                throw new ApiError(400, 'VALIDATION_ERROR', 'client_event_id must be a UUID.');
            }
        } else {
            $clientEventId = Http::header('Idempotency-Key');
            if ($clientEventId === null || !preg_match(self::UUID_PATTERN, $clientEventId)) {
                throw new ApiError(400, 'VALIDATION_ERROR', 'Idempotency-Key header must be a UUID.');
            }
        }

        // The URL's incident id is authoritative; a body copy is ignored.
        unset($body['incident_id'], $body['incident_client_event_id']);

        try {
            $result = self::createCore($pdo, $identity, $deviceId, $body, $clientEventId, $incidentId);
        } catch (\PDOException $e) {
            if ((string) $e->getCode() !== '23000') {
                throw $e;
            }
            // Concurrent retry won the unique key: return the original row.
            $existing = self::findByEvent($pdo, $identity['user_id'], $clientEventId);
            if ($existing === null) {
                throw $e;
            }
            $result = ['id' => (int) $existing['referral_id'], 'wasCreated' => false, 'row' => $existing];
        }

        Http::send($result['wasCreated'] ? 201 : 200, self::mapRow($result['row']));
    }

    /**
     * Sync entry point (POST /sync/batch `referrals[]`). The caller
     * (SyncController) has already verified the batch's device belongs to
     * the Tanod; ownership is re-checked here because this method is public.
     *
     * @param array{user_id:int,barangay_id:int,role:string} $identity
     * @param array<string,mixed> $item {referred_to, other_text?, contact_name?,
     *        referred_at?, reference_no?, client_event_id, and incident_id OR
     *        incident_client_event_id}
     * @return array{id:int,wasCreated:bool}
     */
    public static function createItem(PDO $pdo, array $identity, string $deviceId, array $item): array
    {
        AuthMiddleware::requireRole($identity, ['tanod']);
        self::assertDeviceOwnership($pdo, $identity, $deviceId);
        // H-09, per item: one signature covers the sync batch request and every
        // item is held to it exactly like GpsController::createItem. No-op for a
        // device with no registered Keystore key.
        DeviceSignature::verifyOrReject($pdo, $deviceId, $identity['user_id']);

        $clientEventId = $item['client_event_id'] ?? null;
        if (!is_string($clientEventId) || !preg_match(self::UUID_PATTERN, $clientEventId)) {
            throw new ApiError(400, 'VALIDATION_ERROR', 'client_event_id must be a UUID.');
        }

        $result = self::createCore($pdo, $identity, $deviceId, $item, $clientEventId, null);
        return ['id' => $result['id'], 'wasCreated' => $result['wasCreated']];
    }

    /**
     * GET /incidents/:id/referrals
     *
     * @param array{user_id:int,barangay_id:int,role:string} $identity
     */
    public static function indexForIncident(PDO $pdo, array $identity, string $incidentIdParam): void
    {
        AuthMiddleware::requireRole($identity, ['tanod', 'admin', 'secretary', 'punong_barangay']);
        if (!ctype_digit($incidentIdParam)) {
            throw new ApiError(404, 'NOT_FOUND', 'Incident not found.');
        }
        $incidentId = (int) $incidentIdParam;

        $incident = self::loadIncident($pdo, 'WHERE incident_id = :id', ['id' => $incidentId]);
        if ($incident === null) {
            throw new ApiError(404, 'NOT_FOUND', 'Incident not found.');
        }
        AuthMiddleware::requireTenant($identity, (int) $incident['barangay_id']);
        if ($identity['role'] === 'tanod' && !self::tanodMayAccess($pdo, $incidentId, $identity['user_id'])) {
            throw new ApiError(404, 'NOT_FOUND', 'Incident not found.');
        }

        $stmt = $pdo->prepare(
            'SELECT referral_id, incident_id, referred_to, other_text, contact_name, referred_at, reference_no, created_at
             FROM incident_referral
             WHERE incident_id = :incident_id AND barangay_id = :barangay_id
             ORDER BY referred_at DESC, referral_id DESC'
        );
        $stmt->execute(['incident_id' => $incidentId, 'barangay_id' => $identity['barangay_id']]);

        $items = array_map(static fn (array $row): array => self::mapRow($row), $stmt->fetchAll(PDO::FETCH_ASSOC));
        Http::send(200, ['items' => $items]);
    }

    /**
     * GET /referrals?from=&to=&referred_to=&page=&limit=
     *
     * The barangay-wide delegation log. Rows are deliberately limited to
     * {referral_id, incident_id, display_id, incident_type, referred_to,
     * other_text, referred_at, reference_no}: no narrative, names, contacts
     * or coordinates. `from`/`to` are inclusive Manila calendar dates
     * (YYYY-MM-DD), bucketed in PHP against a fixed +08:00 (Rule 11).
     *
     * @param array{user_id:int,barangay_id:int,role:string} $identity
     */
    public static function index(PDO $pdo, array $identity): void
    {
        AuthMiddleware::requireRole($identity, ['admin', 'secretary', 'punong_barangay']);

        $where = ['r.barangay_id = :barangay_id'];
        $params = ['barangay_id' => $identity['barangay_id']];

        $from = Http::query('from');
        $to = Http::query('to');
        $fromDt = $from !== null ? self::manilaDayStartUtc($from, 'from') : null;
        $toExclusiveDt = $to !== null ? self::manilaDayStartUtc($to, 'to')->modify('+1 day') : null;
        if ($fromDt !== null && $toExclusiveDt !== null && $fromDt >= $toExclusiveDt) {
            throw new ApiError(400, 'VALIDATION_ERROR', 'from must not be after to.');
        }
        if ($fromDt !== null) {
            $where[] = 'r.referred_at >= :from_utc';
            $params['from_utc'] = $fromDt->format('Y-m-d H:i:s');
        }
        if ($toExclusiveDt !== null) {
            $where[] = 'r.referred_at < :to_utc';
            $params['to_utc'] = $toExclusiveDt->format('Y-m-d H:i:s');
        }

        $referredTo = Http::query('referred_to');
        if ($referredTo !== null) {
            if (!in_array($referredTo, self::REFERRED_TO, true)) {
                throw new ApiError(400, 'VALIDATION_ERROR', 'referred_to must be one of: ' . implode(', ', self::REFERRED_TO) . '.');
            }
            $where[] = 'r.referred_to = :referred_to';
            $params['referred_to'] = $referredTo;
        }

        $page = max(1, (int) (Http::query('page') ?? '1'));
        $limit = min(self::MAX_LIMIT, max(1, (int) (Http::query('limit') ?? (string) self::DEFAULT_LIMIT)));
        $offset = ($page - 1) * $limit;
        $whereSql = implode(' AND ', $where);

        $countStmt = $pdo->prepare("SELECT COUNT(*) FROM incident_referral r WHERE {$whereSql}");
        $countStmt->execute($params);
        $total = (int) $countStmt->fetchColumn();

        $stmt = $pdo->prepare(
            "SELECT r.referral_id, r.incident_id, i.display_id, i.incident_type, r.referred_to,
                    r.other_text, r.referred_at, r.reference_no
             FROM incident_referral r
             JOIN incident i ON i.incident_id = r.incident_id
             WHERE {$whereSql}
             ORDER BY r.referred_at DESC, r.referral_id DESC
             LIMIT :limit OFFSET :offset"
        );
        foreach ($params as $name => $value) {
            $stmt->bindValue(':' . $name, $value, is_int($value) ? PDO::PARAM_INT : PDO::PARAM_STR);
        }
        $stmt->bindValue(':limit', $limit, PDO::PARAM_INT);
        $stmt->bindValue(':offset', $offset, PDO::PARAM_INT);
        $stmt->execute();

        $items = array_map(static fn (array $row): array => [
            'referral_id' => (int) $row['referral_id'],
            'incident_id' => (int) $row['incident_id'],
            'display_id' => $row['display_id'],
            'incident_type' => $row['incident_type'],
            'referred_to' => $row['referred_to'],
            'other_text' => $row['other_text'],
            'referred_at' => $row['referred_at'],
            'reference_no' => $row['reference_no'],
        ], $stmt->fetchAll(PDO::FETCH_ASSOC));

        Http::send(200, ['items' => $items, 'page' => $page, 'limit' => $limit, 'total' => $total]);
    }

    // ------------------------------------------------------------------
    // Shared core
    // ------------------------------------------------------------------

    /**
     * Idempotent replay -> incident resolution/tenant/ownership -> field
     * validation -> insert -> audit. Used by both the direct POST and sync.
     *
     * @param array{user_id:int,barangay_id:int,role:string} $identity
     * @param array<string,mixed> $item
     * @param ?int $forcedIncidentId the URL's incident id (direct POST); null
     *        for a sync item, which carries incident_id or
     *        incident_client_event_id itself.
     * @return array{id:int,wasCreated:bool,row:array<string,mixed>}
     */
    private static function createCore(PDO $pdo, array $identity, ?string $deviceId, array $item, string $clientEventId, ?int $forcedIncidentId): array
    {
        // Replay first: a retry must return the original row even if the
        // incident has since moved or the caller's body is now stale.
        $existing = self::findByEvent($pdo, $identity['user_id'], $clientEventId);
        if ($existing !== null) {
            return ['id' => (int) $existing['referral_id'], 'wasCreated' => false, 'row' => $existing];
        }

        $incident = self::resolveIncident($pdo, $item, $deviceId, $forcedIncidentId);
        if ($incident === null) {
            throw new ApiError(404, 'NOT_FOUND', 'Incident not found.');
        }
        $incidentId = (int) $incident['incident_id'];
        // Cross-tenant is 404, never 403 (Rule 2).
        AuthMiddleware::requireTenant($identity, (int) $incident['barangay_id']);
        if ($identity['role'] === 'tanod' && !self::tanodMayAccess($pdo, $incidentId, $identity['user_id'])) {
            throw new ApiError(404, 'NOT_FOUND', 'Incident not found.');
        }

        // Field validation only after the caller is known to be entitled to
        // see this incident, so a foreign incident can't be probed via 400s.
        $referredTo = $item['referred_to'] ?? null;
        if (!is_string($referredTo) || !in_array($referredTo, self::REFERRED_TO, true)) {
            throw new ApiError(400, 'VALIDATION_ERROR', 'referred_to must be one of: ' . implode(', ', self::REFERRED_TO) . '.');
        }
        $otherText = self::optionalString($item['other_text'] ?? null, 100, 'other_text');
        if ($referredTo === 'other' && $otherText === null) {
            throw new ApiError(400, 'VALIDATION_ERROR', 'other_text is required when referred_to is "other".');
        }
        $contactName = self::optionalString($item['contact_name'] ?? null, 100, 'contact_name');
        $referenceNo = self::optionalString($item['reference_no'] ?? null, 64, 'reference_no');
        $referredAt = self::parseReferredAt($item['referred_at'] ?? null);

        $insert = $pdo->prepare(
            'INSERT INTO incident_referral
               (incident_id, barangay_id, referred_to, other_text, contact_name, referred_at, reference_no, created_by, client_event_id, created_at)
             VALUES
               (:incident_id, :barangay_id, :referred_to, :other_text, :contact_name, :referred_at, :reference_no, :created_by, :client_event_id, UTC_TIMESTAMP())'
        );
        $insert->execute([
            'incident_id' => $incidentId,
            'barangay_id' => (int) $incident['barangay_id'],
            'referred_to' => $referredTo,
            'other_text' => $otherText,
            'contact_name' => $contactName,
            'referred_at' => $referredAt,
            'reference_no' => $referenceNo,
            'created_by' => $identity['user_id'],
            'client_event_id' => $clientEventId,
        ]);
        $referralId = (int) $pdo->lastInsertId();

        // Identifiers and the enum value only (Rule 8).
        Audit::record(
            $pdo,
            $identity['barangay_id'],
            $identity['user_id'],
            'incident_referral_created',
            'incident_referral',
            $referralId,
            ['incident_id' => $incidentId, 'referred_to' => $referredTo]
        );

        $row = self::findByEvent($pdo, $identity['user_id'], $clientEventId);
        if ($row === null) {
            throw new ApiError(500, 'SERVER_ERROR', 'Referral could not be read back.');
        }
        return ['id' => $referralId, 'wasCreated' => true, 'row' => $row];
    }

    /**
     * @param array<string,mixed> $item
     * @return ?array<string,mixed>
     */
    private static function resolveIncident(PDO $pdo, array $item, ?string $deviceId, ?int $forcedIncidentId): ?array
    {
        if ($forcedIncidentId !== null) {
            return self::loadIncident($pdo, 'WHERE incident_id = :id', ['id' => $forcedIncidentId]);
        }

        $incidentId = $item['incident_id'] ?? null;
        if ($incidentId !== null) {
            if (!is_int($incidentId) && !(is_string($incidentId) && ctype_digit($incidentId))) {
                throw new ApiError(400, 'VALIDATION_ERROR', 'incident_id must be an integer.');
            }
            return self::loadIncident($pdo, 'WHERE incident_id = :id', ['id' => (int) $incidentId]);
        }

        $incidentEventId = $item['incident_client_event_id'] ?? null;
        if ($incidentEventId === null) {
            throw new ApiError(400, 'VALIDATION_ERROR', 'incident_id or incident_client_event_id is required.');
        }
        if (!is_string($incidentEventId) || !preg_match(self::UUID_PATTERN, $incidentEventId) || $deviceId === null) {
            throw new ApiError(400, 'VALIDATION_ERROR', 'incident_client_event_id must be a UUID.');
        }
        // Same device only: an incident created offline by THIS device.
        return self::loadIncident(
            $pdo,
            'WHERE device_id = :device_id AND client_event_id = :client_event_id',
            ['device_id' => $deviceId, 'client_event_id' => $incidentEventId]
        );
    }

    /**
     * @param array<string,mixed> $params
     * @return ?array<string,mixed>
     */
    private static function loadIncident(PDO $pdo, string $whereSql, array $params): ?array
    {
        $stmt = $pdo->prepare("SELECT incident_id, barangay_id FROM incident {$whereSql} LIMIT 1");
        $stmt->execute($params);
        $row = $stmt->fetch(PDO::FETCH_ASSOC);
        return $row === false ? null : $row;
    }

    /** @return ?array<string,mixed> */
    private static function findByEvent(PDO $pdo, int $userId, string $clientEventId): ?array
    {
        $stmt = $pdo->prepare(
            'SELECT referral_id, incident_id, referred_to, other_text, contact_name, referred_at, reference_no, created_at
             FROM incident_referral WHERE created_by = :user_id AND client_event_id = :client_event_id LIMIT 1'
        );
        $stmt->execute(['user_id' => $userId, 'client_event_id' => $clientEventId]);
        $row = $stmt->fetch(PDO::FETCH_ASSOC);
        return $row === false ? null : $row;
    }

    /**
     * §6/§7's Tanod relationship rule: an incident they reported, or one
     * they have (or had) a dispatch for. Mirrors
     * IncidentsController::tanodMayAccess() (private there).
     */
    private static function tanodMayAccess(PDO $pdo, int $incidentId, int $userId): bool
    {
        $stmt = $pdo->prepare(
            'SELECT 1 FROM incident i
             WHERE i.incident_id = :incident_id
               AND (i.reported_by = :user_id
                    OR EXISTS (SELECT 1 FROM dispatch d WHERE d.incident_id = i.incident_id AND d.tanod_id = :user_id2))
             LIMIT 1'
        );
        $stmt->execute(['incident_id' => $incidentId, 'user_id' => $userId, 'user_id2' => $userId]);
        return $stmt->fetch(PDO::FETCH_ASSOC) !== false;
    }

    /** Same generic-422 pattern as IncidentsController::assertDeviceOwnership(). */
    private static function assertDeviceOwnership(PDO $pdo, array $identity, string $deviceId): void
    {
        $stmt = $pdo->prepare(
            'SELECT device_id FROM mobile_device WHERE device_id = :device_id AND user_id = :user_id AND is_active = 1 LIMIT 1'
        );
        $stmt->execute(['device_id' => $deviceId, 'user_id' => $identity['user_id']]);
        if ($stmt->fetch(PDO::FETCH_ASSOC) === false) {
            throw new ApiError(422, 'UNPROCESSABLE_ENTITY', 'Device is not registered or not active for this account.');
        }
    }

    private static function optionalString(mixed $value, int $maxLength, string $field): ?string
    {
        if ($value === null) {
            return null;
        }
        if (!is_string($value)) {
            throw new ApiError(400, 'VALIDATION_ERROR', "{$field} must be a string.");
        }
        $value = trim($value);
        if ($value === '') {
            return null;
        }
        if (mb_strlen($value) > $maxLength) {
            throw new ApiError(400, 'VALIDATION_ERROR', "{$field} must be at most {$maxLength} characters.");
        }
        return $value;
    }

    /** @return string UTC 'Y-m-d H:i:s'; defaults to now when absent. */
    private static function parseReferredAt(mixed $value): string
    {
        $utc = new DateTimeZone('UTC');
        if ($value === null) {
            return (new DateTimeImmutable('now', $utc))->format('Y-m-d H:i:s');
        }
        if (!is_string($value) || !preg_match('/^\d{4}-\d{2}-\d{2}[T ]\d{2}:\d{2}/', $value)) {
            throw new ApiError(400, 'VALIDATION_ERROR', 'referred_at must be an ISO 8601 date-time.');
        }
        try {
            // A value with no zone designator is read as UTC (storage is UTC, Rule 11).
            $parsed = new DateTimeImmutable($value, $utc);
        } catch (\Exception) {
            throw new ApiError(400, 'VALIDATION_ERROR', 'referred_at must be an ISO 8601 date-time.');
        }
        $parsed = $parsed->setTimezone($utc);
        if ($parsed->getTimestamp() > time() + self::FUTURE_SKEW_SECONDS) {
            throw new ApiError(400, 'VALIDATION_ERROR', 'referred_at cannot be in the future.');
        }
        return $parsed->format('Y-m-d H:i:s');
    }

    /** Manila midnight of a YYYY-MM-DD date, expressed in UTC (fixed +08:00, Rule 11). */
    private static function manilaDayStartUtc(string $date, string $field): DateTimeImmutable
    {
        if (!preg_match('/^\d{4}-\d{2}-\d{2}$/', $date)) {
            throw new ApiError(400, 'VALIDATION_ERROR', "{$field} must be a date in YYYY-MM-DD format.");
        }
        try {
            $local = new DateTimeImmutable($date . ' 00:00:00', new DateTimeZone('+08:00'));
        } catch (\Exception) {
            throw new ApiError(400, 'VALIDATION_ERROR', "{$field} must be a valid date.");
        }
        if ($local->format('Y-m-d') !== $date) {
            throw new ApiError(400, 'VALIDATION_ERROR', "{$field} must be a valid date.");
        }
        return $local->setTimezone(new DateTimeZone('UTC'));
    }

    /**
     * @param array<string,mixed> $row
     * @return array<string,mixed>
     */
    private static function mapRow(array $row): array
    {
        return [
            'referral_id' => (int) $row['referral_id'],
            'incident_id' => (int) $row['incident_id'],
            'referred_to' => $row['referred_to'],
            'other_text' => $row['other_text'],
            'contact_name' => $row['contact_name'],
            'referred_at' => $row['referred_at'],
            'reference_no' => $row['reference_no'],
            'created_at' => $row['created_at'],
        ];
    }
}
