/**
 * patrolLocationService.ts — the TypeScript edge of
 * `modules/patrol-location` (Kotlin Expo Module), the background patrol GPS
 * foreground service. Ported from ../mobile's patrolLocationService.ts
 * (`@capacitor/geolocation`-based) onto `expo-location` + our own local
 * module.
 *
 * Intended caller: Home's duty-status toggle (M2, a later phase) calls
 * `startPatrolTracking()` when duty status becomes `on_duty` (including on
 * load, if already on duty from a previous session) and
 * `stopPatrolTracking()` on going off duty or signing out — same contract as
 * the old app. Both are best-effort: a rejected `start()` never throws, but
 * `start` returns `false` so the caller can show an honest "GPS off" state.
 *
 * `drainFailedGpsPoints()` is the JS half of the rebuild's fix over the old
 * app's "dropped, not queued" native scope gap: it reads and clears the
 * native failed-point buffer and folds each point into `gps_track_local`
 * with its ORIGINAL client_event_id preserved (Rule 3), the same offline
 * queue `syncService.ts` already drains via `/sync/batch`. Call it whenever
 * the app comes back to the foreground (app-state listener, same phase that
 * wires up duty status) — a point sitting in the native buffer isn't lost,
 * just not yet handed to the encrypted, retried queue.
 */

import * as Location from 'expo-location';
import PatrolLocation from '../../modules/patrol-location';
import { getApiBaseUrl } from './apiService';
import { getDeviceId } from './deviceIdentity';
import { saveGpsPointLocally } from './db/gpsTrackRepository';
import { loadSession } from './session';

/**
 * Starts the foreground GPS service. Never throws — duty status itself is
 * never blocked by this — but tells the caller whether tracking is really
 * running, so the UI can say "GPS off" instead of pretending.
 */
export async function startPatrolTracking(): Promise<boolean> {
  try {
    const foreground = await Location.getForegroundPermissionsAsync();
    const grantedForeground = foreground.granted || (await Location.requestForegroundPermissionsAsync()).granted;
    if (!grantedForeground) return false;

    const session = await loadSession();
    if (!session) return false;
    const deviceId = await getDeviceId();

    const result = await PatrolLocation.start({
      baseUrl: getApiBaseUrl(),
      token: session.token,
      deviceId,
    });
    if (!result.started) return false;

    // Best-effort, never blocks going on duty — C7 (docs/REMAINING.md): shows
    // the OS's own battery-optimization-exemption dialog so a locked-screen
    // shift is less likely to have this foreground service killed by Doze/
    // App Standby. No-ops once already exempt.
    //
    // Awaited (not fire-and-forget) before the background-location request
    // below: both resolve through the same host Activity, and a code review
    // in the old app found firing them in the same tick could race the
    // battery-exemption dialog's Activity transition against the background-
    // location permission launcher trying to use that same, mid-transition
    // Activity — silently dropping the background-location prompt.
    await PatrolLocation.requestBatteryOptimizationExemption().catch(() => undefined);

    // C7's actual 2026-09-24 root-cause finding (carried over from the old
    // app): a location-type foreground service still needs
    // ACCESS_BACKGROUND_LOCATION to keep receiving fixes once the app itself
    // is no longer in the foreground (screen locked). Requested as a
    // genuinely separate call from FINE/COARSE, per Android's own documented
    // requirement — expo-location exposes this directly, no native code
    // needed here unlike the old app's Capacitor plugin.
    Location.getBackgroundPermissionsAsync()
      .then((current) => (current.granted ? current : Location.requestBackgroundPermissionsAsync()))
      .then((permissionResult) => {
        if (!permissionResult.granted) {
          console.warn(
            '[patrolLocationService] ACCESS_BACKGROUND_LOCATION denied — patrol GPS may stop once the screen locks (see C7, docs/REMAINING.md).',
          );
        }
      })
      .catch(() => undefined);

    return true;
  } catch {
    return false;
  }
}

export async function stopPatrolTracking(): Promise<void> {
  try {
    await PatrolLocation.stop();
  } catch {
    // Best-effort — stopping a service that isn't running is a no-op we don't need to distinguish from a real error here.
  }
}

/**
 * Folds any points the native service couldn't POST directly into
 * `gps_track_local`, preserving each point's original client_event_id
 * (Rule 3) — `syncService.ts` picks them up from there on its next drain.
 * Never throws: a drain failure just means those points stay in the native
 * buffer for the next call to try again.
 */
export async function drainFailedGpsPoints(): Promise<number> {
  try {
    const points = await PatrolLocation.drainFailedPoints();
    for (const point of points) {
      await saveGpsPointLocally({
        latitude: point.latitude,
        longitude: point.longitude,
        accuracyM: point.accuracyM,
        recordedAt: point.recordedAt,
        clientEventId: point.clientEventId,
      });
    }
    return points.length;
  } catch {
    return 0;
  }
}
