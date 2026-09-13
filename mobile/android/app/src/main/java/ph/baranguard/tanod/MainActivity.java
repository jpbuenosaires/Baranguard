package ph.baranguard.tanod;

import android.os.Bundle;
import com.getcapacitor.BridgeActivity;

public class MainActivity extends BridgeActivity {
    @Override
    public void onCreate(Bundle savedInstanceState) {
        // Local custom plugins — registered before super.onCreate(), same
        // as Capacitor's own documented pattern for a plugin not resolved
        // from capacitor.config.ts's automatic native-dependency scan.
        registerPlugin(SosSmsPlugin.class); // Phase 4.3, G1's SOS fallback SMS
        registerPlugin(PatrolLocationPlugin.class); // Phase 4.1, background patrol GPS
        registerPlugin(FullScreenAlertPlugin.class); // Phase 4.2, full-screen critical alert (test trigger)
        super.onCreate(savedInstanceState);
    }
}
