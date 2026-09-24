/**
 * patrolLocationService.ts — the TypeScript edge of
 * `PatrolLocationService.java`/`PatrolLocationPlugin.java` (Android), a
 * LOCAL custom Capacitor plugin (not an npm dependency) for the
 * background patrol GPS foreground service (Mobile Improvement Plan
 * Phase 4.1).
 *
 * `home.tsx` calls `startPatrolTracking()` when duty status becomes
 * `on_duty` (including on load, if already on duty from a previous
 * session) and `stopPatrolTracking()` on going off duty or signing out.
 * Both are best-effort: a rejected `start()` (e.g. permission genuinely
 * refused) never throws, same non-fatal treatment every other
 * native-plugin edge in this app already gets — duty status itself must
 * never be blocked by a tracking side-channel — but `start` returns
 * `false` so the caller can show an honest "GPS off" state.
 *
 * NOT DEVICE-VERIFIED for a completed multi-hour background run (same
 * disclosure this codebase gives every native-plugin edge): the plugin
 * registers and the app doesn't crash on a running device, but a real
 * shift-length backgrounded run, screen-off battery/Doze behavior, and
 * the OS actually restarting a killed service were not exercised this
 * session.
 */

import { registerPlugin } from '@capacitor/core';
import { ensureLocationPermission } from './geolocation';

export interface PatrolLocationPlugin {
  start(): Promise<{ started: boolean }>;
  stop(): Promise<{ stopped: boolean }>;
  requestBatteryOptimizationExemption(): Promise<{ alreadyExempt: boolean; dialogShown?: boolean }>;
  requestBackgroundLocationPermission(): Promise<{ granted: boolean }>;
}

const PatrolLocation = registerPlugin<PatrolLocationPlugin>('PatrolLocation');

/**
 * Starts the foreground GPS service. Never throws — duty status itself is
 * never blocked by this — but DOES tell the caller whether tracking is
 * really running, so the UI can say "GPS off" instead of pretending
 * (2026-09-19: the previous `Promise<void>` swallowed a permission
 * rejection and Home kept displaying "Foreground GPS"). Asks for the
 * location permission first; the native plugin only checks it.
 */
export async function startPatrolTracking(): Promise<boolean> {
  try {
    if (!(await ensureLocationPermission())) return false;
    const result = await PatrolLocation.start();
    if (result.started) {
      // Best-effort, never blocks going on duty — C7 (docs/REMAINING.md):
      // shows the OS's own battery-optimization-exemption dialog so a
      // locked-screen shift is less likely to have this foreground service
      // killed by Doze/App Standby. No-ops once already exempt, so this
      // only prompts again on a future duty start if the Tanod declined.
      //
      // Awaited (not fire-and-forget) before the background-location
      // request below: both resolve through the same host Activity, and a
      // code review found that firing them in the same tick could race
      // the battery-exemption dialog's Activity transition against the
      // background-location permission launcher trying to use that same,
      // mid-transition Activity — silently dropping the background-
      // location prompt (not yet device-retested).
      await PatrolLocation.requestBatteryOptimizationExemption().catch(() => undefined);
      // C7's actual 2026-09-24 root-cause finding: a location-type
      // foreground service still needs ACCESS_BACKGROUND_LOCATION to keep
      // receiving fixes once the app itself is no longer in the
      // foreground (screen locked) — declaring the service type alone
      // isn't enough. Requested as a genuinely separate call from FINE/
      // COARSE (`ensureLocationPermission()` above), per Android's own
      // documented requirement. Best-effort, same as the battery-
      // exemption call above — a Tanod who declines still goes on duty,
      // just with a real (not fabricated) risk that patrol GPS won't
      // survive a locked screen. The result is still captured (not fully
      // discarded) so a denial at least reaches device logs — otherwise
      // a repeat of C7's original "GPS silently stops" symptom would have
      // no diagnostic trail pointing at the real cause.
      PatrolLocation.requestBackgroundLocationPermission()
        .then((permissionResult) => {
          if (!permissionResult.granted) {
            console.warn('[patrolLocationService] ACCESS_BACKGROUND_LOCATION denied — patrol GPS may stop once the screen locks (see C7, docs/REMAINING.md).');
          }
        })
        .catch(() => undefined);
    }
    return result.started === true;
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
