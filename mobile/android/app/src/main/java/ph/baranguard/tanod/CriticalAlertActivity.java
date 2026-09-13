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
 */
public class CriticalAlertActivity extends AppCompatActivity {

    public static final String EXTRA_TITLE = "title";
    public static final String EXTRA_BODY = "body";

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
        setContentView(buildLayout(
            title != null ? title : "Critical alert",
            body != null ? body : ""
        ));
    }

    /** Built in code rather than a layout XML resource — this screen has exactly two lines of text and one button, not worth a separate res/layout file. */
    private LinearLayout buildLayout(String title, String body) {
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
