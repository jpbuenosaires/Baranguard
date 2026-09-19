package ph.baranguard.tanod;

import android.Manifest;
import android.content.Context;
import android.content.Intent;
import androidx.core.content.ContextCompat;
import com.getcapacitor.JSObject;
import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.CapacitorPlugin;

/**
 * PatrolLocationPlugin — the JS-facing start/stop switch for
 * `PatrolLocationService.java` (Mobile Improvement Plan Phase 4.1).
 *
 * Deliberately does NOT itself request ACCESS_FINE_LOCATION — the JS
 * caller (`patrolLocationService.ts`'s `startPatrolTracking()`) runs
 * `@capacitor/geolocation`'s `requestPermissions()` first (explicitly,
 * since 2026-09-19 — before that the prompt only ever appeared as a side
 * effect of the Live Map/SOS, so a fresh install going on duty from Home
 * first landed here ungranted), so this plugin only CHECKS the grant and
 * refuses cleanly if it's missing rather than duplicating a second
 * permission-request path for the same runtime permission.
 */
@CapacitorPlugin(name = "PatrolLocation")
public class PatrolLocationPlugin extends Plugin {

    @PluginMethod
    public void start(PluginCall call) {
        Context context = getContext();
        boolean hasFineLocation =
            ContextCompat.checkSelfPermission(context, Manifest.permission.ACCESS_FINE_LOCATION)
                == android.content.pm.PackageManager.PERMISSION_GRANTED;
        if (!hasFineLocation) {
            call.reject("ACCESS_FINE_LOCATION is not granted — acquire a GPS fix elsewhere in the app first.");
            return;
        }

        Intent intent = new Intent(context, PatrolLocationService.class);
        ContextCompat.startForegroundService(context, intent);

        JSObject result = new JSObject();
        result.put("started", true);
        call.resolve(result);
    }

    @PluginMethod
    public void stop(PluginCall call) {
        Context context = getContext();
        context.stopService(new Intent(context, PatrolLocationService.class));
        JSObject result = new JSObject();
        result.put("stopped", true);
        call.resolve(result);
    }
}
