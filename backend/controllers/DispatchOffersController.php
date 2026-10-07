<?php
declare(strict_types=1);

namespace Baranguard\Controllers;

use Baranguard\Lib\ApiError;
use Baranguard\Lib\Audit;
use Baranguard\Lib\DeviceSignature;
use Baranguard\Lib\Http;
use Baranguard\Middleware\AuthMiddleware;
use Baranguard\Services\Dispatch\OfferService;
use Baranguard\Services\Scheduling\RosterSupport;
use PDO;

/**
 * Dispatch offers (Wave 2 review decision, migration 0038). The model, the
 * night window, the 180 s timeout and the escalation rules are documented on
 * `OfferService`; this class is the HTTP surface.
 *
 *   GET   /dispatch-offers              tanod: own still-acceptable offers;
 *                                       admin|secretary|punong_barangay:
 *                                       the barangay's offers (+ counts)
 *   POST  /dispatch-offers              admin|secretary, Idempotency-Key:
 *                                       open a round-1 offer by hand
 *   POST  /dispatch-offers/:id/accept   tanod, X-Device-Id device session,
 *                                       body {request_id}: first accept wins
 *   PATCH /dispatch-offers/:id/cancel   admin, Idempotency-Key
 *
 * Resolved decisions (logged for DOC NOTES):
 *   - ACCEPT IS ONLINE-ONLY. It is not a /sync/batch kind and never enters
 *     the offline queue: whether you won can only be known by the server.
 *   - The dispatch an accept creates uses `DispatchController::
 *     createWithinTransaction` (the SAME path as POST /dispatch — every
 *     double-booking/eligibility check stays) minus the published-shift
 *     check (recipients were already filtered by it). Its `dispatched_by` is
 *     the offer's creator when a person opened it, else the barangay's first
 *     (lowest user_id) active Admin; only if the barangay has no Admin at all
 *     does it fall back to the accepting Tanod (the column is NOT NULL).
 *   - Replay of an accept is keyed on `request_id`, stored as the new
 *     dispatch's `created_client_request_id` (UNIQUE), like POST /dispatch.
 *   - Timestamps in this API are ISO-8601 UTC (`...Z`) so a phone can run a
 *     countdown to `expires_at` without guessing a timezone.
 *
 * Cross-tenant and non-recipient are 404, never 403 (Rule 2). Audit metadata
 * is identifiers, rounds, statuses and counts only (Rule 8).
 */
final class DispatchOffersController
{
    private const DEFAULT_LIMIT = 25;
    private const MAX_LIMIT = 100;

    // ------------------------------------------------------------------ list

    /** @param array{user_id:int,barangay_id:int,role:string} $identity */
    public static function index(PDO $pdo, array $identity): void
    {
        AuthMiddleware::requireRole($identity, ['admin', 'secretary', 'punong_barangay', 'tanod']);

        $page = max(1, (int) (Http::query('page') ?? '1'));
        $limit = (int) (Http::query('limit') ?? (string) self::DEFAULT_LIMIT);
        $limit = $limit < 1 ? self::DEFAULT_LIMIT : min($limit, self::MAX_LIMIT);
        $offset = ($page - 1) * $limit;

        if ($identity['role'] === 'tanod') {
            // Only what this Tanod can still ACCEPT: the offer is open, they
            // are still `offered`, and the round has not timed out. Once
            // someone wins (or the round lapses) it simply disappears.
            $now = self::iso(OfferService::now());
            $nowDb = OfferService::now()->format('Y-m-d H:i:s');
            $stmt = $pdo->prepare(
                "SELECT o.offer_id, o.incident_id, o.status, o.created_at, o.expires_at,
                        i.incident_type, i.priority, b.name AS barangay_name
                   FROM dispatch_offer o
                   JOIN dispatch_offer_recipient r ON r.offer_id = o.offer_id AND r.user_id = :user_id
                   JOIN incident i ON i.incident_id = o.incident_id
                   JOIN barangay b ON b.barangay_id = o.barangay_id
                  WHERE o.barangay_id = :barangay_id
                    AND o.status = 'open' AND r.status = 'offered' AND o.expires_at > :now
                  ORDER BY o.created_at DESC, o.offer_id DESC
                  LIMIT 50"
            );
            $stmt->execute([
                'user_id' => $identity['user_id'],
                'barangay_id' => $identity['barangay_id'],
                'now' => $nowDb,
            ]);
            $items = array_map(static fn (array $row): array => [
                'offer_id' => (int) $row['offer_id'],
                'incident_id' => (int) $row['incident_id'],
                'incident_type' => $row['incident_type'],
                'priority' => $row['priority'],
                'barangay_name' => $row['barangay_name'],
                'created_at' => self::isoFromDb((string) $row['created_at']),
                'expires_at' => self::isoFromDb((string) $row['expires_at']),
                'status' => $row['status'],
            ], $stmt->fetchAll(PDO::FETCH_ASSOC));
            unset($now);

            Http::send(200, ['items' => $items, 'page' => 1, 'limit' => count($items), 'total' => count($items)]);
        }

        $where = ['o.barangay_id = :barangay_id'];
        $params = ['barangay_id' => $identity['barangay_id']];
        $incidentParam = Http::query('incident_id');
        if ($incidentParam !== null) {
            if (!ctype_digit($incidentParam)) {
                throw new ApiError(400, 'VALIDATION_ERROR', 'incident_id must be numeric.');
            }
            $where[] = 'o.incident_id = :incident_id';
            $params['incident_id'] = (int) $incidentParam;
        }
        $whereSql = implode(' AND ', $where);

        $countStmt = $pdo->prepare("SELECT COUNT(*) FROM dispatch_offer o WHERE {$whereSql}");
        $countStmt->execute($params);
        $total = (int) $countStmt->fetchColumn();

        $stmt = $pdo->prepare(
            "SELECT o.offer_id, o.incident_id, o.status, o.`round`, o.created_at, o.expires_at, o.closed_at,
                    o.accepted_by, o.accepted_dispatch_id, o.created_by,
                    i.incident_type, i.priority, b.name AS barangay_name,
                    u.full_name AS accepted_by_name,
                    (SELECT COUNT(*) FROM dispatch_offer_recipient r WHERE r.offer_id = o.offer_id) AS recipient_count,
                    (SELECT COUNT(*) FROM dispatch_offer_recipient r WHERE r.offer_id = o.offer_id AND r.status = 'offered') AS offered_count,
                    (SELECT COUNT(*) FROM dispatch_offer_recipient r WHERE r.offer_id = o.offer_id AND r.status = 'accepted') AS accepted_count,
                    (SELECT COUNT(*) FROM dispatch_offer_recipient r WHERE r.offer_id = o.offer_id AND r.status = 'released') AS released_count,
                    (SELECT COUNT(*) FROM dispatch_offer_recipient r WHERE r.offer_id = o.offer_id AND r.status = 'expired') AS expired_count
               FROM dispatch_offer o
               JOIN incident i ON i.incident_id = o.incident_id
               JOIN barangay b ON b.barangay_id = o.barangay_id
               LEFT JOIN user u ON u.user_id = o.accepted_by
              WHERE {$whereSql}
              ORDER BY o.created_at DESC, o.offer_id DESC
              LIMIT :limit OFFSET :offset"
        );
        foreach ($params as $key => $value) {
            $stmt->bindValue(':' . $key, $value);
        }
        $stmt->bindValue(':limit', $limit, PDO::PARAM_INT);
        $stmt->bindValue(':offset', $offset, PDO::PARAM_INT);
        $stmt->execute();

        $items = array_map(static fn (array $row): array => [
            'offer_id' => (int) $row['offer_id'],
            'incident_id' => (int) $row['incident_id'],
            'incident_type' => $row['incident_type'],
            'priority' => $row['priority'],
            'barangay_name' => $row['barangay_name'],
            'status' => $row['status'],
            'round' => (int) $row['round'],
            'created_at' => self::isoFromDb((string) $row['created_at']),
            'expires_at' => self::isoFromDb((string) $row['expires_at']),
            'closed_at' => $row['closed_at'] !== null ? self::isoFromDb((string) $row['closed_at']) : null,
            'created_by' => $row['created_by'] !== null ? (int) $row['created_by'] : null,
            'recipient_count' => (int) $row['recipient_count'],
            'recipient_counts' => [
                'offered' => (int) $row['offered_count'],
                'accepted' => (int) $row['accepted_count'],
                'released' => (int) $row['released_count'],
                'expired' => (int) $row['expired_count'],
            ],
            'accepted_by' => $row['accepted_by'] !== null ? (int) $row['accepted_by'] : null,
            'accepted_by_name' => $row['accepted_by_name'] ?? null,
            'accepted_dispatch_id' => $row['accepted_dispatch_id'] !== null ? (int) $row['accepted_dispatch_id'] : null,
        ], $stmt->fetchAll(PDO::FETCH_ASSOC));

        Http::send(200, ['items' => $items, 'page' => $page, 'limit' => $limit, 'total' => $total]);
    }

    // ------------------------------------------------------------------ open

    /** @param array{user_id:int,barangay_id:int,role:string} $identity */
    public static function open(PDO $pdo, array $identity): void
    {
        AuthMiddleware::requireRole($identity, ['admin', 'secretary']);
        $key = RosterSupport::requireIdempotencyKey();

        $body = Http::jsonBody();
        $raw = $body['incident_id'] ?? null;
        if (!is_int($raw) && !(is_string($raw) && ctype_digit($raw))) {
            throw new ApiError(400, 'VALIDATION_ERROR', 'incident_id is required.');
        }
        $incidentId = (int) $raw;
        if ($incidentId < 1) {
            throw new ApiError(400, 'VALIDATION_ERROR', 'incident_id is required.');
        }

        // Idempotent replay: the same Idempotency-Key returns the original offer.
        $replay = self::findByRequestKey($pdo, (int) $identity['barangay_id'], $key);
        if ($replay !== null) {
            Http::send(200, self::summary($replay));
        }

        // Tenant gate (404 for another barangay's / unknown incident) before
        // anything is written; the service re-checks under its own lock.
        $incStmt = $pdo->prepare('SELECT barangay_id FROM incident WHERE incident_id = :id');
        $incStmt->execute(['id' => $incidentId]);
        $incBarangay = $incStmt->fetchColumn();
        if ($incBarangay === false) {
            throw new ApiError(404, 'NOT_FOUND', 'Incident not found.');
        }
        AuthMiddleware::requireTenant($identity, (int) $incBarangay);

        try {
            $result = OfferService::openForIncident($pdo, $incidentId, (int) $identity['barangay_id'], (int) $identity['user_id'], $key, false);
        } catch (\PDOException $e) {
            // Two concurrent calls with one key: the unique index let one in.
            if (str_contains($e->getMessage(), 'uq_dispatch_offer_request_key')) {
                $replay = self::findByRequestKey($pdo, (int) $identity['barangay_id'], $key);
                if ($replay !== null) {
                    Http::send(200, self::summary($replay));
                }
            }
            if (str_contains($e->getMessage(), 'uq_dispatch_offer_active_incident')) {
                throw new ApiError(409, 'CONFLICT', 'This incident already has a live dispatch offer.');
            }
            throw $e;
        }

        $created = self::findByRequestKey($pdo, (int) $identity['barangay_id'], $key);
        Http::send(201, $created !== null ? self::summary($created) : $result);
    }

    // ---------------------------------------------------------------- accept

    /**
     * First accept wins. The whole decision happens in one transaction that
     * locks the incident row and then the offer row (OfferService's lock
     * order), so two Tanods tapping Accept at the same instant are
     * serialized: the second finds the offer `accepted` and gets 409
     * OFFER_CLOSED. (Reasoned from SELECT ... FOR UPDATE; not demonstrated
     * under real concurrency — the test server is single-threaded.)
     *
     * @param array{user_id:int,barangay_id:int,role:string} $identity
     */
    public static function accept(PDO $pdo, array $identity, string $offerIdParam): void
    {
        AuthMiddleware::requireRole($identity, ['tanod']);
        if (!ctype_digit($offerIdParam)) {
            throw new ApiError(404, 'NOT_FOUND', 'Offer not found.');
        }
        $offerId = (int) $offerIdParam;

        $body = Http::jsonBody();
        $requestId = $body['request_id'] ?? null;
        if (!is_string($requestId) || !preg_match(RosterSupport::UUID_PATTERN, $requestId)) {
            throw new ApiError(400, 'VALIDATION_ERROR', 'request_id must be a UUID.');
        }

        // Device session, exactly as the other Tanod write endpoints.
        $deviceId = Http::header('X-Device-Id');
        if ($deviceId === null || $deviceId === '') {
            throw new ApiError(400, 'VALIDATION_ERROR', 'X-Device-Id header is required.');
        }
        RosterSupport::assertDeviceOwnership($pdo, $identity, $deviceId);
        DeviceSignature::verifyOrReject($pdo, $deviceId, $identity['user_id']);

        // Idempotent replay: this exact accept already succeeded.
        $replayStmt = $pdo->prepare(
            'SELECT d.dispatch_id, d.incident_id
               FROM dispatch d
               JOIN dispatch_offer o ON o.accepted_dispatch_id = d.dispatch_id
              WHERE d.created_client_request_id = :request_id AND d.tanod_id = :user_id
                AND o.offer_id = :offer_id AND o.barangay_id = :barangay_id
              LIMIT 1'
        );
        $replayStmt->execute([
            'request_id' => $requestId,
            'user_id' => $identity['user_id'],
            'offer_id' => $offerId,
            'barangay_id' => $identity['barangay_id'],
        ]);
        $replay = $replayStmt->fetch(PDO::FETCH_ASSOC);
        if ($replay !== false) {
            Http::send(200, [
                'dispatch_id' => (int) $replay['dispatch_id'],
                'status' => 'assigned',
                'incident_id' => (int) $replay['incident_id'],
            ]);
        }

        $notificationId = null;
        $pdo->beginTransaction();
        try {
            $offer = OfferService::lockOffer($pdo, $offerId);
            if ($offer === null) {
                throw new ApiError(404, 'NOT_FOUND', 'Offer not found.');
            }
            AuthMiddleware::requireTenant($identity, (int) $offer['barangay_id']);

            $recipientStmt = $pdo->prepare(
                'SELECT status FROM dispatch_offer_recipient WHERE offer_id = :offer_id AND user_id = :user_id FOR UPDATE'
            );
            $recipientStmt->execute(['offer_id' => $offerId, 'user_id' => $identity['user_id']]);
            $recipientStatus = $recipientStmt->fetchColumn();
            if ($recipientStatus === false) {
                // Never offered this call: it does not exist for them.
                throw new ApiError(404, 'NOT_FOUND', 'Offer not found.');
            }

            if ($offer['status'] !== 'open') {
                throw new ApiError(409, 'OFFER_CLOSED', 'This offer is no longer open.');
            }
            if ((string) $offer['expires_at'] <= OfferService::now()->format('Y-m-d H:i:s')) {
                throw new ApiError(409, 'OFFER_CLOSED', 'This offer has expired.');
            }
            if ($recipientStatus !== 'offered') {
                throw new ApiError(409, 'OFFER_CLOSED', 'This offer is no longer open to you.');
            }

            $incidentId = (int) $offer['incident_id'];
            $dispatchedBy = self::resolveDispatchedBy($pdo, $offer, (int) $identity['user_id']);

            try {
                $created = DispatchController::createWithinTransaction(
                    $pdo,
                    $identity,
                    $dispatchedBy,
                    $incidentId,
                    (int) $identity['user_id'],
                    $requestId,
                    false,
                    null,
                    ['via_offer' => true, 'offer_id' => $offerId, 'offer_round' => (int) $offer['round']]
                );
            } catch (\PDOException $e) {
                if (str_contains($e->getMessage(), 'uq_dispatch_client_request')) {
                    throw new ApiError(409, 'CONFLICT', 'request_id has already been used.');
                }
                throw $e;
            }

            $pdo->prepare(
                "UPDATE dispatch_offer
                    SET status = 'accepted', accepted_by = :user_id, accepted_dispatch_id = :dispatch_id, closed_at = UTC_TIMESTAMP()
                  WHERE offer_id = :offer_id"
            )->execute([
                'user_id' => $identity['user_id'],
                'dispatch_id' => $created['dispatch_id'],
                'offer_id' => $offerId,
            ]);
            $pdo->prepare("UPDATE dispatch_offer_recipient SET status = 'accepted' WHERE offer_id = :offer_id AND user_id = :user_id")
                ->execute(['offer_id' => $offerId, 'user_id' => $identity['user_id']]);
            OfferService::releaseRecipients($pdo, $offerId, (int) $identity['user_id']);

            Audit::record($pdo, (int) $identity['barangay_id'], (int) $identity['user_id'], 'dispatch_offer_accepted', 'dispatch_offer', $offerId, [
                'incident_id' => $incidentId,
                'dispatch_id' => $created['dispatch_id'],
                'round' => (int) $offer['round'],
            ]);

            $notificationId = $created['notification_id'];
            $dispatchId = $created['dispatch_id'];
            $pdo->commit();
        } catch (\Throwable $e) {
            if ($pdo->inTransaction()) {
                $pdo->rollBack();
            }
            throw $e;
        }

        // Tell the winner like a normal dispatch (after commit; never fails the accept).
        OfferService::deliver($pdo, [$notificationId]);

        Http::send(200, [
            'dispatch_id' => $dispatchId,
            'status' => 'assigned',
            'incident_id' => $incidentId,
        ]);
    }

    /**
     * `dispatch.dispatched_by` for an accepted offer: the person who opened
     * it, else the barangay's first active Admin, else (no Admin exists)
     * the accepting Tanod themself.
     *
     * @param array<string,mixed> $offer
     */
    private static function resolveDispatchedBy(PDO $pdo, array $offer, int $tanodUserId): int
    {
        if ($offer['created_by'] !== null) {
            return (int) $offer['created_by'];
        }
        $admins = OfferService::adminIds($pdo, (int) $offer['barangay_id']);
        return $admins !== [] ? $admins[0] : $tanodUserId;
    }

    // ---------------------------------------------------------------- cancel

    /** @param array{user_id:int,barangay_id:int,role:string} $identity */
    public static function cancel(PDO $pdo, array $identity, string $offerIdParam): void
    {
        AuthMiddleware::requireRole($identity, ['admin']);
        RosterSupport::requireIdempotencyKey();
        if (!ctype_digit($offerIdParam)) {
            throw new ApiError(404, 'NOT_FOUND', 'Offer not found.');
        }
        $offerId = (int) $offerIdParam;

        $pdo->beginTransaction();
        try {
            $offer = OfferService::lockOffer($pdo, $offerId);
            if ($offer === null) {
                throw new ApiError(404, 'NOT_FOUND', 'Offer not found.');
            }
            AuthMiddleware::requireTenant($identity, (int) $offer['barangay_id']);

            if ($offer['status'] === 'cancelled') {
                // Idempotent: a retry of a cancel that already landed.
                $pdo->commit();
                Http::send(200, ['offer_id' => $offerId, 'status' => 'cancelled', 'incident_id' => (int) $offer['incident_id']]);
            }
            if (!in_array($offer['status'], ['open', 'escalated'], true)) {
                throw new ApiError(409, 'CONFLICT', 'Only an open or escalated offer can be cancelled.');
            }

            $pdo->prepare("UPDATE dispatch_offer SET status = 'cancelled', closed_at = UTC_TIMESTAMP() WHERE offer_id = :id")
                ->execute(['id' => $offerId]);
            OfferService::releaseRecipients($pdo, $offerId);

            Audit::record($pdo, (int) $identity['barangay_id'], (int) $identity['user_id'], 'dispatch_offer_cancelled', 'dispatch_offer', $offerId, [
                'incident_id' => (int) $offer['incident_id'],
                'round' => (int) $offer['round'],
                'from_status' => $offer['status'],
            ]);

            $pdo->commit();
        } catch (\Throwable $e) {
            if ($pdo->inTransaction()) {
                $pdo->rollBack();
            }
            throw $e;
        }

        Http::send(200, ['offer_id' => $offerId, 'status' => 'cancelled', 'incident_id' => (int) $offer['incident_id']]);
    }

    // --------------------------------------------------------------- helpers

    /** @return array<string,mixed>|null */
    private static function findByRequestKey(PDO $pdo, int $barangayId, string $key): ?array
    {
        $stmt = $pdo->prepare(
            'SELECT o.offer_id, o.incident_id, o.status, o.`round`, o.expires_at,
                    (SELECT COUNT(*) FROM dispatch_offer_recipient r WHERE r.offer_id = o.offer_id) AS recipient_count
               FROM dispatch_offer o
              WHERE o.barangay_id = :barangay_id AND o.request_key = :key
              LIMIT 1'
        );
        $stmt->execute(['barangay_id' => $barangayId, 'key' => $key]);
        $row = $stmt->fetch(PDO::FETCH_ASSOC);
        return $row === false ? null : $row;
    }

    /**
     * @param array<string,mixed> $row
     * @return array<string,mixed>
     */
    private static function summary(array $row): array
    {
        return [
            'offer_id' => (int) $row['offer_id'],
            'incident_id' => (int) $row['incident_id'],
            'round' => (int) $row['round'],
            'status' => $row['status'],
            'recipient_count' => (int) $row['recipient_count'],
            'expires_at' => self::isoFromDb((string) $row['expires_at']),
        ];
    }

    private static function iso(\DateTimeImmutable $instant): string
    {
        return $instant->setTimezone(new \DateTimeZone('UTC'))->format('Y-m-d\TH:i:s\Z');
    }

    /** A naive-UTC DB datetime string as ISO-8601 with Z. */
    private static function isoFromDb(string $dbValue): string
    {
        return (new \DateTimeImmutable($dbValue, new \DateTimeZone('UTC')))->format('Y-m-d\TH:i:s\Z');
    }
}
