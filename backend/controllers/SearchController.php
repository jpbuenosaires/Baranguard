<?php
declare(strict_types=1);

namespace Baranguard\Controllers;

use Baranguard\Lib\ApiError;
use Baranguard\Lib\Http;
use Baranguard\Middleware\AuthMiddleware;
use PDO;

/**
 * GET /search?q= — Master Reference §6 "Reference / lookup" section, added
 * this session (2026-09-02 architecture review) as the real backing
 * endpoint for the web dashboard topbar's search box, which previously
 * rendered but called nothing (§8's production-realism rule forbids a
 * decorative input that does nothing when used).
 *
 * Deliberately narrow scope: incidents only, not Tanods/locations — there's
 * no incident/user detail screen (W7/W10) built yet to deep-link a Tanod
 * match into, and reusing GET /incidents' own exact authorization instead
 * of inventing a new information-disclosure surface keeps this safe by
 * construction. Same tenant + Tanod-own-only scoping as
 * IncidentsController::index(), same field allow-list (no raw_narrative,
 * regardless of role) — this is a read-only overlay on data the caller
 * could already see via GET /incidents, not new visibility.
 */
final class SearchController
{
    private const MIN_QUERY_LENGTH = 2;
    private const MAX_QUERY_LENGTH = 64;
    private const MAX_RESULTS = 10;
    private const INCIDENT_STATUSES = ['pending', 'dispatched', 'resolved'];
    private const INCIDENT_TYPES = [
        'theft', 'physical_injury', 'disturbance', 'domestic_dispute',
        'vandalism', 'traffic_incident', 'fire', 'medical_emergency',
        'missing_person', 'animal_complaint', 'other',
    ];

    /** @param array{user_id:int,barangay_id:int,role:string} $identity */
    public static function index(PDO $pdo, array $identity): void
    {
        AuthMiddleware::requireRole($identity, ['admin', 'secretary', 'tanod', 'punong_barangay']);

        $q = trim((string) (Http::query('q') ?? ''));
        $length = strlen($q);
        if ($length < self::MIN_QUERY_LENGTH || $length > self::MAX_QUERY_LENGTH) {
            throw new ApiError(400, 'VALIDATION_ERROR', 'q must be ' . self::MIN_QUERY_LENGTH . '-' . self::MAX_QUERY_LENGTH . ' characters.');
        }

        $where = ['barangay_id = :barangay_id'];
        $params = ['barangay_id' => $identity['barangay_id']];

        // Same server-enforced restriction as GET /incidents — never a
        // client-supplied filter the caller could widen.
        if ($identity['role'] === 'tanod') {
            $where[] = 'reported_by = :reported_by';
            $params['reported_by'] = $identity['user_id'];
        }

        $matchClauses = ['CAST(incident_id AS CHAR) LIKE :q_id'];
        $params['q_id'] = '%' . $q . '%';

        $qLower = strtolower($q);
        $matchedTypes = array_values(array_filter(self::INCIDENT_TYPES, static fn ($t) => str_contains($t, $qLower) || str_contains(str_replace('_', ' ', $t), $qLower)));
        $matchedStatuses = array_values(array_filter(self::INCIDENT_STATUSES, static fn ($s) => str_contains($s, $qLower)));

        if ($matchedTypes !== []) {
            $placeholders = [];
            foreach ($matchedTypes as $i => $type) {
                $key = "type_{$i}";
                $placeholders[] = ":{$key}";
                $params[$key] = $type;
            }
            $matchClauses[] = 'incident_type IN (' . implode(',', $placeholders) . ')';
        }
        if ($matchedStatuses !== []) {
            $placeholders = [];
            foreach ($matchedStatuses as $i => $status) {
                $key = "status_{$i}";
                $placeholders[] = ":{$key}";
                $params[$key] = $status;
            }
            $matchClauses[] = 'status IN (' . implode(',', $placeholders) . ')';
        }

        $where[] = '(' . implode(' OR ', $matchClauses) . ')';
        $whereSql = implode(' AND ', $where);

        $stmt = $pdo->prepare(
            "SELECT incident_id, incident_type, status, priority, created_at
             FROM incident
             WHERE {$whereSql}
             ORDER BY created_at DESC
             LIMIT " . self::MAX_RESULTS
        );
        foreach ($params as $key => $value) {
            $stmt->bindValue(':' . $key, $value);
        }
        $stmt->execute();
        $rows = $stmt->fetchAll(PDO::FETCH_ASSOC);

        $items = array_map(static function (array $row): array {
            return [
                'incident_id' => (int) $row['incident_id'],
                'incident_type' => $row['incident_type'],
                'status' => $row['status'],
                'priority' => $row['priority'],
                'created_at' => $row['created_at'],
            ];
        }, $rows);

        Http::send(200, ['items' => $items]);
    }
}
