package ph.baranguard.tanod.criticalalert

import android.app.KeyguardManager
import android.content.Intent
import android.graphics.Color
import android.graphics.Typeface
import android.os.Build
import android.os.Bundle
import android.view.Gravity
import android.view.WindowManager
import android.widget.Button
import android.widget.LinearLayout
import android.widget.TextView
import androidx.appcompat.app.AppCompatActivity

/**
 * CriticalAlertActivity — Kotlin port of ../mobile's CriticalAlertActivity.java,
 * the lock-screen-visible half of M12 Critical Alert Overlay.
 *
 * Deliberately THIN: this Activity's only job is to wake a locked/screen-off
 * device and grab attention immediately — the real acknowledge workflow
 * (POST /notifications/:id/ack, the redacted-safe alert detail) lives in
 * `CriticalAlertOverlay.tsx`/`criticalAlertStore.ts`. "Open Baranguard" is
 * this screen's only real action, handing off into the app the moment the
 * device is unlocked, where the JS overlay takes over.
 *
 * The in-process `pendingAlert` handoff (added for the old app's C4 fix)
 * is safe without persistence because this Activity can only be tapped
 * while its own process is already alive — a killed process would have to
 * be started to run this Activity at all, so the process that hosts
 * MainActivity next is the same one holding this companion-object field.
 */
class CriticalAlertActivity : AppCompatActivity() {

  data class PendingAlert(
    val notificationId: String,
    val notificationType: String,
    val title: String,
    val body: String,
  )

  override fun onCreate(savedInstanceState: Bundle?) {
    super.onCreate(savedInstanceState)

    // Android's documented "show over the lock screen and turn the screen
    // on" mechanism — the pre-27 flags remain necessary down to this app's
    // minSdkVersion 24; setShowWhenLocked/setTurnScreenOn (API 27+) are the
    // modern equivalents, so both are set.
    if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O_MR1) {
      setShowWhenLocked(true)
      setTurnScreenOn(true)
    } else {
      @Suppress("DEPRECATION")
      window.addFlags(
        WindowManager.LayoutParams.FLAG_SHOW_WHEN_LOCKED or
          WindowManager.LayoutParams.FLAG_TURN_SCREEN_ON or
          WindowManager.LayoutParams.FLAG_KEEP_SCREEN_ON or
          WindowManager.LayoutParams.FLAG_DISMISS_KEYGUARD,
      )
    }
    (getSystemService(KEYGUARD_SERVICE) as? KeyguardManager)?.requestDismissKeyguard(this, null)

    val title = intent.getStringExtra(EXTRA_TITLE) ?: "Critical alert"
    val body = intent.getStringExtra(EXTRA_BODY) ?: ""
    val notificationId = intent.getStringExtra(EXTRA_NOTIFICATION_ID)
    val notificationType = intent.getStringExtra(EXTRA_NOTIFICATION_TYPE)
    setContentView(buildLayout(title, body, notificationId, notificationType))
  }

  /** Built in code rather than a layout XML resource — two lines of text and one button, not worth a separate res/layout file. */
  private fun buildLayout(title: String, body: String, notificationId: String?, notificationType: String?): LinearLayout {
    val root = LinearLayout(this)
    root.orientation = LinearLayout.VERTICAL
    root.gravity = Gravity.CENTER
    root.setBackgroundColor(Color.parseColor("#DC2626")) // §8 --color-critical
    val pad = (32 * resources.displayMetrics.density).toInt()
    root.setPadding(pad, pad, pad, pad)

    val titleView = TextView(this)
    titleView.text = title
    titleView.setTextColor(Color.WHITE)
    titleView.textSize = 24f
    titleView.setTypeface(null, Typeface.BOLD)
    titleView.gravity = Gravity.CENTER

    val bodyView = TextView(this)
    bodyView.text = body
    bodyView.setTextColor(Color.WHITE)
    bodyView.textSize = 16f
    bodyView.gravity = Gravity.CENTER
    bodyView.setPadding(0, pad / 2, 0, pad)

    val openButton = Button(this)
    openButton.text = "Open Baranguard"
    openButton.setOnClickListener {
      if (notificationId != null && notificationType != null) {
        pendingAlert = PendingAlert(notificationId, notificationType, title, body)
      }
      packageManager.getLaunchIntentForPackage(packageName)?.let { launchIntent ->
        launchIntent.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK or Intent.FLAG_ACTIVITY_CLEAR_TOP)
        startActivity(launchIntent)
      }
      finish()
    }

    root.addView(titleView)
    root.addView(bodyView)
    root.addView(openButton)
    return root
  }

  companion object {
    const val EXTRA_TITLE = "title"
    const val EXTRA_BODY = "body"
    const val EXTRA_NOTIFICATION_ID = "notificationId"
    const val EXTRA_NOTIFICATION_TYPE = "notificationType"

    @Volatile
    private var pendingAlert: PendingAlert? = null

    /** Read-and-clear — a handoff is consumed at most once. */
    fun takePendingAlert(): PendingAlert? {
      val result = pendingAlert
      pendingAlert = null
      return result
    }
  }
}
