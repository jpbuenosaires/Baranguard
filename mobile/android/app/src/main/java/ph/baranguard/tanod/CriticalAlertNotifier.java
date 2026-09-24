package ph.baranguard.tanod;

import android.app.Notification;
import android.app.NotificationChannel;
import android.app.NotificationManager;
import android.app.PendingIntent;
import android.content.Context;
import android.content.Intent;
import android.media.AudioAttributes;
import android.media.RingtoneManager;
import android.net.Uri;
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

    // "_v2": a NotificationChannel's sound/vibration/importance are locked
    // by Android the moment it's first created — the app can never change
    // them on a channel ID that already exists on a device (only the user
    // can, from system settings). This app has already shipped
    // `baranguard_critical_alert` (silent-by-default) to test devices, so
    // 2026-09-24's alarm-sound/vibration fix needs a NEW channel ID to
    // actually take effect on them — bumping to "_v2" rather than deleting
    // and recreating the old ID, which would need extra code for no benefit
    // here (no per-channel user customization to preserve yet).
    private static final String CHANNEL_ID = "baranguard_critical_alert_v2";
    private static final int NOTIFICATION_ID = 2001;

    private CriticalAlertNotifier() {}

    /**
     * C4 (2026-09-19 device session): the system heads-up notification
     * stayed posted after the in-app "ACKNOWLEDGE ALERT" dismissed only
     * the overlay — `setAutoCancel(true)` above only clears it on a TAP,
     * not on an in-app acknowledge. Called from
     * `FullScreenAlertPlugin.dismiss()`, itself called by
     * `criticalAlertStore.ts`'s `dismissCriticalAlert()`.
     */
    static void cancelFullScreenAlert(Context context) {
        NotificationManager manager = (NotificationManager) context.getSystemService(Context.NOTIFICATION_SERVICE);
        if (manager != null) {
            manager.cancel(NOTIFICATION_ID);
        }
    }

    /** Distinct, insistent pattern (not the OS default single-buzz) — long enough to notice even in a pocket. */
    private static final long[] VIBRATION_PATTERN = { 0, 400, 200, 400, 200, 400 };

    static void postFullScreenAlert(Context context, String title, String body, String notificationId, String notificationType) {
        createChannelIfNeeded(context);
        Uri alarmSound = RingtoneManager.getDefaultUri(RingtoneManager.TYPE_ALARM);

        Intent activityIntent = new Intent(context, CriticalAlertActivity.class);
        activityIntent.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK | Intent.FLAG_ACTIVITY_CLEAR_TOP);
        activityIntent.putExtra(CriticalAlertActivity.EXTRA_TITLE, title);
        activityIntent.putExtra(CriticalAlertActivity.EXTRA_BODY, body);
        activityIntent.putExtra(CriticalAlertActivity.EXTRA_NOTIFICATION_ID, notificationId);
        activityIntent.putExtra(CriticalAlertActivity.EXTRA_NOTIFICATION_TYPE, notificationType);

        int flags = PendingIntent.FLAG_UPDATE_CURRENT | (Build.VERSION.SDK_INT >= Build.VERSION_CODES.S ? PendingIntent.FLAG_IMMUTABLE : 0);
        PendingIntent fullScreenPendingIntent = PendingIntent.getActivity(context, 0, activityIntent, flags);

        // On API 26+ the CHANNEL's own sound/vibration (set below) is what
        // actually plays — a Builder's setSound()/setVibrate() are ignored
        // once a channel exists. They're set here too anyway so the same
        // alarm-style cue still applies on API 24-25, which have no channel
        // concept at all (this app's minSdk is 24).
        Notification notification = new NotificationCompat.Builder(context, CHANNEL_ID)
            .setContentTitle(title)
            .setContentText(body)
            .setSmallIcon(android.R.drawable.ic_dialog_alert)
            .setPriority(NotificationCompat.PRIORITY_MAX)
            .setCategory(NotificationCompat.CATEGORY_ALARM)
            .setFullScreenIntent(fullScreenPendingIntent, true)
            .setAutoCancel(true)
            .setSound(alarmSound)
            .setVibrate(VIBRATION_PATTERN)
            .build();

        NotificationManager manager = (NotificationManager) context.getSystemService(Context.NOTIFICATION_SERVICE);
        if (manager != null) {
            manager.notify(NOTIFICATION_ID, notification);
        }
    }

    private static void createChannelIfNeeded(Context context) {
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
            NotificationManager manager = (NotificationManager) context.getSystemService(Context.NOTIFICATION_SERVICE);
            if (manager != null && manager.getNotificationChannel(CHANNEL_ID) != null) {
                // A channel's sound/vibration/importance are locked once
                // created — Android intentionally ignores any later change
                // from the app itself (only the USER can edit them from
                // system settings). Re-creating with the same ID is a no-op
                // by design, so an app update can't silently re-quiet an
                // alert the user deliberately turned down — but it also
                // means this method existing already proves the current
                // channel was built with the alarm sound/vibration below;
                // nothing to do on a repeat call.
                return;
            }

            // Distinct display name from the old (pre-2026-09-24, silent)
            // "Critical Alerts" channel this app already shipped to test
            // devices — a code-review finding pointed out that leaving both
            // channels titled identically risks a user muting the wrong one
            // from system settings, since neither name would tell them
            // which is which.
            NotificationChannel channel = new NotificationChannel(
                CHANNEL_ID,
                "Critical Alerts (Sound & Vibration)",
                NotificationManager.IMPORTANCE_HIGH
            );
            channel.setDescription("SOS and priority dispatch alerts that should wake the device.");
            // Alarm-usage audio attributes (not the default notification
            // usage) — more likely to play at a genuinely attention-getting
            // volume and to be audible under Do Not Disturb's "alarms"
            // exception, which most phones allow through by default.
            AudioAttributes alarmAttributes = new AudioAttributes.Builder()
                .setUsage(AudioAttributes.USAGE_ALARM)
                .setContentType(AudioAttributes.CONTENT_TYPE_SONIFICATION)
                .build();
            channel.setSound(RingtoneManager.getDefaultUri(RingtoneManager.TYPE_ALARM), alarmAttributes);
            channel.enableVibration(true);
            channel.setVibrationPattern(VIBRATION_PATTERN);
            channel.enableLights(true);
            if (manager != null) {
                manager.createNotificationChannel(channel);
            }
        }
    }
}
