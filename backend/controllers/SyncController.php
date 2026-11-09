<?php
declare(strict_types=1);

namespace Baranguard\Controllers;

use Baranguard\Lib\ApiError;
use Baranguard\Lib\Http;
use Baranguard\Middleware\AuthMiddleware;
use PDO;

/**
 * POST /sync/batch — Tanod only. Returns
 * {results:[{client_event_id,server_id,status,reason?}]}.
 *
 * Body {device_id, incidents[], gps_tracks[], duty_status_updates[],
 * dispatch_status_updates[], sos[], referrals[], availability[],
 * accomplishment_entries[], school_checkins[]}. Device ownership must match
 * the authenticated Tanod. Every item has client_event_id; dispatch status
 * updates use the same event-key/idempotency rules as other mobile writes.
 * The server mirror stores only reconciliation metadata.
 *
 *   - Per-item body shape is exactly the body each item's own single-item
 *     endpoint documents: incidents[] = POST /incidents (mobile) body,
 *     gps_tracks[] = POST /gps body, duty_status_updates[] = POST
 *     /duty-status body, dispatch_status_updates[] =
 *     {dispatch_id,status,client_event_id} (a subset of PATCH
 *     /dispatch/:id/status's body, with no override_reason, since a sync item
 *     is always the owning Tanod moving their own dispatch).
 *
 *   - Ordering: the arrays are processed in a fixed order (see the loop
 *     below; SOS first), and within each array in the order the client
 *     supplied, which is the order it naturally appended while queuing
 *     offline.
 *
 *   - The `offline_queue` table is the idempotency ledger for THIS endpoint,
 *     keyed on (device_id, client_event_id), independent of whatever dedup
 *     column the underlying business table has. This matters most for
 *     `dispatch_status_updates`: `dispatch` has NO client_event_id column, so
 *     without this ledger a retried sync of the same status-change event
 *     would attempt the same transition twice and hit a real 409.
 *     `incidents`/`gps_tracks`/`duty_status_updates` have their own UNIQUE
 *     keys, so the ledger check there is a harmless fast-path that also
 *     reports 'duplicate' for a retried sync call itself.
 *     `sync_metadata_json` holds only `{"server_id": ...}` — reconciliation
 *     metadata, never the original payload.
 *
 *   - `sos[]` reuses `TanodSosController::createItem()`, so a queued offline
 *     SOS lands identically to a live one — same idempotency key, same
 *     fan-out — and an SOS that also arrived by SMS fallback correlates
 *     rather than alarming twice.
 */
final class SyncController
{
    /** Max items (all arrays combined) accepted in one batch. */
    private const MAX_ITEMS_PER_BATCH = 200;

    private const UUID_PATTERN = '/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i';

    /** @param array{user_id:int,barangay_id:int,role:string} $identity */
    public static function batch(PDO $pdo, array $identity): void
    {
        AuthMiddleware::requireRole($identity, ['tanod']);

        $body = Http::jsonBody();
        $deviceId = $body['device_id'] ?? null;
        if (!is_string($deviceId) || $deviceId === '') {
            throw new ApiError(400, 'VALIDATION_ERROR', 'device_id is required.');
        }

        // Device ownership must match the authenticated Tanod.
        $deviceStmt = $pdo->prepare(
            'SELECT device_id FROM mobile_device WHERE device_id = :device_id AND user_id = :user_id AND is_active = 1 LIMIT 1'
        );
        $deviceStmt->execute(['device_id' => $deviceId, 'user_id' => $identity['user_id']]);
        if ($deviceStmt->fetch(PDO::FETCH_ASSOC) === false) {
            // Distinct code (status unchanged) so the app can tell this
            // whole-batch refusal apart from an ordinary validation 422 and
            // show "this phone belongs to another account" instead of
            // silently retrying forever.
            throw new ApiError(422, 'DEVICE_NOT_REGISTERED', 'Device is not registered or not active for this account.');
        }

        $groups = [
            'incident' => self::asItemArray($body['incidents'] ?? null),
            'gps' => self::asItemArray($body['gps_tracks'] ?? null),
            'duty_status' => self::asItemArray($body['duty_status_updates'] ?? null),
            'dispatch_status' => self::asItemArray($body['dispatch_status_updates'] ?? null),
            'sos' => self::asItemArray($body['sos'] ?? null),
            // Item shape = each feature's own single-item endpoint body.
            'referral' => self::asItemArray($body['referrals'] ?? null),
            'availability' => self::asItemArray($body['availability'] ?? null),
            'accomplishment_entry' => self::asItemArray($body['accomplishment_entries'] ?? null),
            'school_checkin' => self::asItemArray($body['school_checkins'] ?? null),
        ];
        $total = 0;
        foreach ($groups as $items) {
            $total += count($items);
        }
        if ($total > self::MAX_ITEMS_PER_BATCH) {
            throw new ApiError(413, 'PAYLOAD_TOO_LARGE', 'A sync batch may contain at most ' . self::MAX_ITEMS_PER_BATCH . ' items.');
        }

        // SOS first: an emergency must never wait behind (or be lost
        // to a failure in) routine items. Remaining order is unchanged.
        // A referral may point at an incident created earlier in this
        // same batch (by incident_client_event_id), so incidents precede
        // referrals.
        $order = ['sos', 'incident', 'referral', 'gps', 'duty_status', 'dispatch_status', 'availability', 'accomplishment_entry', 'school_checkin'];
        $startedNs = hrtime(true);
        $results = [];
        $tally = [];
        foreach ($order as $payloadType) {
            foreach ($groups[$payloadType] as $item) {
                $result = self::processItem($pdo, $identity, $deviceId, $payloadType, $item);
                $results[] = $result;
                $status = (string) ($result['status'] ?? 'unknown');
                $tally[$payloadType][$status] = ($tally[$payloadType][$status] ?? 0) + 1;
            }
        }

        self::logBatchMetrics($identity, $tally, $total, $startedNs);
        Http::send(200, ['results' => $results]);
    }

    /**
     * Thesis measurement (reliability): one JSON line per non-empty batch in
     * `backend/storage/metrics/sync-YYYYMMDD.jsonl` — counts of success /
     * duplicate / failed per item kind and the server's processing time. Read
     * by `scripts/metrics-report.php`. Deliberately a file, not `audit_log`: a
     * batch is posted every few seconds while a phone has a queue, which
     * would drown the Admin-visible audit trail. Identifiers and counts ONLY
     * (never narratives, coordinates or tokens). Best-effort: any failure
     * here is swallowed, because measuring must never break a sync.
     *
     * @param array{user_id:int,barangay_id:int,role:string} $identity
     * @param array<string,array<string,int>> $tally
     */
    private static function logBatchMetrics(array $identity, array $tally, int $total, int|float $startedNs): void
    {
        if ($total < 1) {
            return;
        }
        try {
            $dir = dirname(__DIR__) . '/storage/metrics';
            if (!is_dir($dir) && !mkdir($dir, 0750, true) && !is_dir($dir)) {
                return;
            }
            $line = json_encode([
                'ts' => gmdate('Y-m-d\TH:i:s\Z'),
                'user_id' => $identity['user_id'],
                'barangay_id' => $identity['barangay_id'],
                'items' => $total,
                'results' => $tally,
                'server_ms' => (int) round((hrtime(true) - $startedNs) / 1_000_000),
            ], JSON_UNESCAPED_SLASHES);
            if ($line !== false) {
                file_put_contents($dir . '/sync-' . gmdate('Ymd') . '.jsonl', $line . "\n", FILE_APPEND | LOCK_EX);
            }
        } catch (\Throwable $e) {
            // Intentionally silent — see the doc comment.
        }
    }

    /** @return array<int,array<string,mixed>> */
    private static function asItemArray(mixed $value): array
    {
        if (!is_array($value)) {
            return [];
        }
        $items = [];
        foreach ($value as $entry) {
            if (is_array($entry)) {
                $items[] = $entry;
            }
        }
        return $items;
    }

    /**
     * @param array<string,mixed> $item
     * @return array{client_event_id:string,server_id:?int,status:string,reason?:string}
     */
    private static function processItem(PDO $pdo, array $identity, string $deviceId, string $payloadType, array $item): array
    {
        $clientEventId = $item['client_event_id'] ?? null;
        if (!is_string($clientEventId) || !preg_match(self::UUID_PATTERN, $clientEventId)) {
            return [
                'client_event_id' => is_string($clientEventId) ? $clientEventId : '',
                'server_id' => null,
                'status' => 'failed',
                'reason' => 'client_event_id must be a UUID.',
            ];
        }

        // `offline_queue` mirror: the ledger exists independent of each
        // business table's own dedup column (see class doc).
        $existingQueueStmt = $pdo->prepare(
            'SELECT queue_id, reconciliation_status, sync_metadata_json FROM offline_queue
             WHERE device_id = :device_id AND client_event_id = :client_event_id LIMIT 1'
        );
        $existingQueueStmt->execute(['device_id' => $deviceId, 'client_event_id' => $clientEventId]);
        $existingQueue = $existingQueueStmt->fetch(PDO::FETCH_ASSOC);

        if ($existingQueue !== false && $existingQueue['reconciliation_status'] === 'success') {
            $metadata = json_decode((string) $existingQueue['sync_metadata_json'], true);
            $serverId = is_array($metadata) && isset($metadata['server_id']) ? (int) $metadata['server_id'] : null;
            return ['client_event_id' => $clientEventId, 'server_id' => $serverId, 'status' => 'duplicate']
                + self::displayIdField($pdo, $payloadType, $serverId);
        }

        if ($existingQueue === false) {
            $insertQueueStmt = $pdo->prepare(
                "INSERT INTO offline_queue (device_id, client_event_id, payload_type, sync_metadata_json, created_offline_at, received_at, reconciliation_status)
                 VALUES (:device_id, :client_event_id, :payload_type, '{}', UTC_TIMESTAMP(), UTC_TIMESTAMP(), 'pending')"
            );
            $insertQueueStmt->execute(['device_id' => $deviceId, 'client_event_id' => $clientEventId, 'payload_type' => $payloadType]);
            $queueId = (int) $pdo->lastInsertId();
        } else {
            $queueId = (int) $existingQueue['queue_id'];
        }

        try {
            [$serverId, $wasCreated] = self::applyItem($pdo, $identity, $deviceId, $payloadType, $item);

            $updateStmt = $pdo->prepare(
                "UPDATE offline_queue SET reconciliation_status = 'success', synced_at = UTC_TIMESTAMP(), sync_metadata_json = :metadata
                 WHERE queue_id = :queue_id"
            );
            $updateStmt->execute(['metadata' => json_encode(['server_id' => $serverId]), 'queue_id' => $queueId]);

            return [
                'client_event_id' => $clientEventId,
                'server_id' => $serverId,
                'status' => $wasCreated ? 'success' : 'duplicate',
            ] + self::displayIdField($pdo, $payloadType, $serverId);
        } catch (\Throwable $e) {
            if ($pdo->inTransaction()) {
                $pdo->rollBack();
            }

            // SQLSTATE 23000 (unique-key) means a concurrent/earlier write
            // already stored this event: report it as a duplicate of the
            // original row instead of a failure. ONLY when that original row
            // is actually found: 23000 also covers FK violations and other
            // integrity errors, which are real failures and must never be
            // reported as a (phantom) duplicate that the client would then
            // drop from its queue.
            $serverId = null;
            if ($e instanceof \PDOException && (string) $e->getCode() === '23000') {
                $serverId = self::findExistingServerId($pdo, $identity, $deviceId, $payloadType, $clientEventId);
            }
            if ($serverId !== null) {
                try {
                    $pdo->prepare(
                        "UPDATE offline_queue SET reconciliation_status = 'success', synced_at = UTC_TIMESTAMP(), sync_metadata_json = :metadata
                         WHERE queue_id = :queue_id"
                    )->execute(['metadata' => json_encode(['server_id' => $serverId]), 'queue_id' => $queueId]);
                } catch (\Throwable $ignored) {
                }
                return ['client_event_id' => $clientEventId, 'server_id' => $serverId, 'status' => 'duplicate'];
            }

            // ApiError messages are client-safe validation text; anything
            // else is logged by class/code only (never message/payload,
            // which could carry narrative or PII) and masked.
            if ($e instanceof ApiError) {
                $reason = $e->getMessage();
            } elseif ($e instanceof \PDOException && (string) $e->getCode() === '23000') {
                $reason = 'Item could not be stored (data integrity check failed).';
                error_log('sync/batch item failed: type=' . $payloadType . ' class=' . get_class($e) . ' code=23000');
            } else {
                $reason = 'Internal error processing item.';
                error_log('sync/batch item failed: type=' . $payloadType . ' class=' . get_class($e) . ' code=' . (string) $e->getCode());
            }
            try {
                $pdo->prepare(
                    "UPDATE offline_queue SET reconciliation_status = 'failed', failure_reason = :reason WHERE queue_id = :queue_id"
                )->execute(['reason' => substr($reason, 0, 255), 'queue_id' => $queueId]);
            } catch (\Throwable $ignored) {
            }

            return [
                'client_event_id' => $clientEventId,
                'server_id' => null,
                'status' => 'failed',
                'reason' => $reason,
            ];
        }
    }

    /**
     * `display_id` for an incident item's sync result, so the phone can show the official INC-YYYY-NNN right after sync
     * instead of the numeric row id. Other payload types (sos, gps, referral ...) carry no display code: returns [].
     *
     * @return array<string,string>
     */
    private static function displayIdField(PDO $pdo, string $payloadType, ?int $serverId): array
    {
        if ($payloadType !== 'incident' || $serverId === null) {
            return [];
        }
        $stmt = $pdo->prepare('SELECT display_id FROM incident WHERE incident_id = :id');
        $stmt->execute(['id' => $serverId]);
        $code = $stmt->fetchColumn();
        return is_string($code) && $code !== '' ? ['display_id' => $code] : [];
    }

    /** Looks up the original row's id for a unique-key duplicate; null if unknown. */
    private static function findExistingServerId(PDO $pdo, array $identity, string $deviceId, string $payloadType, string $clientEventId): ?int
    {
        try {
            switch ($payloadType) {
                case 'incident':
                    $stmt = $pdo->prepare('SELECT incident_id FROM incident WHERE device_id = :d AND client_event_id = :c LIMIT 1');
                    $stmt->execute(['d' => $deviceId, 'c' => $clientEventId]);
                    break;
                case 'gps':
                    $stmt = $pdo->prepare('SELECT track_id FROM gps_track WHERE user_id = :u AND client_event_id = :c LIMIT 1');
                    $stmt->execute(['u' => $identity['user_id'], 'c' => $clientEventId]);
                    break;
                case 'sos':
                    $stmt = $pdo->prepare('SELECT sos_id FROM tanod_sos WHERE user_id = :u AND client_event_id = :c LIMIT 1');
                    $stmt->execute(['u' => $identity['user_id'], 'c' => $clientEventId]);
                    break;
                case 'referral':
                    $stmt = $pdo->prepare('SELECT referral_id FROM incident_referral WHERE created_by = :u AND client_event_id = :c LIMIT 1');
                    $stmt->execute(['u' => $identity['user_id'], 'c' => $clientEventId]);
                    break;
                case 'availability':
                    $stmt = $pdo->prepare('SELECT avail_id FROM tanod_availability WHERE user_id = :u AND client_event_id = :c LIMIT 1');
                    $stmt->execute(['u' => $identity['user_id'], 'c' => $clientEventId]);
                    break;
                case 'accomplishment_entry':
                    $stmt = $pdo->prepare('SELECT entry_id FROM accomplishment_entry WHERE user_id = :u AND client_event_id = :c LIMIT 1');
                    $stmt->execute(['u' => $identity['user_id'], 'c' => $clientEventId]);
                    break;
                case 'school_checkin':
                    $stmt = $pdo->prepare('SELECT checkin_id FROM school_checkin WHERE user_id = :u AND client_event_id = :c LIMIT 1');
                    $stmt->execute(['u' => $identity['user_id'], 'c' => $clientEventId]);
                    break;
                case 'duty_status':
                    $stmt = $pdo->prepare('SELECT status_id FROM duty_status WHERE user_id = :u AND client_event_id = :c LIMIT 1');
                    $stmt->execute(['u' => $identity['user_id'], 'c' => $clientEventId]);
                    break;
                default:
                    return null;
            }
            $id = $stmt->fetchColumn();
            return $id === false ? null : (int) $id;
        } catch (\Throwable $e) {
            return null;
        }
    }

    /**
     * @param array<string,mixed> $item
     * @return array{0:?int,1:bool} [server_id, wasCreated]
     */
    private static function applyItem(PDO $pdo, array $identity, string $deviceId, string $payloadType, array $item): array
    {
        switch ($payloadType) {
            case 'incident':
                $result = IncidentsController::createMobileItem($pdo, $identity, $deviceId, $item);
                return [(int) $result['incident']['incident_id'], $result['wasCreated']];

            case 'gps':
                $result = GpsController::createItem($pdo, $identity, $item);
                return [$result['track_id'], $result['wasCreated']];

            case 'duty_status':
                $status = $item['status'] ?? null;
                $clientEventId = $item['client_event_id'] ?? null;
                if (!is_string($status)) {
                    throw new ApiError(400, 'VALIDATION_ERROR', 'status is required.');
                }
                // Optional `changed_at`: the device time of an off-duty
                // toggled while offline (DutyStatusController class doc).
                $result = DutyStatusController::applyToggle($pdo, $identity, $status, $clientEventId, 'app', $item['changed_at'] ?? $item['created_offline_at'] ?? null);
                return [$result['status_id'], $result['wasCreated']];

            case 'dispatch_status':
                $dispatchId = $item['dispatch_id'] ?? null;
                $status = $item['status'] ?? null;
                if (!is_int($dispatchId) && !(is_string($dispatchId) && ctype_digit($dispatchId))) {
                    throw new ApiError(400, 'VALIDATION_ERROR', 'dispatch_id is required.');
                }
                // No override_reason from a sync item — see class doc: a
                // queued offline status change is always the owning Tanod
                // moving their own dispatch, never an Admin override.
                $result = DispatchController::applyStatusTransition($pdo, $identity, (int) $dispatchId, $status, null, $item['created_offline_at'] ?? null);
                return [$result['dispatch_id'], true];

            case 'sos':
                // An SOS raised while offline reaches the server through
                // exactly the same path as a live one, including the same
                // (user_id, client_event_id) idempotency key, so an SOS that
                // was ALSO delivered by SMS fallback correlates instead of
                // raising a second alarm.
                $result = TanodSosController::createItem($pdo, $identity, $item);
                return [$result['sos_id'], $result['wasCreated']];

            // The four feature controllers below each expose
            // `createItem(PDO, identity, deviceId, item): array{id:int,wasCreated:bool}`.
            case 'referral':
                $result = ReferralsController::createItem($pdo, $identity, $deviceId, $item);
                return [$result['id'], $result['wasCreated']];

            case 'availability':
                $result = AvailabilityController::createItem($pdo, $identity, $deviceId, $item);
                return [$result['id'], $result['wasCreated']];

            case 'accomplishment_entry':
                $result = AccomplishmentController::createEntryItem($pdo, $identity, $deviceId, $item);
                return [$result['id'], $result['wasCreated']];

            case 'school_checkin':
                $result = SchoolCheckinsController::createItem($pdo, $identity, $deviceId, $item);
                return [$result['id'], $result['wasCreated']];

            default:
                throw new ApiError(400, 'VALIDATION_ERROR', 'Unknown sync payload type.');
        }
    }
}
