<?php
declare(strict_types=1);

namespace Baranguard\Controllers;

use Baranguard\Lib\ApiError;
use Baranguard\Lib\Audit;
use Baranguard\Lib\Http;
use Baranguard\Services\Notifications\NotificationDispatcher;
use Baranguard\Services\Notifications\NotificationService;
use Baranguard\Middleware\AuthMiddleware;
use PDO;

/**
 * GET /tanod-sos — Master Reference §6 "Tanod SOS" section, §5
 * `tanod_sos` table, §7 ("View/acknowledge/resolve SOS": Admin full, PB
 * read-only), §9 W3 (SOS banner)/W4 (SOS markers).
 *
 * Sprint 4 adds the write side: `POST /tanod-sos` (Tanod-only trigger)
 * and the Admin acknowledge/resolve endpoints.
 *
 * §2 Rule 27 governs this whole file and is worth restating, because it is
 * the reason SOS looks different from every other flow here:
 *
 *   "SOS never depends on incident dispatch triage. It creates a
 *    persistent SOS record and sends alerts to Admin and other eligible
 *    on-duty Tanods. SOS must have a local/offline fallback path so a
 *    workstation/LAN outage does not silently suppress a personal-safety
 *    emergency."
 *
 * Three consequences implemented below:
 *   - `create()` does NOT create, require, or consult an incident. A Tanod
 *     in danger is not a triage queue item.
 *   - The SOS row and its notification are committed in ONE transaction,
 *     so a fan-out problem can never lose the record that someone called
 *     for help.
 *   - A missing transport is never allowed to fail the request. If nothing
 *     is configured to send, the SOS is still recorded and still appears
 *     on W3's banner — answering 500 here would tell the app "SOS failed"
 *     for an emergency the server actually knows about.
 */
final class TanodSosController
{
    private const SOS_STATUSES = ['active', 'acknowledged', 'resolved'];
    private const DEFAULT_LIMIT = 25;
    private const MAX_LIMIT = 100;
    private const UUID_PATTERN = '/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i';

    /** @param array{user_id:int,barangay_id:int,role:string} $identity */
    public static function index(PDO $pdo, array $identity): void
    {
        AuthMiddleware::requireRole($identity, ['admin', 'punong_barangay']);

        $status = Http::query('status');
        if ($status !== null && !in_array($status, self::SOS_STATUSES, true)) {
            throw new ApiError(400, 'VALIDATION_ERROR', 'status must be one of: ' . implode(', ', self::SOS_STATUSES) . '.');
        }

        $page = max(1, (int) (Http::query('page') ?? '1'));
        $limit = min(self::MAX_LIMIT, max(1, (int) (Http::query('limit') ?? (string) self::DEFAULT_LIMIT)));
        $offset = ($page - 1) * $limit;

        $where = ['barangay_id = :barangay_id'];
        $params = ['barangay_id' => $identity['barangay_id']];
        if ($status !== null) {
            $where[] = 'status = :status';
            $params['status'] = $status;
        }
        $whereSql = implode(' AND ', $where);

        $countStmt = $pdo->prepare("SELECT COUNT(*) FROM tanod_sos WHERE {$whereSql}");
        $countStmt->execute($params);
        $total = (int) $countStmt->fetchColumn();

        $stmt = $pdo->prepare(
            "SELECT sos_id, user_id, dispatch_id, latitude, longitude, triggered_at, received_at,
                    status, acknowledged_at, resolved_at
             FROM tanod_sos
             WHERE {$whereSql}
             ORDER BY triggered_at DESC
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
                'sos_id' => (int) $row['sos_id'],
                'user_id' => (int) $row['user_id'],
                'dispatch_id' => $row['dispatch_id'] !== null ? (int) $row['dispatch_id'] : null,
                'latitude' => (float) $row['latitude'],
                'longitude' => (float) $row['longitude'],
                'triggered_at' => $row['triggered_at'],
                'received_at' => $row['received_at'],
                'status' => $row['status'],
                'acknowledged_at' => $row['acknowledged_at'],
                'resolved_at' => $row['resolved_at'],
            ];
        }, $rows);

        Http::send(200, ['items' => $items, 'page' => $page, 'limit' => $limit, 'total' => $total]);
    }

    /**
     * POST /tanod-sos — §6: "Tanod only → {sos_id,status,received_at}.
     * Body {latitude,longitude,dispatch_id?,client_event_id,
     * fallback_channel?}. Own user/barangay are derived from token.
     * Optional dispatch must belong to caller and be active. Creates
     * idempotent SOS record, creates logical notifications, and
     * immediately attempts configured FCM/SMS channels."
     *
     * @param array{user_id:int,barangay_id:int,role:string} $identity
     */
    public static function create(PDO $pdo, array $identity): void
    {
        AuthMiddleware::requireRole($identity, ['tanod']);

        $body = Http::jsonBody();
        $result = self::createItem($pdo, $identity, $body);

        Http::send($result['wasCreated'] ? 201 : 200, [
            'sos_id' => $result['sos_id'],
            'status' => $result['status'],
            'received_at' => $result['received_at'],
        ]);
    }

    /**
     * Core SOS-creation logic. `public` so `SyncController::batch()`'s
     * `sos[]` items reuse the identical path — an SOS that had to wait for
     * connectivity must land exactly as one raised online, including the
     * same idempotency key and the same fan-out.
     *
     * @param array<string,mixed> $item
     * @return array{sos_id:int,status:string,received_at:string,wasCreated:bool}
     */
    public static function createItem(PDO $pdo, array $identity, array $item): array
    {
        $latitude = $item['latitude'] ?? null;
        $longitude = $item['longitude'] ?? null;
        $dispatchId = $item['dispatch_id'] ?? null;
        $clientEventId = $item['client_event_id'] ?? null;
        $fallbackChannel = $item['fallback_channel'] ?? 'app';

        if (!is_string($clientEventId) || !preg_match(self::UUID_PATTERN, $clientEventId)) {
            throw new ApiError(400, 'VALIDATION_ERROR', 'client_event_id must be a UUID.');
        }
        // §5 tanod_sos.latitude/longitude are NOT NULL — an SOS without a
        // position is still worth recording, but the schema forbids it, so
        // this is a hard requirement rather than a silent null.
        if (!is_numeric($latitude) || !is_numeric($longitude)) {
            throw new ApiError(400, 'VALIDATION_ERROR', 'latitude and longitude are required.');
        }
        $lat = (float) $latitude;
        $lng = (float) $longitude;
        if ($lat < -90 || $lat > 90 || $lng < -180 || $lng > 180) {
            throw new ApiError(400, 'VALIDATION_ERROR', 'latitude/longitude are out of range.');
        }
        if (!in_array($fallbackChannel, ['app', 'sms'], true)) {
            throw new ApiError(400, 'VALIDATION_ERROR', "fallback_channel must be 'app' or 'sms'.");
        }

        // §5 UNIQUE(user_id, client_event_id) — a retried SOS (the app
        // retrying through a flaky link, or the same event arriving by both
        // direct POST and /sync/batch) returns the original rather than
        // raising a second alarm.
        $existingStmt = $pdo->prepare(
            'SELECT sos_id, status, received_at FROM tanod_sos
             WHERE user_id = :user_id AND client_event_id = :client_event_id LIMIT 1'
        );
        $existingStmt->execute(['user_id' => $identity['user_id'], 'client_event_id' => $clientEventId]);
        $existing = $existingStmt->fetch(PDO::FETCH_ASSOC);
        if ($existing !== false) {
            return [
                'sos_id' => (int) $existing['sos_id'],
                'status' => $existing['status'],
                'received_at' => $existing['received_at'],
                'wasCreated' => false,
            ];
        }

        $dispatchIdInt = null;
        if ($dispatchId !== null) {
            if (!is_int($dispatchId) && !(is_string($dispatchId) && ctype_digit($dispatchId))) {
                throw new ApiError(400, 'VALIDATION_ERROR', 'dispatch_id must be an integer.');
            }
            $dispatchIdInt = (int) $dispatchId;
            // §6: "Optional dispatch must belong to caller and be active."
            $dispatchStmt = $pdo->prepare(
                "SELECT d.dispatch_id FROM dispatch d
                 JOIN incident i ON i.incident_id = d.incident_id
                 WHERE d.dispatch_id = :dispatch_id AND d.tanod_id = :tanod_id
                   AND i.barangay_id = :barangay_id
                   AND d.status IN ('assigned','en_route','arrived')
                 LIMIT 1"
            );
            $dispatchStmt->execute([
                'dispatch_id' => $dispatchIdInt,
                'tanod_id' => $identity['user_id'],
                'barangay_id' => $identity['barangay_id'],
            ]);
            if ($dispatchStmt->fetch(PDO::FETCH_ASSOC) === false) {
                throw new ApiError(422, 'UNPROCESSABLE_ENTITY', 'dispatch_id does not reference an active dispatch assigned to you.');
            }
        }

        $pdo->beginTransaction();
        try {
            $insertStmt = $pdo->prepare(
                "INSERT INTO tanod_sos
                    (user_id, barangay_id, dispatch_id, latitude, longitude, triggered_at, received_at,
                     status, client_event_id, fallback_channel)
                 VALUES
                    (:user_id, :barangay_id, :dispatch_id, :latitude, :longitude, UTC_TIMESTAMP(), UTC_TIMESTAMP(),
                     'active', :client_event_id, :fallback_channel)"
            );
            $insertStmt->execute([
                'user_id' => $identity['user_id'],
                'barangay_id' => $identity['barangay_id'],
                'dispatch_id' => $dispatchIdInt,
                'latitude' => $lat,
                'longitude' => $lng,
                'client_event_id' => $clientEventId,
                'fallback_channel' => $fallbackChannel,
            ]);
            $sosId = (int) $pdo->lastInsertId();

            // Rule 27's fan-out, in the SAME transaction as the SOS row.
            $notificationResult = NotificationService::create(
                $pdo,
                $identity['barangay_id'],
                NotificationService::TYPE_SOS,
                ['sos_id' => $sosId],
                $identity['user_id'],
                NotificationService::sosRecipients($pdo, $identity['barangay_id'], $identity['user_id'])
            );

            // Rule 17 allow-list: identifiers and status only. Coordinates
            // are deliberately NOT audited — they are a person's location.
            Audit::record($pdo, $identity['barangay_id'], $identity['user_id'], 'tanod_sos_raised', 'tanod_sos', $sosId, [
                'fallback_channel' => $fallbackChannel,
            ]);

            $readBack = $pdo->prepare('SELECT status, received_at FROM tanod_sos WHERE sos_id = :sos_id');
            $readBack->execute(['sos_id' => $sosId]);
            $created = $readBack->fetch(PDO::FETCH_ASSOC);

            $pdo->commit();
        } catch (\Throwable $e) {
            $pdo->rollBack();
            throw $e;
        }

        // §6: "immediately attempts configured FCM/SMS channels" — done
        // OUTSIDE the transaction (external HTTP calls should never hold a
        // DB transaction open) and never allowed to fail the request that
        // already recorded the SOS. See the class doc's third bullet.
        try {
            (new NotificationDispatcher())->dispatchAll($pdo, $notificationResult['notification_id']);
        } catch (\Throwable $e) {
            error_log('[baranguard] SOS notification dispatch failed for sos_id=' . $sosId . ': ' . $e->getMessage());
        }

        return [
            'sos_id' => $sosId,
            'status' => $created['status'],
            'received_at' => $created['received_at'],
            'wasCreated' => true,
        ];
    }

    /**
     * PATCH /tanod-sos/:id/acknowledge — §6: "Admin only, same barangay,
     * active/acknowledged target → {sos_id,status:'acknowledged',
     * acknowledged_at,acknowledged_by}. **Does not resolve.**"
     *
     * That last sentence is the point: §9 W3 keeps the SOS banner visible
     * while status is anything other than `resolved`, so acknowledging
     * tells the room "someone is on it" without clearing the alarm.
     *
     * @param array{user_id:int,barangay_id:int,role:string} $identity
     */
    public static function acknowledge(PDO $pdo, array $identity, string $sosIdParam): void
    {
        self::transition($pdo, $identity, $sosIdParam, 'acknowledged');
    }

    /**
     * PATCH /tanod-sos/:id/resolve — §6: "Admin only, same barangay →
     * {sos_id,status:'resolved',resolved_at,resolved_by}. Cannot resolve an
     * unrelated tenant record."
     *
     * @param array{user_id:int,barangay_id:int,role:string} $identity
     */
    public static function resolve(PDO $pdo, array $identity, string $sosIdParam): void
    {
        self::transition($pdo, $identity, $sosIdParam, 'resolved');
    }

    /** Shared, row-locked state change for acknowledge/resolve. */
    private static function transition(PDO $pdo, array $identity, string $sosIdParam, string $target): void
    {
        AuthMiddleware::requireRole($identity, ['admin']);
        if (!ctype_digit($sosIdParam)) {
            throw new ApiError(404, 'NOT_FOUND', 'SOS record not found.');
        }
        $sosId = (int) $sosIdParam;

        $pdo->beginTransaction();
        try {
            $stmt = $pdo->prepare('SELECT sos_id, barangay_id, status FROM tanod_sos WHERE sos_id = :sos_id FOR UPDATE');
            $stmt->execute(['sos_id' => $sosId]);
            $sos = $stmt->fetch(PDO::FETCH_ASSOC);
            if ($sos === false) {
                throw new ApiError(404, 'NOT_FOUND', 'SOS record not found.');
            }
            AuthMiddleware::requireTenant($identity, (int) $sos['barangay_id']);

            if ($target === 'acknowledged') {
                // §6 allows an active OR already-acknowledged target, which
                // makes a repeat acknowledge idempotent rather than an error
                // — two Admins reacting at once is a good problem.
                if ($sos['status'] === 'resolved') {
                    throw new ApiError(409, 'CONFLICT', 'This SOS is already resolved.');
                }
                $update = $pdo->prepare(
                    "UPDATE tanod_sos
                        SET status = 'acknowledged',
                            acknowledged_by = COALESCE(acknowledged_by, :actor),
                            acknowledged_at = COALESCE(acknowledged_at, UTC_TIMESTAMP())
                      WHERE sos_id = :sos_id"
                );
            } else {
                if ($sos['status'] === 'resolved') {
                    throw new ApiError(409, 'CONFLICT', 'This SOS is already resolved.');
                }
                $update = $pdo->prepare(
                    "UPDATE tanod_sos
                        SET status = 'resolved', resolved_by = :actor, resolved_at = UTC_TIMESTAMP()
                      WHERE sos_id = :sos_id"
                );
            }
            $update->execute(['actor' => $identity['user_id'], 'sos_id' => $sosId]);

            Audit::record($pdo, $identity['barangay_id'], $identity['user_id'], 'tanod_sos_' . $target, 'tanod_sos', $sosId, [
                'from_status' => $sos['status'],
                'to_status' => $target,
            ]);

            $readBack = $pdo->prepare(
                'SELECT status, acknowledged_at, acknowledged_by, resolved_at, resolved_by
                 FROM tanod_sos WHERE sos_id = :sos_id'
            );
            $readBack->execute(['sos_id' => $sosId]);
            $row = $readBack->fetch(PDO::FETCH_ASSOC);

            $pdo->commit();
        } catch (\Throwable $e) {
            $pdo->rollBack();
            throw $e;
        }

        $payload = ['sos_id' => $sosId, 'status' => $row['status']];
        if ($target === 'acknowledged') {
            $payload['acknowledged_at'] = $row['acknowledged_at'];
            $payload['acknowledged_by'] = $row['acknowledged_by'] !== null ? (int) $row['acknowledged_by'] : null;
        } else {
            $payload['resolved_at'] = $row['resolved_at'];
            $payload['resolved_by'] = $row['resolved_by'] !== null ? (int) $row['resolved_by'] : null;
        }
        Http::send(200, $payload);
    }
}
