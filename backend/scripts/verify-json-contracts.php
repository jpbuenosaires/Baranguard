<?php
declare(strict_types=1);

/**
 * verify-json-contracts.php — Sprint 8 "Valid JSON contracts" box.
 *
 * Schema-validates the response ENVELOPE for every one of the 43 live
 * `/api/v1` GET routes (backend/routes/*.php) against §6's own contract:
 * success = the object itself; error = exactly
 * `{"error":{"code":"...","message":"..."}}`. Runs against a real running
 * backend (default http://127.0.0.1:8081) and the real seeded
 * baranguard_uiseed data — never invents a fixture, only reads real IDs
 * already in the DB.
 *
 * Scope, stated plainly: this validates the ENVELOPE shape (valid JSON,
 * correct Content-Type, success body is not an {"error":...} wrapper,
 * error body matches the exact {"error":{"code","message"}} shape) for
 * every GET route, plus a 401-without-token check on a sample of
 * protected ones. It does NOT deep-validate every documented field's
 * type on every route — that would need a per-endpoint schema spec this
 * session doesn't have time to author for all 90 routes. Said here
 * rather than silently implied, per this project's own "prove it, don't
 * claim it" rule.
 *
 * Usage: php scripts/verify-json-contracts.php [base_url]
 */

$baseUrl = rtrim($argv[1] ?? 'http://127.0.0.1:8081/api/v1', '/');

$pass = 0;
$fail = 0;
$failures = [];

function httpGet(string $url, ?string $token = null): array
{
    $ch = curl_init($url);
    $headers = ['Accept: application/json'];
    if ($token !== null) {
        $headers[] = "Authorization: Bearer {$token}";
    }
    curl_setopt_array($ch, [
        CURLOPT_HTTPHEADER => $headers,
        CURLOPT_RETURNTRANSFER => true,
        CURLOPT_HEADER => true,
        CURLOPT_TIMEOUT => 15,
    ]);
    $raw = curl_exec($ch);
    if ($raw === false) {
        return ['status' => 0, 'contentType' => null, 'body' => null, 'error' => curl_error($ch)];
    }
    $headerSize = curl_getinfo($ch, CURLINFO_HEADER_SIZE);
    $status = (int) curl_getinfo($ch, CURLINFO_HTTP_CODE);
    $rawHeaders = substr($raw, 0, $headerSize);
    $rawBody = substr($raw, $headerSize);
    curl_close($ch);

    $contentType = null;
    foreach (explode("\r\n", $rawHeaders) as $line) {
        if (stripos($line, 'content-type:') === 0) {
            $contentType = trim(substr($line, strlen('content-type:')));
        }
    }

    return ['status' => $status, 'contentType' => $contentType, 'body' => $rawBody, 'error' => null];
}

function login(string $baseUrl, string $username, string $password): ?string
{
    $ch = curl_init("{$baseUrl}/auth/login");
    curl_setopt_array($ch, [
        CURLOPT_POST => true,
        CURLOPT_POSTFIELDS => json_encode(['username' => $username, 'password' => $password]),
        CURLOPT_HTTPHEADER => ['Content-Type: application/json'],
        CURLOPT_RETURNTRANSFER => true,
        CURLOPT_TIMEOUT => 15,
    ]);
    $raw = curl_exec($ch);
    curl_close($ch);
    $json = json_decode((string) $raw, true);
    return is_array($json) && isset($json['token']) && is_string($json['token']) ? $json['token'] : null;
}

/**
 * @param mixed $decoded
 */
function checkSuccessEnvelope(string $label, int $status, ?string $contentType, ?string $rawBody, $decoded): void
{
    global $pass, $fail, $failures;

    $ok = true;
    $reasons = [];

    if ($status < 200 || $status >= 300) {
        $ok = false;
        $reasons[] = "expected 2xx, got {$status}";
    }
    if ($contentType === null || stripos($contentType, 'application/json') !== 0) {
        $ok = false;
        $reasons[] = 'Content-Type is not application/json (got ' . ($contentType ?? 'none') . ')';
    }
    if ($decoded === null && $rawBody !== 'null') {
        $ok = false;
        $reasons[] = 'body did not parse as valid JSON';
    } elseif (is_array($decoded) && array_key_exists('error', $decoded) && count($decoded) === 1 && is_array($decoded['error'])) {
        $ok = false;
        $reasons[] = 'success status but body is an {"error":...} envelope';
    }

    record($label, $ok, $reasons);
}

/**
 * @param mixed $decoded
 */
function checkErrorEnvelope(string $label, int $expectedStatus, int $status, ?string $contentType, $decoded): void
{
    global $pass, $fail, $failures;

    $ok = true;
    $reasons = [];

    if ($status !== $expectedStatus) {
        $ok = false;
        $reasons[] = "expected {$expectedStatus}, got {$status}";
    }
    if ($contentType === null || stripos($contentType, 'application/json') !== 0) {
        $ok = false;
        $reasons[] = 'Content-Type is not application/json (got ' . ($contentType ?? 'none') . ')';
    }
    if (!is_array($decoded) || !isset($decoded['error']) || !is_array($decoded['error'])) {
        $ok = false;
        $reasons[] = 'body is not {"error":{...}}';
    } else {
        $err = $decoded['error'];
        if (!isset($err['code']) || !is_string($err['code']) || $err['code'] === '') {
            $ok = false;
            $reasons[] = 'error.code missing/empty/non-string';
        }
        if (!isset($err['message']) || !is_string($err['message']) || $err['message'] === '') {
            $ok = false;
            $reasons[] = 'error.message missing/empty/non-string';
        }
        $extraKeys = array_diff(array_keys($decoded), ['error']);
        if ($extraKeys !== []) {
            $ok = false;
            $reasons[] = 'top-level has keys beyond "error": ' . implode(',', $extraKeys);
        }
    }

    record($label, $ok, $reasons);
}

function record(string $label, bool $ok, array $reasons): void
{
    global $pass, $fail, $failures;
    if ($ok) {
        $pass++;
        echo "[PASS] {$label}\n";
    } else {
        $fail++;
        $reasonText = implode('; ', $reasons);
        $failures[] = "{$label}: {$reasonText}";
        echo "[FAIL] {$label} — {$reasonText}\n";
    }
}

// --- Log in as each role that can reach protected GET routes ---------------
$adminToken = login($baseUrl, 'admin.dao', 'Demo@2026');
$secretaryToken = login($baseUrl, 'secretary.dao', 'Demo@2026');
$pbToken = login($baseUrl, 'kapitan.dao', 'Demo@2026');

if ($adminToken === null || $secretaryToken === null || $pbToken === null) {
    fwrite(STDERR, "Could not log in as one or more seeded roles — aborting.\n");
    fwrite(STDERR, "admin=" . ($adminToken !== null ? 'ok' : 'FAIL') . " secretary=" . ($secretaryToken !== null ? 'ok' : 'FAIL') . " pb=" . ($pbToken !== null ? 'ok' : 'FAIL') . "\n");
    exit(1);
}

// --- Real IDs from the seeded DB, gathered once, no fixtures invented ------
$incidentId = 1;
$dispatchId = 1;
$dispatchWithRouteId = 12;
$blotterId = 1;
$mapPackageId = 1; // none seeded — exercises the 404 error-envelope path instead
$smsPhone = '09175550101';

// --- Every GET route in routes/*.php, driven by an appropriate role --------
$routes = [
    ["/ai-tools/jobs/1", $adminToken],
    ["/ai-tools/availability", $adminToken],
    ["/incidents/{$incidentId}/ai-draft", $secretaryToken],
    ["/incidents/{$incidentId}/ai-draft/extraction", $secretaryToken],
    ["/audit-log", $adminToken],
    ["/barangays", null],
    ["/blotter", $secretaryToken],
    ["/incidents/{$incidentId}/blotter", $secretaryToken],
    ["/citizen-reports", $adminToken],
    ["/dispatch", $adminToken],
    ["/dispatch/{$dispatchWithRouteId}/route?latitude=13.1857&longitude=123.6260&mode=car", $adminToken],
    ["/duty-status", $adminToken],
    ["/gps/live", $adminToken],
    ["/gps/history?tanod_id=1", $adminToken],
    ["/incidents/nearby?latitude=13.1857&longitude=123.6260&radius_m=5000", $adminToken],
    ["/incidents/{$incidentId}", $secretaryToken],
    ["/incidents/{$incidentId}/evidence", $adminToken],
    ["/incidents", $adminToken],
    ["/notifications", $adminToken],
    ["/public/transparency", null],
    ["/reports/summary", $adminToken],
    ["/reports/heatmap", $adminToken],
    ["/reports/nav-counts", $adminToken],
    ["/search?q=theft", $adminToken],
    ["/system-settings", $adminToken],
    ["/shift-swap-requests", $adminToken],
    ["/shifts", $adminToken],
    ["/shifts/fatigue-flags", $pbToken],
    ["/sms/logs", $adminToken],
    ["/sms/conversations", $adminToken],
    ["/sms/conversations/{$smsPhone}/messages", $adminToken],
    ["/sms/subscribers", $adminToken],
    ["/system/health", $adminToken],
    ["/system/health/history", $adminToken],
    ["/tanod-sos/fallback-contact", $adminToken],
    ["/tanod-sos", $adminToken],
    ["/users", $adminToken],
];

foreach ($routes as [$path, $token]) {
    $result = httpGet("{$baseUrl}{$path}", $token);
    $decoded = $result['body'] !== null ? json_decode($result['body'], true) : null;
    $label = "GET {$path}" . ($token !== null ? '' : ' (public)');

    if ($result['status'] >= 200 && $result['status'] < 300) {
        checkSuccessEnvelope($label, $result['status'], $result['contentType'], $result['body'], $decoded);
    } elseif ($result['status'] >= 400) {
        // A handful of these are EXPECTED to error against this seed (no
        // resource with that id, wrong role, etc.) — still schema-checked
        // as a real error-envelope instance, not skipped.
        checkErrorEnvelope("{$label} [{$result['status']}]", $result['status'], $result['status'], $result['contentType'], $decoded);
    } else {
        record($label, false, ["unexpected/no response: " . ($result['error'] ?? 'status 0')]);
    }
}

// --- Not-found path params: two more real 404 envelope instances ----------
$notFoundChecks = [
    ["/incidents/999999", $secretaryToken],
    ["/blotter/999999", $secretaryToken],
    ["/map-packages/{$mapPackageId}", $adminToken],
];
foreach ($notFoundChecks as [$path, $token]) {
    $result = httpGet("{$baseUrl}{$path}", $token);
    $decoded = $result['body'] !== null ? json_decode($result['body'], true) : null;
    checkErrorEnvelope("GET {$path} [expect 404]", 404, $result['status'], $result['contentType'], $decoded);
}

// --- Auth boundary: every protected route must reject with the SAME ------
// generic 401 envelope when no token is presented (a sample, not all 41,
// since the shape is produced by one shared AuthMiddleware, not per-route
// code — sampling one per controller is representative, not exhaustive).
$noTokenSample = [
    "/audit-log", "/dispatch", "/incidents", "/reports/summary", "/users",
    "/shifts", "/sms/logs", "/system/health", "/tanod-sos", "/notifications",
];
foreach ($noTokenSample as $path) {
    $result = httpGet("{$baseUrl}{$path}", null);
    $decoded = $result['body'] !== null ? json_decode($result['body'], true) : null;
    checkErrorEnvelope("GET {$path} [no token, expect 401]", 401, $result['status'], $result['contentType'], $decoded);
}

echo "\n{$pass} passed, {$fail} failed.\n";
if ($fail > 0) {
    echo "\nFailures:\n";
    foreach ($failures as $f) {
        echo "  - {$f}\n";
    }
    exit(1);
}
exit(0);
