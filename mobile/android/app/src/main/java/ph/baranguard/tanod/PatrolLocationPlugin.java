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
 * Deliberately does NOT itself request ACCESS_FINE_LOCATION — every
 * caller in this app (home.tsx toggling duty on) has already gone
 * through `@capacitor/geolocation`'s own permission flow before this
 * point (a Tanod cannot get a GPS fix for SOS or the Live Map otherwise),
 * so this plugin only CHECKS the permission already granted (or refuses
 * cleanly if it somehow isn't) rather than duplicating a second
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
