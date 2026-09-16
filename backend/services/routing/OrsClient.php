<?php
declare(strict_types=1);

namespace Baranguard\Services\Routing;

/**
 * OrsClient — the ONLY place this codebase talks to OpenRouteService
 * (ORS), a cloud-hosted routing API run by HeiGIT/Heidelberg University
 * on OpenStreetMap data. Second architecture decision on this feature
 * in one day (2026-09-13, explicit user sign-off): Google's Routes API
 * was ruled out immediately after — it requires a billing account with
 * a card on file even to stay inside the free tier, which this
 * deployment doesn't have. ORS's free tier needs no card. A self-hosted
 * OSRM instance was the ORIGINAL plan before that and was abandoned
 * mid-build over WSL2/vcpkg memory constraints on this workstation's
 * ~8GB RAM — see GoogleRoutesClient's replacement, this class, for that
 * history; ORS runs on the same underlying OSM data a self-hosted OSRM
 * build would have, just hosted for you instead of built here.
 *
 * WHAT THIS MEANS OPERATIONALLY, recorded here since it's a real
 * deviation from every other dependency in this stack (same trade
 * Google would have been, different vendor):
 *   - Every route request sends the Tanod's current GPS position and
 *     the incident's location to a third party (HeiGIT, not Google) —
 *     real operational data leaving the system, a deliberate trade the
 *     user made explicitly.
 *   - The phone needs to reach the public internet directly for this
 *     one feature — every other mobile feature only ever needs to reach
 *     the workstation itself (plain LAN by default; see
 *     apiService.ts's own note on temporary remote-testing options).
 *   - Free tier, no card — but rate-limited; exact current limits are
 *     whatever ORS's dashboard shows at signup (their docs pages did
 *     not render for automated verification when this was built).
 *     Mobile's "Get Route" being an explicit tap, not an auto-refresh
 *     poll, is what keeps real usage well inside whatever that limit
 *     is — see AssignmentDetail's own note (Phase 4).
 *
 * Configuration (see .env.example):
 *   ORS_API_KEY   UNSET means "this deployment has never wired up
 *                 routing", which is what makes /system/health report
 *                 `ors: not_configured` rather than `unhealthy` — same
 *                 reasoning OLLAMA_URL's own "not defaulted" comment
 *                 gives. Free, created directly at openrouteservice.org
 *                 by the user — no card required, but still an account
 *                 signup this codebase/an assistant doesn't do on the
 *                 user's behalf.
 *   ORS_TIMEOUT_SECONDS   request timeout (default 10 — a live cloud
 *                 API call inside a web request, not a background job).
 *
 * VERIFICATION STATUS, stated plainly because it matters: the REQUEST
 * side of this client (endpoint path, `Authorization` header carrying
 * the raw key with no "Bearer" prefix, body field names, `geojson`
 * format) is verified directly against ORS's own official Python
 * client source (github.com/GIScience/openrouteservice-py,
 * client.py/directions.py) — not guessed. The RESPONSE-parsing side
 * (features[].properties.segments[].steps[] shape) is built from
 * well-established, long-stable knowledge of ORS's public API, since
 * ORS's docs pages did not render for this session's automated
 * verification and no real API key was available to test a live
 * response against. Parsing below is defensive (null-safe) specifically
 * because of that gap — confirm against a real response once a key
 * exists, per this project's own "prove it, don't claim it" standard.
 *
 * Two distinct failure modes, deliberately not collapsed into one (see
 * each exception's own doc): `OrsUnavailableException` = didn't answer,
 * or answered transiently (5xx, 429 rate limit); `OrsException` = it
 * answered with something unusable.
 */
final class OrsClient
{
    public const MODE_CAR = 'car';
    public const MODE_FOOT = 'foot';

    private const API_BASE_URL = 'https://api.openrouteservice.org';

    /** Health/ping calls get a short timeout — this runs inside a web request. */
    private const PING_TIMEOUT_SECONDS = 5;
    private const DEFAULT_REQUEST_TIMEOUT_SECONDS = 10;

    /**
     * A fixed pair of points for the health probe, confirmed to sit ON
     * ORS's actual OSM-derived road network in Pilar, Sorsogon (real
     * street names: Prieto, Smith Street) — a REAL route request, not a
     * bare reachability check, so this also proves the key is valid and
     * not rate-limited, not just that the domain resolves.
     *
     * NOT the mobile app's `DEFAULT_CENTER` (LiveMapCanvas.tsx,
     * 12.9186/123.6667) — that point was tried first and turned out to
     * have no routable road within even 500m in OSM's data for this
     * area (confirmed live against the real API: ORS error 2010,
     * "Could not find routable point within a radius of 350.0 meters").
     * That's a genuine, if unfortunate, illustration of the rural-OSM-
     * coverage trade-off this architecture decision accepted — worth
     * knowing if `DEFAULT_CENTER` itself is ever revisited. These two
     * points were instead extracted from a real computed route between
     * the confirmed snap point and a nearby coordinate, so both are
     * provably on-road, not guessed.
     */
    private const HEALTH_CHECK_ORIGIN_LAT = 12.918905;
    private const HEALTH_CHECK_ORIGIN_LNG = 123.670203;
    private const HEALTH_CHECK_DEST_LAT = 12.921617;
    private const HEALTH_CHECK_DEST_LNG = 123.672552;

    private string $apiKey;
    private int $requestTimeout;

    public function __construct(?string $apiKey = null, ?int $requestTimeout = null)
    {
        $this->apiKey = $apiKey ?? (string) (baranguard_env('ORS_API_KEY') ?: '');
        $this->requestTimeout = $requestTimeout
            ?? (int) (baranguard_env('ORS_TIMEOUT_SECONDS') ?: self::DEFAULT_REQUEST_TIMEOUT_SECONDS);
    }

    /**
     * False when this deployment has never wired up ORS at all — the
     * `not_configured` case, as opposed to `unhealthy` (configured but
     * failing its check).
     */
    public function isConfigured(): bool
    {
        return $this->apiKey !== '';
    }

    /**
     * Requests a road-snapped route between two points.
     *
     * `$mode` is this app's own vocabulary (car/foot, matching the UI
     * and the earlier OSRM-profile naming so callers didn't need to
     * change again) — translated to ORS's own profile names
     * (`driving-car`/`foot-walking`) here.
     *
     * Requesting the `geojson` response format means ORS hands back
     * already-decoded `[lng,lat]` coordinate arrays for the route
     * geometry — mobile never needs a polyline-decoder library, the
     * same property the OSRM and Google designs both had.
     *
     * @return array{geometry:array<string,mixed>,distance_m:float,duration_s:float,steps:array<int,array{instruction:string,maneuver:string,distance_m:float,duration_s:float}>}
     * @throws OrsUnavailableException when ORS can't be reached, or answers transiently (5xx/429)
     * @throws OrsException when it responds with something unusable
     */
    public function route(float $originLat, float $originLng, float $destLat, float $destLng, string $mode): array
    {
        if ($mode !== self::MODE_CAR && $mode !== self::MODE_FOOT) {
            throw new \InvalidArgumentException("Unknown routing mode: {$mode}");
        }
        $profile = $mode === self::MODE_CAR ? 'driving-car' : 'foot-walking';

        $body = [
            // ORS coordinates are [lon, lat], in visit order — confirmed
            // against openrouteservice-py's directions() docstring.
            'coordinates' => [[$originLng, $originLat], [$destLng, $destLat]],
            'instructions' => true,
            'units' => 'm',
        ];

        $payload = $this->request("/v2/directions/{$profile}/geojson", $body, $this->requestTimeout);

        $feature = $payload['features'][0] ?? null;
        if (!is_array($feature)) {
            throw new OrsException('ORS returned no route.');
        }

        $properties = is_array($feature['properties'] ?? null) ? $feature['properties'] : [];
        $summary = is_array($properties['summary'] ?? null) ? $properties['summary'] : [];
        $segments = is_array($properties['segments'] ?? null) ? $properties['segments'] : [];

        $steps = [];
        foreach ($segments as $segment) {
            foreach (($segment['steps'] ?? []) as $step) {
                $instruction = $step['instruction'] ?? null;
                $roadName = $step['name'] ?? null;
                $steps[] = [
                    'instruction' => is_string($instruction) ? $instruction : '',
                    // ORS's own maneuver signal is an integer `type` code,
                    // not a text enum — kept as a string here so this
                    // shape matches the other routing clients' `maneuver`
                    // field without this app needing ORS's specific
                    // numeric-code table (the `instruction` text is
                    // already human-readable and is what mobile shows).
                    'maneuver' => is_string($roadName) && $roadName !== '' ? $roadName : 'UNKNOWN',
                    'distance_m' => (float) ($step['distance'] ?? 0),
                    'duration_s' => (float) ($step['duration'] ?? 0),
                ];
            }
        }

        $geometry = $feature['geometry'] ?? null;

        return [
            'geometry' => is_array($geometry) ? $geometry : ['type' => 'LineString', 'coordinates' => []],
            'distance_m' => (float) ($summary['distance'] ?? 0),
            'duration_s' => (float) ($summary['duration'] ?? 0),
            'steps' => $steps,
        ];
    }

    /**
     * Cheap-ish reachability probe for /system/health — a REAL route
     * request against fixed, known points, not just a key-presence
     * check, so an invalid/revoked key or a fully exhausted rate limit
     * shows as unhealthy rather than healthy.
     *
     * PUBLIC so SystemHealthController can reuse it without a second
     * implementation, same reasoning OllamaClient/ollamaStatus() share.
     * Only probes the CAR mode — both modes hit the same API key/quota,
     * so a second full request would just double the (rate-limited)
     * request count for no new information.
     */
    public function ping(): bool
    {
        if (!$this->isConfigured()) {
            return false;
        }
        try {
            $this->route(
                self::HEALTH_CHECK_ORIGIN_LAT,
                self::HEALTH_CHECK_ORIGIN_LNG,
                self::HEALTH_CHECK_DEST_LAT,
                self::HEALTH_CHECK_DEST_LNG,
                self::MODE_CAR
            );
            return true;
        } catch (OrsUnavailableException | OrsException) {
            return false;
        }
    }

    /**
     * @param array<string,mixed> $body
     * @return array<string,mixed>
     * @throws OrsUnavailableException|OrsException
     */
    private function request(string $path, array $body, int $timeoutSeconds): array
    {
        if (!$this->isConfigured()) {
            throw new OrsUnavailableException('ORS is not configured (set ORS_API_KEY).');
        }
        if (!function_exists('curl_init')) {
            throw new OrsException('PHP ext-curl is required to reach ORS.');
        }

        $handle = curl_init(self::API_BASE_URL . $path);
        if ($handle === false) {
            throw new OrsException('Could not initialise an HTTP request to ORS.');
        }

        curl_setopt($handle, CURLOPT_RETURNTRANSFER, true);
        curl_setopt($handle, CURLOPT_TIMEOUT, $timeoutSeconds);
        curl_setopt($handle, CURLOPT_CONNECTTIMEOUT, min(5, $timeoutSeconds));
        curl_setopt($handle, CURLOPT_POST, true);
        curl_setopt($handle, CURLOPT_POSTFIELDS, json_encode($body, JSON_UNESCAPED_UNICODE | JSON_UNESCAPED_SLASHES));
        curl_setopt($handle, CURLOPT_HTTPHEADER, [
            'Content-Type: application/json',
            // Raw key, no "Bearer" prefix — confirmed against
            // openrouteservice-py's client.py (`"Authorization":
            // self._key`).
            'Authorization: ' . $this->apiKey,
        ]);

        $raw = curl_exec($handle);
        $errorNo = curl_errno($handle);
        $errorMessage = curl_error($handle);
        $httpStatus = (int) curl_getinfo($handle, CURLINFO_RESPONSE_CODE);
        curl_close($handle);

        if ($raw === false || $errorNo !== 0) {
            throw new OrsUnavailableException("Could not reach ORS: {$errorMessage}");
        }
        if ($httpStatus === 429 || $httpStatus >= 500) {
            // 429 = free-tier rate limit hit; 5xx = ORS's own outage.
            // Both are "try again later", not "this request is wrong" —
            // confirmed against openrouteservice-py's own
            // _OverQueryLimit/retriable-status handling.
            throw new OrsUnavailableException("ORS returned HTTP {$httpStatus}.");
        }

        $decoded = json_decode((string) $raw, true);
        if (!is_array($decoded)) {
            throw new OrsException('ORS returned a non-JSON response.');
        }

        if (isset($decoded['error'])) {
            $message = is_string($decoded['error'])
                ? $decoded['error']
                : (is_string($decoded['error']['message'] ?? null) ? $decoded['error']['message'] : 'unknown error');
            throw new OrsException("ORS rejected the request: {$message}");
        }
        if ($httpStatus >= 400) {
            throw new OrsException("ORS rejected the request with HTTP {$httpStatus}.");
        }

        return $decoded;
    }
}
