<?php
declare(strict_types=1);

namespace Baranguard\Services\Notifications;

/**
 * LocalGsmOutboundClient — replaces `SemaphoreClient` (removed 2026-09-23,
 * explicit user decision: a paid per-SMS aggregator cost too much for this
 * project's actual volume, see DEVLOG.md). Sends outbound SMS through the
 * SAME tethered Android phone `gsm-ingest-daemon.php` already reads
 * INBOUND SMS off (§1's "GSM modem" — now genuinely bidirectional, no
 * separate hardware).
 *
 * MECHANISM: a small companion Android app (`sms-gateway/`, its own
 * standalone Gradle project, NOT part of the Capacitor Tanod app) runs a
 * single `BroadcastReceiver` (`SendSmsReceiver.java`) that calls
 * `SmsManager.sendTextMessage()`/`sendMultipartTextMessage()` using the
 * phone's own SIM. This class triggers it via `adb shell am broadcast`
 * (an explicit, targeted broadcast — not an implicit one Android would
 * restrict) and reads the result back via `adb logcat`, filtering for that
 * app's own "BaranguardSmsGateway" tag and this call's `correlation_id`.
 * Same trust boundary and same "shell out to adb, no network call this
 * phone has to make" design `gsm-ingest-daemon.php` already established
 * for the read side — deliberately NOT a phone-side HTTP server polling
 * the backend, which would need its own auth story this design avoids
 * entirely (adb access to a physically-controlled device already IS the
 * authorization).
 *
 * COST: sends over the gateway phone's own SIM plan, not a per-message
 * aggregator fee — the entire point of this replacement.
 *
 * CONFIGURATION (.env — see .env.example): `GSM_GATEWAY_ENABLED` (must be
 * explicitly `true`; unset/false means `isConfigured()` is false, exactly
 * mirroring how an absent `SEMAPHORE_API_KEY` used to behave — §2 Rule 6,
 * `not_configured` stays neutral, never silently attempted).
 * `GSM_GATEWAY_ADB_PATH` (optional override; same auto-detection
 * `gsm-ingest-daemon.php` uses if unset — see `defaultAdbPath()` below).
 * `GSM_GATEWAY_DEVICE_SERIAL`
 * (optional; only needed if more than one device is ever attached at
 * once).
 *
 * TIMEOUT MECHANISM (2026-09-24): `dispatch()` IS real timeout-bound now
 * — see `runWithTimeout()`'s own doc block for why plain `exec()`/
 * `proc_open()` couldn't do this on Windows PHP, and why a PowerShell
 * wrapper using .NET's `Process.WaitForExit(ms)` was used instead (a
 * genuinely different, working mechanism, not the same broken approach
 * retried).
 */
class LocalGsmOutboundClient
{
    private const RECEIVER_ACTION = 'ph.baranguard.smsgateway.SEND';
    private const RECEIVER_COMPONENT = 'ph.baranguard.smsgateway/.SendSmsReceiver';
    // The Infinix (HiOS) puts a background app in a "Hiber/broadcast restricted" queue: a broadcast to the
    // gateway app 15 s after it left the foreground was silently NOT delivered (result=0, nothing sent).
    // Bringing the app to the front right before each send fixes it (checked on the device 2026-11-07).
    private const WAKE_COMPONENT = 'ph.baranguard.smsgateway/.MainActivity';
    // The app appends every RESULT line here (the phone's log buffer loses it within ~2 min, the carrier
    // result takes ~60 s). adb's shell user can read it.
    private const RESULT_FILE = '/sdcard/Android/data/ph.baranguard.smsgateway/files/results.log';
    // Real device, 2026-09-23: `am broadcast` waiting on this receiver's
    // goAsync() finish() (itself gated on the carrier's own sent-status
    // callback) took up to ~60s under this specific phone's OEM
    // background-freeze churn. 12s is deliberately shorter than that
    // observed worst case — a send that times out here may still have
    // gone out on the phone (this only bounds how long THIS PROCESS
    // waits), and 12s keeps an SOS-triggering request from hanging a
    // full minute. Tune upward if legitimate sends start timing out more
    // than rarely; this number came from one real device's worst case,
    // not an exhaustive study.
    private const BROADCAST_TIMEOUT_SECONDS = 12;
    /** Sentinel our own PowerShell wrapper script exits with on a real timeout kill — distinct from any real adb.exe exit code. */
    private const TIMEOUT_EXIT_CODE = 124;
    private const RESULT_POLL_ATTEMPTS = 4;
    private const RESULT_POLL_DELAY_MICROSECONDS = 700_000; // 0.7s between polls, ~7s total.
    // Each poll attempt's own bound (not yet device-tuned — a stuck adb
    // connection during a `logcat -d` dump should never be able to hang
    // longer than this, worst case ~10*(0.7s+3s) if every attempt times out.
    private const POLL_TIMEOUT_SECONDS = 3;
    private const MAX_MESSAGE_LENGTH = 1600; // 10 concatenated GSM-7 SMS segments — generous; SmsManager itself declines to send anything absurd.
    private const POWERSHELL_PATH = 'C:/Windows/System32/WindowsPowerShell/v1.0/powershell.exe';

    private bool $enabled;
    private string $adbPath;
    private ?string $deviceSerial;

    public function __construct(?bool $enabled = null, ?string $adbPath = null, ?string $deviceSerial = null)
    {
        $this->enabled = $enabled ?? (baranguard_env('GSM_GATEWAY_ENABLED') === 'true');
        $this->adbPath = $adbPath ?? (baranguard_env('GSM_GATEWAY_ADB_PATH') ?: self::defaultAdbPath());
        $deviceSerial = $deviceSerial ?? (baranguard_env('GSM_GATEWAY_DEVICE_SERIAL') ?: null);
        $this->deviceSerial = ($deviceSerial !== null && trim($deviceSerial) !== '') ? $deviceSerial : null;
    }

    /**
     * Was a hardcoded `C:/Users/JAYSON~1/...` path — real on the machine it
     * was written on, silently wrong on every other one (`isConfigured()`
     * would just report false, with no clue why, since `is_file()` on a
     * nonexistent path is not an error). Same fallback order as
     * `gsm-ingest-daemon.php`'s `resolveAdbPath()`: the standard Android
     * Studio SDK location under LOCALAPPDATA, then ANDROID_HOME/
     * ANDROID_SDK_ROOT if set, then a bare `adb` relying on PATH.
     */
    private static function defaultAdbPath(): string
    {
        $localAppData = getenv('LOCALAPPDATA');
        if ($localAppData !== false && $localAppData !== '') {
            $candidate = $localAppData . '/Android/Sdk/platform-tools/adb.exe';
            if (is_file($candidate)) {
                return $candidate;
            }
        }
        foreach (['ANDROID_HOME', 'ANDROID_SDK_ROOT'] as $envVar) {
            $root = getenv($envVar);
            if ($root !== false && $root !== '') {
                $candidate = rtrim($root, '/\\') . '/platform-tools/adb.exe';
                if (is_file($candidate)) {
                    return $candidate;
                }
            }
        }
        return 'adb';
    }

    public function isConfigured(): bool
    {
        return $this->enabled && is_file($this->adbPath);
    }

    /**
     * @return array{gateway_message_id:string}
     * @throws GsmGatewayException
     */
    public function send(string $phoneNumber, string $message): array
    {
        return $this->dispatch($phoneNumber, $message);
    }

    /**
     * No separate "priority" transport exists on this phone's own SIM the
     * way Semaphore offered a distinct priority API route — a native SMS
     * IS already the fastest path this hardware has. Kept as a separate
     * method only so `SmsGatewayService::sendOutbound()`'s call site
     * (`$priority ? ...->sendPriority() : ...->send()`) needs no change.
     *
     * @return array{gateway_message_id:string}
     * @throws GsmGatewayException
     */
    public function sendPriority(string $phoneNumber, string $message): array
    {
        return $this->dispatch($phoneNumber, $message);
    }

    /** @return array{gateway_message_id:string} */
    private function dispatch(string $phoneNumber, string $message): array
    {
        if (!$this->isConfigured()) {
            throw new GsmGatewayException('The local GSM SMS gateway is not configured (set GSM_GATEWAY_ENABLED=true and confirm GSM_GATEWAY_ADB_PATH).');
        }
        if (mb_strlen($message) > self::MAX_MESSAGE_LENGTH) {
            $message = mb_substr($message, 0, self::MAX_MESSAGE_LENGTH - 1) . '…';
        }
        $phoneNumber = trim($phoneNumber);
        if ($phoneNumber === '') {
            throw new GsmGatewayException('No destination phone number was given.');
        }

        $correlationId = bin2hex(random_bytes(16));

        // `adb shell` re-joins ALL of its own remaining arguments with a
        // single space and sends that as ONE string for the REMOTE
        // Android shell to parse — it does NOT preserve individual
        // multi-word arguments as atomic tokens the way a normal local
        // exec() would. Quoting each token with PHP's escapeshellarg()
        // (confirmed the hard way, real device: `body`/`correlation_id`
        // both got corrupted this way, `correlation_id` arrived as
        // literally "unknown" on the receiver side) only protects the
        // LOCAL hop (this workstation's shell invoking adb.exe) — the
        // `to`/`body`/`correlation_id` values then get word-split AGAIN
        // by the remote shell unless the ENTIRE "am broadcast ..." command
        // is built as one already-POSIX-shell-quoted string and passed to
        // `adb shell` as a single argument.
        $remoteArgs = [
            'am', 'broadcast',
            '-a', self::RECEIVER_ACTION,
            '-n', self::RECEIVER_COMPONENT,
            '--es', 'to', $phoneNumber,
            '--es', 'body', $message,
            '--es', 'correlation_id', $correlationId,
        ];
        $remoteCommand = implode(' ', array_map(self::posixShellQuote(...), $remoteArgs));

        $adbArgs = [];
        if ($this->deviceSerial !== null) {
            $adbArgs[] = '-s';
            $adbArgs[] = $this->deviceSerial;
        }
        $adbArgs[] = 'shell';
        $adbArgs[] = $remoteCommand;

        $wakeArgs = $this->deviceSerial !== null ? ['-s', $this->deviceSerial] : [];
        array_push($wakeArgs, 'shell', 'am start -n ' . self::WAKE_COMPONENT);
        self::runWithTimeout($this->adbPath, $wakeArgs, 5); // best effort: a failure here shows up as an undelivered broadcast below
        usleep(400_000);

        // `adb shell am broadcast` waits for the receiver's `goAsync()`
        // PendingResult to finish before returning — and this receiver's
        // `finish()` is only called once the SMS's own carrier-confirmed
        // sent/failed result arrives (real device, 2026-09-23: observed up
        // to ~60s under this phone's OEM background-freeze churn). This
        // transport backs the SOS fallback ladder, so a genuinely stuck
        // gateway must not hang whatever request triggered a send
        // (possibly a Tanod's own emergency POST) — bounded via
        // `runWithTimeout()`.
        $startedAt = microtime(true);
        [$exitCode, $output] = self::runWithTimeout($this->adbPath, $adbArgs, self::BROADCAST_TIMEOUT_SECONDS);
        $elapsed = microtime(true) - $startedAt;

        if ($exitCode === self::TIMEOUT_EXIT_CODE) {
            // Only THIS process stopped waiting; the broadcast may already have been delivered,
            // so this is "unconfirmed", not "failed" (Rule 6).
            throw new GsmUnconfirmedException("The gateway phone did not answer within " . self::BROADCAST_TIMEOUT_SECONDS . "s (correlation_id={$correlationId}); the SMS may still have been sent. " . $output, $correlationId);
        }
        if ($exitCode !== 0) {
            throw new GsmGatewayException('adb could not reach the gateway phone: ' . $output);
        }

        if (self::broadcastNotDelivered($output, $elapsed)) {
            throw new GsmGatewayException("The gateway app did not receive the send (it was asleep or is not installed on the phone); nothing was sent (correlation_id={$correlationId}).");
        }

        // The app answers inside the broadcast result ("Broadcast completed: result=1, data=\"RESULT ... status=sent ...\"");
        // older builds only logged it, so fall back to polling logcat.
        $status = self::statusFromBroadcastOutput($output, $correlationId) ?? $this->pollForResult($correlationId);
        if ($status === 'sent') {
            return ['gateway_message_id' => $correlationId];
        }
        if ($status === 'failed') {
            throw new GsmGatewayException("The gateway phone reported the send failed (correlation_id={$correlationId}).");
        }

        // No result line within the poll window: the carrier result may just
        // be slow (~60 s observed). The SMS may well have gone out, so this is
        // "unconfirmed", not "failed" (Rule 6: claim neither).
        throw new GsmUnconfirmedException("No delivery confirmation from the gateway phone within " . (self::RESULT_POLL_ATTEMPTS * self::RESULT_POLL_DELAY_MICROSECONDS / 1_000_000) . "s (correlation_id={$correlationId}); it may still have been sent.", $correlationId);
    }

    /** POSIX single-quote wrapping for a token that will be parsed by the REMOTE Android shell (via `adb shell <one string>`), not this workstation's own. */
    private static function posixShellQuote(string $value): string
    {
        return "'" . str_replace("'", "'\\''", $value) . "'";
    }

    /**
     * Runs `$adbPath $adbArgs` with a REAL enforced timeout.
     *
     * WHY NOT PLAIN `exec()`/`proc_open()`: a 2026-09-23 attempt using
     * `proc_open()` + non-blocking pipes was built and directly tested —
     * confirmed BROKEN on this Windows workstation.
     * `stream_set_blocking($pipes[n], false)` is a documented no-op for
     * `proc_open` pipes on Windows PHP, so `stream_get_contents()` blocks
     * exactly like plain `exec()` would until the child produces output
     * or exits — proven with a real test (`adb shell sleep 30` capped at
     * a 3s timeout still took the full 30.3s). `stream_select()` is
     * *also* documented as unsupported for non-socket streams on
     * Windows, so that isn't a fallback either.
     *
     * WHAT ACTUALLY WORKS: shelling out to `powershell.exe`, which starts
     * `adb.exe` via .NET's `System.Diagnostics.Process` and waits with
     * `Process.WaitForExit(ms)` — a real, OS-level timeout unrelated to
     * PHP's broken pipe-blocking behavior. If it expires, the wrapper
     * force-kills the process and exits with `TIMEOUT_EXIT_CODE` (124,
     * matching the POSIX `timeout` convention) so the caller can tell a
     * real kill apart from any of adb's own exit codes. PHP's own
     * `exec()` call on `powershell.exe` itself has no timeout either —
     * but that's fine, because `powershell.exe` ALWAYS returns once its
     * own `WaitForExit($timeoutMs)` call resolves (success or timeout),
     * so the outer `exec()` is bounded transitively, not by anything PHP
     * has to enforce itself.
     *
     * `-EncodedCommand` (base64 of UTF-16LE script text) is used instead
     * of building a quoted command-line string, deliberately — this
     * session already found two real bugs from shell-requoting across
     * process boundaries (`adb shell`'s own re-joining behavior,
     * HANDOFF.md gotcha #17); base64-encoding the whole script sidesteps
     * that class of bug entirely rather than trying to get it right a
     * third time. `Start-Process -ArgumentList <array>` (not a hand-
     * quoted string) is used for the SAME reason on the adb.exe call
     * inside the script.
     *
     * @param list<string> $adbArgs
     * @return array{0:int, 1:string} [exitCode, combined stdout+stderr] — exitCode is TIMEOUT_EXIT_CODE (124) on a real kill.
     */
    private static function runWithTimeout(string $adbPath, array $adbArgs, int $timeoutSeconds): array
    {
        $outFile = tempnam(sys_get_temp_dir(), 'baranguard_gsm_out_');
        $errFile = tempnam(sys_get_temp_dir(), 'baranguard_gsm_err_');
        if ($outFile === false || $errFile === false) {
            return [-1, 'Could not create a temp file for the adb call.'];
        }

        $timeoutMs = $timeoutSeconds * 1000;
        $psAdbPath = self::psSingleQuote($adbPath);
        $psOutFile = self::psSingleQuote($outFile);
        $psErrFile = self::psSingleQuote($errFile);
        // A code-review finding (2026-09-2x, not yet device-retested) caught
        // that `-ArgumentList @(...)` — a PowerShell ARRAY — is silently
        // space-joined into one string by Windows PowerShell 5.1's
        // Start-Process BEFORE CreateProcess ever runs, so adb.exe ends up
        // reparsing that joined string with ITS OWN Windows argv rules,
        // which know nothing about the PowerShell single-quotes each
        // element was wrapped in — a `"` anywhere in a message body or
        // phone number could shift or corrupt token boundaries. Fix: build
        // ONE already-Windows-argv-quoted string ourselves
        // (windowsArgQuote() — the same algorithm the C runtime uses to
        // reverse a Windows command line) and hand -ArgumentList a single
        // string, leaving nothing for Start-Process to (mis)join.
        $argsLine = implode(' ', array_map(self::windowsArgQuote(...), $adbArgs));
        $psArgsLine = self::psSingleQuote($argsLine);
        $timeoutExitCode = self::TIMEOUT_EXIT_CODE;

        $script = <<<PS
        \$p = Start-Process -FilePath {$psAdbPath} -ArgumentList {$psArgsLine} -NoNewWindow -PassThru -RedirectStandardOutput {$psOutFile} -RedirectStandardError {$psErrFile}
        if (-not \$p.WaitForExit({$timeoutMs})) {
            try { Stop-Process -Id \$p.Id -Force -ErrorAction SilentlyContinue } catch {}
            exit {$timeoutExitCode}
        }
        exit \$p.ExitCode
        PS;

        $encoded = base64_encode(mb_convert_encoding($script, 'UTF-16LE', 'UTF-8'));
        $psOutput = [];
        $psExitCode = 0;
        // The full path is used deliberately, not a bare `powershell.exe` —
        // confirmed the hard way that PATH as seen by PHP's own exec()
        // context (under Apache/XAMPP) does not reliably include
        // C:\Windows\System32, so a bare command name failed with "is not
        // recognized as an internal or external command" before this fix.
        exec(self::POWERSHELL_PATH . ' -NoProfile -NonInteractive -EncodedCommand ' . escapeshellarg($encoded) . ' 2>&1', $psOutput, $psExitCode);

        $stdout = is_file($outFile) ? (string) file_get_contents($outFile) : '';
        $stderr = is_file($errFile) ? (string) file_get_contents($errFile) : '';
        @unlink($outFile);
        @unlink($errFile);

        $combined = trim($stdout . $stderr);
        if ($psExitCode === self::TIMEOUT_EXIT_CODE) {
            return [self::TIMEOUT_EXIT_CODE, $combined];
        }
        // A non-timeout, non-zero exit here (powershell.exe itself failing to
        // even launch adb, a malformed script, etc.) is distinguishable from
        // adb's own exit code only by these being genuinely rare — surfaced
        // as-is rather than specially handled, same as any other real failure.
        return [$psExitCode, $combined !== '' ? $combined : implode("\n", $psOutput)];
    }

    /** PowerShell single-quoted string literal — only `''` doubling needed, no other escaping (this string never leaves single-quote context). */
    private static function psSingleQuote(string $value): string
    {
        return "'" . str_replace("'", "''", $value) . "'";
    }

    /**
     * Windows/CreateProcess argv quoting — the standard algorithm the C
     * runtime uses to SPLIT a command line back into argv (so this builds
     * a string that round-trips correctly through it). This is a THIRD,
     * distinct quoting dialect from `posixShellQuote()` (for the REMOTE
     * Android shell) and `psSingleQuote()` (for a PowerShell string
     * LITERAL) above — conflating any two of the three is exactly how a
     * `"` in a message body could previously corrupt what got sent.
     */
    private static function windowsArgQuote(string $arg): string
    {
        if ($arg === '') {
            return '""';
        }
        if (strpbrk($arg, " \t\n\v\"") === false) {
            return $arg;
        }
        $result = '"';
        $length = strlen($arg);
        for ($i = 0; $i < $length; $i++) {
            $numBackslashes = 0;
            while ($i < $length && $arg[$i] === '\\') {
                $i++;
                $numBackslashes++;
            }
            if ($i === $length) {
                $result .= str_repeat('\\', $numBackslashes * 2);
                break;
            }
            if ($arg[$i] === '"') {
                $result .= str_repeat('\\', $numBackslashes * 2 + 1) . '"';
            } else {
                $result .= str_repeat('\\', $numBackslashes) . $arg[$i];
            }
        }
        $result .= '"';
        return $result;
    }

    /**
     * Settles earlier `pending` sends: the phone's carrier result can arrive ~60 s after the send
     * (seen on the Infinix/Globe), long after dispatch() stopped waiting. One logcat read for all ids.
     *
     * @param list<string> $correlationIds
     * @return array<string,'sent'|'failed'> only the ids the phone has answered for
     */
    public function lookupResults(array $correlationIds): array
    {
        if ($correlationIds === [] || !$this->isConfigured()) {
            return [];
        }
        $output = $this->readResultLog();
        $found = [];
        foreach ($correlationIds as $id) {
            $status = self::statusFromBroadcastOutput($output, $id);
            if ($status !== null) {
                $found[$id] = $status;
            }
        }
        return $found;
    }

    /**
     * `am broadcast` that returns at once with result=0 and no data never ran the receiver (a running one
     * waits for the carrier and answers with data). Known not sent, so the caller records `failed`.
     */
    private static function broadcastNotDelivered(string $output, float $elapsedSeconds): bool
    {
        return $elapsedSeconds < 2.0
            && str_contains($output, 'Broadcast completed: result=0')
            && !str_contains($output, 'data=');
    }

    /**
     * Live, side-effect-free check for Service Health: the phone is attached over adb and the gateway
     * app is installed on it. Sends nothing. (Proving a send needs a real SMS; sms_log shows those.)
     */
    public function probe(): bool
    {
        if (!$this->isConfigured()) {
            return false;
        }
        $serial = $this->deviceSerial !== null ? ['-s', $this->deviceSerial] : [];
        [$code, $out] = self::runWithTimeout($this->adbPath, [...$serial, 'shell', 'pm path ph.baranguard.smsgateway'], 6);
        return $code === 0 && str_contains($out, 'package:');
    }

    /** The app's own result file plus the (short-lived) logcat lines, as one text; '' if the phone is unreachable. */
    private function readResultLog(): string
    {
        $serial = $this->deviceSerial !== null ? ['-s', $this->deviceSerial] : [];
        [$fileCode, $fileText] = self::runWithTimeout($this->adbPath, [...$serial, 'shell', 'cat ' . self::RESULT_FILE], 6);
        [$logCode, $logText] = self::runWithTimeout($this->adbPath, [...$serial, 'logcat', '-d', 'BaranguardSmsGateway:I', '*:S'], 6);
        return ($fileCode === 0 ? $fileText : '') . "
" . ($logCode === 0 ? $logText : '');
    }

    /** @return 'sent'|'failed'|null null = the output carries no answer for this correlation id */
    private static function statusFromBroadcastOutput(string $output, string $correlationId): ?string
    {
        if (preg_match('/RESULT correlation_id=' . preg_quote($correlationId, '/') . ' status=(sent|failed)/', $output, $m) === 1) {
            return $m[1];
        }
        return null;
    }

    /** @return 'sent'|'failed'|'unknown' */
    private function pollForResult(string $correlationId): string
    {
        for ($attempt = 0; $attempt < self::RESULT_POLL_ATTEMPTS; $attempt++) {
            usleep(self::RESULT_POLL_DELAY_MICROSECONDS);
            $status = self::statusFromBroadcastOutput($this->readResultLog(), $correlationId);
            if ($status !== null) {
                return $status;
            }
        }
        return 'unknown';
    }
}
