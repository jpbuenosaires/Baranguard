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
 * `POST /map-packages` — Admin only, own barangay. §6: "Body multipart
 * {version,file}. Server derives barangay, validates MBTiles
 * structure/checksum/size/version uniqueness, publishes atomically ->
 * {package_id,version,checksum_sha256,is_published}."
 *
 * Resolved decisions for the upload path (§6 states the contract but not
 * these specifics — logged in DEVLOG.md):
 *   - **"Validates MBTiles structure"** is two-tier. Every upload's first
 *     16 bytes are checked against the SQLite file-format magic header
 *     (MBTiles IS a SQLite database, per the MBTiles spec) — this alone
 *     rejects arbitrary non-package uploads with no extra dependency. If
 *     this PHP build's `pdo_sqlite` driver is available, a second,
 *     stricter check opens the file and confirms `tiles`/`metadata`
 *     tables actually exist in `sqlite_master`. If the driver is absent,
 *     the endpoint still works (does not hard-fail) but only the header
 *     check ran — logged via `error_log` so that gap is visible in
 *     practice, not silently assumed away.
 *   - **"Atomic publish"** implements §5's own invariant on
 *     `offline_map_package`: "Exactly one package is published per
 *     barangay, enforced transactionally by locking the barangay package
 *     set before publication." A `SELECT ... FOR UPDATE` locks that
 *     barangay's existing rows, any previously-published version is
 *     flipped to `is_published=0`, then the new row is inserted
 *     published — all inside one transaction. The uploaded file is only
 *     moved into permanent storage after validation passes, and is
 *     deleted if the transaction rolls back, so a failed publish never
 *     leaves an orphaned file.
 *   - **500MB size ceiling** — no §6/§5 number is given for a barangay
 *     basemap package; picked as a sane ceiling for hosting on a local
 *     XAMPP workstation disk, not a documented requirement.
 *   - **Version string**: same charset as other identifier fields in this
 *     codebase (`device_id`, etc.) — `[A-Za-z0-9._-]{1,64}` — rather than
 *     accepting arbitrary bytes into a value that becomes part of a
 *     stored filename.
 *
 * Resolved decisions from the original read-only cut (§6 states the
 * contract but not these specifics):
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
    /** §5 offline_map_package.version is VARCHAR(64). */
    private const VERSION_PATTERN = '/^[A-Za-z0-9._-]{1,64}$/';
    private const MAX_BYTES = 500 * 1024 * 1024;

    /** @param array{user_id:int,barangay_id:int,role:string} $identity */
    public static function create(PDO $pdo, array $identity): void
    {
        AuthMiddleware::requireRole($identity, ['admin']);

        $version = $_POST['version'] ?? null;
        if (!is_string($version) || !preg_match(self::VERSION_PATTERN, $version)) {
            throw new ApiError(400, 'VALIDATION_ERROR', 'version must be 1-64 characters of A-Z a-z 0-9 . _ or -.');
        }

        $file = $_FILES['file'] ?? null;
        if (!is_array($file) || ($file['error'] ?? UPLOAD_ERR_NO_FILE) === UPLOAD_ERR_NO_FILE) {
            throw new ApiError(400, 'VALIDATION_ERROR', 'file is required.');
        }
        if (($file['error'] ?? UPLOAD_ERR_NO_FILE) !== UPLOAD_ERR_OK) {
            throw new ApiError(400, 'VALIDATION_ERROR', 'File upload failed.');
        }
        $tmpPath = (string) $file['tmp_name'];
        if (!is_uploaded_file($tmpPath)) {
            throw new ApiError(400, 'VALIDATION_ERROR', 'Invalid upload.');
        }

        $byteSize = filesize($tmpPath);
        if ($byteSize === false || $byteSize === 0) {
            throw new ApiError(400, 'VALIDATION_ERROR', 'Uploaded file is empty.');
        }
        if ($byteSize > self::MAX_BYTES) {
            throw new ApiError(400, 'VALIDATION_ERROR', 'File exceeds the maximum package size (500MB).');
        }

        self::validateMbtilesStructure($tmpPath);
        $checksum = hash_file('sha256', $tmpPath);

        // Uniqueness pre-check for a clean 409 rather than a raw DB
        // constraint-violation error; §5 UNIQUE(barangay_id,version).
        $dupStmt = $pdo->prepare(
            'SELECT package_id FROM offline_map_package WHERE barangay_id = :barangay_id AND version = :version LIMIT 1'
        );
        $dupStmt->execute(['barangay_id' => $identity['barangay_id'], 'version' => $version]);
        if ($dupStmt->fetchColumn() !== false) {
            throw new ApiError(409, 'CONFLICT', 'A package with this version already exists for this barangay.');
        }

        $baseDir = self::baseStorageDir();
        if (!is_dir($baseDir) && !mkdir($baseDir, 0750, true) && !is_dir($baseDir)) {
            throw new ApiError(500, 'SERVER_ERROR', 'Could not prepare storage directory.');
        }
        $relativeFilename = 'barangay-' . $identity['barangay_id'] . '-' . $version . '-' . bin2hex(random_bytes(4)) . '.mbtiles';
        $destination = $baseDir . DIRECTORY_SEPARATOR . $relativeFilename;
        if (!move_uploaded_file($tmpPath, $destination)) {
            throw new ApiError(500, 'SERVER_ERROR', 'Could not store the uploaded package.');
        }

        try {
            $pdo->beginTransaction();

            // §5: "Exactly one package is published per barangay, enforced
            // transactionally by locking the barangay package set before
            // publication."
            $pdo->prepare('SELECT package_id FROM offline_map_package WHERE barangay_id = :barangay_id FOR UPDATE')
                ->execute(['barangay_id' => $identity['barangay_id']]);
            $pdo->prepare('UPDATE offline_map_package SET is_published = 0 WHERE barangay_id = :barangay_id AND is_published = 1')
                ->execute(['barangay_id' => $identity['barangay_id']]);

            $insertStmt = $pdo->prepare(
                'INSERT INTO offline_map_package
                    (barangay_id, version, file_path, checksum_sha256, byte_size, created_by, created_at, is_published)
                 VALUES (:barangay_id, :version, :file_path, :checksum, :byte_size, :created_by, UTC_TIMESTAMP(), 1)'
            );
            $insertStmt->execute([
                'barangay_id' => $identity['barangay_id'],
                'version' => $version,
                'file_path' => $relativeFilename,
                'checksum' => $checksum,
                'byte_size' => $byteSize,
                'created_by' => $identity['user_id'],
            ]);
            $packageId = (int) $pdo->lastInsertId();

            Audit::record(
                $pdo,
                $identity['barangay_id'],
                $identity['user_id'],
                'map_package_published',
                'offline_map_package',
                $packageId,
                ['version' => $version, 'byte_size' => $byteSize]
            );

            $pdo->commit();
        } catch (\Throwable $e) {
            if ($pdo->inTransaction()) {
                $pdo->rollBack();
            }
            @unlink($destination);
            throw $e;
        }

        Http::send(201, [
            'package_id' => $packageId,
            'version' => $version,
            'checksum_sha256' => $checksum,
            'is_published' => true,
        ]);
    }

    private static function validateMbtilesStructure(string $path): void
    {
        $handle = fopen($path, 'rb');
        if ($handle === false) {
            throw new ApiError(400, 'VALIDATION_ERROR', 'Could not read the uploaded file.');
        }
        $header = fread($handle, 16);
        fclose($handle);
        if ($header !== "SQLite format 3\000") {
            throw new ApiError(400, 'VALIDATION_ERROR', 'File is not a valid MBTiles (SQLite) package.');
        }

        if (!in_array('sqlite', \PDO::getAvailableDrivers(), true)) {
            error_log('[baranguard] pdo_sqlite unavailable on this PHP build; MBTiles structure validated by header only for ' . $path);
            return;
        }

        try {
            $sqlite = new \PDO('sqlite:' . $path);
            $tables = $sqlite->query("SELECT name FROM sqlite_master WHERE type='table'")->fetchAll(\PDO::FETCH_COLUMN);
        } catch (\Throwable $e) {
            throw new ApiError(400, 'VALIDATION_ERROR', 'File could not be opened as a SQLite/MBTiles database.');
        }
        if (!in_array('tiles', $tables, true) || !in_array('metadata', $tables, true)) {
            throw new ApiError(400, 'VALIDATION_ERROR', "MBTiles file must contain 'tiles' and 'metadata' tables.");
        }
    }

    private static function baseStorageDir(): string
    {
        $baseDir = baranguard_env('MAP_PACKAGE_DIR');
        if ($baseDir === false || $baseDir === '') {
            $baseDir = dirname(__DIR__) . '/storage/map-packages';
        }
        return $baseDir;
    }

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
        $realBase = realpath(self::baseStorageDir());
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
