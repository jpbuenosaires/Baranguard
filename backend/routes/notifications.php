<?php
declare(strict_types=1);

/**
 * Route table for notifications (§6 "Notification acknowledgment"). Sprint 4.
 *
 * `GET /notifications` is NOT in §6 and was added later, for the web
 * topbar's notification bell — see NotificationsController::index for the
 * full reasoning. The original note here said there was "deliberately no
 * notification LIST endpoint" because the MOBILE app learns about
 * notifications through the transport plus its own local cache; that
 * remains true of mobile and is why this is a web-facing read only. It
 * does not change how the app receives alerts.
 */

use Baranguard\Controllers\NotificationsController;

return [
    ['GET', '#^/notifications$#', [NotificationsController::class, 'index'], true],
    ['POST', '#^/notifications/(\d+)/ack$#', [NotificationsController::class, 'acknowledge'], true],
];
