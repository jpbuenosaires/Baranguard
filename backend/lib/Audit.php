<?php
declare(strict_types=1);

namespace Baranguard\Lib;

use PDO;

/**
 * Shared audit_log writer (§2 Rule 17: "Administrative actions are
 * auditable ... device changes, configuration changes ...").
 *
 * Extracted 2026-09-02, when the mobile device/map-package endpoints
 * would have become the THIRD and FOURTH copy of the same private
 * `audit()` method (AuthController and CitizenReportsController each grew
 * their own). Deliberately additive: those two existing controllers are
 * NOT rewritten to use this — they are already built and tested, and this
 * project's rules say not to restructure completed work just for
 * tidiness. New controllers use this; if those two are ever touched for
 * another reason, they can migrate then.
 *
 * §2 Rule 17 also fixes what may go in `$metadata`: "Audit metadata is
 * allow-listed and contains identifiers/statuses only, never raw
 * narrative or credentials." Callers are responsible for honoring that —
 * this helper deliberately does not try to sanitize, because a filter
 * here would create false confidence that anything passed in is safe.
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
