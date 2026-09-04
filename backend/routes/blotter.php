<?php
declare(strict_types=1);

/**
 * Route table for blotter finalization/amendment/packet (§6 "Blotter").
 *
 * The packet `download` route is not in §6's endpoint list; it exists
 * because §6 promises a `file_url` while §5 requires the file to live
 * outside the web root, and an authorized endpoint is the only way to
 * satisfy both. Same precedent as `GET /map-packages/:id/download`.
 */

use Baranguard\Controllers\BlotterController;

return [
    ['GET', '#^/blotter$#', [BlotterController::class, 'index'], true],
    ['GET', '#^/incidents/(\d+)/blotter$#', [BlotterController::class, 'showByIncident'], true],
    ['POST', '#^/incidents/(\d+)/finalize$#', [BlotterController::class, 'finalize'], true],
    ['POST', '#^/incidents/(\d+)/blotter/amend$#', [BlotterController::class, 'amend'], true],
    ['POST', '#^/incidents/(\d+)/lupon-packet$#', [BlotterController::class, 'luponPacket'], true],
    ['GET', '#^/incidents/(\d+)/lupon-packet/download$#', [BlotterController::class, 'luponPacketDownload'], true],
    ['GET', '#^/blotter/(\d+)$#', [BlotterController::class, 'show'], true],
];
