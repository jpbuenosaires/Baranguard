package ph.baranguard.tanod.patrollocation

import android.app.Notification
import android.app.NotificationChannel
import android.app.NotificationManager
import android.app.PendingIntent
import android.app.Service
import android.content.Context
import android.content.Intent
import android.location.Location
import android.os.Build
import android.os.IBinder
import android.os.Looper
import android.util.Base64
import androidx.annotation.Nullable
import androidx.core.app.NotificationCompat
import com.google.android.gms.location.FusedLocationProviderClient
import com.google.android.gms.location.LocationCallback
import com.google.android.gms.location.LocationRequest
import com.google.android.gms.location.LocationResult
import com.google.android.gms.location.LocationServices
import com.google.android.gms.location.Priority
import java.io.File
import java.net.HttpURLConnection
import java.net.URI
import java.net.URL
import java.security.KeyStore
import java.security.PrivateKey
import java.security.Signature
import java.text.SimpleDateFormat
import java.util.Date
import java.util.Locale
import java.util.TimeZone
import java.util.UUID
import org.json.JSONObject

/**
 * PatrolLocationService — Kotlin Expo Module port of ../mobile's
 * PatrolLocationService.java (Mobile Improvement Plan Phase 4.1), keeping
 * GPS broadcasting to the workstation while a Tanod is on duty even with the
 * app backgrounded or the screen locked. See that file's own header comment
 * for why this needs to be a foreground Service rather than a JS watch (the
 * reasoning is unchanged; `geolocation.ts` here carries the same "foreground
 * only, this is a separate concern" note).
 *
 * THREE FIXES OVER THE JAVA ORIGINAL, per the rebuild plan (optimized-
 * petting-lightning.md):
 *
 * 1. H-09 signing: every POST /gps now carries X-Device-Id and, when the
 *    device-key Keystore entry already exists (created at login by the
 *    device-key module — `KeyStore.getInstance` here only READS it, never
 *    generates one, since a foreground service has no Activity to prompt
 *    through), X-Device-Timestamp/X-Device-Signature too. The original never
 *    sent any of these.
 * 2. Rule 3 (idempotency): exactly one client_event_id is minted per fix,
 *    reused for both the direct POST attempt and the buffered-failure copy
 *    below — never two different ids for one physical point.
 * 3. A point that fails to POST is no longer silently dropped: it's appended
 *    to a small JSONL file in app-private storage, which
 *    `PatrolLocationModule.drainFailedPoints()` reads and clears on the JS
 *    side so `patrolLocationService.ts` can fold it into `gps_track_local`
 *    (the same offline-queue table the foreground JS GPS path already
 *    uses) for `syncService.ts` to send on. The Service itself still does
 *    zero retrying and zero encryption — that division of labor (native:
 *    capture + best-effort send + hand-off; JS: encrypted persistence +
 *    retry) is what keeps this class small.
 *
 * Config (`baseUrl`/`token`/`deviceId`) is written by
 * `PatrolLocationModule.start()` into this app's own private SharedPreferences
 * file (NOT `@react-native-async-storage/async-storage`'s or
 * `expo-secure-store`'s backing files — both are more involved to read
 * correctly from outside their own JS-side libraries, and the plan's own
 * scope note says this service should "get these values directly instead of
 * reading [the old app's] SharedPreferences keys"). A session renewal
 * (`X-Renewed-Token`) during a shift is not re-pushed into this file
 * automatically — same accepted scope boundary the Java original's read-
 * every-attempt-from-Preferences design didn't have to make, but sliding-
 * window device sessions (§2 Rule 12) stay alive from this service's own
 * successful requests either way, so a multi-hour patrol shift does not by
 * itself expire the token this service is holding.
 */
class PatrolLocationService : Service() {

  private var fusedLocationClient: FusedLocationProviderClient? = null
  private var locationCallback: LocationCallback? = null

  override fun onCreate() {
    super.onCreate()
    createNotificationChannel()
    startForeground(NOTIFICATION_ID, buildNotification())
    startLocationUpdates()
  }

  override fun onStartCommand(intent: Intent?, flags: Int, startId: Int): Int {
    // START_STICKY: if the OS kills this process under memory pressure, it
    // restarts the service (with a null Intent) rather than leaving a Tanod
    // silently untracked for the rest of their shift. Config was already
    // persisted to SharedPreferences by start(), so onCreate() can resume
    // without needing the original Intent's extras.
    return START_STICKY
  }

  override fun onDestroy() {
    val client = fusedLocationClient
    val callback = locationCallback
    if (client != null && callback != null) {
      client.removeLocationUpdates(callback)
    }
    super.onDestroy()
  }

  @Nullable
  override fun onBind(intent: Intent?): IBinder? {
    // Not a bound service — PatrolLocationModule only ever starts/stops it.
    return null
  }

  private fun startLocationUpdates() {
    val client = LocationServices.getFusedLocationProviderClient(this)
    fusedLocationClient = client
    val request = LocationRequest.Builder(Priority.PRIORITY_HIGH_ACCURACY, UPDATE_INTERVAL_MS).build()
    val callback = object : LocationCallback() {
      override fun onLocationResult(result: LocationResult) {
        result.lastLocation?.let { postGpsPoint(it) }
      }
    }
    locationCallback = callback
    try {
      client.requestLocationUpdates(request, callback, Looper.getMainLooper())
    } catch (e: SecurityException) {
      // ACCESS_FINE_LOCATION was revoked after this service started (e.g.
      // from Android Settings mid-shift) — stop cleanly rather than crash;
      // PatrolLocationModule's own permission check before starting this
      // service is the normal gate, this is just the defensive fallback.
      stopSelf()
    }
  }

  /** Runs the network call off the main thread — a plain background Thread is enough for one small POST every 30s. */
  private fun postGpsPoint(location: Location) {
    Thread {
      val prefs = getSharedPreferences(CONFIG_PREFS_NAME, Context.MODE_PRIVATE)
      val baseUrl = prefs.getString(KEY_BASE_URL, null)
      val token = prefs.getString(KEY_TOKEN, null)
      val deviceId = prefs.getString(KEY_DEVICE_ID, null)
      if (baseUrl == null || token == null || deviceId == null) {
        return@Thread // Signed out — nothing to authenticate this POST with, and nobody to buffer it for.
      }

      // Minted ONCE per fix (Rule 3) — reused below for the buffered-failure
      // copy too, so a point never ends up with two different server-facing ids.
      val clientEventId = UUID.randomUUID().toString()
      val recordedAt = toIso8601Utc(location.time)

      val succeeded = try {
        sendGpsPoint(baseUrl, token, deviceId, location, clientEventId, recordedAt)
      } catch (e: Exception) {
        false
      }

      if (!succeeded) {
        bufferFailedPoint(location, clientEventId, recordedAt)
      }
    }.start()
  }

  private fun sendGpsPoint(
    baseUrl: String,
    token: String,
    deviceId: String,
    location: Location,
    clientEventId: String,
    recordedAt: String,
  ): Boolean {
    val body = JSONObject().apply {
      put("latitude", location.latitude)
      put("longitude", location.longitude)
      put("accuracy_m", location.accuracy)
      put("recorded_at", recordedAt)
      put("client_event_id", clientEventId)
    }

    val path = basePathOf(baseUrl) + "/gps"
    val timestamp = (System.currentTimeMillis() / 1000).toString()
    val signature = signRequestOrNull("POST", path, deviceId, timestamp)

    val connection = URL(baseUrl + "/gps").openConnection() as HttpURLConnection
    return try {
      connection.requestMethod = "POST"
      connection.setRequestProperty("Content-Type", "application/json")
      connection.setRequestProperty("Authorization", "Bearer $token")
      connection.setRequestProperty("X-Device-Id", deviceId)
      if (signature != null) {
        connection.setRequestProperty("X-Device-Timestamp", timestamp)
        connection.setRequestProperty("X-Device-Signature", signature)
      }
      connection.connectTimeout = 10000
      connection.readTimeout = 10000
      connection.doOutput = true
      connection.outputStream.use { it.write(body.toString().toByteArray(Charsets.UTF_8)) }
      val status = connection.responseCode
      status in 200..299
    } finally {
      connection.disconnect()
    }
  }

  /** Same mount-prefix-aware path derivation as apiService.ts's basePathOf(), so the signed string matches server-side exactly. */
  private fun basePathOf(baseUrl: String): String {
    return try {
      (URI(baseUrl).path ?: "").trimEnd('/')
    } catch (e: Exception) {
      ""
    }
  }

  /**
   * Reads (never creates) the H-09 Keystore key the device-key module
   * generates at login. A foreground service has no Activity/UI, so it must
   * never attempt key generation itself — if the alias doesn't exist yet
   * (e.g. patrol somehow started before a first login on this install),
   * this returns null and the request goes out X-Device-Id-only, same as a
   * not-yet-upgraded device (deviceIdentity.ts's own documented contract).
   */
  private fun signRequestOrNull(method: String, path: String, deviceId: String, timestamp: String): String? {
    return try {
      val keyStore = KeyStore.getInstance(KEYSTORE_PROVIDER).apply { load(null) }
      if (!keyStore.containsAlias(KEY_ALIAS)) return null
      val privateKey = keyStore.getKey(KEY_ALIAS, null) as? PrivateKey ?: return null
      val payload = "$method\n$path\n$deviceId\n$timestamp"
      val signature = Signature.getInstance("SHA256withECDSA")
      signature.initSign(privateKey)
      signature.update(payload.toByteArray(Charsets.UTF_8))
      Base64.encodeToString(signature.sign(), Base64.NO_WRAP)
    } catch (e: Exception) {
      null
    }
  }

  /** Appends one JSONL line — drained and cleared by PatrolLocationModule.drainFailedPoints(). */
  private fun bufferFailedPoint(location: Location, clientEventId: String, recordedAt: String) {
    try {
      val entry = JSONObject().apply {
        put("latitude", location.latitude)
        put("longitude", location.longitude)
        put("accuracy_m", location.accuracy)
        put("recorded_at", recordedAt)
        put("client_event_id", clientEventId)
      }
      synchronized(FILE_LOCK) {
        File(filesDir, FAILED_POINTS_FILENAME).appendText(entry.toString() + "\n")
      }
    } catch (e: Exception) {
      // Best-effort buffer; losing a point here is the same accepted
      // tradeoff this class's own header comment already documents for a
      // POST failure — full durability would mean re-implementing the
      // encrypted local queue natively, disproportionate scope.
    }
  }

  private fun toIso8601Utc(epochMillis: Long): String {
    val format = SimpleDateFormat("yyyy-MM-dd'T'HH:mm:ss'Z'", Locale.US)
    format.timeZone = TimeZone.getTimeZone("UTC")
    return format.format(Date(epochMillis))
  }

  private fun createNotificationChannel() {
    if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
      val channel = NotificationChannel(CHANNEL_ID, "Patrol Tracking", NotificationManager.IMPORTANCE_LOW)
      channel.description = "Shows while your position is being transmitted to Barangay HQ during an active patrol."
      val manager = getSystemService(NotificationManager::class.java)
      manager?.createNotificationChannel(channel)
    }
  }

  private fun buildNotification(): Notification {
    val launchIntent = packageManager.getLaunchIntentForPackage(packageName)
    val flags = if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.S) PendingIntent.FLAG_IMMUTABLE else 0
    val contentIntent = if (launchIntent != null) PendingIntent.getActivity(this, 0, launchIntent, flags) else null

    return NotificationCompat.Builder(this, CHANNEL_ID)
      .setContentTitle("Baranguard Patrol Active")
      .setContentText("Transmitting real-time coordinates to Barangay Command Center")
      .setSmallIcon(android.R.drawable.ic_menu_mylocation)
      .setOngoing(true)
      .setContentIntent(contentIntent)
      .build()
  }

  companion object {
    const val CONFIG_PREFS_NAME = "patrol_location_config"
    const val KEY_BASE_URL = "baseUrl"
    const val KEY_TOKEN = "token"
    const val KEY_DEVICE_ID = "deviceId"
    const val FAILED_POINTS_FILENAME = "patrol_failed_points.jsonl"
    val FILE_LOCK = Any()

    private const val CHANNEL_ID = "baranguard_patrol"
    private const val NOTIFICATION_ID = 1001
    private const val UPDATE_INTERVAL_MS = 30000L
    private const val KEY_ALIAS = "baranguard_device_identity"
    private const val KEYSTORE_PROVIDER = "AndroidKeyStore"
  }
}
