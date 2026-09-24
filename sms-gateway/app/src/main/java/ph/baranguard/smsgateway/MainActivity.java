package ph.baranguard.smsgateway;

import android.app.Activity;
import android.content.pm.PackageManager;
import android.os.Bundle;
import android.widget.TextView;

/**
 * MainActivity — not part of the send path (SendSmsReceiver.java is).
 * Exists only so this app has a launcher icon and a way for whoever set
 * this phone up to confirm SEND_SMS is actually granted (it's granted via
 * `adb shell pm grant` at install time, not a runtime prompt — this phone
 * is never operated by touch for this app's real job). Purely a status
 * screen, no controls.
 */
public class MainActivity extends Activity {
    @Override
    protected void onCreate(Bundle savedInstanceState) {
        super.onCreate(savedInstanceState);
        TextView view = new TextView(this);
        int padding = (int) (24 * getResources().getDisplayMetrics().density);
        view.setPadding(padding, padding, padding, padding);
        view.setTextSize(16);

        boolean granted = checkSelfPermission(android.Manifest.permission.SEND_SMS)
            == PackageManager.PERMISSION_GRANTED;

        view.setText(
            "Baranguard SMS Gateway\n\n"
            + "This phone sends outbound SMS on command from the barangay\n"
            + "workstation over adb. It has no user interface for sending —\n"
            + "everything happens via `adb shell am broadcast`.\n\n"
            + "SEND_SMS permission: " + (granted ? "GRANTED" : "NOT GRANTED — run:\n"
                + "adb shell pm grant ph.baranguard.smsgateway android.permission.SEND_SMS")
        );
        setContentView(view);
    }
}
