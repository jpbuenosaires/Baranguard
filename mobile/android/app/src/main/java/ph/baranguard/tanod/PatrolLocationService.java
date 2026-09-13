package ph.baranguard.tanod;

import android.app.Notification;
import android.app.NotificationChannel;
import android.app.NotificationManager;
import android.app.PendingIntent;
import android.app.Service;
import android.content.Context;
import android.content.Intent;
import android.content.SharedPreferences;
import android.location.Location;
import android.os.Build;
import android.os.IBinder;
import android.os.Looper;
import androidx.annotation.Nullable;
import androidx.core.app.NotificationCompat;
import com.google.android.gms.location.FusedLocationProviderClient;
import com.google.android.gms.location.LocationCallback;
import com.google.android.gms.location.LocationRequest;
import com.google.android.gms.location.LocationResult;
import com.google.android.gms.location.LocationServices;
import com.google.android.gms.location.Priority;
import java.io.OutputStream;
import java.net.HttpURLConnection;
import java.net.URL;
import java.text.SimpleDateFormat;
import java.util.Date;
import java.util.Locale;
import java.util.TimeZone;
import java.util.UUID;
import org.json.JSONObject;

/**
 * PatrolLocationService — Mobile Improvement Plan Phase 4.1: keeps GPS
 * broadcasting to the workstation while a Tanod is on duty, even with the
 * app backgrounded or the screen locked.
 *
 * WHY A NATIVE SERVICE, NOT JUST live-map.tsx's EXISTING WATCH: that
 * screen's own header comment is explicit — its GPS broadcast is
 * "FOREGROUND-ONLY... starts when this screen mounts, stops when it
 * unmounts" — a deliberate Sprint-3-era scope decision. The moment the
 * app is backgrounded or the Tanod is on a different screen, that JS
 * timer/watch stops. A foreground Service is the standard Android
 * mechanism for exactly this gap: it survives backgrounding (and, with
 * FusedLocationProviderClient rather than a WebView-JS location watch, it
 * survives the WebView being suspended too), at the cost of a persistent,
 * always-visible notification — which Android REQUIRES for a foreground
 * service and which is also the honest thing to show a Tanod: tracking
 * that isn't visibly disclosed is exactly the kind of thing §2 Rule 6
 * forbids, emergency-response justification or not.
 *
 * SCOPE DECISION, STATED PLAINLY: a point that fails to POST (offline,
 * server error) is DROPPED, not queued. Full parity with the JS side's
 * offline-queue architecture (`gps_track_local`, SQLCipher-encrypted)
 * would mean re-implementing encrypted local storage and the sync
 * reconciliation logic in native Java — real scope, disproportionate to
 * what this pass asks for. A moving patrol reports a new point every
 * ~30s; losing one point to a transient network blip is an acceptable
 * tradeoff the foreground JS path doesn't have to make (and doesn't
 * make — `gps_track_local` there IS queued). This tradeoff is intentional
 * and logged, not an oversight.
 *
 * Reads the session token and API base URL directly from the
 * "CapacitorStorage" SharedPreferences file — the same file
 * `@capacitor/preferences` itself reads/writes (confirmed from that
 * plugin's own Android source, not assumed), under the exact keys
 * `session.ts`/`apiService.ts` already use. No Capacitor Bridge/WebView
 * access is needed or possible from here — this runs as an independent
 * Service, potentially with the Activity/WebView already destroyed.
 */
public class PatrolLocationService extends Service {

    private static final String CHANNEL_ID = "baranguard_patrol";
    private static final int NOTIFICATION_ID = 1001;
    private static final String PREFS_NAME = "CapacitorStorage";
    private static final String SESSION_KEY = "baranguard.session";
    private static final String API_BASE_URL_KEY = "baranguard.effectiveApiBaseUrl";
    private static final String DEFAULT_API_BASE_URL = "http://192.168.1.10/baranguard-api/api/v1";
    private static final long UPDATE_INTERVAL_MS = 30000;

    private FusedLocationProviderClient fusedLocationClient;
    private LocationCallback locationCallback;

    @Override
    public void onCreate() {
        super.onCreate();
        createNotificationChannel();
        startForeground(NOTIFICATION_ID, buildNotification());
        startLocationUpdates();
    }

    @Override
    public int onStartCommand(Intent intent, int flags, int startId) {
        // START_STICKY: if the OS kills this process under memory
        // pressure, it restarts the service (with a null Intent) rather
        // than leaving a Tanod silently untracked for the rest of their
        // shift — restarting onCreate()'s own logic is enough to resume.
        return START_STICKY;
    }

    @Override
    public void onDestroy() {
        if (fusedLocationClient != null && locationCallback != null) {
            fusedLocationClient.removeLocationUpdates(locationCallback);
        }
        super.onDestroy();
    }

    @Nullable
    @Override
    public IBinder onBind(Intent intent) {
        // Not a bound service — PatrolLocationPlugin only ever starts/stops it.
        return null;
    }

    private void startLocationUpdates() {
        fusedLocationClient = LocationServices.getFusedLocationProviderClient(this);
        LocationRequest request = new LocationRequest.Builder(Priority.PRIORITY_HIGH_ACCURACY, UPDATE_INTERVAL_MS).build();
        locationCallback = new LocationCallback() {
            @Override
            public void onLocationResult(LocationResult result) {
                Location location = result.getLastLocation();
                if (location != null) {
                    postGpsPoint(location);
                }
            }
        };
        try {
            fusedLocationClient.requestLocationUpdates(request, locationCallback, Looper.getMainLooper());
        } catch (SecurityException e) {
            // ACCESS_FINE_LOCATION was revoked after this service started
            // (e.g. from Android Settings mid-shift) — stop cleanly rather
            // than crash; PatrolLocationPlugin's own permission check
            // before starting this service is the normal gate, this is
            // just the defensive fallback for a permission pulled later.
            stopSelf();
        }
    }

    /** Runs the network call off the main thread — a plain background Thread is enough for one small POST every 30s, no need for a full executor/WorkManager setup. */
    private void postGpsPoint(final Location location) {
        new Thread(new Runnable() {
            @Override
            public void run() {
                try {
                    SharedPreferences prefs = getSharedPreferences(PREFS_NAME, Context.MODE_PRIVATE);
                    String sessionJson = prefs.getString(SESSION_KEY, null);
                    if (sessionJson == null) {
                        return; // Signed out — nothing to authenticate this POST with.
                    }
                    String token = new JSONObject(sessionJson).getString("token");
                    String baseUrl = prefs.getString(API_BASE_URL_KEY, DEFAULT_API_BASE_URL);

                    JSONObject body = new JSONObject();
                    body.put("latitude", location.getLatitude());
                    body.put("longitude", location.getLongitude());
                    body.put("accuracy_m", location.getAccuracy());
                    body.put("recorded_at", toIso8601Utc(location.getTime()));
                    body.put("client_event_id", UUID.randomUUID().toString());

                    URL url = new URL(baseUrl + "/gps");
                    HttpURLConnection connection = (HttpURLConnection) url.openConnection();
                    connection.setRequestMethod("POST");
                    connection.setRequestProperty("Content-Type", "application/json");
                    connection.setRequestProperty("Authorization", "Bearer " + token);
                    connection.setConnectTimeout(10000);
                    connection.setReadTimeout(10000);
                    connection.setDoOutput(true);

                    try (OutputStream out = connection.getOutputStream()) {
                        out.write(body.toString().getBytes("UTF-8"));
                    }
                    // Draining the response is what actually sends the
                    // request on HttpURLConnection; the point is dropped
                    // either way per this class's own documented tradeoff
                    // above, so the status code itself isn't branched on.
                    connection.getResponseCode();
                    connection.disconnect();
                } catch (Exception e) {
                    // Dropped, not queued/retried — see class doc.
                }
            }
        }).start();
    }

    private static String toIso8601Utc(long epochMillis) {
        SimpleDateFormat format = new SimpleDateFormat("yyyy-MM-dd'T'HH:mm:ss'Z'", Locale.US);
        format.setTimeZone(TimeZone.getTimeZone("UTC"));
        return format.format(new Date(epochMillis));
    }

    private void createNotificationChannel() {
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
            NotificationChannel channel = new NotificationChannel(
                CHANNEL_ID,
                "Patrol Tracking",
                NotificationManager.IMPORTANCE_LOW
            );
            channel.setDescription("Shows while your position is being transmitted to Barangay HQ during an active patrol.");
            NotificationManager manager = getSystemService(NotificationManager.class);
            if (manager != null) {
                manager.createNotificationChannel(channel);
            }
        }
    }

    private Notification buildNotification() {
        Intent launchIntent = getPackageManager().getLaunchIntentForPackage(getPackageName());
        int flags = Build.VERSION.SDK_INT >= Build.VERSION_CODES.S ? PendingIntent.FLAG_IMMUTABLE : 0;
        PendingIntent contentIntent = launchIntent != null
            ? PendingIntent.getActivity(this, 0, launchIntent, flags)
            : null;

        return new NotificationCompat.Builder(this, CHANNEL_ID)
            .setContentTitle("Baranguard Patrol Active")
            .setContentText("Transmitting real-time coordinates to Barangay Command Center")
            .setSmallIcon(android.R.drawable.ic_menu_mylocation)
            .setOngoing(true)
            .setContentIntent(contentIntent)
            .build();
    }
}
