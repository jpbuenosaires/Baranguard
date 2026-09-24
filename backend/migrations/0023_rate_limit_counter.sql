-- 0023: rate_limit_counter — shared abuse-budget/rate-limit store.
--
-- Code-review findings H-11 (no abuse budget on AI jobs, evidence uploads,
-- GPS ingestion, exports, map packages, SMS broadcast) and H-13 (public
-- transparency endpoint has no rate limit), 2026-09-24 external audit.
--
-- No generic counter table existed before this: the two rate-limit
-- patterns already in the codebase are both special-cased to one entity
-- (AuthController's lockout counters live directly on the `user` row;
-- CitizenReportsController's IP throttle counts rows in `audit_log`).
-- Neither generalizes to "N of these per window" for an arbitrary key,
-- and `PublicReportsController::transparency()` deliberately writes no
-- audit row at all (to avoid flooding audit_log with public page views),
-- so there is nowhere else to piggyback a public-endpoint rate limit.
--
-- Design: a fixed-window counter, one row per (limiter_key, window_start).
-- `limiter_key` encodes both the quota TYPE and the SCOPE it applies to,
-- e.g. 'ai_job:user:42' or 'transparency:ip:203.0.113.5' — callers decide
-- their own key format via backend/lib/RateLimiter.php, this table has no
-- opinion on what a key means. `window_start` is UTC, floored to the
-- caller's window size, so concurrent requests in the same window collide
-- on the same primary key and increment atomically via
-- INSERT ... ON DUPLICATE KEY UPDATE. Old rows are not retained (Rule 11 is
-- about STORED business timestamps, not this throwaway counter) — the
-- application opportunistically deletes rows older than 2 days on write,
-- so this table never needs its own retention/legal-hold treatment (it is
-- not personal data — no request payload, IP-scoped keys hash the IP —
-- and holds nothing that would ever need to survive a legal hold).
CREATE TABLE rate_limit_counter (
    limiter_key VARCHAR(191) NOT NULL,
    window_start DATETIME NOT NULL,
    request_count INT UNSIGNED NOT NULL DEFAULT 1,
    PRIMARY KEY (limiter_key, window_start)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
