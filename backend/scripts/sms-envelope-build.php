<?php
declare(strict_types=1);

/**
 * sms-envelope-build.php — builds one valid §6-shaped encrypted SMS
 * envelope and prints it as JSON on stdout.
 *
 * This is test/development tooling, not a production component: the REAL
 * GSM ingestion process (reading messages off the tethered phone) is out
 * of this cut's scope (no hardware exists to build or test one against —
 * see DEVLOG.md). This script exists so `verify-sprint4-phase2-3.sh` (and
 * a human developer) can exercise the real `/internal/sms/*` handlers
 * end-to-end — real AES-256-GCM encryption, real AAD binding, real replay
 * dedup — without needing that hardware. Nothing in `backend/` other than
 * this script and the verify suite ever calls it.
 *
 * Usage (from backend/):
 *   php scripts/sms-envelope-build.php \
 *     --secret=<base64 device secret from POST /devices/register> \
 *     --device-id=<device_id> \
 *     --type=incident_fallback|coord_ping|duty_status|sos \
 *     --payload='{"incident_type":"theft",...}' \
 *     [--client-event-id=<uuid>] [--ttl=600]
 *
 * Prints the flat envelope JSON — exactly the body §6 documents for
 * `/sms/incident-fallback` et al. ("body {encrypted_envelope}") — ready to
 * pipe straight into curl.
 */

if (PHP_SAPI !== 'cli') {
    http_response_code(404);
    exit(1);
}

require dirname(__DIR__) . '/config/env.php';
baranguard_load_env();
require dirname(__DIR__) . '/config/autoload.php';

use Baranguard\Services\Sms\EnvelopeCrypto;

$options = parseArguments($argv);
foreach (['secret', 'device-id', 'type', 'payload'] as $required) {
    if (!isset($options[$required])) {
        fwrite(STDERR, "Missing required --{$required}\n");
        exit(1);
    }
}

$rawSecret = base64_decode($options['secret'], true);
if ($rawSecret === false || strlen($rawSecret) !== 32) {
    fwrite(STDERR, "--secret must be the base64 message_encryption_key from POST /devices/register (32 raw bytes).\n");
    exit(1);
}

$payload = json_decode($options['payload'], true);
if (!is_array($payload)) {
    fwrite(STDERR, "--payload must be valid JSON.\n");
    exit(1);
}

$version = '1';
$messageId = generateUuid();
$clientEventId = $options['client-event-id'] ?? generateUuid();
$deviceId = $options['device-id'];
$messageType = $options['type'];
$ttlSeconds = isset($options['ttl']) ? (int) $options['ttl'] : 600;

$createdAt = gmdate('Y-m-d\TH:i:s\Z');
$expiry = gmdate('Y-m-d\TH:i:s\Z', time() + $ttlSeconds);

$aad = EnvelopeCrypto::buildAad($version, $messageId, $deviceId, $clientEventId, $createdAt, $expiry, $messageType);

$crypto = new EnvelopeCrypto();
$encrypted = $crypto->encryptPayload($rawSecret, $payload, $aad);

$envelope = [
    'version' => $version,
    'message_id' => $messageId,
    'device_id' => $deviceId,
    'client_event_id' => $clientEventId,
    'created_at' => $createdAt,
    'expiry' => $expiry,
    'message_type' => $messageType,
    'nonce' => $encrypted['nonce'],
    'ciphertext' => $encrypted['ciphertext'],
    'tag' => $encrypted['tag'],
];

echo json_encode($envelope, JSON_UNESCAPED_SLASHES | JSON_PRETTY_PRINT) . PHP_EOL;

/** @param string[] $argv @return array<string,string> */
function parseArguments(array $argv): array
{
    $options = [];
    foreach (array_slice($argv, 1) as $argument) {
        if (str_starts_with($argument, '--') && str_contains($argument, '=')) {
            [$key, $value] = explode('=', substr($argument, 2), 2);
            $options[$key] = $value;
        }
    }
    return $options;
}

function generateUuid(): string
{
    $bytes = random_bytes(16);
    $bytes[6] = chr((ord($bytes[6]) & 0x0f) | 0x40);
    $bytes[8] = chr((ord($bytes[8]) & 0x3f) | 0x80);
    $hex = bin2hex($bytes);
    return sprintf('%s-%s-%s-%s-%s', substr($hex, 0, 8), substr($hex, 8, 4), substr($hex, 12, 4), substr($hex, 16, 4), substr($hex, 20, 12));
}
