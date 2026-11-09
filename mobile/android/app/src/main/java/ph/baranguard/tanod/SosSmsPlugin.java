package ph.baranguard.tanod;

import android.Manifest;
import android.app.Activity;
import android.app.PendingIntent;
import android.content.BroadcastReceiver;
import android.content.Context;
import android.content.Intent;
import android.content.IntentFilter;
import android.os.Build;
import android.telephony.SmsManager;
import androidx.annotation.NonNull;
import com.getcapacitor.JSObject;
import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.PermissionState;
import com.getcapacitor.annotation.CapacitorPlugin;
import com.getcapacitor.annotation.Permission;
import com.getcapacitor.annotation.PermissionCallback;
import java.util.ArrayList;
import java.util.concurrent.atomic.AtomicInteger;
import java.util.regex.Pattern;

/**
 * SosSmsPlugin — the third SOS fallback tier.
 *
 * SOS must have a local/offline fallback so a workstation/LAN outage does
 * not silently suppress a personal-safety emergency. The app-POST fallback
 * (queued to offline_queue_local) and the server's GSM-modem SMS envelope
 * path both terminate on the workstation, so neither survives it being
 * down. This plugin does: it sends a plain SMS directly from the device's own SIM,
 * via Android's SmsManager, to a human-monitored backup number — no
 * gateway, no workstation, no LAN required.
 *
 * A local (not npm-published) Capacitor plugin, not a third-party
 * dependency: existing candidates on npm for "capacitor sms" open the
 * device's native SMS composer for a human to review and tap send
 * (Intent.ACTION_SENDTO), which defeats the point here — a Tanod in a
 * total-outage emergency should not need to additionally find and tap
 * Send in a different app. `SmsManager.sendTextMessage()` sends
 * silently, in the background, the moment this method resolves.
 *
 * SEND_SMS is a dangerous-protection-level runtime permission Google
 * Play restricts to an app's DEFAULT SMS handler — but that restriction
 * is a Play Store distribution policy, not an Android OS restriction;
 * Baranguard is sideloaded (LAN-only, not Play-distributed),
 * so a normal runtime grant is sufficient here, same as CAMERA/RECORD_AUDIO
 * elsewhere in this app.
 *
 * `SmsManager` doesn't synchronously validate the destination address, and
 * a rejected send leaves no trace in `content://sms/sent`/`/failed`/`/outbox`,
 * so this (1) checks the PH-mobile-number format (same shape
 * `SettingsController::update()` enforces server-side) before calling
 * SmsManager, and (2) reports a real `sentIntent`-based result instead of
 * trusting `sendTextMessage()`'s synchronous return, which only throws for
 * permission/argument errors, never for a carrier-rejected send.
 */
@CapacitorPlugin(
    name = "SosSms",
    permissions = { @Permission(strings = { Manifest.permission.SEND_SMS }, alias = "sms") }
)
public class SosSmsPlugin extends Plugin {

    // Kept in sync by hand with SettingsController::PH_MOBILE_NUMBER_PATTERN
    // (PHP) — same shape, two languages, no shared code between them.
    private static final Pattern PH_MOBILE_NUMBER = Pattern.compile("^(\\+63|0)9\\d{9}$");

    private static int sendRequestCounter = 0;

    @PluginMethod
    public void sendDirect(PluginCall call) {
        String number = call.getString("number");
        String message = call.getString("message");
        if (number == null || number.trim().isEmpty() || message == null || message.trim().isEmpty()) {
            call.reject("number and message are both required.");
            return;
        }
        String trimmedNumber = number.trim();
        if (!PH_MOBILE_NUMBER.matcher(trimmedNumber).matches()) {
            call.reject("Invalid phone number format: " + trimmedNumber);
            return;
        }

        if (getPermissionState("sms") != PermissionState.GRANTED) {
            requestPermissionForAlias("sms", call, "smsPermissionCallback");
            return;
        }
        doSend(call, trimmedNumber, message);
    }

    @PermissionCallback
    private void smsPermissionCallback(PluginCall call) {
        if (getPermissionState("sms") != PermissionState.GRANTED) {
            call.reject("SEND_SMS permission was not granted.");
            return;
        }
        String number = call.getString("number");
        String message = call.getString("message");
        // sendDirect() already validated the format before requesting the
        // permission, so number is guaranteed non-null/well-formed here.
        doSend(call, number.trim(), message);
    }

    /**
     * `sentIntent` PendingIntents carry the ACTUAL carrier-level submission
     * result (success, or a specific `SmsManager.RESULT_ERROR_*` code) back
     * through a locally-registered `BroadcastReceiver` — this is what makes
     * a real `sms_failed` (vs. a false `sent_by_sms`) possible. One
     * PendingIntent per message part (multipart messages need every part
     * to report before the call resolves); the receiver unregisters itself
     * once the last part's result has arrived.
     */
    private void doSend(PluginCall call, @NonNull String number, @NonNull String message) {
        try {
            SmsManager smsManager = SmsManager.getDefault();
            // A GPS-coordinate-bearing SOS text can exceed one 160-char
            // SMS segment — divideMessage()/sendMultipartTextMessage()
            // handles that split, rather than silently truncating a
            // coordinate off the end of a single-part message.
            ArrayList<String> parts = smsManager.divideMessage(message);
            int partCount = Math.max(parts.size(), 1);
            String action = "ph.baranguard.tanod.SOS_SMS_SENT_" + (sendRequestCounter++) + "_" + System.nanoTime();
            Context context = getContext();

            AtomicInteger remaining = new AtomicInteger(partCount);
            AtomicInteger failureCode = new AtomicInteger(Activity.RESULT_OK);

            BroadcastReceiver receiver = new BroadcastReceiver() {
                @Override
                public void onReceive(Context ctx, Intent intent) {
                    int result = getResultCode();
                    if (result != Activity.RESULT_OK) {
                        failureCode.compareAndSet(Activity.RESULT_OK, result);
                    }
                    if (remaining.decrementAndGet() == 0) {
                        try {
                            context.unregisterReceiver(this);
                        } catch (IllegalArgumentException ignored) {
                            // Already unregistered — harmless.
                        }
                        if (failureCode.get() == Activity.RESULT_OK) {
                            JSObject resolved = new JSObject();
                            resolved.put("sent", true);
                            call.resolve(resolved);
                        } else {
                            call.reject("SMS send failed: " + describeResult(failureCode.get()));
                        }
                    }
                }
            };

            IntentFilter filter = new IntentFilter(action);
            if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.TIRAMISU) {
                context.registerReceiver(receiver, filter, Context.RECEIVER_NOT_EXPORTED);
            } else {
                context.registerReceiver(receiver, filter);
            }

            int piFlags = PendingIntent.FLAG_UPDATE_CURRENT
                | (Build.VERSION.SDK_INT >= Build.VERSION_CODES.S ? PendingIntent.FLAG_IMMUTABLE : 0);
            ArrayList<PendingIntent> sentIntents = new ArrayList<>();
            for (int i = 0; i < partCount; i++) {
                sentIntents.add(PendingIntent.getBroadcast(context, i, new Intent(action), piFlags));
            }

            if (parts.size() > 1) {
                smsManager.sendMultipartTextMessage(number, null, parts, sentIntents, null);
            } else {
                smsManager.sendTextMessage(number, null, message, sentIntents.get(0), null);
            }
        } catch (Exception e) {
            // No airplane-mode/no-SIM/radio-off check beforehand — letting
            // SmsManager itself fail and reporting that failure honestly
            // is simpler and more accurate than trying to predict every
            // reason a real send can fail. This catch only ever fires for
            // synchronous errors (e.g. permission edge cases); the async
            // sentIntent result above is what catches everything else.
            call.reject("SMS send failed: " + e.getMessage(), e);
        }
    }

    private static String describeResult(int resultCode) {
        switch (resultCode) {
            case SmsManager.RESULT_ERROR_NO_SERVICE:
                return "no cellular service";
            case SmsManager.RESULT_ERROR_RADIO_OFF:
                return "radio off (airplane mode?)";
            case SmsManager.RESULT_ERROR_NULL_PDU:
                return "null PDU";
            case SmsManager.RESULT_ERROR_GENERIC_FAILURE:
                return "generic failure";
            default:
                return "result code " + resultCode;
        }
    }
}
