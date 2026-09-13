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
        CriticalAlertNotifier.postFullScreenAlert(getContext(), title, body);

        JSObject result = new JSObject();
        result.put("shown", true);
        call.resolve(result);
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
