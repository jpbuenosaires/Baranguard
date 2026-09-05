<?php
declare(strict_types=1);

/**
 * Route table for `/sms/*` (§6, §9 W14/SMS Monitor). Ordinary
 * authenticated `/api/v1` routes — NOT the internal-only
 * `/internal/sms/*` surface (see routes-internal/sms.php +
 * public/internal.php for that one).
 *
 * `conversations`/`send`/`broadcast` (2026-09-05 UX pass) are the
 * deliberate rescoping of this screen's prior read-only-only design —
 * see SmsController.php's own class doc.
 */

use Baranguard\Controllers\SmsController;

return [
    ['GET', '#^/sms/logs$#', [SmsController::class, 'index'], true],
    ['GET', '#^/sms/conversations$#', [SmsController::class, 'conversations'], true],
    ['GET', '#^/sms/conversations/([0-9+]+)/messages$#', [SmsController::class, 'conversationMessages'], true],
    ['PATCH', '#^/sms/conversations/([0-9+]+)/resolve$#', [SmsController::class, 'resolveConversation'], true],
    ['POST', '#^/sms/send$#', [SmsController::class, 'send'], true],
    ['POST', '#^/sms/broadcast$#', [SmsController::class, 'broadcast'], true],
];
