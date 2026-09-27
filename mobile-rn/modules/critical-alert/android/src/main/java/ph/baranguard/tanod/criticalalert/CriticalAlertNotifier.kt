package ph.baranguard.tanod.criticalalert

import android.app.Notification
import android.app.NotificationChannel
import android.app.NotificationManager
import android.app.PendingIntent
import android.content.Context
import android.content.Intent
import android.media.AudioAttributes
import android.media.RingtoneManager
import android.os.Build
import androidx.core.app.NotificationCompat

/**
 * CriticalAlertNotifier — Kotlin port of ../mobile's CriticalAlertNotifier.java.
 * The one place that builds the full-screen critical-alert notification, so
 * a real FCM message and the JS-callable test trigger both go through
 * identical code.
 *
 * `setFullScreenIntent(..., true)` is the actual mechanism: Android shows
 * `CriticalAlertActivity` immediately (waking a locked screen) PROVIDED the
 * app holds USE_FULL_SCREEN_INTENT (declared in app.config.ts) — without
 * it, the system silently downgrades to a normal high-priority notification
 * instead of throwing.
 */
internal object CriticalAlertNotifier {

  // "_v2": a NotificationChannel's sound/vibration/importance are locked by
  // Android the moment it's first created — bumping the id is what actually
  // takes effect on a device that already has the old (silent) channel.
  private const val CHANNEL_ID = "baranguard_critical_alert_v2"
  private const val NOTIFICATION_ID = 2001

  /** Distinct, insistent pattern (not the OS default single-buzz). */
  private val VIBRATION_PATTERN = longArrayOf(0, 400, 200, 400, 200, 400)

  fun cancelFullScreenAlert(context: Context) {
    (context.getSystemService(Context.NOTIFICATION_SERVICE) as? NotificationManager)?.cancel(NOTIFICATION_ID)
  }

  fun postFullScreenAlert(context: Context, title: String, body: String, notificationId: String?, notificationType: String?) {
    createChannelIfNeeded(context)
    val alarmSound = RingtoneManager.getDefaultUri(RingtoneManager.TYPE_ALARM)

    val activityIntent = Intent(context, CriticalAlertActivity::class.java)
    activityIntent.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK or Intent.FLAG_ACTIVITY_CLEAR_TOP)
    activityIntent.putExtra(CriticalAlertActivity.EXTRA_TITLE, title)
    activityIntent.putExtra(CriticalAlertActivity.EXTRA_BODY, body)
    activityIntent.putExtra(CriticalAlertActivity.EXTRA_NOTIFICATION_ID, notificationId)
    activityIntent.putExtra(CriticalAlertActivity.EXTRA_NOTIFICATION_TYPE, notificationType)

    val flags = PendingIntent.FLAG_UPDATE_CURRENT or (if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.S) PendingIntent.FLAG_IMMUTABLE else 0)
    val fullScreenPendingIntent = PendingIntent.getActivity(context, 0, activityIntent, flags)

    // On API 26+ the CHANNEL's own sound/vibration (set below) is what
    // actually plays — a Builder's setSound()/setVibrate() are ignored once
    // a channel exists. Set here too anyway for API 24-25 (this app's
    // minSdk), which have no channel concept.
    val notification: Notification = NotificationCompat.Builder(context, CHANNEL_ID)
      .setContentTitle(title)
      .setContentText(body)
      .setSmallIcon(android.R.drawable.ic_dialog_alert)
      .setPriority(NotificationCompat.PRIORITY_MAX)
      .setCategory(NotificationCompat.CATEGORY_ALARM)
      .setFullScreenIntent(fullScreenPendingIntent, true)
      .setAutoCancel(true)
      .setSound(alarmSound)
      .setVibrate(VIBRATION_PATTERN)
      .build()

    (context.getSystemService(Context.NOTIFICATION_SERVICE) as? NotificationManager)?.notify(NOTIFICATION_ID, notification)
  }

  private fun createChannelIfNeeded(context: Context) {
    if (Build.VERSION.SDK_INT < Build.VERSION_CODES.O) return
    val manager = context.getSystemService(Context.NOTIFICATION_SERVICE) as? NotificationManager ?: return
    // A channel's sound/vibration/importance are locked once created —
    // Android ignores any later change from the app itself. Re-creating
    // with the same ID is a no-op by design.
    if (manager.getNotificationChannel(CHANNEL_ID) != null) return

    val channel = NotificationChannel(CHANNEL_ID, "Critical Alerts (Sound & Vibration)", NotificationManager.IMPORTANCE_HIGH)
    channel.description = "SOS and priority dispatch alerts that should wake the device."
    // Alarm-usage audio attributes (not the default notification usage) —
    // more likely to play at an attention-getting volume and to be audible
    // under Do Not Disturb's "alarms" exception.
    val alarmAttributes = AudioAttributes.Builder()
      .setUsage(AudioAttributes.USAGE_ALARM)
      .setContentType(AudioAttributes.CONTENT_TYPE_SONIFICATION)
      .build()
    channel.setSound(RingtoneManager.getDefaultUri(RingtoneManager.TYPE_ALARM), alarmAttributes)
    channel.enableVibration(true)
    channel.vibrationPattern = VIBRATION_PATTERN
    channel.enableLights(true)
    manager.createNotificationChannel(channel)
  }
}
