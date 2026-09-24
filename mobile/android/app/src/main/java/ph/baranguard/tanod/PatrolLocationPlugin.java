package ph.baranguard.tanod;

import android.Manifest;
import android.app.Activity;
import android.content.Context;
import android.content.Intent;
import android.net.Uri;
import android.os.Build;
import android.os.PowerManager;
import android.provider.Settings;
import androidx.core.content.ContextCompat;
import com.getcapacitor.JSObject;
import com.getcapacitor.PermissionState;
import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.CapacitorPlugin;
import com.getcapacitor.annotation.Permission;
import com.getcapacitor.annotation.PermissionCallback;

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
 *
 * DOES request ACCESS_BACKGROUND_LOCATION itself (`requestBackgroundLocationPermission`,
 * added for C7, docs/REMAINING.md) — that one has no equivalent in
 * `@capacitor/geolocation` at all, and Android requires it be requested
 * as a genuinely separate call from FINE/COARSE (see this method's own
 * doc), which only makes sense living next to the plugin that already
 * owns the "is patrol tracking actually going to work" question.
 */
@CapacitorPlugin(
    name = "PatrolLocation",
    permissions = { @Permission(alias = PatrolLocationPlugin.BACKGROUND_LOCATION_ALIAS, strings = { Manifest.permission.ACCESS_BACKGROUND_LOCATION }) }
)
public class PatrolLocationPlugin extends Plugin {

    static final String BACKGROUND_LOCATION_ALIAS = "backgroundLocation";

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

    /**
     * Shows the OS's own "ignore battery optimizations" system dialog for
     * this app — C7 (docs/REMAINING.md): a locked-screen patrol shift is
     * exactly the scenario Doze/App Standby targets, and this is the
     * documented leading fix if a real device kill is ever reproduced.
     * Grants nothing itself; the user approves or denies the real OS
     * prompt, same disclosed-not-silent discipline `PatrolLocationService`'s
     * own persistent notification already follows. Best-effort: no-ops
     * below API 23 (Doze doesn't exist there) and when already exempt: some
     * heavily-customized OEM ROMs block the intent outright, so a launch
     * failure resolves rather than rejects — the caller treats this whole
     * call as best-effort and must never let it block going on duty.
     */
    @PluginMethod
    public void requestBatteryOptimizationExemption(PluginCall call) {
        Context context = getContext();
        JSObject result = new JSObject();

        if (Build.VERSION.SDK_INT < Build.VERSION_CODES.M) {
            result.put("alreadyExempt", true);
            call.resolve(result);
            return;
        }

        PowerManager powerManager = (PowerManager) context.getSystemService(Context.POWER_SERVICE);
        boolean alreadyExempt = powerManager != null
            && powerManager.isIgnoringBatteryOptimizations(context.getPackageName());
        if (alreadyExempt) {
            result.put("alreadyExempt", true);
            call.resolve(result);
            return;
        }

        Activity activity = getActivity();
        if (activity == null) {
            call.reject("No foreground activity to show the battery-optimization dialog.");
            return;
        }

        Intent intent = new Intent(Settings.ACTION_REQUEST_IGNORE_BATTERY_OPTIMIZATIONS);
        intent.setData(Uri.parse("package:" + context.getPackageName()));
        try {
            activity.startActivity(intent);
            result.put("alreadyExempt", false);
            result.put("dialogShown", true);
        } catch (Exception e) {
            // Some OEMs block this intent entirely — fail soft, same
            // best-effort treatment as every other native-plugin edge here.
            result.put("alreadyExempt", false);
            result.put("dialogShown", false);
        }
        call.resolve(result);
    }

    /**
     * Requests ACCESS_BACKGROUND_LOCATION — C7 research finding,
     * 2026-09-24 (docs/REMAINING.md, AndroidManifest.xml's own comment on
     * this permission has the full reasoning): declaring
     * `foregroundServiceType="location"` on `PatrolLocationService` is
     * necessary but NOT sufficient for it to keep receiving fixes once
     * the app itself drops out of the foreground (screen locked) — that
     * needs this permission too, and Android requires it be requested in
     * a SEPARATE call from FINE/COARSE (both `null`-out silently if
     * requested together, since Android 11). Best-effort, same as
     * `requestBatteryOptimizationExemption()`: the caller must never let
     * this block going on duty, and a real device may route the user to
     * Settings instead of an inline dialog (Android 11+ platform
     * behavior, not something this app can control or needs to special-
     * case) — `granted` in the result tells the JS side which happened.
     */
    @PluginMethod
    public void requestBackgroundLocationPermission(PluginCall call) {
        if (Build.VERSION.SDK_INT < Build.VERSION_CODES.Q) {
            // ACCESS_BACKGROUND_LOCATION doesn't exist before Android 10 —
            // foreground location permission already covers this case.
            JSObject result = new JSObject();
            result.put("granted", true);
            call.resolve(result);
            return;
        }
        if (getPermissionState(BACKGROUND_LOCATION_ALIAS) == PermissionState.GRANTED) {
            JSObject result = new JSObject();
            result.put("granted", true);
            call.resolve(result);
            return;
        }
        requestPermissionForAlias(BACKGROUND_LOCATION_ALIAS, call, "backgroundLocationPermissionCallback");
    }

    @PermissionCallback
    private void backgroundLocationPermissionCallback(PluginCall call) {
        JSObject result = new JSObject();
        result.put("granted", getPermissionState(BACKGROUND_LOCATION_ALIAS) == PermissionState.GRANTED);
        call.resolve(result);
    }
}
