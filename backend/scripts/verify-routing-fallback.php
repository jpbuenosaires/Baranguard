<?php
declare(strict_types=1);

/**
 * Partial-outage check for routing: with ORS forced unavailable (empty
 * API key), the client must refuse cleanly (never fatal) and the
 * straight-line fallback must still produce a sane distance/rough ETA.
 * No database or network needed.
 *
 * Usage: php backend/scripts/verify-routing-fallback.php
 */

require dirname(__DIR__) . '/config/env.php';
require dirname(__DIR__) . '/config/autoload.php';

use Baranguard\Services\Routing\OrsClient;
use Baranguard\Services\Routing\OrsUnavailableException;

$pass = 0;
$fail = 0;
$check = function (bool $ok, string $name) use (&$pass, &$fail): void {
    echo ($ok ? '[PASS] ' : '[FAIL] ') . $name . PHP_EOL;
    $ok ? $pass++ : $fail++;
};

$client = new OrsClient('', 5);
$check($client->isConfigured() === false, 'empty key reports not configured');
$check($client->ping() === false, 'ping() is false without a key');
try {
    $client->route(12.9189, 123.6702, 12.9216, 123.6725, OrsClient::MODE_CAR);
    $check(false, 'route() throws OrsUnavailableException without a key');
} catch (OrsUnavailableException) {
    $check(true, 'route() throws OrsUnavailableException without a key');
}

// 0.01 degree of latitude is ~1111 m on the great circle.
$line = OrsClient::straightLine(12.90, 123.67, 12.91, 123.67, OrsClient::MODE_CAR);
$check(abs($line['distance_m'] - 1111.9) < 5, "1 centidegree latitude is about 1112 m (got {$line['distance_m']})");
$check($line['assumed_speed_kmh'] === 30 && abs($line['rough_duration_s'] - 133) < 3, "car rough ETA uses 30 km/h (got {$line['rough_duration_s']} s)");
$walk = OrsClient::straightLine(12.90, 123.67, 12.91, 123.67, OrsClient::MODE_FOOT);
$check($walk['assumed_speed_kmh'] === 5 && $walk['rough_duration_s'] > $line['rough_duration_s'], 'foot is slower than car');
$zero = OrsClient::straightLine(12.9, 123.6, 12.9, 123.6, OrsClient::MODE_CAR);
$check($zero['distance_m'] === 0.0, 'identical points give 0 m');

echo PHP_EOL . "{$pass} passed, {$fail} failed" . PHP_EOL;
exit($fail === 0 ? 0 : 1);
