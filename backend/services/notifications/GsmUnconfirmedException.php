<?php
declare(strict_types=1);

namespace Baranguard\Services\Notifications;

/**
 * adb accepted the send but no carrier result line arrived in time. The SMS
 * MAY have gone out, so callers record `pending`, never `failed`.
 */
final class GsmUnconfirmedException extends GsmGatewayException
{
}
