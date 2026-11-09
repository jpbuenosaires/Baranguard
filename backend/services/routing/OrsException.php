<?php
declare(strict_types=1);

namespace Baranguard\Services\Routing;

/**
 * OpenRouteService (ORS) responded, but the response was unusable —
 * malformed JSON, an HTTP 4xx (bad request, invalid/unauthorized key,
 * no route found), or a JSON-level `error`.
 *
 * DELIBERATELY DISTINCT from `OrsUnavailableException`: this one means the
 * request genuinely FAILED (retrying it unchanged fails the same way),
 * while "unavailable" means ORS's service itself didn't answer, or answered
 * with a transient/rate-limit signal.
 * `DispatchController::route()` treats them differently:
 * unavailable keeps a prior good cached route and marks it `stale`; a
 * real rejection has none to fall back to and marks `unavailable`
 * outright.
 *
 * Own file: the autoloader maps class name -> filename, one class per file.
 */
final class OrsException extends \RuntimeException
{
}
