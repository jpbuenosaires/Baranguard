<?php

declare(strict_types=1);

namespace Baranguard\Services\Auth;

/**
 * SessionPolicy — how long an auth_session lives, by kind.
 *
 * Architecture decision 2026-09-19 (user-confirmed, DEVLOG 2026-09-19 (7);
 * Master Reference §2 Rule 9 amended the same day):
 *
 *   web    — the dashboard on the shared barangay-hall PC. 15-minute
 *            sliding token (`JWT_EXPIRES_IN_MINUTES`). An open dashboard
 *            polls every 15s and so never expires; only a closed tab or a
 *            sleeping PC ends the session. That is an idle timeout for a
 *            shared screen, kept deliberately.
 *   device — the Tanod app on a registered Android device. 24 hours
 *            sliding, capped at 7 days from `issued_at`. A responder who
 *            used the app since yesterday is never asked for a password
 *            when a dispatch push arrives; one who lost the phone is
 *            bounded to a week even if nobody reports it.
 *
 * Both kinds are revoked instantly by logout / suspension / deactivation /
 * password change, because AuthMiddleware checks the auth_session row on
 * EVERY request — the long device token changes only how long an
 * un-revoked session lives, never how fast a revoked one dies.
 *
 * The two device numbers are constants, not config, in the same spirit as
 * §11's retention numbers (REFERENCE.md §2 rule 10): changing them is an
 * architecture review, not a runbook edit.
 */
final class SessionPolicy
{
    public const KIND_WEB = 'web';
    public const KIND_DEVICE = 'device';

    public const DEVICE_LIFETIME_SECONDS = 24 * 3600;
    public const DEVICE_ABSOLUTE_CAP_SECONDS = 7 * 86400;

    /** Mobile device ids are minted client-side as `and-<uuid v4>` (deviceIdentity.ts). */
    private const DEVICE_ID_PATTERN = '/^and-[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i';

    public static function webLifetimeSeconds(): int
    {
        return ((int) (baranguard_env('JWT_EXPIRES_IN_MINUTES') ?: 15)) * 60;
    }

    public static function lifetimeSeconds(string $kind): int
    {
        return $kind === self::KIND_DEVICE ? self::DEVICE_LIFETIME_SECONDS : self::webLifetimeSeconds();
    }

    /**
     * Which kind a fresh login gets. A device session needs BOTH a
     * well-formed `X-Device-Id` header AND the tanod role (§3: Tanod is the
     * only mobile role) — an Admin/Secretary in a browser can't lengthen
     * their own session by adding a header.
     */
    public static function kindForLogin(?string $deviceIdHeader, string $role): string
    {
        if ($role !== 'tanod') {
            return self::KIND_WEB;
        }
        if ($deviceIdHeader === null || preg_match(self::DEVICE_ID_PATTERN, $deviceIdHeader) !== 1) {
            return self::KIND_WEB;
        }
        return self::KIND_DEVICE;
    }

    /**
     * Applies the absolute cap: a device session never renews past
     * issued_at + 7 days. Web sessions have no cap (they end when the
     * dashboard stops polling).
     */
    public static function capExpiry(string $kind, int $issuedAtTs, int $proposedExpiryTs): int
    {
        if ($kind !== self::KIND_DEVICE) {
            return $proposedExpiryTs;
        }
        return min($proposedExpiryTs, $issuedAtTs + self::DEVICE_ABSOLUTE_CAP_SECONDS);
    }
}
