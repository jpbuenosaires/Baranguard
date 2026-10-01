<?php
declare(strict_types=1);

namespace Baranguard\Controllers;

use Baranguard\Lib\ApiError;
use Baranguard\Lib\Audit;
use Baranguard\Lib\Http;
use Baranguard\Middleware\AuthMiddleware;
use PDO;

/**
 * Safer School Zones registry (docs/FEATURE_CONTRACT_2026-10.md section 7,
 * migration 0033, DILG Annex B).
 *
 *   GET   /schools        every role incl. tanod (own barangay, `?active=`)
 *   POST  /schools        admin + secretary, Idempotency-Key
 *   PATCH /schools/:id    admin + secretary, Idempotency-Key
 *
 * There is deliberately NO DELETE: a school an incident or check-in refers
 * to must stay resolvable, so the only way to retire one is
 * `is_active = false`. The registry carries NO student data of any kind; the
 * focal person is school staff and only a name + contact number is kept.
 *
 * Idempotency (Rule 3): `POST` stores the Idempotency-Key in
 * `school.client_request_id`, so a retry returns the original row (200).
 * `PATCH` has no natural unique column, so it replays off
 * `audit_log.idempotency_key` (migration 0019), the same shape
 * `IncidentsController::update()` uses.
 *
 * Audit metadata is ids + changed field NAMES only (Rule 8): never the
 * school name, address or focal-person details.
 *
 * `GET /schools` is not paginated by default the way other lists are
 * (default limit 100, max 100): a barangay has a handful of schools and the
 * Tanod app caches the whole list for its offline picker.
 */
final class SchoolsController
{
    public const SCHOOL_TYPES = ['public', 'private'];
    public const LEVELS = [
        'preschool_daycare_eccd', 'primary_elementary', 'secondary_high_school',
        'integrated', 'higher_education_tertiary', 'all_through', 'tvet', 'sned',
    ];
    private const DEFAULT_LIMIT = 100;
    private const MAX_LIMIT = 100;

    private const COLUMNS = 'school_id, barangay_id, name, school_type, level, address, focal_person, focal_contact,
                              remarks, latitude, longitude, is_active, created_at, updated_at';

    /** @param array{user_id:int,barangay_id:int,role:string} $identity */
    public static function index(PDO $pdo, array $identity): void
    {
        AuthMiddleware::requireRole($identity, ['admin', 'secretary', 'punong_barangay', 'tanod']);

        $where = ['barangay_id = :barangay_id'];
        $params = ['barangay_id' => $identity['barangay_id']];

        $active = Http::query('active');
        if ($active !== null) {
            $flag = self::parseBool($active);
            if ($flag === null) {
                throw new ApiError(400, 'VALIDATION_ERROR', 'active must be true/false (or 1/0).');
            }
            $where[] = 'is_active = :is_active';
            $params['is_active'] = $flag ? 1 : 0;
        }
        $whereSql = implode(' AND ', $where);

        $page = max(1, (int) (Http::query('page') ?? '1'));
        $limit = (int) (Http::query('limit') ?? (string) self::DEFAULT_LIMIT);
        if ($limit < 1) {
            $limit = self::DEFAULT_LIMIT;
        }
        $limit = min($limit, self::MAX_LIMIT);
        $offset = ($page - 1) * $limit;

        $countStmt = $pdo->prepare("SELECT COUNT(*) FROM school WHERE {$whereSql}");
        $countStmt->execute($params);
        $total = (int) $countStmt->fetchColumn();

        $stmt = $pdo->prepare(
            'SELECT ' . self::COLUMNS . " FROM school WHERE {$whereSql} ORDER BY name ASC, school_id ASC LIMIT :limit OFFSET :offset"
        );
        foreach ($params as $key => $value) {
            $stmt->bindValue(':' . $key, $value);
        }
        $stmt->bindValue(':limit', $limit, PDO::PARAM_INT);
        $stmt->bindValue(':offset', $offset, PDO::PARAM_INT);
        $stmt->execute();

        Http::send(200, [
            'items' => array_map([self::class, 'mapSchool'], $stmt->fetchAll(PDO::FETCH_ASSOC)),
            'page' => $page,
            'limit' => $limit,
            'total' => $total,
        ]);
    }

    /** @param array{user_id:int,barangay_id:int,role:string} $identity */
    public static function create(PDO $pdo, array $identity): void
    {
        AuthMiddleware::requireRole($identity, ['admin', 'secretary']);
        $key = self::requireIdempotencyKey();
        $body = Http::jsonBody();

        $fields = self::validateFields($body, true);

        $find = $pdo->prepare('SELECT ' . self::COLUMNS . ' FROM school WHERE client_request_id = :k AND barangay_id = :b LIMIT 1');
        $find->execute(['k' => $key, 'b' => $identity['barangay_id']]);
        $existing = $find->fetch(PDO::FETCH_ASSOC);
        if ($existing !== false) {
            Http::send(200, self::mapSchool($existing));
        }

        try {
            $pdo->prepare(
                'INSERT INTO school
                    (barangay_id, name, school_type, level, address, focal_person, focal_contact, remarks,
                     latitude, longitude, is_active, created_by, client_request_id, created_at, updated_at)
                 VALUES
                    (:barangay_id, :name, :school_type, :level, :address, :focal_person, :focal_contact, :remarks,
                     :latitude, :longitude, :is_active, :created_by, :k, UTC_TIMESTAMP(), UTC_TIMESTAMP())'
            )->execute([
                'barangay_id' => $identity['barangay_id'],
                'name' => $fields['name'],
                'school_type' => $fields['school_type'],
                'level' => $fields['level'],
                'address' => $fields['address'],
                'focal_person' => $fields['focal_person'] ?? null,
                'focal_contact' => $fields['focal_contact'] ?? null,
                'remarks' => $fields['remarks'] ?? null,
                'latitude' => $fields['latitude'] ?? null,
                'longitude' => $fields['longitude'] ?? null,
                'is_active' => ($fields['is_active'] ?? true) ? 1 : 0,
                'created_by' => $identity['user_id'],
                'k' => $key,
            ]);
        } catch (\PDOException $e) {
            if ($e->getCode() === '23000') {
                // Same key from a concurrent retry (or another tenant's
                // collision on the global UNIQUE) -- return the original if
                // it is ours, else a plain conflict.
                $find->execute(['k' => $key, 'b' => $identity['barangay_id']]);
                $row = $find->fetch(PDO::FETCH_ASSOC);
                if ($row !== false) {
                    Http::send(200, self::mapSchool($row));
                }
                throw new ApiError(409, 'CONFLICT', 'This Idempotency-Key was already used.');
            }
            throw $e;
        }
        $schoolId = (int) $pdo->lastInsertId();

        Audit::record($pdo, $identity['barangay_id'], $identity['user_id'], 'school_created', 'school', $schoolId, [
            'school_id' => $schoolId,
        ]);

        Http::send(201, self::mapSchool(self::fetchRow($pdo, $schoolId)));
    }

    /** @param array{user_id:int,barangay_id:int,role:string} $identity */
    public static function update(PDO $pdo, array $identity, string $schoolIdParam): void
    {
        AuthMiddleware::requireRole($identity, ['admin', 'secretary']);
        $key = self::requireIdempotencyKey();
        if (!ctype_digit($schoolIdParam)) {
            throw new ApiError(404, 'NOT_FOUND', 'School not found.');
        }
        $schoolId = (int) $schoolIdParam;
        $body = Http::jsonBody();

        $row = self::fetchRow($pdo, $schoolId);
        if ($row === null) {
            throw new ApiError(404, 'NOT_FOUND', 'School not found.');
        }
        AuthMiddleware::requireTenant($identity, (int) $row['barangay_id']);

        // Replay: the same key already applied to this school.
        $replay = $pdo->prepare(
            "SELECT 1 FROM audit_log
             WHERE barangay_id = :b AND action = 'school_updated' AND entity_id = :e AND idempotency_key = :k LIMIT 1"
        );
        $replay->execute(['b' => $identity['barangay_id'], 'e' => $schoolId, 'k' => $key]);
        if ($replay->fetchColumn() !== false) {
            Http::send(200, self::mapSchool($row));
        }

        $fields = self::validateFields($body, false);
        if ($fields === []) {
            throw new ApiError(400, 'VALIDATION_ERROR', 'No editable fields were supplied.');
        }
        $sets = [];
        $params = ['id' => $schoolId];
        foreach ($fields as $column => $value) {
            $sets[] = "{$column} = :{$column}";
            $params[$column] = is_bool($value) ? ($value ? 1 : 0) : $value;
        }
        $sets[] = 'updated_at = UTC_TIMESTAMP()';
        $pdo->prepare('UPDATE school SET ' . implode(', ', $sets) . ' WHERE school_id = :id')->execute($params);

        Audit::record($pdo, $identity['barangay_id'], $identity['user_id'], 'school_updated', 'school', $schoolId, [
            'school_id' => $schoolId,
            'fields' => array_keys($fields),
            'idempotency_key' => $key,
        ]);

        Http::send(200, self::mapSchool(self::fetchRow($pdo, $schoolId)));
    }

    /**
     * Used by IncidentsController: true when the school exists in this
     * barangay. Deliberately returns the same answer for "no such school"
     * and "another barangay's school" so a caller cannot probe existence.
     */
    public static function belongsToBarangay(PDO $pdo, int $schoolId, int $barangayId): bool
    {
        $stmt = $pdo->prepare('SELECT 1 FROM school WHERE school_id = :s AND barangay_id = :b LIMIT 1');
        $stmt->execute(['s' => $schoolId, 'b' => $barangayId]);
        return $stmt->fetchColumn() !== false;
    }

    /**
     * Validates body fields. $creating = all required fields must be present.
     * On update only the supplied keys are returned (values already
     * normalised); `is_active` comes back as a bool.
     *
     * @param array<string,mixed> $body
     * @return array<string,mixed>
     */
    private static function validateFields(array $body, bool $creating): array
    {
        $out = [];

        $requireString = static function (string $key, int $max, bool $required) use ($body, $creating, &$out): void {
            if (!array_key_exists($key, $body)) {
                if ($creating && $required) {
                    throw new ApiError(400, 'VALIDATION_ERROR', "{$key} is required.");
                }
                return;
            }
            $value = $body[$key];
            if ($value === null) {
                if ($required) {
                    throw new ApiError(400, 'VALIDATION_ERROR', "{$key} cannot be empty.");
                }
                $out[$key] = null;
                return;
            }
            if (!is_string($value)) {
                throw new ApiError(400, 'VALIDATION_ERROR', "{$key} must be a string.");
            }
            $value = trim($value);
            if ($value === '') {
                if ($required) {
                    throw new ApiError(400, 'VALIDATION_ERROR', "{$key} cannot be empty.");
                }
                $out[$key] = null;
                return;
            }
            if (mb_strlen($value) > $max) {
                throw new ApiError(400, 'VALIDATION_ERROR', "{$key} must be at most {$max} characters.");
            }
            $out[$key] = $value;
        };

        $requireString('name', 160, true);
        $requireString('address', 255, true);
        $requireString('focal_person', 120, false);
        $requireString('focal_contact', 32, false);
        $requireString('remarks', 500, false);

        foreach (['school_type' => self::SCHOOL_TYPES, 'level' => self::LEVELS] as $key => $allowed) {
            if (!array_key_exists($key, $body)) {
                if ($creating) {
                    throw new ApiError(400, 'VALIDATION_ERROR', "{$key} is required.");
                }
                continue;
            }
            if (!is_string($body[$key]) || !in_array($body[$key], $allowed, true)) {
                throw new ApiError(400, 'VALIDATION_ERROR', "{$key} must be one of: " . implode(', ', $allowed) . '.');
            }
            $out[$key] = $body[$key];
        }

        $hasLat = array_key_exists('latitude', $body);
        $hasLng = array_key_exists('longitude', $body);
        if ($hasLat || $hasLng) {
            $lat = $body['latitude'] ?? null;
            $lng = $body['longitude'] ?? null;
            if ($lat === null && $lng === null) {
                $out['latitude'] = null;
                $out['longitude'] = null;
            } else {
                if (!is_numeric($lat) || !is_numeric($lng)) {
                    throw new ApiError(400, 'VALIDATION_ERROR', 'latitude and longitude must both be numbers (or both null).');
                }
                $latF = (float) $lat;
                $lngF = (float) $lng;
                if ($latF < -90 || $latF > 90 || $lngF < -180 || $lngF > 180) {
                    throw new ApiError(400, 'VALIDATION_ERROR', 'latitude/longitude are out of range.');
                }
                $out['latitude'] = $latF;
                $out['longitude'] = $lngF;
            }
        }

        if (array_key_exists('is_active', $body)) {
            $flag = is_bool($body['is_active']) ? $body['is_active'] : self::parseBool($body['is_active']);
            if ($flag === null) {
                throw new ApiError(400, 'VALIDATION_ERROR', 'is_active must be a boolean.');
            }
            $out['is_active'] = $flag;
        }

        return $out;
    }

    private static function parseBool(mixed $value): ?bool
    {
        if (is_int($value) || is_string($value)) {
            $v = strtolower((string) $value);
            if ($v === '1' || $v === 'true') {
                return true;
            }
            if ($v === '0' || $v === 'false') {
                return false;
            }
        }
        return null;
    }

    private static function requireIdempotencyKey(): string
    {
        $key = Http::header('Idempotency-Key');
        if ($key === null || !preg_match(IncidentsController::UUID_PATTERN, $key)) {
            throw new ApiError(400, 'VALIDATION_ERROR', 'Idempotency-Key header must be a UUID.');
        }
        return $key;
    }

    /** @return array<string,mixed>|null */
    private static function fetchRow(PDO $pdo, int $schoolId): ?array
    {
        $stmt = $pdo->prepare('SELECT ' . self::COLUMNS . ' FROM school WHERE school_id = :id');
        $stmt->execute(['id' => $schoolId]);
        $row = $stmt->fetch(PDO::FETCH_ASSOC);
        return $row === false ? null : $row;
    }

    /** @param array<string,mixed> $row @return array<string,mixed> */
    private static function mapSchool(array $row): array
    {
        return [
            'school_id' => (int) $row['school_id'],
            'barangay_id' => (int) $row['barangay_id'],
            'name' => $row['name'],
            'school_type' => $row['school_type'],
            'level' => $row['level'],
            'address' => $row['address'],
            'focal_person' => $row['focal_person'],
            'focal_contact' => $row['focal_contact'],
            'remarks' => $row['remarks'],
            'latitude' => $row['latitude'] !== null ? (float) $row['latitude'] : null,
            'longitude' => $row['longitude'] !== null ? (float) $row['longitude'] : null,
            'is_active' => (bool) $row['is_active'],
            'created_at' => $row['created_at'],
            'updated_at' => $row['updated_at'],
        ];
    }
}
