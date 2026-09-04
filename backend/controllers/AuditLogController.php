<?php
declare(strict_types=1);

namespace Baranguard\Controllers;

use Baranguard\Lib\ApiError;
use Baranguard\Lib\Http;
use Baranguard\Middleware\AuthMiddleware;
use PDO;

/**
 * GET /audit-log — §6: "Admin own barangay → {items:[{audit_id,
 * actor_user_id,action,entity_type,entity_id,metadata_json,created_at}],
 * page,limit,total}, paginated newest-first." §9 W17 Audit Log Viewer:
 * "Roles: Admin only · Last 7 days default, paginated, no edit/delete
 * controls."
 *
 * READ-ONLY BY CONSTRUCTION. §5 calls `audit_log` "write-once except
 * controlled retention deletion" and Rule 17 makes the audit trail the
 * thing that survives a dispute — so this controller has exactly one
 * method and there is no route anywhere that edits or deletes an audit
 * row. The single legitimate deletion path is
 * `RetentionService::purgeAuditLog()` (Sprint 7's retention cut), which
 * is a CLI job with an age filter and no other conditional logic,
 * precisely so it cannot be used to make specific rows disappear.
 *
 * Resolved decisions (logged in DEVLOG.md):
 *
 *   - **"Last 7 days default" is a DEFAULT, not a cap.** §9 W17 names it
 *     as the default view; an Admin investigating something older can
 *     pass `date_from`/`date_to` (same Asia/Manila calendar-day contract
 *     as `GET /reports/summary`, reused rather than invented). Capping
 *     the window would make the viewer useless for the exact
 *     investigation an audit log exists for.
 *
 *   - **`metadata_json` is returned as parsed JSON, not a string.** §6
 *     lists it in the item shape; handing the client a JSON string to
 *     re-parse would be a worse contract, and every writer in this
 *     codebase goes through `Audit::record()`, which always writes valid
 *     JSON.
 *
 *   - **No tenant escape hatch.** Every row is filtered on
 *     `barangay_id = caller's`, exactly like every other list endpoint
 *     here. Rows written by system jobs carry a NULL `barangay_id` (see
 *     `RetentionService`'s own note on why retention rows have no
 *     invented actor or tenant) and are therefore NOT visible to a
 *     barangay Admin — a deliberate consequence, not an oversight: those
 *     rows describe workstation-wide maintenance, not that barangay's
 *     operations, and `NULL = 1` is false in SQL rather than a leak.
 *
 *   - **`actor_username` is joined in.** §6 fixes the item shape and
 *     `actor_user_id` is in it, but a screen showing "user 7 did X"
 *     forces a second lookup the API can do once. Same precedent as
 *     `officer_name` on `GET /incidents`. The raw id is still returned.
 */
final class AuditLogController
{
    private const DEFAULT_LIMIT = 25;
    private const MAX_LIMIT = 100;
    private const DEFAULT_WINDOW_DAYS = 7; // §9 W17's documented default view

    /** @param array{user_id:int,barangay_id:int,role:string} $identity */
    public static function index(PDO $pdo, array $identity): void
    {
        AuthMiddleware::requireRole($identity, ['admin']);

        $page = max(1, (int) (Http::query('page') ?? '1'));
        $limit = min(self::MAX_LIMIT, max(1, (int) (Http::query('limit') ?? (string) self::DEFAULT_LIMIT)));
        $offset = ($page - 1) * $limit;

        $where = ['a.barangay_id = :barangay_id'];
        $params = ['barangay_id' => $identity['barangay_id']];

        // Optional exact-match action filter. Not validated against a
        // fixed list on purpose: `action` is VARCHAR(128) and new
        // auditable actions are added as features land, so an allow-list
        // here would silently hide rows the moment it drifted from
        // reality. An unknown value simply matches nothing.
        $action = Http::query('action');
        if ($action !== null && $action !== '') {
            $where[] = 'a.action = :action';
            $params['action'] = $action;
        }

        $manila = new \DateTimeZone('Asia/Manila');
        $utc = new \DateTimeZone('UTC');
        $dateFromRaw = Http::query('date_from');
        $dateToRaw = Http::query('date_to');

        $today = new \DateTimeImmutable('now', $manila);
        $to = $dateToRaw !== null && $dateToRaw !== '' ? self::parseDate($dateToRaw, $manila, 'date_to') : $today;
        $from = $dateFromRaw !== null && $dateFromRaw !== ''
            ? self::parseDate($dateFromRaw, $manila, 'date_from')
            : $to->modify('-' . (self::DEFAULT_WINDOW_DAYS - 1) . ' days');

        if ($from > $to) {
            throw new ApiError(400, 'VALIDATION_ERROR', 'date_from must not be after date_to.');
        }

        $where[] = 'a.created_at >= :range_start AND a.created_at < :range_end';
        $params['range_start'] = $from->setTime(0, 0, 0)->setTimezone($utc)->format('Y-m-d H:i:s');
        $params['range_end'] = $to->setTime(0, 0, 0)->modify('+1 day')->setTimezone($utc)->format('Y-m-d H:i:s');

        $whereSql = implode(' AND ', $where);

        $countStmt = $pdo->prepare("SELECT COUNT(*) FROM audit_log a WHERE {$whereSql}");
        $countStmt->execute($params);
        $total = (int) $countStmt->fetchColumn();

        $stmt = $pdo->prepare(
            "SELECT a.audit_id, a.actor_user_id, a.action, a.entity_type, a.entity_id,
                    a.metadata_json, a.created_at, u.username AS actor_username
             FROM audit_log a
             LEFT JOIN user u ON u.user_id = a.actor_user_id
             WHERE {$whereSql}
             ORDER BY a.created_at DESC, a.audit_id DESC
             LIMIT :limit OFFSET :offset"
        );
        foreach ($params as $key => $value) {
            $stmt->bindValue(':' . $key, $value);
        }
        $stmt->bindValue(':limit', $limit, PDO::PARAM_INT);
        $stmt->bindValue(':offset', $offset, PDO::PARAM_INT);
        $stmt->execute();

        $items = array_map(static function (array $row): array {
            return [
                'audit_id' => (int) $row['audit_id'],
                'actor_user_id' => $row['actor_user_id'] !== null ? (int) $row['actor_user_id'] : null,
                'actor_username' => $row['actor_username'],
                'action' => $row['action'],
                'entity_type' => $row['entity_type'],
                'entity_id' => $row['entity_id'] !== null ? (int) $row['entity_id'] : null,
                'metadata_json' => $row['metadata_json'] !== null
                    ? json_decode((string) $row['metadata_json'], true)
                    : null,
                'created_at' => $row['created_at'],
            ];
        }, $stmt->fetchAll(PDO::FETCH_ASSOC));

        Http::send(200, ['items' => $items, 'page' => $page, 'limit' => $limit, 'total' => $total]);
    }

    private static function parseDate(string $raw, \DateTimeZone $tz, string $field): \DateTimeImmutable
    {
        $date = \DateTimeImmutable::createFromFormat('!Y-m-d', $raw, $tz);
        $errors = \DateTimeImmutable::getLastErrors();
        $hasErrors = $errors !== false && ($errors['warning_count'] > 0 || $errors['error_count'] > 0);
        if ($date === false || $hasErrors) {
            throw new ApiError(400, 'VALIDATION_ERROR', "{$field} must be in YYYY-MM-DD format.");
        }
        return $date;
    }
}
