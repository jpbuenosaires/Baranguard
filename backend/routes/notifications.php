<?php
declare(strict_types=1);

/**
 * Route table for notifications and their acknowledgment.
 *
 * `GET /notifications` serves the web topbar's notification bell (see
 * NotificationsController::index). The MOBILE app learns about
 * notifications through the transport plus its own local cache, so this is
 * a web-facing read only.
 */

use Baranguard\Controllers\NotificationsController;

return [
    ['GET', '#^/notifications$#', [NotificationsController::class, 'index'], true],
    ['POST', '#^/notifications/ack-all$#', [NotificationsController::class, 'acknowledgeAll'], true],
    ['POST', '#^/notifications/(\d+)/ack$#', [NotificationsController::class, 'acknowledge'], true],
];
