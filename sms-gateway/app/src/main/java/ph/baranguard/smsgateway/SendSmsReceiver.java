package ph.baranguard.smsgateway;

import android.app.PendingIntent;
import android.content.BroadcastReceiver;
import android.content.Context;
import android.content.Intent;
import android.content.IntentFilter;
import android.os.Build;
import android.telephony.SmsManager;
import android.util.Log;
import java.util.ArrayList;

/**
 * SendSmsReceiver — the whole point of this app. Replaces
 * `SemaphoreClient.php`'s job: sends one outbound SMS via this phone's own
 * SIM (`SmsManager`) on command from the workstation, over `adb shell am
 * broadcast`. No network call of its own, no server, no polling — the
 * workstation reaches IN via adb, the same trust boundary
 * `gsm-ingest-daemon.php` already relies on for reading inbound SMS off
 * this same phone (§1 REFERENCE.md's F1 architecture: LAN/USB-local, no
 * cloud dependency).
 *
 * Long messages are split via `divideMessage`/`sendMultipartTextMessage` —
 * a plain `sendTextMessage` silently truncates anything over ~160 chars
 * (70 for non-GSM-7 alphabets), which would be a real, hard-to-notice
 * correctness bug for this being the SOS-fallback/broadcast transport.
 *
 * Result reporting: logs to logcat with tag "BaranguardSmsGateway" and the
 * caller's own `correlation_id`, not a callback POST — the workstation
 * side (`LocalGsmOutboundClient.php`) reads it back via `adb logcat`,
 * mirroring how the inbound daemon already parses `adb shell content
 * query` output rather than requiring this phone to make any HTTP call.
 */
public class SendSmsReceiver extends BroadcastReceiver {

    private static final String TAG = "BaranguardSmsGateway";
    private static final String ACTION_SENT_SUFFIX = ".SMS_SENT_RESULT";

    @Override
    public void onReceive(Context context, Intent intent) {
        String to = intent.getStringExtra("to");
        String body = intent.getStringExtra("body");
        String correlationId = intent.getStringExtra("correlation_id");

        if (correlationId == null) correlationId = "unknown";
        if (to == null || to.trim().isEmpty() || body == null || body.isEmpty()) {
            Log.e(TAG, "RESULT correlation_id=" + correlationId + " status=failed reason=missing_to_or_body");
            return;
        }

        final PendingResult pendingResult = goAsync();
        final String finalCorrelationId = correlationId;
        final Context appContext = context.getApplicationContext();

        // Declared outside the try so a code-review-found bug can be fixed:
        // any exception thrown AFTER registerReceiver() but before the send
        // call completes (e.g. a SecurityException from a revoked SEND_SMS
        // permission) used to leave `resultReceiver` registered forever —
        // the catch block only called pendingResult.finish(), never
        // unregisterReceiver(). Tracked here so the catch block can clean
        // it up too.
        BroadcastReceiver resultReceiver = null;
        boolean receiverRegistered = false;

        try {
            SmsManager smsManager = SmsManager.getDefault();
            ArrayList<String> parts = smsManager.divideMessage(body);
            int partCount = parts.size();

            String sentAction = appContext.getPackageName() + ACTION_SENT_SUFFIX + "." + finalCorrelationId;
            ArrayList<PendingIntent> sentIntents = new ArrayList<>();
            int piFlags = PendingIntent.FLAG_UPDATE_CURRENT
                | (Build.VERSION.SDK_INT >= Build.VERSION_CODES.S ? PendingIntent.FLAG_MUTABLE : 0);
            for (int i = 0; i < partCount; i++) {
                Intent sentIntent = new Intent(sentAction);
                sentIntent.setPackage(appContext.getPackageName());
                sentIntent.putExtra("part_index", i);
                sentIntents.add(PendingIntent.getBroadcast(appContext, i, sentIntent, piFlags));
            }

            final int[] remaining = {partCount};
            final boolean[] anyFailure = {false};
            IntentFilter filter = new IntentFilter(sentAction);
            resultReceiver = new BroadcastReceiver() {
                @Override
                public void onReceive(Context ctx, Intent resultIntent) {
                    remaining[0] -= 1;
                    if (getResultCode() != android.app.Activity.RESULT_OK) {
                        anyFailure[0] = true;
                    }
                    if (remaining[0] <= 0) {
                        try {
                            appContext.unregisterReceiver(this);
                        } catch (Exception ignored) {
                            // Already unregistered — fine.
                        }
                        Log.i(TAG, "RESULT correlation_id=" + finalCorrelationId
                            + " status=" + (anyFailure[0] ? "failed" : "sent")
                            + " parts=" + partCount);
                        pendingResult.finish();
                    }
                }
            };

            int registerFlags = Build.VERSION.SDK_INT >= Build.VERSION_CODES.TIRAMISU
                ? Context.RECEIVER_NOT_EXPORTED : 0;
            if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.TIRAMISU) {
                appContext.registerReceiver(resultReceiver, filter, registerFlags);
            } else {
                appContext.registerReceiver(resultReceiver, filter);
            }
            receiverRegistered = true;

            if (partCount <= 1) {
                smsManager.sendTextMessage(to, null, body, sentIntents.get(0), null);
            } else {
                smsManager.sendMultipartTextMessage(to, null, parts, sentIntents, null);
            }

            Log.i(TAG, "SUBMITTED correlation_id=" + finalCorrelationId + " parts=" + partCount + " to_redacted=" + redact(to));
        } catch (Exception e) {
            if (receiverRegistered) {
                try {
                    appContext.unregisterReceiver(resultReceiver);
                } catch (Exception ignored) {
                    // Already unregistered — fine.
                }
            }
            Log.e(TAG, "RESULT correlation_id=" + finalCorrelationId + " status=failed reason=exception:" + e.getMessage());
            pendingResult.finish();
        }
    }

    /** Never let a phone number reach logcat in full — same audit-metadata discipline (§2 Rule 8) as the rest of this codebase. */
    private static String redact(String phoneNumber) {
        if (phoneNumber.length() <= 4) return "****";
        return "****" + phoneNumber.substring(phoneNumber.length() - 4);
    }
}
