<?php
declare(strict_types=1);

namespace Baranguard\Controllers;

use Baranguard\Lib\ApiError;
use Baranguard\Lib\Http;
use Baranguard\Middleware\AuthMiddleware;
use PDO;

/**
 * POST /sync/batch — Master Reference §6 "Sync" section, §5 sync
 * invariants, §9 M6 (dispatch_status_updates[] reconciliation).
 *
 * §6: "Tanod only -> {results:[{client_event_id,server_id,status,reason?}]}.
 * Body {device_id,incidents[],gps_tracks[],duty_status_updates[],
 * dispatch_status_updates[],sos[]}. Device ownership must match
 * authenticated Tanod. Every item has client_event_id; dispatch status
 * updates use the same event-key/idempotency rules as other mobile writes;
 * server processes oldest-first per device, locks/deduplicates by event
 * key ... Server mirror stores only reconciliation metadata."
 *
 * Resolved decisions not fully pinned down by that prose (logged in
 * DEVLOG.md — this endpoint was Sprint 3's own "idempotent sync" box):
 *
 *   - **Per-item body shape.** §6 never spells out each array's item
 *     shape beyond "every item has client_event_id." Resolved as exactly
 *     the same body each item's own single-item endpoint already
 *     documents: incidents[] = POST /incidents (mobile) body,
 *     gps_tracks[] = POST /gps body, duty_status_updates[] = POST
 *     /duty-status body, dispatch_status_updates[] =
 *     {dispatch_id,status,client_event_id} (a subset of PATCH
 *     /dispatch/:id/status's body — no override_reason, since a sync item
 *     is always the owning Tanod moving their own dispatch, never an
 *     Admin override).
 *
 *   - **"Oldest-first per device."** With no shared timestamp field across
 *     five differently-shaped item types, and no license to invent one not
 *     in §6's documented per-endpoint bodies, this is interpreted as: the
 *     five arrays are processed in the fixed order §6's own body lists
 *     them (incidents, gps_tracks, duty_status_updates,
 *     dispatch_status_updates, sos), and within each array, in the order
 *     the client supplied — i.e. each array is itself already
 *     "oldest-first" because that's the order a client naturally appends
 *     to it while queuing offline.
 *
 *   - **The `offline_queue` table is the idempotency ledger for THIS
 *     endpoint specifically**, keyed on (device_id, client_event_id),
 *     independent of whatever dedup column the underlying business table
 *     may or may not have. This matters most for `dispatch_status_updates`
 *     — `dispatch` has NO client_event_id column at all, so without this
 *     ledger a retried sync of the same status-change event would attempt
 *     the same transition twice and hit a real 409 on the second attempt.
 *     `incidents`/`gps_tracks`/`duty_status_updates` DO have their own
 *     business-table UNIQUE(device_id-or-user_id, client_event_id), so
 *     they are self-deduping too — the ledger check here is then a
 *     harmless fast-path that also correctly reports 'duplicate' for a
 *     retried sync call itself, not just a cross-transport duplicate.
 *     `sync_metadata_json` holds only `{"server_id": ...}` — reconciliation
 *     metadata, never the original payload (§5: "Server mirror never
 *     stores original raw payload").
 *
 *   - **`sos[]` works as of Sprint 4.** It reuses
 *     `TanodSosController::createItem()`, so a queued offline SOS lands
 *     identically to a live one — same idempotency key, same Rule 27
 *     fan-out — and an SOS that also arrived by SMS fallback correlates
 *     rather than alarming twice.
 */
final class SyncController
{
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

        // §6: "Device ownership must match authenticated Tanod."
        $deviceStmt = $pdo->prepare(
            'SELECT device_id FROM mobile_device WHERE device_id = :device_id AND user_id = :user_id AND is_active = 1 LIMIT 1'
        );
        $deviceStmt->execute(['device_id' => $deviceId, 'user_id' => $identity['user_id']]);
        if ($deviceStmt->fetch(PDO::FETCH_ASSOC) === false) {
            throw new ApiError(422, 'UNPROCESSABLE_ENTITY', 'Device is not registered or not active for this account.');
        }

        $results = [];
        foreach (self::asItemArray($body['incidents'] ?? null) as $item) {
            $results[] = self::processItem($pdo, $identity, $deviceId, 'incident', $item);
        }
        foreach (self::asItemArray($body['gps_tracks'] ?? null) as $item) {
            $results[] = self::processItem($pdo, $identity, $deviceId, 'gps', $item);
        }
        foreach (self::asItemArray($body['duty_status_updates'] ?? null) as $item) {
            $results[] = self::processItem($pdo, $identity, $deviceId, 'duty_status', $item);
        }
        foreach (self::asItemArray($body['dispatch_status_updates'] ?? null) as $item) {
            $results[] = self::processItem($pdo, $identity, $deviceId, 'dispatch_status', $item);
        }
        foreach (self::asItemArray($body['sos'] ?? null) as $item) {
            $results[] = self::processItem($pdo, $identity, $deviceId, 'sos', $item);
        }

        Http::send(200, ['results' => $results]);
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

        // §5 offline_queue mirror — see class doc for why this ledger
        // exists independent of each business table's own dedup column.
        $existingQueueStmt = $pdo->prepare(
            'SELECT queue_id, reconciliation_status, sync_metadata_json FROM offline_queue
             WHERE device_id = :device_id AND client_event_id = :client_event_id LIMIT 1'
        );
        $existingQueueStmt->execute(['device_id' => $deviceId, 'client_event_id' => $clientEventId]);
        $existingQueue = $existingQueueStmt->fetch(PDO::FETCH_ASSOC);

        if ($existingQueue !== false && $existingQueue['reconciliation_status'] === 'success') {
            $metadata = json_decode((string) $existingQueue['sync_metadata_json'], true);
            $serverId = is_array($metadata) && isset($metadata['server_id']) ? (int) $metadata['server_id'] : null;
            return ['client_event_id' => $clientEventId, 'server_id' => $serverId, 'status' => 'duplicate'];
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
            ];
        } catch (ApiError $e) {
            $failStmt = $pdo->prepare(
                "UPDATE offline_queue SET reconciliation_status = 'failed', failure_reason = :reason WHERE queue_id = :queue_id"
            );
            $failStmt->execute(['reason' => substr($e->getMessage(), 0, 255), 'queue_id' => $queueId]);

            return [
                'client_event_id' => $clientEventId,
                'server_id' => null,
                'status' => 'failed',
                'reason' => $e->getMessage(),
            ];
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
                $result = DutyStatusController::applyToggle($pdo, $identity, $status, $clientEventId);
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
                $result = DispatchController::applyStatusTransition($pdo, $identity, (int) $dispatchId, $status, null);
                return [$result['dispatch_id'], true];

            case 'sos':
                // Sprint 4: an SOS raised while offline reaches the server
                // through exactly the same path as a live one, including
                // the same (user_id, client_event_id) idempotency key — so
                // an SOS that was ALSO delivered by SMS fallback correlates
                // instead of raising a second alarm (§2 Rule 27).
                $result = TanodSosController::createItem($pdo, $identity, $item);
                return [$result['sos_id'], $result['wasCreated']];

            default:
                throw new ApiError(400, 'VALIDATION_ERROR', 'Unknown sync payload type.');
        }
    }
}
