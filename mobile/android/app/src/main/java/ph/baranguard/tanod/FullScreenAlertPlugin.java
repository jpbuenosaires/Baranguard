package ph.baranguard.tanod;

import com.getcapacitor.JSObject;
import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.CapacitorPlugin;

/**
 * FullScreenAlertPlugin — the one way Phase 4.2's full-screen alert
 * capability can actually be exercised in an environment with no real
 * FCM project (REMAINING.md A4): Profile's diagnostics calls this
 * directly ("Test Full-Screen Alert"), posting through the exact same
 * `CriticalAlertNotifier` a real incoming critical push would use via
 * `CriticalAlertMessagingService`. Proves the notification/full-screen-
 * intent/Activity path works; does not and cannot prove the FCM delivery
 * path itself.
 */
@CapacitorPlugin(name = "FullScreenAlert")
public class FullScreenAlertPlugin extends Plugin {

    @PluginMethod
    public void showTest(PluginCall call) {
        String title = call.getString("title", "Test Critical Alert");
        String body = call.getString("body", "This is a test of the full-screen emergency alert.");
        // Sentinel id/type — this path has no real notification row behind
        // it, but criticalAlertStore.ts's parseAlert() still needs both
        // fields present to accept the handoff, so the manual diagnostic
        // exercises the exact same handoff code the real FCM path uses.
        CriticalAlertNotifier.postFullScreenAlert(getContext(), title, body, "-1", "sos");

        JSObject result = new JSObject();
        result.put("shown", true);
        call.resolve(result);
    }

    /**
     * Reads and clears whatever `CriticalAlertActivity`'s "Open Baranguard"
     * button stashed just before launching this Activity — the in-process
     * handoff that lets `criticalAlertStore.ts` show/ack the SAME alert the
     * native screen just displayed, instead of losing context on cold
     * launch. Resolves `{pending: false}` when there's nothing to hand off
     * (the ordinary app-launch case). Called once from `App.tsx`'s mount
     * effect via `checkForPendingNativeAlert()`.
     */
    @PluginMethod
    public void getPendingAlert(PluginCall call) {
        CriticalAlertActivity.PendingAlert pending = CriticalAlertActivity.takePendingAlert();
        JSObject result = new JSObject();
        if (pending == null) {
            result.put("pending", false);
        } else {
            result.put("pending", true);
            result.put("notificationId", pending.notificationId);
            result.put("notificationType", pending.notificationType);
            result.put("title", pending.title);
            result.put("body", pending.body);
        }
        call.resolve(result);
    }

    /**
     * Cancels the system heads-up notification (id 2001) posted by
     * `CriticalAlertNotifier`. Called once the Tanod acknowledges the alert
     * in-app — `setAutoCancel(true)` on the notification itself only
     * clears it on a direct tap, so an in-app ACKNOWLEDGE otherwise left it
     * sitting in the tray after the overlay was already gone (found on the
     * Infinix X6840, 2026-09-19).
     */
    @PluginMethod
    public void dismiss(PluginCall call) {
        CriticalAlertNotifier.cancelFullScreenAlert(getContext());
        call.resolve();
    }

    /**
     * Whether the native Firebase SDK actually initialized in this process
     * — false whenever `google-services.json` was never added to the
     * build (REMAINING.md A4, still open). `deviceIdentity.ts`'s
     * `getFcmToken()` calls this BEFORE `PushNotifications.register()`,
     * because that call throws an uncaught `IllegalStateException` on
     * Capacitor's own native plugin-invocation thread when Firebase isn't
     * initialized — confirmed on a real device 2026-09-13, crashing the
     * whole app on login. A JS try/catch around `register()` cannot
     * intercept that: the exception never reaches the JS promise
     * machinery, it kills the process first. This check runs entirely in
     * Java, so it can safely observe the failure mode `register()` cannot
     * survive, and lets the JS side skip the crash-prone call instead of
     * merely reacting to it.
     */
    @PluginMethod
    public void isFirebaseAvailable(PluginCall call) {
        boolean available;
        try {
            com.google.firebase.FirebaseApp.getInstance();
            available = true;
        } catch (IllegalStateException e) {
            available = false;
        }
        JSObject result = new JSObject();
        result.put("available", available);
        call.resolve(result);
    }
}
