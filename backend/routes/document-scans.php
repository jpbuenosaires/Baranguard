<?php
declare(strict_types=1);

/**
 * Route table for the signed-paper document scans (migration 0037): upload,
 * list and download of a PDF/JPEG/PNG scan attached to an approved
 * accomplishment report or Annex D term report. Picked up automatically by
 * public/index.php's glob of routes/*.php.
 */

use Baranguard\Controllers\DocumentScansController;

return [
    ['POST', '#^/document-scans$#', [DocumentScansController::class, 'upload'], true],
    ['GET', '#^/document-scans$#', [DocumentScansController::class, 'index'], true],
    ['GET', '#^/document-scans/(\d+)/download$#', [DocumentScansController::class, 'download'], true],
];
