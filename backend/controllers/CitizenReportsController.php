<?php
declare(strict_types=1);

namespace Baranguard\Controllers;

use Baranguard\Lib\ApiError;
use Baranguard\Lib\Http;
use Baranguard\Middleware\AuthMiddleware;
use PDO;

/**
 * Citizen reports — Master Reference §6 "Citizen reports" section, §5
 * `citizen_report` table, §7 role matrix ("View citizen report inbox":
 * Admin/Secretary only), §9 W19 Public Citizen Report + W16 Citizen
 * Reports Inbox (list only — `POST /citizen-reports/:id/convert` is a
 * separate, unbuilt §6 endpoint; W16's own Sprint 1 checklist entry is
 * explicitly "list only").
 *
 * Resolved decisions, logged in DEVLOG.md:
 *   - **Rate limiting.** §6 says `POST /citizen-reports` is "rate-limited
 *     and size-limited" but never states a threshold or mechanism, and
 *     `citizen_report` itself has no IP column to key a limiter off of.
 *     `audit_log` already exists for exactly this kind of write-once
 *     tracking (has `ip_address`, `action`, `created_at`) — reused here
 *     rather than adding a new table: every submission attempt (accepted
 *     or rate-limited) writes an `audit_log` row with
 *     `action='citizen_report_submitted'`, and a new request is rejected
 *     with 429 once the same IP has 3 accepted submissions inside a
 *     rolling 15-minute window. Same "reuse an existing schema entity
 *     instead of inventing one" precedent as `AuthController`'s lockout
 *     counters living on the `user` row itself.
 *   - **`confirmation`.** §6: "Creates report before attempting optional
 *     confirmation SMS. Response includes `{report_id,confirmation}`."
 *     No SMS/GSM transport exists yet (Sprint 4 dependency — same
 *     "not wired up yet" situation `DispatchController` documents for
 *     OSRM). `confirmation` is always `null` here rather than a fabricated
 *     `{sent:true}` — this is queued dependent-feature absence, not a
 *     bug, and mirrors `dispatch.route_status="unavailable"`'s precedent
 *     exactly: don't claim a side effect that never actually happened.
 *   - **Response shape for a listed report.** §6 fixes
 *     `{report_id,description,contact_number,latitude,longitude,
 *     submitted_at,incident_id}` for the inbox list; that's returned
 *     verbatim, no raw narrative concept applies here (citizen reports
 *     have no separate raw/redacted split — that split is only on
 *     `incident`, post-conversion).
 *   - **Size limit.** `description` is capped at 2000 characters (the
 *     column is TEXT, effectively unbounded — this is an abuse-prevention
 *     ceiling on a public unauthenticated endpoint, not a schema limit).
 *     `contact_number` follows the column's own VARCHAR(32).
 */
final class CitizenReportsController
{
    private const MAX_DESCRIPTION_LENGTH = 2000;
    private const MAX_CONTACT_LENGTH = 32;
    private const RATE_LIMIT_MAX_ATTEMPTS = 3;
    private const RATE_LIMIT_WINDOW_MINUTES = 15;
    private const DEFAULT_LIMIT = 25;
    private const MAX_LIMIT = 100;

    public static function submit(PDO $pdo): void
    {
        $ip = $_SERVER['REMOTE_ADDR'] ?? null;

        if ($ip !== null) {
            $stmt = $pdo->prepare(
                "SELECT COUNT(*) FROM audit_log
                 WHERE action = 'citizen_report_submitted' AND ip_address = :ip
                   AND created_at >= DATE_SUB(UTC_TIMESTAMP(), INTERVAL :window_minutes MINUTE)"
            );
            $stmt->bindValue('ip', $ip);
            $stmt->bindValue('window_minutes', self::RATE_LIMIT_WINDOW_MINUTES, PDO::PARAM_INT);
            $stmt->execute();
            if ((int) $stmt->fetchColumn() >= self::RATE_LIMIT_MAX_ATTEMPTS) {
                throw new ApiError(429, 'RATE_LIMITED', 'Too many reports submitted recently. Please try again later.');
            }
        }

        $body = Http::jsonBody();
        $barangayId = $body['barangay_id'] ?? null;
        $description = $body['description'] ?? null;
        $contactNumber = $body['contact_number'] ?? null;
        $latitude = $body['latitude'] ?? null;
        $longitude = $body['longitude'] ?? null;

        if (!is_int($barangayId) && !(is_string($barangayId) && ctype_digit($barangayId))) {
            throw new ApiError(400, 'VALIDATION_ERROR', 'barangay_id is required.');
        }
        $barangayId = (int) $barangayId;

        if (!is_string($description) || trim($description) === '') {
            throw new ApiError(400, 'VALIDATION_ERROR', 'description is required.');
        }
        if (strlen($description) > self::MAX_DESCRIPTION_LENGTH) {
            throw new ApiError(400, 'VALIDATION_ERROR', 'description must be at most ' . self::MAX_DESCRIPTION_LENGTH . ' characters.');
        }

        if ($contactNumber !== null) {
            if (!is_string($contactNumber) || strlen($contactNumber) > self::MAX_CONTACT_LENGTH) {
                throw new ApiError(400, 'VALIDATION_ERROR', 'contact_number must be a string of at most ' . self::MAX_CONTACT_LENGTH . ' characters.');
            }
        }

        [$latitude, $longitude] = self::validateCoordinates($latitude, $longitude);

        // "Only the four known barangays are accepted" (§6) — checked
        // against the real table rather than hardcoding 1-4, so this
        // still works if the deterministic seed ever changes rows.
        $barangayStmt = $pdo->prepare('SELECT barangay_id FROM barangay WHERE barangay_id = :barangay_id LIMIT 1');
        $barangayStmt->execute(['barangay_id' => $barangayId]);
        if ($barangayStmt->fetch(PDO::FETCH_ASSOC) === false) {
            throw new ApiError(400, 'VALIDATION_ERROR', 'barangay_id must be one of the known barangays.');
        }

        $insertStmt = $pdo->prepare(
            'INSERT INTO citizen_report (barangay_id, contact_number, description, latitude, longitude, submitted_at)
             VALUES (:barangay_id, :contact_number, :description, :latitude, :longitude, UTC_TIMESTAMP())'
        );
        $insertStmt->execute([
            'barangay_id' => $barangayId,
            'contact_number' => $contactNumber,
            'description' => $description,
            'latitude' => $latitude,
            'longitude' => $longitude,
        ]);
        $reportId = (int) $pdo->lastInsertId();

        // Write-once tracking row, doubling as the rate-limit ledger — see
        // class doc. actor_user_id is NULL: public/unauthenticated caller.
        $auditStmt = $pdo->prepare(
            'INSERT INTO audit_log (barangay_id, actor_user_id, action, entity_type, entity_id, metadata_json, ip_address, user_agent, created_at)
             VALUES (:barangay_id, NULL, :action, :entity_type, :entity_id, :metadata_json, :ip, :ua, UTC_TIMESTAMP())'
        );
        $auditStmt->execute([
            'barangay_id' => $barangayId,
            'action' => 'citizen_report_submitted',
            'entity_type' => 'citizen_report',
            'entity_id' => $reportId,
            'metadata_json' => json_encode([], JSON_UNESCAPED_SLASHES),
            'ip' => $ip,
            'ua' => Http::header('User-Agent'),
        ]);

        Http::send(201, [
            'report_id' => $reportId,
            'confirmation' => null, // No SMS transport built yet — see class doc.
        ]);
    }

    /** @param array{user_id:int,barangay_id:int,role:string} $identity */
    public static function index(PDO $pdo, array $identity): void
    {
        AuthMiddleware::requireRole($identity, ['admin', 'secretary']);

        $status = Http::query('status');
        if ($status !== null && $status !== 'unconverted') {
            throw new ApiError(400, 'VALIDATION_ERROR', 'status must be "unconverted" when provided.');
        }

        $page = max(1, (int) (Http::query('page') ?? '1'));
        $limit = min(self::MAX_LIMIT, max(1, (int) (Http::query('limit') ?? (string) self::DEFAULT_LIMIT)));
        $offset = ($page - 1) * $limit;

        $where = ['barangay_id = :barangay_id'];
        $params = ['barangay_id' => $identity['barangay_id']];
        if ($status === 'unconverted') {
            $where[] = 'incident_id IS NULL';
        }
        $whereSql = implode(' AND ', $where);

        $countStmt = $pdo->prepare("SELECT COUNT(*) FROM citizen_report WHERE {$whereSql}");
        $countStmt->execute($params);
        $total = (int) $countStmt->fetchColumn();

        $stmt = $pdo->prepare(
            "SELECT report_id, description, contact_number, latitude, longitude, submitted_at, incident_id
             FROM citizen_report
             WHERE {$whereSql}
             ORDER BY submitted_at DESC
             LIMIT :limit OFFSET :offset"
        );
        foreach ($params as $key => $value) {
            $stmt->bindValue(':' . $key, $value);
        }
        $stmt->bindValue(':limit', $limit, PDO::PARAM_INT);
        $stmt->bindValue(':offset', $offset, PDO::PARAM_INT);
        $stmt->execute();
        $rows = $stmt->fetchAll(PDO::FETCH_ASSOC);

        $items = array_map(static function (array $row): array {
            return [
                'report_id' => (int) $row['report_id'],
                'description' => $row['description'],
                'contact_number' => $row['contact_number'],
                'latitude' => $row['latitude'] !== null ? (float) $row['latitude'] : null,
                'longitude' => $row['longitude'] !== null ? (float) $row['longitude'] : null,
                'submitted_at' => $row['submitted_at'],
                'incident_id' => $row['incident_id'] !== null ? (int) $row['incident_id'] : null,
            ];
        }, $rows);

        Http::send(200, ['items' => $items, 'page' => $page, 'limit' => $limit, 'total' => $total]);
    }

    /** @return array{0:?float,1:?float} */
    private static function validateCoordinates(mixed $latitude, mixed $longitude): array
    {
        if ($latitude === null && $longitude === null) {
            return [null, null];
        }
        if (!is_numeric($latitude) || !is_numeric($longitude)) {
            throw new ApiError(400, 'VALIDATION_ERROR', 'latitude and longitude must both be provided together as numbers.');
        }
        $lat = (float) $latitude;
        $lng = (float) $longitude;
        if ($lat < -90 || $lat > 90 || $lng < -180 || $lng > 180) {
            throw new ApiError(400, 'VALIDATION_ERROR', 'latitude/longitude are out of range.');
        }
        return [$lat, $lng];
    }
}
