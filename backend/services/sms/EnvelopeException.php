<?php
declare(strict_types=1);

namespace Baranguard\Services\Sms;

/**
 * Every rejection reason (bad shape, failed auth tag, expired, replayed,
 * unknown device) collapses into this ONE exception type deliberately —
 * see `SmsGatewayService`'s class doc for why the HTTP response never
 * distinguishes between them.
 */
final class EnvelopeException extends \RuntimeException
{
}
