package ph.baranguard.tanod.patrollocation

import android.Manifest
import android.app.Activity
import android.content.Context
import android.content.Intent
import android.content.pm.PackageManager
import android.net.Uri
import android.os.Build
import android.os.PowerManager
import android.provider.Settings
import androidx.core.content.ContextCompat
import expo.modules.kotlin.exception.Exceptions
import expo.modules.kotlin.modules.Module
import expo.modules.kotlin.modules.ModuleDefinition
import expo.modules.kotlin.records.Field
import expo.modules.kotlin.records.Record
import expo.modules.kotlin.types.OptimizedRecord
import java.io.File
import org.json.JSONObject

@OptimizedRecord
class PatrolLocationStartConfig(
  @Field val baseUrl: String = "",
  @Field val token: String = "",
  @Field val deviceId: String = "",
) : Record

@OptimizedRecord
class PatrolLocationStartResult(
  @Field val started: Boolean = false,
) : Record

@OptimizedRecord
class PatrolLocationStopResult(
  @Field val stopped: Boolean = false,
) : Record

@OptimizedRecord
class BatteryExemptionResult(
  @Field val alreadyExempt: Boolean = false,
  @Field val dialogShown: Boolean? = null,
) : Record

@OptimizedRecord
class FailedPointRecord(
  @Field val latitude: Double = 0.0,
  @Field val longitude: Double = 0.0,
  @Field val accuracyM: Double = 0.0,
  @Field val recordedAt: String = "",
  @Field val clientEventId: String = "",
) : Record

/**
 * PatrolLocationModule — the JS-facing start/stop switch for
 * PatrolLocationService.kt, port of ../mobile's PatrolLocationPlugin.java.
 *
 * Deliberately does NOT itself request ACCESS_FINE_LOCATION — the JS caller
 * (`patrolLocationService.ts`'s `startPatrolTracking()`) runs
 * `expo-location`'s `requestForegroundPermissionsAsync()` first, so this
 * module only CHECKS the grant and refuses cleanly if it's missing.
 * Background location (ACCESS_BACKGROUND_LOCATION) is requested from JS too,
 * via `expo-location`'s own `requestBackgroundPermissionsAsync()` — unlike
 * the Capacitor original, no native permission-request code is needed here
 * for that at all.
 */
class PatrolLocationModule : Module() {
  override fun definition() = ModuleDefinition {
    Name("PatrolLocation")

    AsyncFunction("start") { config: PatrolLocationStartConfig ->
      val context = appContext.reactContext ?: throw Exceptions.ReactContextLost()
      val hasFineLocation = ContextCompat.checkSelfPermission(context, Manifest.permission.ACCESS_FINE_LOCATION) ==
        PackageManager.PERMISSION_GRANTED
      if (!hasFineLocation) {
        throw Exception("ACCESS_FINE_LOCATION is not granted — acquire a GPS fix elsewhere in the app first.")
      }

      context.getSharedPreferences(PatrolLocationService.CONFIG_PREFS_NAME, Context.MODE_PRIVATE)
        .edit()
        .putString(PatrolLocationService.KEY_BASE_URL, config.baseUrl)
        .putString(PatrolLocationService.KEY_TOKEN, config.token)
        .putString(PatrolLocationService.KEY_DEVICE_ID, config.deviceId)
        .apply()

      ContextCompat.startForegroundService(context, Intent(context, PatrolLocationService::class.java))
      PatrolLocationStartResult(true)
    }

    AsyncFunction("stop") {
      val context = appContext.reactContext ?: throw Exceptions.ReactContextLost()
      context.stopService(Intent(context, PatrolLocationService::class.java))
      PatrolLocationStopResult(true)
    }

    /**
     * Shows the OS's own "ignore battery optimizations" dialog — C7's
     * documented leading fix for a locked-screen patrol shift being killed
     * by Doze/App Standby. Grants nothing itself; best-effort, same as the
     * Java original — never lets a decline block going on duty.
     */
    AsyncFunction("requestBatteryOptimizationExemption") {
      val context = appContext.reactContext ?: throw Exceptions.ReactContextLost()

      if (Build.VERSION.SDK_INT < Build.VERSION_CODES.M) {
        return@AsyncFunction BatteryExemptionResult(true, null)
      }

      val powerManager = context.getSystemService(Context.POWER_SERVICE) as? PowerManager
      if (powerManager?.isIgnoringBatteryOptimizations(context.packageName) == true) {
        return@AsyncFunction BatteryExemptionResult(true, null)
      }

      val activity: Activity = appContext.currentActivity
        ?: throw Exception("No foreground activity to show the battery-optimization dialog.")

      val intent = Intent(Settings.ACTION_REQUEST_IGNORE_BATTERY_OPTIMIZATIONS)
      intent.data = Uri.parse("package:" + context.packageName)
      try {
        activity.startActivity(intent)
        BatteryExemptionResult(false, true)
      } catch (e: Exception) {
        // Some OEMs block this intent entirely — fail soft, same best-effort
        // treatment as every other native-plugin edge in this app.
        BatteryExemptionResult(false, false)
      }
    }

    /**
     * Reads and clears the failed-point buffer PatrolLocationService.kt
     * writes to on a POST failure — `patrolLocationService.ts` folds the
     * result into `gps_track_local` (the same offline queue the foreground
     * JS GPS path already uses) so a point dropped while the app was fully
     * backgrounded still reaches the server once connectivity returns,
     * fixing the Java original's "dropped, not queued" scope gap.
     */
    AsyncFunction("drainFailedPoints") {
      val context = appContext.reactContext ?: throw Exceptions.ReactContextLost()
      val file = File(context.filesDir, PatrolLocationService.FAILED_POINTS_FILENAME)
      if (!file.exists()) return@AsyncFunction emptyList<FailedPointRecord>()

      val points = mutableListOf<FailedPointRecord>()
      synchronized(PatrolLocationService.FILE_LOCK) {
        val lines = file.readLines()
        file.delete()
        for (line in lines) {
          if (line.isBlank()) continue
          try {
            val obj = JSONObject(line)
            points.add(
              FailedPointRecord(
                latitude = obj.getDouble("latitude"),
                longitude = obj.getDouble("longitude"),
                accuracyM = obj.getDouble("accuracy_m"),
                recordedAt = obj.getString("recorded_at"),
                clientEventId = obj.getString("client_event_id"),
              )
            )
          } catch (e: Exception) {
            // Malformed line — skip rather than fail the whole drain.
          }
        }
      }
      points
    }
  }
}
