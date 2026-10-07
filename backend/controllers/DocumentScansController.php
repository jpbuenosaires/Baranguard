<?php
declare(strict_types=1);

namespace Baranguard\Controllers;

use Baranguard\Lib\ApiError;
use Baranguard\Lib\Audit;
use Baranguard\Lib\Http;
use Baranguard\Lib\RateLimiter;
use Baranguard\Middleware\AuthMiddleware;
use PDO;

/**
 * Signed-paper document scans (migration 0037: `document_scan`).
 *
 *   POST /document-scans                  admin|secretary, multipart/form-data
 *   GET  /document-scans?entity_type=&entity_id=
 *                                         admin|secretary|punong_barangay
 *   GET  /document-scans/:id/download     admin|secretary|punong_barangay
 *
 * A scan is the photographed/scanned copy of a report that was signed on
 * paper. It attaches to an accomplishment report or an Annex D term report
 * of the caller's barangay that is already approved (or, for Annex D,
 * submitted) - an earlier-state report is 409, a missing or another
 * barangay's report is 404 (Rule 2).
 *
 * Storage and validation follow `IncidentsController::uploadEvidence`:
 *   - the file is kept OUTSIDE the web root under `SCANS_DIR` (default
 *     `backend/storage/scans`), under a server-generated name; the client's
 *     filename is never stored or used (it could carry a student's name);
 *   - the type is decided by MAGIC BYTES (PDF `%PDF-`, JPEG `FF D8 FF`, PNG
 *     `89 50 4E 47 0D 0A 1A 0A`) cross-checked against finfo, never by the
 *     client's Content-Type or extension; anything else is 400;
 *   - at most 10 MB (`MAX_BYTES`), non-empty;
 *   - the server hashes the bytes it received; uploading identical bytes to
 *     the same report again returns the original row (200) instead of a
 *     second copy (a multipart POST has no Idempotency-Key);
 *   - responses NEVER include `stored_path`; the download endpoint streams
 *     the bytes through the authorization check as an attachment with
 *     `X-Content-Type-Options: nosniff`.
 *
 * Not malware scanning: a file that merely begins with a valid signature is
 * accepted. A scan lives exactly as long as its parent report; there is no
 * separate purge (retention for these reports is an open decision, Rule 10).
 *
 * Audit metadata is identifiers only: {scan_id, entity_type, entity_id}.
 */
final class DocumentScansController
{
    public const MAX_BYTES = 10 * 1024 * 1024;
    private const UPLOAD_RATE_LIMIT_MAX = 60;
    private const UPLOAD_RATE_LIMIT_WINDOW_SECONDS = 3600;

    /** entity_type => [table, statuses that may carry a scan]. */
    private const ENTITIES = [
        'accomplishment_report' => ['accomplishment_report', ['approved']],
        'ssz_term_report' => ['ssz_term_report', ['approved', 'submitted']],
    ];

    private const EXTENSION_BY_MIME = [
        'application/pdf' => 'pdf',
        'image/jpeg' => 'jpg',
        'image/png' => 'png',
    ];

    /** @param array{user_id:int,barangay_id:int,role:string} $identity */
    public static function upload(PDO $pdo, array $identity): void
    {
        AuthMiddleware::requireRole($identity, ['admin', 'secretary']);

        if (!RateLimiter::check(
            $pdo,
            'document_scan_upload:user:' . $identity['user_id'],
            self::UPLOAD_RATE_LIMIT_WINDOW_SECONDS,
            self::UPLOAD_RATE_LIMIT_MAX
        )) {
            throw new ApiError(429, 'RATE_LIMITED', 'Too many scan uploads recently. Please wait before uploading another.');
        }

        // PHP discards the whole multipart body (empty $_POST and $_FILES)
        // when it exceeds post_max_size; say so instead of a confusing
        // "entity_type is required".
        if ($_POST === [] && $_FILES === [] && (int) ($_SERVER['CONTENT_LENGTH'] ?? 0) > 0) {
            throw new ApiError(400, 'VALIDATION_ERROR', 'The upload is too large (maximum 10 MB).');
        }

        [$entityType, $entityId] = self::requireEntityRef($_POST['entity_type'] ?? null, $_POST['entity_id'] ?? null);
        $entity = self::loadEntity($pdo, $identity, $entityType, $entityId);
        if (!in_array($entity['status'], self::ENTITIES[$entityType][1], true)) {
            throw new ApiError(409, 'CONFLICT', "A scan can only be attached to an approved report (this one is '{$entity['status']}').");
        }

        $file = $_FILES['file'] ?? null;
        if (!is_array($file) || ($file['error'] ?? UPLOAD_ERR_NO_FILE) === UPLOAD_ERR_NO_FILE) {
            throw new ApiError(400, 'VALIDATION_ERROR', 'file is required.');
        }
        $error = (int) ($file['error'] ?? UPLOAD_ERR_NO_FILE);
        if ($error === UPLOAD_ERR_INI_SIZE || $error === UPLOAD_ERR_FORM_SIZE) {
            throw new ApiError(400, 'VALIDATION_ERROR', 'The file exceeds the maximum scan size (10 MB).');
        }
        if ($error !== UPLOAD_ERR_OK) {
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
            throw new ApiError(400, 'VALIDATION_ERROR', 'The file exceeds the maximum scan size (10 MB).');
        }

        $mime = self::detectMime($tmpPath);
        if ($mime === null) {
            throw new ApiError(400, 'VALIDATION_ERROR', 'Only PDF, JPEG or PNG files are accepted.');
        }

        $sha256 = hash_file('sha256', $tmpPath);
        $existing = self::findBySha($pdo, $entityType, $entityId, $sha256);
        if ($existing !== null) {
            Http::send(200, self::mapScan($existing));
        }

        $baseDir = self::storageDir();
        if (!is_dir($baseDir) && !mkdir($baseDir, 0750, true) && !is_dir($baseDir)) {
            throw new ApiError(500, 'SERVER_ERROR', 'Could not prepare scan storage directory.');
        }
        $storedName = 'scan-' . $identity['barangay_id'] . '-' . $entityId . '-' . bin2hex(random_bytes(12)) . '.' . self::EXTENSION_BY_MIME[$mime];
        $destination = $baseDir . DIRECTORY_SEPARATOR . $storedName;
        if (!move_uploaded_file($tmpPath, $destination)) {
            throw new ApiError(500, 'SERVER_ERROR', 'Could not store the uploaded scan.');
        }

        try {
            $pdo->beginTransaction();
            $pdo->prepare(
                'INSERT INTO document_scan
                    (barangay_id, entity_type, entity_id, stored_path, mime_type, size_bytes, sha256, uploaded_by, uploaded_at)
                 VALUES (:barangay_id, :entity_type, :entity_id, :stored_path, :mime_type, :size_bytes, :sha256, :uploaded_by, UTC_TIMESTAMP())'
            )->execute([
                'barangay_id' => $identity['barangay_id'],
                'entity_type' => $entityType,
                'entity_id' => $entityId,
                'stored_path' => $storedName,
                'mime_type' => $mime,
                'size_bytes' => $byteSize,
                'sha256' => $sha256,
                'uploaded_by' => $identity['user_id'],
            ]);
            $scanId = (int) $pdo->lastInsertId();
            Audit::record($pdo, $identity['barangay_id'], $identity['user_id'], 'document_scan_uploaded', 'document_scan', $scanId, [
                'scan_id' => $scanId,
                'entity_type' => $entityType,
                'entity_id' => $entityId,
            ]);
            $pdo->commit();
        } catch (\Throwable $e) {
            if ($pdo->inTransaction()) {
                $pdo->rollBack();
            }
            @unlink($destination);
            // Lost a race against an identical concurrent upload (UNIQUE
            // entity + sha256): the winner's row is the answer.
            if ($e instanceof \PDOException && (string) $e->getCode() === '23000') {
                $winner = self::findBySha($pdo, $entityType, $entityId, $sha256);
                if ($winner !== null) {
                    Http::send(200, self::mapScan($winner));
                }
            }
            throw $e;
        }

        $row = self::findById($pdo, $scanId);
        Http::send(201, self::mapScan($row ?? []));
    }

    /** @param array{user_id:int,barangay_id:int,role:string} $identity */
    public static function index(PDO $pdo, array $identity): void
    {
        AuthMiddleware::requireRole($identity, ['admin', 'secretary', 'punong_barangay']);
        [$entityType, $entityId] = self::requireEntityRef(Http::query('entity_type'), Http::query('entity_id'));
        self::loadEntity($pdo, $identity, $entityType, $entityId);

        $stmt = $pdo->prepare(
            'SELECT s.scan_id, s.barangay_id, s.entity_type, s.entity_id, s.mime_type, s.size_bytes, s.sha256,
                    s.uploaded_by, s.uploaded_at, u.full_name AS uploaded_by_name
               FROM document_scan s
               LEFT JOIN user u ON u.user_id = s.uploaded_by
              WHERE s.entity_type = :t AND s.entity_id = :e AND s.barangay_id = :b
              ORDER BY s.uploaded_at ASC, s.scan_id ASC'
        );
        $stmt->execute(['t' => $entityType, 'e' => $entityId, 'b' => $identity['barangay_id']]);
        Http::send(200, [
            'items' => array_map(static fn (array $r): array => self::mapScan($r), $stmt->fetchAll(PDO::FETCH_ASSOC)),
        ]);
    }

    /** @param array{user_id:int,barangay_id:int,role:string} $identity */
    public static function download(PDO $pdo, array $identity, string $scanIdParam): void
    {
        AuthMiddleware::requireRole($identity, ['admin', 'secretary', 'punong_barangay']);
        if (!ctype_digit($scanIdParam)) {
            throw new ApiError(404, 'NOT_FOUND', 'Scan not found.');
        }
        $scanId = (int) $scanIdParam;
        $stmt = $pdo->prepare('SELECT * FROM document_scan WHERE scan_id = :id');
        $stmt->execute(['id' => $scanId]);
        $row = $stmt->fetch(PDO::FETCH_ASSOC);
        if ($row === false) {
            throw new ApiError(404, 'NOT_FOUND', 'Scan not found.');
        }
        AuthMiddleware::requireTenant($identity, (int) $row['barangay_id']);

        $storedPath = (string) $row['stored_path'];
        $absolutePath = self::storageDir() . DIRECTORY_SEPARATOR . $storedPath;
        if (!preg_match('/^[A-Za-z0-9._-]+$/', $storedPath) || !is_readable($absolutePath)) {
            error_log('[baranguard] scan file missing or unreadable for scan_id=' . $scanId);
            throw new ApiError(503, 'SERVICE_UNAVAILABLE', 'This scan is temporarily unavailable.');
        }

        Audit::record($pdo, $identity['barangay_id'], $identity['user_id'], 'document_scan_downloaded', 'document_scan', $scanId, [
            'scan_id' => $scanId,
            'entity_type' => $row['entity_type'],
            'entity_id' => (int) $row['entity_id'],
        ]);

        // Re-validate the stored type against the allow-list: never echo an
        // arbitrary string into Content-Type.
        $mime = isset(self::EXTENSION_BY_MIME[(string) $row['mime_type']]) ? (string) $row['mime_type'] : 'application/octet-stream';
        $extension = self::EXTENSION_BY_MIME[$mime] ?? 'bin';

        http_response_code(200);
        header('Content-Type: ' . $mime);
        header('Content-Length: ' . (string) filesize($absolutePath));
        header('Content-Disposition: attachment; filename="scan-' . $scanId . '.' . $extension . '"');
        header('X-Content-Type-Options: nosniff');
        header("Content-Security-Policy: default-src 'none'; sandbox");
        // A scan of an official record: never cached by shared proxies/browsers.
        header('Cache-Control: private, no-store');

        while (ob_get_level() > 0) {
            ob_end_clean();
        }
        readfile($absolutePath);
        exit;
    }

    /**
     * @return array{0:string,1:int} [entity_type, entity_id], 400 when either is missing/invalid.
     */
    private static function requireEntityRef(mixed $type, mixed $id): array
    {
        if (!is_string($type) || !isset(self::ENTITIES[$type])) {
            throw new ApiError(400, 'VALIDATION_ERROR', 'entity_type must be one of: ' . implode(', ', array_keys(self::ENTITIES)) . '.');
        }
        if (!is_string($id) || !ctype_digit($id) || strlen($id) > 18 || (int) $id < 1) {
            throw new ApiError(400, 'VALIDATION_ERROR', 'entity_id must be a positive integer.');
        }
        return [$type, (int) $id];
    }

    /**
     * Loads the parent report; 404 when missing or in another barangay.
     *
     * @param array{user_id:int,barangay_id:int,role:string} $identity
     * @return array{barangay_id:int,status:string}
     */
    private static function loadEntity(PDO $pdo, array $identity, string $entityType, int $entityId): array
    {
        $table = self::ENTITIES[$entityType][0]; // whitelisted constant, never client text
        $stmt = $pdo->prepare("SELECT barangay_id, status FROM {$table} WHERE report_id = :id");
        $stmt->execute(['id' => $entityId]);
        $row = $stmt->fetch(PDO::FETCH_ASSOC);
        if ($row === false) {
            throw new ApiError(404, 'NOT_FOUND', 'Report not found.');
        }
        AuthMiddleware::requireTenant($identity, (int) $row['barangay_id']);
        return ['barangay_id' => (int) $row['barangay_id'], 'status' => (string) $row['status']];
    }

    /**
     * Magic-byte detection, cross-checked with finfo. Returns the canonical
     * mime type or null when the file is none of PDF/JPEG/PNG.
     */
    private static function detectMime(string $path): ?string
    {
        $handle = fopen($path, 'rb');
        if ($handle === false) {
            return null;
        }
        $head = (string) fread($handle, 8);
        fclose($handle);

        $byMagic = null;
        if (str_starts_with($head, '%PDF-')) {
            $byMagic = 'application/pdf';
        } elseif (str_starts_with($head, "\xFF\xD8\xFF")) {
            $byMagic = 'image/jpeg';
        } elseif (str_starts_with($head, "\x89PNG\r\n\x1A\n")) {
            $byMagic = 'image/png';
        }
        if ($byMagic === null) {
            return null;
        }
        $finfo = finfo_open(FILEINFO_MIME_TYPE);
        $detected = $finfo !== false ? finfo_file($finfo, $path) : false;
        if ($finfo !== false) {
            finfo_close($finfo);
        }
        return $detected === $byMagic ? $byMagic : null;
    }

    /** @return array<string,mixed>|null */
    private static function findBySha(PDO $pdo, string $entityType, int $entityId, string $sha256): ?array
    {
        $stmt = $pdo->prepare(
            'SELECT s.*, u.full_name AS uploaded_by_name FROM document_scan s
               LEFT JOIN user u ON u.user_id = s.uploaded_by
              WHERE s.entity_type = :t AND s.entity_id = :e AND s.sha256 = :h LIMIT 1'
        );
        $stmt->execute(['t' => $entityType, 'e' => $entityId, 'h' => $sha256]);
        $row = $stmt->fetch(PDO::FETCH_ASSOC);
        return $row === false ? null : $row;
    }

    /** @return array<string,mixed>|null */
    private static function findById(PDO $pdo, int $scanId): ?array
    {
        $stmt = $pdo->prepare(
            'SELECT s.*, u.full_name AS uploaded_by_name FROM document_scan s
               LEFT JOIN user u ON u.user_id = s.uploaded_by
              WHERE s.scan_id = :id'
        );
        $stmt->execute(['id' => $scanId]);
        $row = $stmt->fetch(PDO::FETCH_ASSOC);
        return $row === false ? null : $row;
    }

    /** Never includes `stored_path`. @param array<string,mixed> $row @return array<string,mixed> */
    private static function mapScan(array $row): array
    {
        $uploadedAt = $row['uploaded_at'] ?? null;
        return [
            'scan_id' => (int) ($row['scan_id'] ?? 0),
            'entity_type' => $row['entity_type'] ?? null,
            'entity_id' => (int) ($row['entity_id'] ?? 0),
            'mime_type' => $row['mime_type'] ?? null,
            'size_bytes' => (int) ($row['size_bytes'] ?? 0),
            'sha256' => $row['sha256'] ?? null,
            'uploaded_by' => (int) ($row['uploaded_by'] ?? 0),
            'uploaded_by_name' => $row['uploaded_by_name'] ?? null,
            'uploaded_at' => $uploadedAt === null
                ? null
                : (new \DateTimeImmutable((string) $uploadedAt, new \DateTimeZone('UTC')))->format('Y-m-d\TH:i:s\Z'),
        ];
    }

    /** `SCANS_DIR` (absolute, outside the web root) or `backend/storage/scans`. */
    private static function storageDir(): string
    {
        $base = baranguard_env('SCANS_DIR');
        if ($base === false || trim((string) $base) === '') {
            return dirname(__DIR__) . '/storage/scans';
        }
        return rtrim((string) $base, '/\\');
    }
}
