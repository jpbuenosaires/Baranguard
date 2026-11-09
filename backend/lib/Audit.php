<?php
declare(strict_types=1);

namespace Baranguard\Lib;

use PDO;

/**
 * Shared audit_log writer for administrative actions.
 *
 * `$metadata` is allow-listed: identifiers/statuses only, never raw
 * narrative or credentials. Callers are responsible for honoring that —
 * this helper deliberately does not sanitize, because a filter here would
 * create false confidence that anything passed in is safe.
 */
final class Audit
{
    /**
     * @param array<string,mixed> $metadata identifiers/statuses only —
     *        never raw_narrative, passwords, tokens, or FCM tokens.
     */
    public static function record(
        PDO $pdo,
        ?int $barangayId,
        ?int $actorUserId,
        string $action,
        string $entityType,
        ?int $entityId,
        array $metadata = []
    ): void {
        $stmt = $pdo->prepare(
            'INSERT INTO audit_log (barangay_id, actor_user_id, action, entity_type, entity_id, metadata_json, ip_address, user_agent, created_at)
             VALUES (:barangay_id, :actor_user_id, :action, :entity_type, :entity_id, :metadata_json, :ip, :ua, UTC_TIMESTAMP())'
        );
        $stmt->execute([
            'barangay_id' => $barangayId,
            'actor_user_id' => $actorUserId,
            'action' => $action,
            'entity_type' => $entityType,
            'entity_id' => $entityId,
            'metadata_json' => json_encode($metadata, JSON_UNESCAPED_SLASHES),
            'ip' => $_SERVER['REMOTE_ADDR'] ?? null,
            'ua' => Http::header('User-Agent'),
        ]);
    }
}
