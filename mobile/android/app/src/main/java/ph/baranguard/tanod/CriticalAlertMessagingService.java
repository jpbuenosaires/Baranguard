package ph.baranguard.tanod;

import androidx.annotation.NonNull;
import com.capacitorjs.plugins.pushnotifications.MessagingService;
import com.google.firebase.messaging.RemoteMessage;
import java.util.Arrays;
import java.util.HashSet;
import java.util.Map;
import java.util.Set;

/**
 * CriticalAlertMessagingService — Mobile Improvement Plan Phase 4.2's
 * hook into a REAL incoming FCM message.
 *
 * Extends `@capacitor/push-notifications`' own `MessagingService`
 * (rather than `FirebaseMessagingService` directly) so `super.onMessageReceived()`
 * still runs the plugin's normal handling unchanged — this override adds
 * the full-screen-intent behavior for the specific critical types
 * (`criticalAlertStore.ts`'s own `CRITICAL_TYPES`, kept in sync by hand
 * since Java and TypeScript can't share one literal source here) WITHOUT
 * touching or duplicating the existing JS-side foreground/tapped-from-tray
 * handling that already works.
 *
 * `AndroidManifest.xml` removes the library's own `<service>` declaration
 * (`tools:node="remove"`) and declares this class in its place with the
 * identical `com.google.firebase.MESSAGING_EVENT` intent-filter — the
 * standard Android technique for overriding a library's FCM service. This
 * is the one piece of Phase 4.2 that is genuinely unverifiable in this
 * environment: there is no real Firebase project configured
 * (REMAINING.md A4), so this class has never received a real RemoteMessage.
 * `FullScreenAlertPlugin.java` exists specifically so the full-screen
 * behavior ITSELF (as opposed to this FCM plumbing) has a way to be
 * exercised today.
 */
public class CriticalAlertMessagingService extends MessagingService {

    private static final Set<String> CRITICAL_TYPES = new HashSet<>(Arrays.asList("sos", "priority_alert", "dispatch"));

    @Override
    public void onMessageReceived(@NonNull RemoteMessage remoteMessage) {
        Map<String, String> data = remoteMessage.getData();
        String notificationType = data.get("notification_type");
        if (notificationType != null && CRITICAL_TYPES.contains(notificationType)) {
            RemoteMessage.Notification notificationBlock = remoteMessage.getNotification();
            String title = notificationBlock != null && notificationBlock.getTitle() != null
                ? notificationBlock.getTitle()
                : "Critical alert";
            String body = notificationBlock != null && notificationBlock.getBody() != null
                ? notificationBlock.getBody()
                : "";
            CriticalAlertNotifier.postFullScreenAlert(getApplicationContext(), title, body);
        }
        // Preserves the plugin's own default handling (foreground JS
        // listener via criticalAlertStore.ts, token refresh, non-critical
        // notification display) for every message, critical or not.
        super.onMessageReceived(remoteMessage);
    }
}
