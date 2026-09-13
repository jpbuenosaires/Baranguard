<?php
declare(strict_types=1);

namespace Baranguard\Services\Routing;

/**
 * OpenRouteService (ORS) could not be reached at all, answered with a
 * server-side (5xx) error, or answered `429` (free-tier rate limit hit)
 * — grouped with "unavailable" rather than a hard rejection because,
 * unlike a genuinely malformed request, retrying later is expected to
 * succeed.
 *
 * `DispatchController::route()` (Phase 3) catches this and, if a
 * dispatch already has a previously-computed route cached, KEEPS it and
 * marks `route_status: stale` rather than discarding it — the same
 * fallback the Master Reference's M6 "cached route labeled as such"
 * line describes. If there is no prior route, it falls to
 * `unavailable`, the same literal `DispatchController::create()`
 * already hardcodes today. Either way, mobile's "Open in external
 * navigation app" link keeps working regardless.
 *
 * See OrsException for the other half of the distinction.
 */
final class OrsUnavailableException extends \RuntimeException
{
}
