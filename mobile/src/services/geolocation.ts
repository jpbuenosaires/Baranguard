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

/**
 * Makes sure ACCESS_FINE/COARSE_LOCATION is granted, prompting the OS
 * dialog if it isn't yet. Returns whether location is usable afterwards.
 *
 * 2026-09-19, found on the Infinix after `pm clear`: nothing in the app
 * ever called `requestPermissions()` explicitly — the prompt only ever
 * appeared as a side effect of the Live Map/SOS calling
 * `getCurrentPosition()`. A fresh install that goes on duty from Home
 * first therefore never got asked, `PatrolLocationPlugin.start()`
 * rejected on the missing grant, and the duty card still said
 * "Foreground GPS · 15s Broadcast" with zero GPS running (§2 Rule 6).
 * `home.tsx` calls this before starting the patrol service.
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
