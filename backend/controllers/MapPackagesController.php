<?php
declare(strict_types=1);

namespace Baranguard\Controllers;

use Baranguard\Lib\ApiError;
use Baranguard\Lib\Audit;
use Baranguard\Lib\Http;
use Baranguard\Middleware\AuthMiddleware;
use PDO;

/**
 * Offline basemap packages — Master Reference §6 "Map packages",
 * §5 `offline_map_package`, §2 Rule 14 ("Offline maps are part of the
 * offline-first guarantee. Each approved device has a versioned
 * encrypted/app-private cached basemap package.").
 *
 * Built for Sprint 2's M1 Login box, which "checks map package version
 * and enters M2 without blocking on map download" (§9 M1).
 *
 * §6 fixes these contracts:
 *   - `GET /map-packages/:barangay_id` — Admin or Tanod, only when the
 *     requested barangay equals the caller's tenant →
 *     `{version,checksum_sha256,download_url,is_published}`.
 *   - `GET /map-packages/:barangay_id/download` — Tanod only, own
 *     barangay. "Streams the published package; client verifies SHA-256
 *     before activation."
 *
 * NOT built here: `POST /map-packages` (Admin multipart upload +
 * MBTiles-structure validation + atomic publish). It is a separate,
 * larger piece with no §9 web screen consuming it, and M1 only ever
 * READS packages — building an upload path this cut would be scope the
 * chosen box doesn't need. Consequence, stated plainly rather than left
 * implicit: until it exists, `offline_map_package` rows must be created
 * out-of-band, so both endpoints below will legitimately 404 on a fresh
 * install. Logged in DEVLOG.md and on the Sprint 2 checklist.
 *
 * Resolved decisions (§6 states the contract but not these specifics):
 *   - **Package files live under `MAP_PACKAGE_DIR`** (env; defaults to
 *     `backend/storage/map-packages`), and `offline_map_package.file_path`
 *     is interpreted as a path RELATIVE to it. The resolved real path is
 *     then asserted to still sit inside that directory, so a malformed or
 *     hostile `file_path` row cannot turn this endpoint into an arbitrary
 *     file reader.
 *   - **`download_url` is API-relative**, not absolute. The server has no
 *     reliable notion of its own externally-visible host (§2 Rule 7: LAN
 *     only, no fixed public origin), and the mobile client already knows
 *     its API base URL.
 *   - **No published package → 404.** §9 M1 requires the map check to be
 *     non-blocking, so the client must treat this as "nothing to download
 *     yet", never as a login failure.
 *   - **The download response carries `X-Checksum-SHA256`** so the client
 *     can do §6's mandatory pre-activation verification without a second
 *     round trip. The metadata endpoint returns the same value.
 */
final class MapPackagesController
{
    /** @param array{user_id:int,barangay_id:int,role:string} $identity */
    public static function show(PDO $pdo, array $identity, string $barangayId): void
    {
        AuthMiddleware::requireRole($identity, ['admin', 'tanod']);
        AuthMiddleware::requireTenant($identity, (int) $barangayId);

        $package = self::findPublishedPackage($pdo, (int) $barangayId);
        if ($package === null) {
            throw new ApiError(404, 'NOT_FOUND', 'No published map package for this barangay.');
        }

        Http::send(200, [
            'version' => $package['version'],
            'checksum_sha256' => $package['checksum_sha256'],
            'download_url' => "/map-packages/{$barangayId}/download",
            'is_published' => true,
        ]);
    }

    /** @param array{user_id:int,barangay_id:int,role:string} $identity */
    public static function download(PDO $pdo, array $identity, string $barangayId): void
    {
        // §6: download is Tanod-only (an Admin has no offline map to
        // install), unlike the metadata endpoint above which both roles read.
        AuthMiddleware::requireRole($identity, ['tanod']);
        AuthMiddleware::requireTenant($identity, (int) $barangayId);

        $package = self::findPublishedPackage($pdo, (int) $barangayId);
        if ($package === null) {
            throw new ApiError(404, 'NOT_FOUND', 'No published map package for this barangay.');
        }

        $absolutePath = self::resolvePackagePath((string) $package['file_path']);
        if ($absolutePath === null || !is_readable($absolutePath)) {
            // The row says published but the bytes are gone/unreadable —
            // an operator problem, not a client one. Don't leak the path.
            error_log('[baranguard] map package file missing or unreadable for package_id=' . $package['package_id']);
            throw new ApiError(503, 'SERVICE_UNAVAILABLE', 'The map package is temporarily unavailable.');
        }

        Audit::record(
            $pdo,
            $identity['barangay_id'],
            $identity['user_id'],
            'map_package_downloaded',
            'offline_map_package',
            (int) $package['package_id'],
            ['version' => $package['version']]
        );

        $filename = 'baranguard-barangay-' . (int) $barangayId . '-' . $package['version'] . '.mbtiles';

        http_response_code(200);
        header('Content-Type: application/octet-stream');
        header('Content-Length: ' . (string) filesize($absolutePath));
        header('Content-Disposition: attachment; filename="' . $filename . '"');
        // §6: "client verifies SHA-256 before activation" — served here so
        // that verification needs no second request.
        header('X-Checksum-SHA256: ' . $package['checksum_sha256']);
        header('X-Package-Version: ' . $package['version']);

        // Drop any buffering so a large package streams rather than being
        // assembled in memory first.
        while (ob_get_level() > 0) {
            ob_end_clean();
        }
        readfile($absolutePath);
        exit;
    }

    /** @return array<string,mixed>|null */
    private static function findPublishedPackage(PDO $pdo, int $barangayId): ?array
    {
        // Newest published version wins. §5's UNIQUE(barangay_id, version)
        // permits several versions per barangay; only published ones are
        // ever offered to a device.
        $stmt = $pdo->prepare(
            'SELECT package_id, version, file_path, checksum_sha256, byte_size
             FROM offline_map_package
             WHERE barangay_id = :barangay_id AND is_published = 1
             ORDER BY created_at DESC, package_id DESC
             LIMIT 1'
        );
        $stmt->execute(['barangay_id' => $barangayId]);
        $row = $stmt->fetch(PDO::FETCH_ASSOC);
        return $row === false ? null : $row;
    }

    /**
     * Resolves a stored `file_path` against MAP_PACKAGE_DIR and refuses
     * anything that escapes it. Returns null if the path is invalid or
     * outside the configured directory.
     */
    private static function resolvePackagePath(string $filePath): ?string
    {
        $baseDir = baranguard_env('MAP_PACKAGE_DIR');
        if ($baseDir === false || $baseDir === '') {
            $baseDir = dirname(__DIR__) . '/storage/map-packages';
        }
        $realBase = realpath($baseDir);
        if ($realBase === false) {
            return null;
        }

        $candidate = realpath($realBase . DIRECTORY_SEPARATOR . $filePath);
        if ($candidate === false) {
            return null;
        }
        // Containment check — `realpath` has already resolved any `..`,
        // symlinks, and Windows/POSIX separator differences by this point.
        if (!str_starts_with($candidate, $realBase . DIRECTORY_SEPARATOR) && $candidate !== $realBase) {
            return null;
        }
        return is_file($candidate) ? $candidate : null;
    }
}
