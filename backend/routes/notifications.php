<?php
declare(strict_types=1);

/**
 * Route table for notification acknowledgment (§6 "Notification
 * acknowledgment"). Sprint 4.
 *
 * There is deliberately no notification LIST endpoint: §6 defines none,
 * and the mobile app learns about notifications through the transport
 * (FCM/SMS) plus its own local cache, not by polling a feed.
 */

use Baranguard\Controllers\NotificationsController;

return [
    ['POST', '#^/notifications/(\d+)/ack$#', [NotificationsController::class, 'acknowledge'], true],
];
