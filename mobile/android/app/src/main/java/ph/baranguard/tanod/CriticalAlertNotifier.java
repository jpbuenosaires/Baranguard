package ph.baranguard.tanod;

import android.app.Notification;
import android.app.NotificationChannel;
import android.app.NotificationManager;
import android.app.PendingIntent;
import android.content.Context;
import android.content.Intent;
import android.os.Build;
import androidx.core.app.NotificationCompat;

/**
 * CriticalAlertNotifier — shared by `CriticalAlertMessagingService.java`
 * (a real incoming critical push) and `FullScreenAlertPlugin.java` (the
 * JS-callable test trigger, since no real FCM project exists to exercise
 * the first path — REMAINING.md A4) so there is exactly one place that
 * builds this notification, not two drifting copies.
 *
 * `setFullScreenIntent(..., true)` is the actual mechanism: Android shows
 * `CriticalAlertActivity` immediately (waking a locked screen) rather
 * than only posting a heads-up notification, PROVIDED the app holds
 * USE_FULL_SCREEN_INTENT (declared in the manifest) — without it, the
 * system silently downgrades to a normal high-priority notification
 * instead of throwing, which is worth knowing if this is ever debugged on
 * a device that behaves unexpectedly.
 */
final class CriticalAlertNotifier {

    private static final String CHANNEL_ID = "baranguard_critical_alert";
    private static final int NOTIFICATION_ID = 2001;

    private CriticalAlertNotifier() {}

    static void postFullScreenAlert(Context context, String title, String body) {
        createChannelIfNeeded(context);

        Intent activityIntent = new Intent(context, CriticalAlertActivity.class);
        activityIntent.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK | Intent.FLAG_ACTIVITY_CLEAR_TOP);
        activityIntent.putExtra(CriticalAlertActivity.EXTRA_TITLE, title);
        activityIntent.putExtra(CriticalAlertActivity.EXTRA_BODY, body);

        int flags = PendingIntent.FLAG_UPDATE_CURRENT | (Build.VERSION.SDK_INT >= Build.VERSION_CODES.S ? PendingIntent.FLAG_IMMUTABLE : 0);
        PendingIntent fullScreenPendingIntent = PendingIntent.getActivity(context, 0, activityIntent, flags);

        Notification notification = new NotificationCompat.Builder(context, CHANNEL_ID)
            .setContentTitle(title)
            .setContentText(body)
            .setSmallIcon(android.R.drawable.ic_dialog_alert)
            .setPriority(NotificationCompat.PRIORITY_MAX)
            .setCategory(NotificationCompat.CATEGORY_ALARM)
            .setFullScreenIntent(fullScreenPendingIntent, true)
            .setAutoCancel(true)
            .build();

        NotificationManager manager = (NotificationManager) context.getSystemService(Context.NOTIFICATION_SERVICE);
        if (manager != null) {
            manager.notify(NOTIFICATION_ID, notification);
        }
    }

    private static void createChannelIfNeeded(Context context) {
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
            NotificationChannel channel = new NotificationChannel(
                CHANNEL_ID,
                "Critical Alerts",
                NotificationManager.IMPORTANCE_HIGH
            );
            channel.setDescription("SOS and priority dispatch alerts that should wake the device.");
            NotificationManager manager = (NotificationManager) context.getSystemService(Context.NOTIFICATION_SERVICE);
            if (manager != null) {
                manager.createNotificationChannel(channel);
            }
        }
    }
}
