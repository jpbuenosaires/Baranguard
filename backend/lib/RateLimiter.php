<?php
declare(strict_types=1);

namespace Baranguard\Lib;

use PDO;

/**
 * Shared abuse-budget / rate-limit counter — code-review findings H-11
 * (no abuse budget on AI jobs, evidence uploads, GPS ingestion, exports,
 * map packages, SMS broadcast) and H-13 (public transparency endpoint has
 * no rate limit), 2026-09-24 external audit.
 *
 * Fixed-window counter backed by `rate_limit_counter` (migration 0023).
 * Callers pick their own `$key` (should encode both quota TYPE and SCOPE,
 * e.g. `'ai_job:user:42'`, `'transparency:ip:203.0.113.5'`) and their own
 * window/threshold — this class has no per-feature policy, it is pure
 * mechanism. `check()` increments unconditionally (a request already over
 * budget still counts, same as every other window-counter in this
 * codebase, e.g. AuthController's lockout) and returns whether the NEW
 * count is within budget; callers throw their own `ApiError(429, ...)`
 * with a feature-specific message rather than this class doing it, so the
 * error text can name the actual limit being hit.
 */
final class RateLimiter
{
    public static function check(PDO $pdo, string $key, int $windowSeconds, int $maxPerWindow): bool
    {
        $windowStart = gmdate('Y-m-d H:i:s', intdiv(time(), $windowSeconds) * $windowSeconds);

        $pdo->prepare(
            'INSERT INTO rate_limit_counter (limiter_key, window_start, request_count)
             VALUES (:key, :window_start, 1)
             ON DUPLICATE KEY UPDATE request_count = request_count + 1'
        )->execute(['key' => $key, 'window_start' => $windowStart]);

        $countStmt = $pdo->prepare(
            'SELECT request_count FROM rate_limit_counter WHERE limiter_key = :key AND window_start = :window_start'
        );
        $countStmt->execute(['key' => $key, 'window_start' => $windowStart]);
        $count = (int) $countStmt->fetchColumn();

        // Opportunistic cleanup, no scheduler dependency — see migration
        // 0023's own doc comment for why this table isn't retention-managed
        // like a real business dataset.
        if (random_int(1, 200) === 1) {
            $pdo->prepare('DELETE FROM rate_limit_counter WHERE window_start < (UTC_TIMESTAMP() - INTERVAL 2 DAY)')->execute();
        }

        return $count <= $maxPerWindow;
    }
}
