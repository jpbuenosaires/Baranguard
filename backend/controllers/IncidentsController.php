<?php
declare(strict_types=1);

namespace Baranguard\Controllers;

use Baranguard\Lib\ApiError;
use Baranguard\Lib\Http;
use Baranguard\Middleware\AuthMiddleware;
use PDO;

/**
 * GET /incidents — Master Reference §6 "Incidents" section, §7 role
 * matrix ("View incident list": Admin/Secretary full, Tanod own only,
 * Punong Barangay read-only), §9 W3 (feeds the Dispatch Center's pending
 * queue via `status=pending`).
 *
 * The reference fixes the response item shape exactly (no raw narrative
 * in the list view — that's only ever returned by
 * `GET /incidents/:id` for Secretary) but leaves the `?...` query
 * params/pagination defaults to the global invariants in §6 (default
 * page size 25, max 100). Resolved decisions, logged in DEVLOG.md:
 *   - `status=` / `priority=` are optional exact-match filters against
 *     the §5 enum values; an unrecognized value is 400 VALIDATION_ERROR
 *     rather than silently matching nothing.
 *   - `page=` / `limit=` follow the same convention as
 *     `ReportsController` would if it paginated: 1-indexed page,
 *     default limit 25, hard cap 100.
 *   - Ordering is `created_at DESC` (newest first) — the reference
 *     doesn't state one, but a dispatch queue needs a stable, useful
 *     default rather than undefined row order.
 *
 * `create()` (W6 Electronic Blotter List's "new-entry form") adds
 * POST /incidents -- Section 6 Incidents, Section 7 role matrix
 * ("Web-side incident entry": Admin/Secretary only). Resolved decisions,
 * logged in DEVLOG.md:
 *   - Idempotency: Section 6 requires the Idempotency-Key UUID header for
 *     trusted web creation, with the server persisting that key and
 *     returning the original incident on replay. Mobile's own idempotency
 *     key is (device_id, client_event_id); a web write has no device_id
 *     (NULL), and MariaDB's nullable UNIQUE KEY (device_id,
 *     client_event_id) does not dedupe across NULL device_id rows (NULL
 *     is never equal to NULL in a unique index) -- Section 5's own schema
 *     note anticipates exactly this ("nullable composite UNIQUE
 *     constraints plus transactional checks are used where a partial
 *     constraint would otherwise be required"). So a web create stores
 *     the Idempotency-Key header value in client_event_id (same column,
 *     device_id stays NULL) and a check-then-insert inside one
 *     transaction supplies the "transactional check" half of that
 *     documented pattern, matching DispatchController::create()'s own
 *     replay-lookup-then-insert shape.
 *   - No priority field: Section 6's POST /incidents body is exactly
 *     {incident_type,raw_narrative,latitude,longitude,source?,
 *     device_offline_created_at?,client_event_id} -- no priority key. The
 *     schema defaults it to 'normal'; this endpoint never accepts one
 *     rather than inventing an unlisted field.
 *   - Response shape: not fixed by Section 6 beyond "creates pending
 *     incident with server created_at" -- returns the same redacted shape
 *     GET /incidents already uses (no raw narrative echoed back), for one
 *     consistent incident-item contract across both endpoints.
 */
final class IncidentsController
{
    private const INCIDENT_STATUSES = ['pending', 'dispatched', 'resolved'];
    private const INCIDENT_PRIORITIES = ['normal', 'high', 'critical'];
    private const INCIDENT_TYPES = [
        'theft', 'physical_injury', 'disturbance', 'domestic_dispute',
        'vandalism', 'traffic_incident', 'fire', 'medical_emergency',
        'missing_person', 'animal_complaint', 'other',
    ];
    private const UUID_PATTERN = '/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i';
    private const DEFAULT_LIMIT = 25;
    private const MAX_LIMIT = 100;

    /** @param array{user_id:int,barangay_id:int,role:string} $identity */
    public static function index(PDO $pdo, array $identity): void
    {
        AuthMiddleware::requireRole($identity, ['admin', 'secretary', 'tanod', 'punong_barangay']);

        $status = Http::query('status');
        if ($status !== null && !in_array($status, self::INCIDENT_STATUSES, true)) {
            throw new ApiError(400, 'VALIDATION_ERROR', 'status must be one of: ' . implode(', ', self::INCIDENT_STATUSES) . '.');
        }
        $priority = Http::query('priority');
        if ($priority !== null && !in_array($priority, self::INCIDENT_PRIORITIES, true)) {
            throw new ApiError(400, 'VALIDATION_ERROR', 'priority must be one of: ' . implode(', ', self::INCIDENT_PRIORITIES) . '.');
        }

        $page = max(1, (int) (Http::query('page') ?? '1'));
        $limit = (int) (Http::query('limit') ?? (string) self::DEFAULT_LIMIT);
        if ($limit < 1) {
            $limit = self::DEFAULT_LIMIT;
        }
        $limit = min($limit, self::MAX_LIMIT);
        $offset = ($page - 1) * $limit;

        // Qualified with i. throughout — the officer-name join below adds
        // `dispatch` (also has status/priority columns) and `user` (also
        // has barangay_id), so an unqualified column here would be
        // ambiguous rather than merely wrong.
        $where = ['i.barangay_id = :barangay_id'];
        $params = ['barangay_id' => $identity['barangay_id']];

        // §6: "Tanod forced to reported_by=me" — server-enforced, not a
        // client-supplied filter the caller could override.
        if ($identity['role'] === 'tanod') {
            $where[] = 'i.reported_by = :reported_by';
            $params['reported_by'] = $identity['user_id'];
        }
        if ($status !== null) {
            $where[] = 'i.status = :status';
            $params['status'] = $status;
        }
        if ($priority !== null) {
            $where[] = 'i.priority = :priority';
            $params['priority'] = $priority;
        }
        $whereSql = implode(' AND ', $where);

        $countStmt = $pdo->prepare("SELECT COUNT(*) FROM incident i WHERE {$whereSql}");
        $countStmt->execute($params);
        $total = (int) $countStmt->fetchColumn();

        // officer_name: the Tanod name off this incident's most recent
        // dispatch (any status, including cancelled — an incident that was
        // dispatched then cancelled still meaningfully had "an officer
        // handle it" for blotter purposes; a fresh, never-dispatched
        // incident correctly has none). §6's item shape for GET /incidents
        // doesn't list this field; added as W6 blotter-table plumbing, same
        // precedent as GET /users?role= being added for the Tanod picker.
        $stmt = $pdo->prepare(
            "SELECT i.incident_id, i.barangay_id, i.reported_by, i.incident_type, i.priority, i.status, i.source,
                    i.latitude, i.longitude, i.created_at, i.device_offline_created_at, i.synced_at,
                    tanod.full_name AS officer_name
             FROM incident i
             LEFT JOIN dispatch d ON d.dispatch_id = (
                 SELECT d2.dispatch_id FROM dispatch d2
                 WHERE d2.incident_id = i.incident_id
                 ORDER BY d2.dispatched_at DESC
                 LIMIT 1
             )
             LEFT JOIN user tanod ON tanod.user_id = d.tanod_id
             WHERE {$whereSql}
             ORDER BY i.created_at DESC
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
                'incident_id' => (int) $row['incident_id'],
                'barangay_id' => (int) $row['barangay_id'],
                'reported_by' => $row['reported_by'] !== null ? (int) $row['reported_by'] : null,
                'incident_type' => $row['incident_type'],
                'priority' => $row['priority'],
                'status' => $row['status'],
                'source' => $row['source'],
                'latitude' => $row['latitude'] !== null ? (float) $row['latitude'] : null,
                'longitude' => $row['longitude'] !== null ? (float) $row['longitude'] : null,
                'created_at' => $row['created_at'],
                'device_offline_created_at' => $row['device_offline_created_at'],
                'synced_at' => $row['synced_at'],
                'officer_name' => $row['officer_name'] ?? null,
            ];
        }, $rows);

        Http::send(200, [
            'items' => $items,
            'page' => $page,
            'limit' => $limit,
            'total' => $total,
        ]);
    }

    /** @param array{user_id:int,barangay_id:int,role:string} $identity */
    public static function create(PDO $pdo, array $identity): void
    {
        AuthMiddleware::requireRole($identity, ['admin', 'secretary']);

        $idempotencyKey = Http::header('Idempotency-Key');
        if ($idempotencyKey === null || !preg_match(self::UUID_PATTERN, $idempotencyKey)) {
            throw new ApiError(400, 'VALIDATION_ERROR', 'Idempotency-Key header must be a UUID.');
        }

        $body = Http::jsonBody();
        $incidentType = $body['incident_type'] ?? null;
        $rawNarrative = $body['raw_narrative'] ?? null;
        $latitude = $body['latitude'] ?? null;
        $longitude = $body['longitude'] ?? null;

        if (!is_string($incidentType) || !in_array($incidentType, self::INCIDENT_TYPES, true)) {
            throw new ApiError(400, 'VALIDATION_ERROR', 'incident_type must be one of: ' . implode(', ', self::INCIDENT_TYPES) . '.');
        }
        if (!is_string($rawNarrative) || trim($rawNarrative) === '') {
            throw new ApiError(400, 'VALIDATION_ERROR', 'raw_narrative is required.');
        }
        [$latitude, $longitude] = self::validateCoordinates($latitude, $longitude);

        // Idempotent replay lookup -- see class doc for why this is keyed
        // on (barangay_id, device_id IS NULL, client_event_id) rather than
        // relying on the nullable UNIQUE KEY alone.
        $existingStmt = $pdo->prepare(
            'SELECT incident_id, barangay_id, reported_by, incident_type, priority, status, source,
                    latitude, longitude, created_at, device_offline_created_at, synced_at
             FROM incident
             WHERE barangay_id = :barangay_id AND device_id IS NULL AND client_event_id = :idempotency_key
             LIMIT 1'
        );
        $existingStmt->execute(['barangay_id' => $identity['barangay_id'], 'idempotency_key' => $idempotencyKey]);
        $existing = $existingStmt->fetch(PDO::FETCH_ASSOC);
        if ($existing !== false) {
            Http::send(200, self::mapIncident($existing));
        }

        $pdo->beginTransaction();
        try {
            // Re-check inside the transaction to close (not eliminate --
            // see class doc's note on the schema's own documented
            // nullable-UNIQUE-plus-transactional-check pattern) the race
            // between the lookup above and this insert.
            $recheckStmt = $pdo->prepare(
                'SELECT incident_id FROM incident
                 WHERE barangay_id = :barangay_id AND device_id IS NULL AND client_event_id = :idempotency_key
                 LIMIT 1 FOR UPDATE'
            );
            $recheckStmt->execute(['barangay_id' => $identity['barangay_id'], 'idempotency_key' => $idempotencyKey]);
            if ($recheckStmt->fetch(PDO::FETCH_ASSOC) !== false) {
                $pdo->rollBack();
                $existingStmt->execute(['barangay_id' => $identity['barangay_id'], 'idempotency_key' => $idempotencyKey]);
                Http::send(200, self::mapIncident($existingStmt->fetch(PDO::FETCH_ASSOC)));
            }

            $insertStmt = $pdo->prepare(
                "INSERT INTO incident
                    (barangay_id, reported_by, device_id, incident_type, priority, raw_narrative, status, source,
                     latitude, longitude, created_at, client_event_id, updated_at)
                 VALUES
                    (:barangay_id, :reported_by, NULL, :incident_type, 'normal', :raw_narrative, 'pending', 'web',
                     :latitude, :longitude, UTC_TIMESTAMP(), :idempotency_key, UTC_TIMESTAMP())"
            );
            $insertStmt->execute([
                'barangay_id' => $identity['barangay_id'],
                'reported_by' => $identity['user_id'],
                'incident_type' => $incidentType,
                'raw_narrative' => $rawNarrative,
                'latitude' => $latitude,
                'longitude' => $longitude,
                'idempotency_key' => $idempotencyKey,
            ]);
            $incidentId = (int) $pdo->lastInsertId();

            $pdo->commit();
        } catch (\Throwable $e) {
            $pdo->rollBack();
            throw $e;
        }

        $readBackStmt = $pdo->prepare(
            'SELECT incident_id, barangay_id, reported_by, incident_type, priority, status, source,
                    latitude, longitude, created_at, device_offline_created_at, synced_at
             FROM incident WHERE incident_id = :incident_id'
        );
        $readBackStmt->execute(['incident_id' => $incidentId]);
        Http::send(201, self::mapIncident($readBackStmt->fetch(PDO::FETCH_ASSOC)));
    }

    /** @param array<string,mixed> $row @return array<string,mixed> */
    private static function mapIncident(array $row): array
    {
        return [
            'incident_id' => (int) $row['incident_id'],
            'barangay_id' => (int) $row['barangay_id'],
            'reported_by' => $row['reported_by'] !== null ? (int) $row['reported_by'] : null,
            'incident_type' => $row['incident_type'],
            'priority' => $row['priority'],
            'status' => $row['status'],
            'source' => $row['source'],
            'latitude' => $row['latitude'] !== null ? (float) $row['latitude'] : null,
            'longitude' => $row['longitude'] !== null ? (float) $row['longitude'] : null,
            'created_at' => $row['created_at'],
            'device_offline_created_at' => $row['device_offline_created_at'],
            'synced_at' => $row['synced_at'],
            // create()'s callers never join dispatch — a just-created
            // incident can't have one yet — so this is always null here,
            // same shape as index()'s items for a one-consistent contract.
            'officer_name' => $row['officer_name'] ?? null,
        ];
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
