<?php
declare(strict_types=1);

/**
 * gsm-ingest-daemon.php — reads inbound SMS off a tethered Android phone
 * over `adb` and forwards each one to the matching `/internal/sms/*`
 * handler. §6 "Internal SMS / GSM": "the real GSM ingestion process
 * (reading messages off the tethered phone)" — the half
 * `scripts/sms-envelope-build.php` stood in for while no hardware
 * existed (see that script's own doc block, and DEVLOG.md's
 * "GSM-modem INBOUND ingestion... is NOT trimmed" note). A5
 * (docs/REMAINING.md) unblocks this once hardware is available.
 *
 * WIRE FORMAT, DEFINED HERE (nothing upstream had ever defined one — the
 * mobile side never built on-device SMS *sending* either, see
 * `mobile/src/services/smsFallbackState.ts`'s own header comment): the
 * SMS body is the EXACT flat JSON envelope §6 documents for
 * `POST /internal/sms/*` — the same shape `sms-envelope-build.php`
 * already prints. No new encoding invented; the proven contract is
 * reused verbatim, so a real phone's SMS app and this daemon need to
 * agree on nothing beyond "send this JSON as the message text."
 *
 * THIS PROCESS NEVER DECRYPTS ANYTHING. It only reads a body string off
 * the phone and forwards it byte-for-byte as the request body — the
 * ciphertext stays ciphertext all the way to `EnvelopeCrypto` inside the
 * backend. Nothing here ever holds a device's `message_encryption_key`
 * or plaintext narrative, so this script's own output discipline (like
 * `ai-worker.php`'s) is easy to keep: identifiers and statuses only.
 *
 * Runs on THIS workstation, over loopback, same as `public/internal.php`
 * requires (§2 Rule 7). `INTERNAL_SERVICE_TOKEN` must be configured or
 * every forward attempt 401s — this is a real requirement, not a
 * decoration: unlike `ai-worker.php`, `/internal/sms/*` is a normal
 * `curl`-able HTTP endpoint with no other identity to fall back on.
 *
 * Usage (from backend/):
 *   php scripts/gsm-ingest-daemon.php --once        one poll, then exit
 *   php scripts/gsm-ingest-daemon.php --daemon       keep polling (Ctrl-C to stop)
 *   php scripts/gsm-ingest-daemon.php --status        print state + reachability, exit
 *   php scripts/gsm-ingest-daemon.php --interval=10   seconds between polls in --daemon (default 10)
 *   php scripts/gsm-ingest-daemon.php --device=<serial>   adb -s <serial>, if more than one device
 *   php scripts/gsm-ingest-daemon.php --adb=<path>    override the adb binary path
 *   php scripts/gsm-ingest-daemon.php --source=<file> TEST ONLY: read a file containing `adb shell
 *                                      content query` output instead of shelling to a real adb —
 *                                      lets this script's parsing/dispatch logic run and be
 *                                      verified with no phone attached.
 *
 * State: `backend/storage/gsm-ingest-state.json` — `{"last_id": N}`, the
 * highest SMS-inbox `_id` this daemon has FINISHED with (forwarded
 * successfully, or conclusively not-for-us). A transient failure
 * (network blip, workstation-side 5xx) does NOT advance past that
 * message — the next poll retries it. A message that isn't valid JSON,
 * or whose `message_type` isn't one of the four inbound types, is
 * logged and skipped for good (retrying garbage forever helps nobody).
 */

if (PHP_SAPI !== 'cli') {
    http_response_code(404);
    exit(1);
}

require dirname(__DIR__) . '/config/env.php';
baranguard_load_env();

$options = parseArguments($argv);
$interval = isset($options['interval']) ? max(1, (int) $options['interval']) : 10;
$adbPath = $options['adb'] ?? 'C:/Users/JAYSON~1/AppData/Local/Android/Sdk/platform-tools/adb.exe';
$deviceSerial = $options['device'] ?? null;
$sourceFile = $options['source'] ?? null;

$baseUrl = rtrim((string) baranguard_env('INTERNAL_SMS_BASE_URL') ?: 'http://127.0.0.1:8081', '/');
$token = baranguard_env('INTERNAL_SERVICE_TOKEN');

$stateFile = dirname(__DIR__) . '/storage/gsm-ingest-state.json';

/** @return array<string,mixed> */
function loadState(string $stateFile): array
{
    if (!is_file($stateFile)) {
        return ['last_id' => 0];
    }
    $raw = file_get_contents($stateFile);
    $decoded = $raw !== false ? json_decode($raw, true) : null;
    return is_array($decoded) && isset($decoded['last_id']) ? $decoded : ['last_id' => 0];
}

function saveState(string $stateFile, int $lastId): void
{
    $dir = dirname($stateFile);
    if (!is_dir($dir)) {
        mkdir($dir, 0750, true);
    }
    file_put_contents($stateFile, json_encode(['last_id' => $lastId], JSON_PRETTY_PRINT));
}

function out(string $line): void
{
    echo '[' . gmdate('Y-m-d\TH:i:s\Z') . '] ' . $line . PHP_EOL;
}

/**
 * Shells out to `adb shell content query`, `body` projected LAST
 * deliberately — an SMS body can contain commas/`=`/anything, and only
 * being last lets the parser below treat "everything after the last
 * `body=`, to end of line" as the real text without it corrupting the
 * fields that come before it.
 */
function readInboxViaAdb(string $adbPath, ?string $deviceSerial): string
{
    $args = [$adbPath];
    if ($deviceSerial !== null) {
        $args[] = '-s';
        $args[] = $deviceSerial;
    }
    array_push($args, 'shell', 'content', 'query', '--uri', 'content://sms/inbox', '--projection', '_id:address:date:body');

    $cmd = implode(' ', array_map(
        static fn (string $a): string => '"' . str_replace('"', '\\"', $a) . '"',
        $args
    ));

    $descriptors = [1 => ['pipe', 'w'], 2 => ['pipe', 'w']];
    $process = proc_open($cmd, $descriptors, $pipes);
    if (!is_resource($process)) {
        throw new RuntimeException('Could not start adb.');
    }
    $stdout = stream_get_contents($pipes[1]) ?: '';
    $stderr = stream_get_contents($pipes[2]) ?: '';
    fclose($pipes[1]);
    fclose($pipes[2]);
    $exitCode = proc_close($process);

    if ($exitCode !== 0) {
        throw new RuntimeException('adb exited ' . $exitCode . ($stderr !== '' ? (': ' . trim($stderr)) : ''));
    }
    return $stdout;
}

/**
 * Parses `adb shell content query` output into rows. Real device output
 * looks like:
 *   Row: 0 _id=3, address=+639171234567, date=1758186000000, body={"version":"1",...}
 * `content query` prints "No result found." (no "Row:" lines) when the
 * inbox is empty — that is handled by simply returning an empty array,
 * not an error.
 *
 * @return list<array{id:int,address:string,date:int,body:string}>
 */
function parseContentQueryOutput(string $raw): array
{
    $rows = [];
    foreach (preg_split('/\R/', $raw) as $line) {
        if (!str_starts_with($line, 'Row:')) {
            // 2026-09-19, seen on the real Infinix inbox: a body containing a
            // newline prints as a continuation line with no "Row:" prefix.
            // Re-attach it to the row above instead of silently truncating.
            if ($rows !== [] && $line !== '') {
                $rows[array_key_last($rows)]['body'] .= "
" . $line;
            }
            continue;
        }
        if (!preg_match('/_id=(\d+), address=(.*?), date=(\d+), body=(.*)$/s', $line, $m)) {
            continue;
        }
        $rows[] = [
            'id' => (int) $m[1],
            'address' => $m[2],
            'date' => (int) $m[3],
            'body' => $m[4],
        ];
    }
    return $rows;
}

/** Maps an envelope's `message_type` to its `/internal/sms/*` path, or null if it isn't an inbound type. */
function endpointForMessageType(string $messageType): ?string
{
    return match ($messageType) {
        'incident_fallback' => '/internal/sms/incident-fallback',
        'coord_ping' => '/internal/sms/coord-ping',
        'duty_status' => '/internal/sms/duty-status',
        'sos' => '/internal/sms/sos',
        default => null, // dispatch_payload/priority_alert are OUTBOUND-only (InternalSmsController's own doc) — never expected here.
    };
}

/** @return array{status:int,body:?array<string,mixed>} */
function forwardEnvelope(string $baseUrl, string $path, string $rawEnvelopeJson, string $token): array
{
    $ch = curl_init($baseUrl . $path);
    curl_setopt_array($ch, [
        CURLOPT_POST => true,
        CURLOPT_POSTFIELDS => $rawEnvelopeJson,
        CURLOPT_HTTPHEADER => ['Content-Type: application/json', "X-Internal-Token: {$token}"],
        CURLOPT_RETURNTRANSFER => true,
        CURLOPT_TIMEOUT => 15,
    ]);
    $raw = curl_exec($ch);
    if ($raw === false) {
        $error = curl_error($ch);
        curl_close($ch);
        throw new RuntimeException('Could not reach the workstation API: ' . $error);
    }
    $status = (int) curl_getinfo($ch, CURLINFO_HTTP_CODE);
    curl_close($ch);
    $decoded = json_decode((string) $raw, true);
    return ['status' => $status, 'body' => is_array($decoded) ? $decoded : null];
}

/** One poll: read the inbox, forward every new row, update state. Returns [forwarded, skipped]. */
function pollOnce(
    string $adbPath,
    ?string $deviceSerial,
    ?string $sourceFile,
    string $stateFile,
    string $baseUrl,
    string|false $token
): array {
    $raw = $sourceFile !== null ? (file_get_contents($sourceFile) ?: '') : readInboxViaAdb($adbPath, $deviceSerial);
    $rows = parseContentQueryOutput($raw);

    $state = loadState($stateFile);
    $lastId = (int) $state['last_id'];

    $forwarded = 0;
    $skipped = 0;

    foreach ($rows as $row) {
        if ($row['id'] <= $lastId) {
            continue; // Already handled in a previous poll.
        }

        $addressMasked = preg_replace('/\d(?=\d{4})/', '*', $row['address']) ?? '(unreadable)';

        $envelope = json_decode($row['body'], true);
        if (!is_array($envelope) || !isset($envelope['message_type']) || !is_string($envelope['message_type'])) {
            out("[sms _id={$row['id']} from={$addressMasked}] SKIPPED — not a Baranguard envelope (not JSON, or missing message_type). Likely carrier notice or a wrong-number text.");
            $lastId = $row['id'];
            $skipped++;
            continue;
        }

        $path = endpointForMessageType($envelope['message_type']);
        if ($path === null) {
            out("[sms _id={$row['id']} from={$addressMasked}] SKIPPED — message_type '{$envelope['message_type']}' is not a valid INBOUND type.");
            $lastId = $row['id'];
            $skipped++;
            continue;
        }

        if ($token === false || trim($token) === '') {
            out("[sms _id={$row['id']}] NOT FORWARDED — INTERNAL_SERVICE_TOKEN is not configured. Left for the next poll once it is.");
            break; // Same message every row would hit; stop this poll rather than spam it per-row.
        }

        try {
            $result = forwardEnvelope($baseUrl, $path, $row['body'], $token);
        } catch (RuntimeException $e) {
            out("[sms _id={$row['id']}] NOT FORWARDED — {$e->getMessage()}. Left for the next poll.");
            break; // Workstation-side problem, not a per-message one — stop and retry everything from here next time.
        }

        if ($result['status'] >= 200 && $result['status'] < 300) {
            $resultId = is_array($result['body']) ? (reset($result['body']) ?: '?') : '?';
            out("[sms _id={$row['id']} type={$envelope['message_type']} from={$addressMasked}] forwarded to {$path} -> {$result['status']} (result={$resultId})");
            $lastId = $row['id'];
            $forwarded++;
        } elseif ($result['status'] === 422) {
            // §6/EnvelopeException: "deliberately generic — no detail that
            // would help distinguish WHY an envelope was rejected." A
            // replayed/expired/tampered/unknown-device envelope all look
            // identical here on purpose (same class of denial Rule 13
            // uses elsewhere) — terminal for THIS message either way.
            out("[sms _id={$row['id']} type={$envelope['message_type']}] SKIPPED — envelope rejected (expired/replayed/unknown device/tampered — indistinguishable by design).");
            $lastId = $row['id'];
            $skipped++;
        } else {
            out("[sms _id={$row['id']} type={$envelope['message_type']}] NOT FORWARDED — unexpected status {$result['status']}. Left for the next poll.");
            break;
        }
    }

    saveState($stateFile, $lastId);
    return [$forwarded, $skipped];
}

// --- Entry point -------------------------------------------------------

if ($options['status']) {
    $state = loadState($stateFile);
    out('last processed SMS-inbox _id: ' . (int) $state['last_id']);
    out('INTERNAL_SERVICE_TOKEN configured: ' . ($token !== false && trim((string) $token) !== '' ? 'yes' : 'NO — every forward will fail until this is set'));
    if ($sourceFile === null) {
        try {
            readInboxViaAdb($adbPath, $deviceSerial);
            out('adb reachable, tethered phone responds to content query.');
        } catch (RuntimeException $e) {
            out('adb NOT reachable: ' . $e->getMessage());
        }
    } else {
        out("using --source fixture file, not a real device: {$sourceFile}");
    }
    exit(0);
}

if (!$options['once'] && !$options['daemon']) {
    fwrite(STDERR, "Specify --once, --daemon, or --status. See this script's own header for usage.\n");
    exit(1);
}

do {
    try {
        [$forwarded, $skipped] = pollOnce($adbPath, $deviceSerial, $sourceFile, $stateFile, $baseUrl, $token);
        if ($forwarded > 0 || $skipped > 0) {
            out("poll complete — {$forwarded} forwarded, {$skipped} skipped.");
        }
    } catch (RuntimeException $e) {
        out('poll FAILED — ' . $e->getMessage());
    }

    if ($options['daemon']) {
        sleep($interval);
    }
} while ($options['daemon']);

/** @param string[] $argv @return array<string,mixed> */
function parseArguments(array $argv): array
{
    $options = ['once' => false, 'daemon' => false, 'status' => false];
    foreach (array_slice($argv, 1) as $argument) {
        if ($argument === '--once') {
            $options['once'] = true;
        } elseif ($argument === '--daemon') {
            $options['daemon'] = true;
        } elseif ($argument === '--status') {
            $options['status'] = true;
        } elseif (str_starts_with($argument, '--') && str_contains($argument, '=')) {
            [$key, $value] = explode('=', substr($argument, 2), 2);
            $options[$key] = $value;
        }
    }
    return $options;
}
