package ph.baranguard.tanod;

import android.os.Bundle;
import com.getcapacitor.BridgeActivity;

public class MainActivity extends BridgeActivity {
    @Override
    public void onCreate(Bundle savedInstanceState) {
        // Local custom plugins — registered before super.onCreate(), same
        // as Capacitor's own documented pattern for a plugin not resolved
        // from capacitor.config.ts's automatic native-dependency scan.
        registerPlugin(SosSmsPlugin.class); // SOS fallback SMS
        registerPlugin(PatrolLocationPlugin.class); // background patrol GPS
        registerPlugin(FullScreenAlertPlugin.class); // full-screen critical alert (test trigger)
        registerPlugin(DeviceKeyPlugin.class); // hardware-backed device identity keypair
        super.onCreate(savedInstanceState);
    }
}

