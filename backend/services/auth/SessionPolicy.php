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
 * Amended 2026-10-07 (decision 15C): the Chief Tanod's phone. An ADMIN login
 * carrying a well-formed X-Device-Id also gets a device session — but one
 * that is scope-limited to ADMIN_DEVICE_ALLOWLIST below (everything else is
 * 403 DEVICE_SESSION_SCOPE). Web admin logins (no header) are unchanged.
 * Secretary and Punong Barangay never get a device session.
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
     * Roles that may hold a DEVICE session. `tanod` is the original mobile
     * role; `admin` was added 2026-10-07 (review decision 15C — the Chief
     * Tanod's phone, one account, any Admin account). An admin device
     * session is SCOPE-LIMITED to {@see self::ADMIN_DEVICE_ALLOWLIST}, which
     * is what makes giving an Admin a 24h/7d token acceptable. Secretary and
     * Punong Barangay never get one.
     */
    private const DEVICE_SESSION_ROLES = ['tanod', 'admin'];

    /**
     * The ONLY routes an ADMIN device session may reach — everything else
     * answers 403 DEVICE_SESSION_SCOPE (an admin WEB session is unaffected).
     * One table, one place; AuthMiddleware::authenticate() is the enforcer.
     * Each entry: [HTTP method, regex against the path after /api/v1,
     * signed-write?]. `true` marks a state-changing call that must carry the
     * same X-Device-Id (+ H-09 signature when the device has a key on file)
     * that a Tanod's mobile writes carry — see AuthMiddleware.
     *
     * Deliberately NOT here: PATCH /tanod-sos/:id/resolve, GET /users, the
     * audit log, incident resolve/lifecycle, reports/export, system
     * settings, availability, shift publishing, notifications/ack-all.
     * `/dispatch-offers*` is listed by pattern ahead of its routes landing
     * (Wave 2); a pattern with no route simply 404s.
     */
    public const ADMIN_DEVICE_ALLOWLIST = [
        ['GET', '#^/tanod-sos$#', false],
        ['PATCH', '#^/tanod-sos/\d+/acknowledge$#', true],
        ['GET', '#^/tanod-sos/fallback-contact$#', false],
        ['GET', '#^/dispatch$#', false],
        ['POST', '#^/dispatch$#', true],
        ['PATCH', '#^/dispatch/\d+/cancel$#', true],
        ['GET', '#^/dispatch/\d+/route$#', false],
        ['GET', '#^/incidents$#', false],
        ['GET', '#^/incidents/\d+$#', false],
        ['GET', '#^/gps/live$#', false],
        ['GET', '#^/notifications$#', false],
        ['POST', '#^/notifications/\d+/ack$#', false],
        ['POST', '#^/devices/register$#', false],
        ['PATCH', '#^/devices/[A-Za-z0-9._:-]{8,64}/deactivate$#', false],
        ['POST', '#^/auth/logout$#', false],
        ['POST', '#^/auth/change-password$#', false],
        ['GET', '#^/dispatch-offers$#', false],
        ['POST', '#^/dispatch-offers$#', true],
        ['PATCH', '#^/dispatch-offers/\d+/cancel$#', true],
        ['GET', '#^/barangays$#', false],
        ['GET', '#^/users/directory$#', false],
    ];

    /**
     * Scope decision for an admin device session.
     *
     * @return array{allowed:bool,signed_write:bool}
     */
    public static function adminDeviceScope(string $method, string $path): array
    {
        $method = strtoupper($method);
        foreach (self::ADMIN_DEVICE_ALLOWLIST as [$allowedMethod, $pattern, $signedWrite]) {
            if ($allowedMethod === $method && preg_match($pattern, $path) === 1) {
                return ['allowed' => true, 'signed_write' => $signedWrite];
            }
        }
        return ['allowed' => false, 'signed_write' => false];
    }

    /**
     * Which kind a fresh login gets. A device session needs BOTH a
     * well-formed `X-Device-Id` header AND a device-capable role (Tanod, or
     * since 2026-10-07 Admin — scope-limited, see ADMIN_DEVICE_ALLOWLIST).
     * Secretary / Punong Barangay never get one, and an Admin in a browser
     * (no header) keeps the 15-minute web session.
     */
    public static function kindForLogin(?string $deviceIdHeader, string $role): string
    {
        if (!in_array($role, self::DEVICE_SESSION_ROLES, true)) {
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
