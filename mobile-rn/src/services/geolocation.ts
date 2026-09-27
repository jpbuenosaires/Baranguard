/**
 * The device's own position source for M7 Live Map's GPS broadcast.
 * Ported from ../mobile's geolocation.ts (expo-location instead of
 * @capacitor/geolocation) — same foreground-only scope: tracking starts
 * when a screen mounts and stops when it unmounts. Continuous background
 * GPS (Phase 5's patrol service) is a separate, explicitly-scoped native
 * module, not folded in here.
 */
import * as Location from 'expo-location';

export interface DevicePosition {
  latitude: number;
  longitude: number;
  accuracyM: number;
  /** ISO 8601 UTC string — device capture time. */
  recordedAt: string;
}

function toDevicePosition(position: Location.LocationObject): DevicePosition {
  return {
    latitude: position.coords.latitude,
    longitude: position.coords.longitude,
    accuracyM: position.coords.accuracy ?? 0,
    recordedAt: new Date(position.timestamp).toISOString(),
  };
}

/** Ensures foreground location is granted, prompting the OS dialog if it isn't yet. */
export async function ensureLocationPermission(): Promise<boolean> {
  try {
    const current = await Location.getForegroundPermissionsAsync();
    if (current.granted) return true;
    const requested = await Location.requestForegroundPermissionsAsync();
    return requested.granted;
  } catch {
    return false;
  }
}

/** One-shot read, for the initial map center before a watch's first callback arrives. */
export async function getCurrentPosition(): Promise<DevicePosition> {
  const position = await Location.getCurrentPositionAsync({ accuracy: Location.Accuracy.High });
  return toDevicePosition(position);
}

/**
 * Starts continuous position updates. Returns a stop function — callers
 * MUST call it on unmount, or the watch (and its battery drain) outlives
 * the screen that requested it.
 */
export async function watchPosition(onUpdate: (position: DevicePosition) => void): Promise<() => void> {
  const subscription = await Location.watchPositionAsync({ accuracy: Location.Accuracy.High }, (position) => {
    onUpdate(toDevicePosition(position));
  });
  return () => subscription.remove();
}
