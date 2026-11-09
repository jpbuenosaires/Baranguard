<?php
declare(strict_types=1);

namespace Baranguard\Services\Notifications;

/**
 * adb accepted the send but no carrier result line arrived in time. The SMS
 * MAY have gone out, so callers record `pending`, never `failed`.
 */
final class GsmUnconfirmedException extends GsmGatewayException
{
    /** The send id the phone will report on later, so a `pending` row can be settled (see SmsGatewayService::reconcilePending). */
    public function __construct(string $message, public readonly ?string $correlationId = null)
    {
        parent::__construct($message);
    }
}
