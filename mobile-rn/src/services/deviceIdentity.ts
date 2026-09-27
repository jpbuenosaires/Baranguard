/**
 * The device's stable identity (§6 device lifecycle, §5 `mobile_device`)
 * and its H-09 signing key.
 *
 * `device_id` is client-generated and must stay stable for the life of the
 * install: the server deactivates a Tanod's OTHER devices on each
 * registration, so an id that changed per launch would churn forever.
 */
import { Platform } from 'react-native';
import DeviceKey from '../../modules/device-key';
import { prefs } from './storage';
import { uuid } from './uuid';

const DEVICE_ID_KEY = 'baranguard.deviceId';

let cachedDeviceId: string | null = null;

/** Matches DevicesController::DEVICE_ID_PATTERN (8-64 of [A-Za-z0-9._:-]). */
export async function getDeviceId(): Promise<string> {
  if (cachedDeviceId) return cachedDeviceId;
  const stored = await prefs.get(DEVICE_ID_KEY);
  if (stored) {
    cachedDeviceId = stored;
    return stored;
  }
  const deviceId = `and-${uuid()}`.slice(0, 64);
  await prefs.set(DEVICE_ID_KEY, deviceId);
  cachedDeviceId = deviceId;
  return deviceId;
}

/**
 * H-09 public key PEM, or null if the Keystore call failed. Never throws:
 * a device without a key must still register and work — the server treats
 * "no key on file" as not-yet-upgraded, not invalid.
 */
export async function getDevicePublicKeyPem(): Promise<string | null> {
  if (Platform.OS !== 'android') return null;
  try {
    return (await DeviceKey.getPublicKey()) || null;
  } catch {
    return null;
  }
}

/**
 * Signs `METHOD\nPATH\nDEVICE_ID\nTIMESTAMP` — the exact string
 * `DeviceSignature::canonicalMessage()` rebuilds server-side. `path` is the
 * full request path the server saw (including the `/api/v1` mount), no
 * query string. Returns null (never throws) on failure; callers then send
 * `X-Device-Id` alone, the same as a not-yet-upgraded device.
 */
export async function signDeviceRequest(
  method: string,
  path: string,
  deviceId: string,
): Promise<{ timestamp: string; signature: string } | null> {
  if (Platform.OS !== 'android') return null;
  try {
    const timestamp = Math.floor(Date.now() / 1000).toString();
    const payload = `${method.toUpperCase()}\n${path}\n${deviceId}\n${timestamp}`;
    const signature = await DeviceKey.sign(payload);
    return signature ? { timestamp, signature } : null;
  } catch {
    return null;
  }
}

/**
 * FCM registration token. Phase 6 (React Native Firebase + the
 * critical-alert module) implements this; until then there is no push
 * transport in this app, and null is the documented "don't register a
 * token" outcome login already tolerates — never a placeholder value.
 */
export async function getFcmToken(): Promise<string | null> {
  return null;
}
