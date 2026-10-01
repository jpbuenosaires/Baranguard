<?php
declare(strict_types=1);

namespace Baranguard\Services\Scheduling;

use Baranguard\Lib\ApiError;
use Baranguard\Lib\Http;
use PDO;

/**
 * Small shared helpers for the roster / availability / accomplishment
 * controllers (docs/FEATURE_CONTRACT_2026-10.md sections 3, 4 and 8), so
 * the Idempotency-Key replay, device-ownership and Asia/Manila day-bucketing
 * logic exists exactly once. Day bucketing is done in PHP against a fixed
 * +08:00, never CONVERT_TZ() (REFERENCE.md Rule 11).
 */
final class RosterSupport
{
    public const UUID_PATTERN = '/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i';
    public const MANILA_OFFSET = '+08:00';

    /** Web writes carry an `Idempotency-Key` UUID header (Rule 3). */
    public static function requireIdempotencyKey(): string
    {
        $key = Http::header('Idempotency-Key');
        if ($key === null || !preg_match(self::UUID_PATTERN, $key)) {
            throw new ApiError(400, 'VALIDATION_ERROR', 'Idempotency-Key header must be a UUID.');
        }
        return $key;
    }

    /** @return string|null the key when present and well-formed; 400 when present but malformed. */
    public static function optionalIdempotencyKey(): ?string
    {
        $key = Http::header('Idempotency-Key');
        if ($key === null) {
            return null;
        }
        if (!preg_match(self::UUID_PATTERN, $key)) {
            throw new ApiError(400, 'VALIDATION_ERROR', 'Idempotency-Key header must be a UUID.');
        }
        return $key;
    }

    /**
     * The "authenticated" half of the mobile `client_event_id` + device_id
     * idempotency namespace: the device must be one this Tanod registered.
     * Same generic 422 the other tanod write controllers use.
     *
     * @param array{user_id:int,barangay_id:int,role:string} $identity
     */
    public static function assertDeviceOwnership(PDO $pdo, array $identity, string $deviceId): void
    {
        $stmt = $pdo->prepare(
            'SELECT device_id FROM mobile_device WHERE device_id = :device_id AND user_id = :user_id AND is_active = 1 LIMIT 1'
        );
        $stmt->execute(['device_id' => $deviceId, 'user_id' => $identity['user_id']]);
        if ($stmt->fetch(PDO::FETCH_ASSOC) === false) {
            throw new ApiError(422, 'UNPROCESSABLE_ENTITY', 'Device is not registered or not active for this account.');
        }
    }

    /**
     * Returns the stored audit metadata of a prior call with the same
     * Idempotency-Key, or null. Scoped to (barangay, action, entity).
     *
     * @return array<string,mixed>|null
     */
    public static function findAuditReplay(PDO $pdo, int $barangayId, string $action, ?int $entityId, string $key): ?array
    {
        $sql = 'SELECT metadata_json FROM audit_log
                 WHERE barangay_id = :barangay_id AND action = :action AND idempotency_key = :key';
        $params = ['barangay_id' => $barangayId, 'action' => $action, 'key' => $key];
        if ($entityId === null) {
            $sql .= ' AND entity_id IS NULL';
        } else {
            $sql .= ' AND entity_id = :entity_id';
            $params['entity_id'] = $entityId;
        }
        $stmt = $pdo->prepare($sql . ' LIMIT 1');
        $stmt->execute($params);
        $json = $stmt->fetchColumn();
        if ($json === false) {
            return null;
        }
        $decoded = json_decode((string) $json, true);
        return is_array($decoded) ? $decoded : [];
    }

    /** Strict YYYY-MM-DD; returns the same string or throws 400. */
    public static function parseDate(mixed $raw, string $field): string
    {
        if (!is_string($raw)) {
            throw new ApiError(400, 'VALIDATION_ERROR', "{$field} must be a date in YYYY-MM-DD format.");
        }
        $date = \DateTimeImmutable::createFromFormat('!Y-m-d', $raw, new \DateTimeZone('UTC'));
        $errors = \DateTimeImmutable::getLastErrors();
        $hasErrors = $errors !== false && ($errors['warning_count'] > 0 || $errors['error_count'] > 0);
        if ($date === false || $hasErrors || $date->format('Y-m-d') !== $raw) {
            throw new ApiError(400, 'VALIDATION_ERROR', "{$field} must be a date in YYYY-MM-DD format.");
        }
        return $raw;
    }

    /** Today's date in Asia/Manila as YYYY-MM-DD. */
    public static function manilaToday(): string
    {
        return (new \DateTimeImmutable('now', new \DateTimeZone('UTC')))
            ->setTimezone(new \DateTimeZone(self::MANILA_OFFSET))
            ->format('Y-m-d');
    }

    /**
     * UTC bounds [start, end) of one Asia/Manila calendar day.
     *
     * @return array{0:\DateTimeImmutable,1:\DateTimeImmutable}
     */
    public static function manilaDayBoundsUtc(string $manilaDate): array
    {
        $utc = new \DateTimeZone('UTC');
        $start = (new \DateTimeImmutable($manilaDate . ' 00:00:00 ' . self::MANILA_OFFSET))->setTimezone($utc);
        return [$start, $start->modify('+1 day')];
    }

    /** Manila calendar date (YYYY-MM-DD) of a UTC instant. */
    public static function manilaDateOf(\DateTimeImmutable $utcInstant): string
    {
        return $utcInstant->setTimezone(new \DateTimeZone(self::MANILA_OFFSET))->format('Y-m-d');
    }
}
