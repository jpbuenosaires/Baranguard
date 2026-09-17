<?php
declare(strict_types=1);

/**
 * verify-auth-lockout-revocation.php — Sprint 8 "Auth/session revocation
 * + lockout evidence" box.
 *
 * Runs against a real running backend (default http://127.0.0.1:8081)
 * and real seeded `baranguard_uiseed` data, on `tanod.delacruz` — an
 * active, non-suspended seeded tanod deliberately different from
 * `tanod.olayvar` (which this session had incorrectly told the user to
 * use for manual testing — `tanod.olayvar` is actually `is_suspended=1`
 * in this seed, so login is *supposed* to reject it; the correction is
 * logged in DEVLOG.md) and from every account already used for the two
 * earlier Sprint 8 boxes this session. Mutates the target account's
 * password/lockout state during the run; resets both back to the
 * documented shared seed state (`Demo@2026`, zeroed counters) at the end
 * regardless of pass/fail, via a `register_shutdown_function`.
 *
 * Three things get real evidence, not just a read of the code:
 *   1. Login lockout — 5 failed attempts locks the account; even the
 *      CORRECT password is then rejected until the lock clears. The API
 *      response is deliberately the same generic 401 whether locked or
 *      just wrong (anti-enumeration, see AuthController::login()'s own
 *      comment) — so lockout can only be proven by combining "correct
 *      password now rejected" with a direct DB read of `locked_until`.
 *   2. Session revocation on logout — a token used after its own logout
 *      is rejected; a second logout call on an already-revoked session
 *      does not itself error (§6's documented idempotent-logout).
 *   3. Change-password revokes every OTHER active session for that user,
 *      but leaves the session that made the change valid.
 *
 * Usage: php scripts/verify-auth-lockout-revocation.php [base_url]
 */

$baseUrl = rtrim($argv[1] ?? 'http://127.0.0.1:8081/api/v1', '/');
$dbHost = '127.0.0.1';
$dbUser = 'root';
$dbPass = '';
$dbName = 'baranguard_uiseed';

$username = 'tanod.delacruz';
$originalPassword = 'Demo@2026';
$wrongPassword = 'WrongPassword#Nope';
$newPassword = 'TempAuthTest2026Pw';

$pass = 0;
$fail = 0;

function post(string $url, array $body, ?string $token = null): array
{
    $ch = curl_init($url);
    $headers = ['Content-Type: application/json'];
    if ($token !== null) {
        $headers[] = "Authorization: Bearer {$token}";
    }
    curl_setopt_array($ch, [
        CURLOPT_POST => true,
        CURLOPT_POSTFIELDS => json_encode($body),
        CURLOPT_HTTPHEADER => $headers,
        CURLOPT_RETURNTRANSFER => true,
        CURLOPT_TIMEOUT => 15,
    ]);
    $raw = curl_exec($ch);
    $status = (int) curl_getinfo($ch, CURLINFO_HTTP_CODE);
    curl_close($ch);
    $decoded = $raw !== false ? json_decode($raw, true) : null;
    return ['status' => $status, 'body' => $decoded];
}

function get(string $url, ?string $token = null): array
{
    $ch = curl_init($url);
    $headers = ['Accept: application/json'];
    if ($token !== null) {
        $headers[] = "Authorization: Bearer {$token}";
    }
    curl_setopt_array($ch, [CURLOPT_HTTPHEADER => $headers, CURLOPT_RETURNTRANSFER => true, CURLOPT_TIMEOUT => 15]);
    $raw = curl_exec($ch);
    $status = (int) curl_getinfo($ch, CURLINFO_HTTP_CODE);
    curl_close($ch);
    $decoded = $raw !== false ? json_decode($raw, true) : null;
    return ['status' => $status, 'body' => $decoded];
}

function record(string $label, bool $ok, string $detail = ''): void
{
    global $pass, $fail;
    if ($ok) {
        $pass++;
        echo "[PASS] {$label}" . ($detail !== '' ? " ({$detail})" : '') . "\n";
    } else {
        $fail++;
        echo "[FAIL] {$label}" . ($detail !== '' ? " — {$detail}" : '') . "\n";
    }
}

$pdo = new PDO("mysql:host={$dbHost};dbname={$dbName};charset=utf8mb4", $dbUser, $dbPass, [
    PDO::ATTR_ERRMODE => PDO::ERRMODE_EXCEPTION,
]);

// Always restore the account to its documented seed state, even on
// failure/exception — this is a shared disposable fixture other sessions
// (and the user) rely on matching uiseed-dao-demo.sql's own claim.
register_shutdown_function(function () use ($pdo, $username, $originalPassword) {
    $hash = password_hash($originalPassword, PASSWORD_ARGON2ID);
    $pdo->prepare(
        'UPDATE user SET password_hash = :hash, failed_login_attempts = 0,
         login_failure_window_started_at = NULL, locked_until = NULL, updated_at = UTC_TIMESTAMP()
         WHERE username = :username'
    )->execute(['hash' => $hash, 'username' => $username]);
    echo "\n[cleanup] {$username} password/lockout state reset to seed defaults (Demo@2026).\n";
});

echo "Baranguard auth lockout/revocation verification — " . gmdate('Y-m-d\TH:i:s\Z') . "\n";
echo "Target account: {$username} (baranguard_uiseed, restored on exit)\n\n";

// ============================================================
// Part 1: Login lockout
// ============================================================
echo "=== Part 1: Login lockout (5 failed attempts) ===\n";

$stmt = $pdo->prepare('SELECT failed_login_attempts, locked_until FROM user WHERE username = :u');
$stmt->execute(['u' => $username]);
$row = $stmt->fetch(PDO::FETCH_ASSOC);
record('Starting state is clean', (int) $row['failed_login_attempts'] === 0 && $row['locked_until'] === null,
    "attempts={$row['failed_login_attempts']} locked_until=" . ($row['locked_until'] ?? 'NULL'));

for ($i = 1; $i <= 5; $i++) {
    $r = post("{$baseUrl}/auth/login", ['username' => $username, 'password' => $wrongPassword]);
    $sameGenericShape = $r['status'] === 401
        && isset($r['body']['error']['code'], $r['body']['error']['message'])
        && $r['body']['error']['code'] === 'UNAUTHORIZED';
    record("Failed attempt {$i}/5 rejected with generic 401", $sameGenericShape, "status={$r['status']}");
}

$stmt->execute(['u' => $username]);
$row = $stmt->fetch(PDO::FETCH_ASSOC);
$lockedUntil = $row['locked_until'] !== null ? new DateTimeImmutable($row['locked_until'] . ' UTC') : null;
$now = new DateTimeImmutable('now', new DateTimeZone('UTC'));
record('DB shows account locked after 5th failure', (int) $row['failed_login_attempts'] === 5 && $lockedUntil !== null && $lockedUntil > $now,
    "attempts={$row['failed_login_attempts']} locked_until={$row['locked_until']}");

if ($lockedUntil !== null) {
    $minutesLocked = ($lockedUntil->getTimestamp() - $now->getTimestamp()) / 60;
    record('Lock duration is ~15 minutes (MAX_FAILED_ATTEMPTS policy)', $minutesLocked > 14 && $minutesLocked <= 15,
        round($minutesLocked, 1) . ' min remaining');
}

$r = post("{$baseUrl}/auth/login", ['username' => $username, 'password' => $originalPassword]);
record('CORRECT password is STILL rejected while locked (proves the lock, not just a bad password)',
    $r['status'] === 401 && ($r['body']['error']['code'] ?? null) === 'UNAUTHORIZED', "status={$r['status']}");

// Simulate the lock expiring (disposable seed data — safe to poke directly)
// rather than actually sleeping 15 minutes.
$pdo->prepare('UPDATE user SET locked_until = NULL WHERE username = :u')->execute(['u' => $username]);
$r = post("{$baseUrl}/auth/login", ['username' => $username, 'password' => $originalPassword]);
record('Correct password succeeds once the lock clears', $r['status'] === 200 && isset($r['body']['token']), "status={$r['status']}");

$stmt->execute(['u' => $username]);
$row = $stmt->fetch(PDO::FETCH_ASSOC);
record('A successful login resets failed_login_attempts to 0', (int) $row['failed_login_attempts'] === 0,
    "attempts={$row['failed_login_attempts']}");

// ============================================================
// Part 2: Session revocation on logout
// ============================================================
echo "\n=== Part 2: Session revocation on logout ===\n";

$login1 = post("{$baseUrl}/auth/login", ['username' => $username, 'password' => $originalPassword]);
$tokenA = $login1['body']['token'] ?? null;
record('Fresh login for Part 2 succeeds', is_string($tokenA), "status={$login1['status']}");

if ($tokenA !== null) {
    $before = get("{$baseUrl}/duty-status?user_id=me", $tokenA);
    record('Token works on a protected route before logout', $before['status'] === 200, "status={$before['status']}");

    $logoutResult = post("{$baseUrl}/auth/logout", [], $tokenA);
    record('Logout call succeeds', $logoutResult['status'] === 200, "status={$logoutResult['status']}");

    $after = get("{$baseUrl}/duty-status?user_id=me", $tokenA);
    record('SAME token rejected on the SAME route after logout (session revoked)', $after['status'] === 401, "status={$after['status']}");

    $secondLogout = post("{$baseUrl}/auth/logout", [], $tokenA);
    record('A second logout on an already-revoked session does not itself error (§6 idempotent logout)',
        $secondLogout['status'] === 200, "status={$secondLogout['status']}");
}

// ============================================================
// Part 3: change-password revokes every OTHER session, not this one
// ============================================================
echo "\n=== Part 3: change-password revokes other sessions ===\n";

$loginB1 = post("{$baseUrl}/auth/login", ['username' => $username, 'password' => $originalPassword]);
$tokenB1 = $loginB1['body']['token'] ?? null;
$loginB2 = post("{$baseUrl}/auth/login", ['username' => $username, 'password' => $originalPassword]);
$tokenB2 = $loginB2['body']['token'] ?? null;
record('Two independent sessions established', is_string($tokenB1) && is_string($tokenB2) && $tokenB1 !== $tokenB2);

if (is_string($tokenB1) && is_string($tokenB2)) {
    $changeResult = post("{$baseUrl}/auth/change-password", [
        'current_password' => $originalPassword,
        'new_password' => $newPassword,
    ], $tokenB1);
    record('change-password succeeds using session B1', $changeResult['status'] === 200, "status={$changeResult['status']}");

    $b1After = get("{$baseUrl}/duty-status?user_id=me", $tokenB1);
    record('Session B1 (the one that made the change) STILL WORKS', $b1After['status'] === 200, "status={$b1After['status']}");

    $b2After = get("{$baseUrl}/duty-status?user_id=me", $tokenB2);
    record('Session B2 (a DIFFERENT session, same user) is now revoked', $b2After['status'] === 401, "status={$b2After['status']}");

    // Prove the new password is actually live before shutdown restores it.
    $reLogin = post("{$baseUrl}/auth/login", ['username' => $username, 'password' => $newPassword]);
    record('New password logs in successfully (rehash actually took effect)', $reLogin['status'] === 200 && isset($reLogin['body']['token']));
}

echo "\n{$pass} passed, {$fail} failed.\n";
exit($fail > 0 ? 1 : 0);
