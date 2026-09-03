/**
 * geolocation.ts — the device's own position source for M7 Live Map's GPS
 * broadcast (§6 POST /gps, §9 M7).
 *
 * FOREGROUND ONLY, deliberately: tracking starts when M7 mounts and stops
 * when it unmounts (see the stop function `watchPosition` returns). A
 * background location service (tracking while the app is closed) is a
 * materially bigger native undertaking — a foreground-service
 * notification, battery-optimization exemptions, and Android 10+'s
 * separate background-location consent flow — none of which is part of
 * this cut's documented scope (§9 M7 describes a live map SCREEN, not a
 * standing background tracker). If continuous background GPS is wanted
 * later, that is a separate, explicitly-scoped decision, not something to
 * fold in silently here.
 *
 * Needs `@capacitor/geolocation` (added to package.json this cut) and,
 * once `npx cap sync` is re-run, the ACCESS_FINE_LOCATION /
 * ACCESS_COARSE_LOCATION manifest permissions the plugin adds — same
 * "device/Android-SDK verification still outstanding" caveat as every
 * other native-plugin addition in this codebase (Camera, voice recorder).
 */

import { Geolocation, type Position } from '@capacitor/geolocation';

export interface DevicePosition {
  latitude: number;
  longitude: number;
  accuracyM: number;
  /** ISO 8601 UTC string — device capture time, §5's `recorded_at`. */
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

/** One-shot read, for the initial map center before a watch's first callback arrives. */
export async function getCurrentPosition(): Promise<DevicePosition> {
  const position = await Geolocation.getCurrentPosition({ enableHighAccuracy: true, timeout: 10000 });
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
