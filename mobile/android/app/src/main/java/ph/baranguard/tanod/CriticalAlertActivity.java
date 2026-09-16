package ph.baranguard.tanod;

import android.app.KeyguardManager;
import android.content.Intent;
import android.graphics.Color;
import android.graphics.Typeface;
import android.os.Build;
import android.os.Bundle;
import android.view.Gravity;
import android.view.WindowManager;
import android.widget.Button;
import android.widget.LinearLayout;
import android.widget.TextView;
import androidx.appcompat.app.AppCompatActivity;

/**
 * CriticalAlertActivity — Mobile Improvement Plan Phase 4.2: the
 * lock-screen-visible half of M12 Critical Alert Overlay.
 *
 * Deliberately THIN: this Activity's only job is to wake a locked/screen-
 * off device and grab attention immediately — the ACTUAL acknowledge
 * workflow (POST /notifications/:id/ack, the redacted-safe alert detail)
 * already exists and is fully built in `CriticalAlertOverlay.tsx`/
 * `criticalAlertStore.ts`. Duplicating that here in native code would be
 * exactly the kind of second, drifting implementation this codebase
 * avoids elsewhere (see apiService.ts's "one central API client" rule) —
 * so "Open Baranguard" is this screen's only real action, handing off
 * into the app the moment the device is unlocked and attention is
 * secured, where the existing JS overlay takes over.
 *
 * NOT DEVICE-VERIFIED for an actual locked-screen wake (same disclosure
 * as everything else FCM-adjacent in this codebase — see
 * deviceIdentity.ts's getFcmToken()): the window flags below are Android's
 * documented mechanism, exercised in this session only via a manual
 * trigger while the device was unlocked, since no real FCM project exists
 * to deliver a genuine locked-screen push (REMAINING.md A4).
 *
 * HANDOFF, ADDED 2026-09-15 (C4): "Open Baranguard" used to cold-launch
 * the app with no context, so criticalAlertStore.ts's real acknowledge
 * UI never learned which alert to show. `pendingAlert` is a static,
 * in-process holder set just before that launch and read once by
 * `FullScreenAlertPlugin.getPendingAlert()` — safe without
 * SharedPreferences/persistence because this Activity can only be tapped
 * while its own process is already alive (a killed process would have to
 * be started to run this Activity at all), so the process that will host
 * MainActivity next is the same one holding this static field.
 */
public class CriticalAlertActivity extends AppCompatActivity {

    public static final String EXTRA_TITLE = "title";
    public static final String EXTRA_BODY = "body";
    public static final String EXTRA_NOTIFICATION_ID = "notificationId";
    public static final String EXTRA_NOTIFICATION_TYPE = "notificationType";

    /** Plain data holder for the in-process handoff described above. */
    static final class PendingAlert {
        final String notificationId;
        final String notificationType;
        final String title;
        final String body;

        PendingAlert(String notificationId, String notificationType, String title, String body) {
            this.notificationId = notificationId;
            this.notificationType = notificationType;
            this.title = title;
            this.body = body;
        }
    }

    private static volatile PendingAlert pendingAlert;

    /** Read-and-clear — a handoff is consumed at most once. */
    static PendingAlert takePendingAlert() {
        PendingAlert result = pendingAlert;
        pendingAlert = null;
        return result;
    }

    @Override
    protected void onCreate(Bundle savedInstanceState) {
        super.onCreate(savedInstanceState);

        // Android's documented "show over the lock screen and turn the
        // screen on" mechanism — the pre-27 flags remain necessary down to
        // this app's minSdkVersion 24; setShowWhenLocked/setTurnScreenOn
        // (API 27+) are the modern equivalents, so both are set.
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O_MR1) {
            setShowWhenLocked(true);
            setTurnScreenOn(true);
        } else {
            getWindow().addFlags(
                WindowManager.LayoutParams.FLAG_SHOW_WHEN_LOCKED
                    | WindowManager.LayoutParams.FLAG_TURN_SCREEN_ON
                    | WindowManager.LayoutParams.FLAG_KEEP_SCREEN_ON
                    | WindowManager.LayoutParams.FLAG_DISMISS_KEYGUARD
            );
        }
        KeyguardManager keyguardManager = (KeyguardManager) getSystemService(KEYGUARD_SERVICE);
        if (keyguardManager != null) {
            keyguardManager.requestDismissKeyguard(this, null);
        }

        String title = getIntent().getStringExtra(EXTRA_TITLE);
        String body = getIntent().getStringExtra(EXTRA_BODY);
        String notificationId = getIntent().getStringExtra(EXTRA_NOTIFICATION_ID);
        String notificationType = getIntent().getStringExtra(EXTRA_NOTIFICATION_TYPE);
        setContentView(buildLayout(
            title != null ? title : "Critical alert",
            body != null ? body : "",
            notificationId,
            notificationType
        ));
    }

    /** Built in code rather than a layout XML resource — this screen has exactly two lines of text and one button, not worth a separate res/layout file. */
    private LinearLayout buildLayout(String title, String body, String notificationId, String notificationType) {
        LinearLayout root = new LinearLayout(this);
        root.setOrientation(LinearLayout.VERTICAL);
        root.setGravity(Gravity.CENTER);
        root.setBackgroundColor(Color.parseColor("#DC2626")); // §8 --color-critical
        int pad = (int) (32 * getResources().getDisplayMetrics().density);
        root.setPadding(pad, pad, pad, pad);

        TextView titleView = new TextView(this);
        titleView.setText(title);
        titleView.setTextColor(Color.WHITE);
        titleView.setTextSize(24);
        titleView.setTypeface(null, Typeface.BOLD);
        titleView.setGravity(Gravity.CENTER);

        TextView bodyView = new TextView(this);
        bodyView.setText(body);
        bodyView.setTextColor(Color.WHITE);
        bodyView.setTextSize(16);
        bodyView.setGravity(Gravity.CENTER);
        bodyView.setPadding(0, pad / 2, 0, pad);

        Button openButton = new Button(this);
        openButton.setText("Open Baranguard");
        openButton.setOnClickListener(v -> {
            if (notificationId != null && notificationType != null) {
                pendingAlert = new PendingAlert(notificationId, notificationType, title, body);
            }
            Intent launchIntent = getPackageManager().getLaunchIntentForPackage(getPackageName());
            if (launchIntent != null) {
                launchIntent.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK | Intent.FLAG_ACTIVITY_CLEAR_TOP);
                startActivity(launchIntent);
            }
            finish();
        });

        root.addView(titleView);
        root.addView(bodyView);
        root.addView(openButton);
        return root;
    }
}
