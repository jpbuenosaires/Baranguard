/**
 * geolocation.ts — the device's own position source for the Live Map's GPS broadcast (POST /gps).
 *
 * FOREGROUND ONLY, deliberately: tracking starts when the Live Map mounts and stops when it unmounts
 * (see the stop function `watchPosition` returns). Background tracking is a separate native service
 * (`patrolLocationService.ts`).
 *
 * Needs `@capacitor/geolocation` and the ACCESS_FINE_LOCATION / ACCESS_COARSE_LOCATION manifest
 * permissions the plugin adds.
 */

import { Geolocation, type Position } from '@capacitor/geolocation';

export interface DevicePosition {
  latitude: number;
  longitude: number;
  accuracyM: number;
  /** ISO 8601 UTC string — device capture time (the `recorded_at` value). */
  recordedAt: string;
}

function toDevicePosition(position: Position): DevicePosition {
  return {
    latitude: position.coords.latitude,
    longitude: position.coords.longitude,
    accuracyM: position.coords.accuracy,
    recordedAt: new Date(position.timestamp).toISOString(),
  };
}

/**
 * Makes sure ACCESS_FINE/COARSE_LOCATION is granted, prompting the OS dialog if it isn't yet. Returns
 * whether location is usable afterwards.
 *
 * Nothing else calls `requestPermissions()` explicitly: the prompt would otherwise only appear as a
 * side effect of the Live Map/SOS calling `getCurrentPosition()`. A fresh install that goes on duty
 * from Home first would never be asked, `PatrolLocationPlugin.start()` would reject on the missing
 * grant, and the duty card would claim GPS running with none. `home.tsx` calls this before starting
 * the patrol service.
 */
export async function ensureLocationPermission(): Promise<boolean> {
  try {
    const current = await Geolocation.checkPermissions();
    if (current.location === 'granted' || current.coarseLocation === 'granted') return true;
    const requested = await Geolocation.requestPermissions({ permissions: ['location'] });
    return requested.location === 'granted' || requested.coarseLocation === 'granted';
  } catch {
    // Web/no-plugin environment — let the caller's own start() decide.
    return false;
  }
}

/** One-shot read, for the initial map center before a watch's first callback arrives. */
export async function getCurrentPosition(opts: { maximumAge?: number; timeout?: number } = {}): Promise<DevicePosition> {
  const position = await Geolocation.getCurrentPosition({ enableHighAccuracy: true, timeout: opts.timeout ?? 10000, maximumAge: opts.maximumAge });
  return toDevicePosition(position);
}

/**
 * Starts continuous position updates. Returns a stop function — callers
 * MUST call it on unmount, or the watch (and the battery drain it causes)
 * outlives the screen that requested it.
 */
export async function watchPosition(onUpdate: (position: DevicePosition) => void): Promise<() => void> {
  const watchId = await Geolocation.watchPosition({ enableHighAccuracy: true }, (position, err) => {
    if (err || !position) return;
    onUpdate(toDevicePosition(position));
  });
  return () => {
    Geolocation.clearWatch({ id: watchId }).catch(() => {
      // Best-effort cleanup — nothing meaningful to do if this fails on unmount.
    });
  };
}
