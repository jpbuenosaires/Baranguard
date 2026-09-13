package ph.baranguard.tanod;

import android.Manifest;
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

/**
 * SosSmsPlugin — G1's third SOS fallback tier (Mobile Improvement Plan
 * Phase 4.3, docs/REMAINING.md).
 *
 * §2 Rule 27: "SOS must have a local/offline fallback path so a
 * workstation/LAN outage does not silently suppress a personal-safety
 * emergency." The app-POST fallback (queued to offline_queue_local) and
 * the server's own GSM-modem SMS envelope path BOTH still terminate on
 * this same workstation (see REMAINING.md G1's own framing) — neither
 * survives the workstation itself being down. This plugin is the tier
 * that doesn't: it sends a plain SMS directly from the device's own SIM,
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
 * Baranguard is sideloaded (§1: LAN-only, no cloud, not Play-distributed),
 * so a normal runtime grant is sufficient here, same as CAMERA/RECORD_AUDIO
 * elsewhere in this app.
 */
@CapacitorPlugin(
    name = "SosSms",
    permissions = { @Permission(strings = { Manifest.permission.SEND_SMS }, alias = "sms") }
)
public class SosSmsPlugin extends Plugin {

    @PluginMethod
    public void sendDirect(PluginCall call) {
        String number = call.getString("number");
        String message = call.getString("message");
        if (number == null || number.trim().isEmpty() || message == null || message.trim().isEmpty()) {
            call.reject("number and message are both required.");
            return;
        }

        if (getPermissionState("sms") != PermissionState.GRANTED) {
            requestPermissionForAlias("sms", call, "smsPermissionCallback");
            return;
        }
        doSend(call, number, message);
    }

    @PermissionCallback
    private void smsPermissionCallback(PluginCall call) {
        if (getPermissionState("sms") != PermissionState.GRANTED) {
            call.reject("SEND_SMS permission was not granted.");
            return;
        }
        String number = call.getString("number");
        String message = call.getString("message");
        doSend(call, number, message);
    }

    private void doSend(PluginCall call, @NonNull String number, @NonNull String message) {
        try {
            SmsManager smsManager = SmsManager.getDefault();
            // A GPS-coordinate-bearing SOS text can exceed one 160-char
            // SMS segment — divideMessage()/sendMultipartTextMessage()
            // handles that split, rather than silently truncating a
            // coordinate off the end of a single-part message.
            ArrayList<String> parts = smsManager.divideMessage(message);
            if (parts.size() > 1) {
                smsManager.sendMultipartTextMessage(number, null, parts, null, null);
            } else {
                smsManager.sendTextMessage(number, null, message, null, null);
            }
            JSObject result = new JSObject();
            result.put("sent", true);
            call.resolve(result);
        } catch (Exception e) {
            // No airplane-mode/no-SIM/radio-off check beforehand — letting
            // SmsManager itself fail and reporting that failure honestly
            // is simpler and more accurate than trying to predict every
            // reason a real send can fail.
            call.reject("SMS send failed: " + e.getMessage(), e);
        }
    }
}
