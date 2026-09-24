/**
 * deviceIdentity.ts — the device's own stable identity and its FCM
 * registration seam (§6 "Users & device lifecycle", §5 `mobile_device`).
 *
 * `device_id` is CLIENT-generated (§5 stores it as a VARCHAR(64) primary
 * key, not a server sequence) and must stay stable for the life of the
 * install: the server deactivates a Tanod's *other* devices on each
 * registration, so an id that changed per launch would deactivate the
 * previous registration every time and churn the device row endlessly.
 * Generated once, then persisted app-privately.
 */

import { Preferences } from '@capacitor/preferences';
import { Capacitor } from '@capacitor/core';
import { PushNotifications } from '@capacitor/push-notifications';
import FullScreenAlert from './fullScreenAlert';
import DeviceKey from './deviceKey';

const DEVICE_ID_KEY = 'baranguard.deviceId';
/** 8s is generous for a registration round-trip against Google's servers
 *  but short enough that a Tanod is never made to wait on it — see
 *  runPostLoginSetup() in login.tsx, which already treats this whole step
 *  as best-effort and non-fatal. */
const FCM_REGISTRATION_TIMEOUT_MS = 8000;

/** Matches DevicesController::DEVICE_ID_PATTERN (8-64 of [A-Za-z0-9._:-]). */
function generateDeviceId(): string {
  const uuid =
    typeof crypto !== 'undefined' && 'randomUUID' in crypto
      ? crypto.randomUUID()
      : `${Date.now().toString(16)}-${Math.random().toString(16).slice(2)}`;
  return `and-${uuid}`.slice(0, 64);
}

/** Returns this install's device id, creating and persisting one on first call. */
export async function getDeviceId(): Promise<string> {
  const { value } = await Preferences.get({ key: DEVICE_ID_KEY });
  if (value) return value;
  const deviceId = generateDeviceId();
  await Preferences.set({ key: DEVICE_ID_KEY, value: deviceId });
  return deviceId;
}

/**
 * H-09: this install's hardware-backed device identity public key, or
 * null when unavailable (web platform, or the native Keystore call
 * failed for any reason). NEVER THROWS, same "unavailable is a legitimate
 * outcome on the offline-first login path" precedent as `getFcmToken()`
 * above — a device that can't generate a key must still be able to
 * register and work, just without H-09's stronger guarantee (the server
 * treats a device with no key on file as not-yet-upgraded, not invalid;
 * see DeviceSignature.php's own doc).
 */
export async function getDevicePublicKeyPem(): Promise<string | null> {
  if (Capacitor.getPlatform() !== 'android') {
    return null;
  }
  try {
    const { publicKeyPem } = await DeviceKey.getPublicKey();
    return publicKeyPem || null;
  } catch {
    return null;
  }
}

/**
 * H-09: signs `METHOD\nPATH\nDEVICE_ID\nTIMESTAMP` with this device's
 * Keystore private key — the exact canonical string
 * `Baranguard\Lib\DeviceSignature::canonicalMessage()` recomputes
 * server-side. `path` must be the request path only (no query string),
 * matching what `parse_url($_SERVER['REQUEST_URI'], PHP_URL_PATH)`
 * produces server-side. Returns null (never throws) on any failure —
 * callers attach the returned headers only when this succeeds; omitting
 * them is the same "not upgraded yet" state a device with no key produces
 * server-side, never a hard failure.
 */
export async function signDeviceRequest(
  method: string,
  path: string,
  deviceId: string
): Promise<{ timestamp: string; signature: string } | null> {
  if (Capacitor.getPlatform() !== 'android') {
    return null;
  }
  try {
    const timestamp = Math.floor(Date.now() / 1000).toString();
    const payload = `${method.toUpperCase()}\n${path}\n${deviceId}\n${timestamp}`;
    const { signature } = await DeviceKey.sign({ payload });
    return signature ? { timestamp, signature } : null;
  } catch {
    return null;
  }
}

/**
 * The device's FCM registration token, or null when push messaging is not
 * available/permitted/reachable.
 *
 * REAL IMPLEMENTATION as of Sprint 4 Phase 5 (M12 Critical Alert Overlay
 * cannot exist without this) — the null-returning stub this function used
 * to be is exactly what `runPostLoginSetup()` in login.tsx already treats
 * as a legitimate, non-fatal outcome: no token still means "don't
 * register", never "send a placeholder" (see that function's own doc,
 * unchanged by this).
 *
 * NEVER THROWS. Every failure mode — permission denied, no Google Play
 * services, running on the web platform, a registration that never fires
 * within the timeout — resolves to `null` rather than rejecting, because
 * this sits on the login path and §2 Rule 2's offline-first guarantee
 * means a Tanod must be able to sign in and start capturing regardless of
 * whether push messaging is available on this particular device.
 *
 * DEVICE-VERIFIED, and the hard way: run on a real device 2026-09-13
 * without the guard below, `PushNotifications.register()` crashed the
 * entire app on login with an uncaught native `IllegalStateException`
 * ("Default FirebaseApp is not initialized") — a REAL Firebase project +
 * `google-services.json` is a SEPARATE prerequisite this workstation
 * still does not have (REMAINING.md A4; the backend side of the same gap
 * is `FCM_SERVICE_ACCOUNT_PATH` in backend/.env.example, also unset). The
 * try/catch below did NOT help: that exception is thrown on Capacitor's
 * own native plugin-invocation thread, before `register()`'s promise can
 * ever reject, so it never reaches JS at all — it just kills the process.
 * `FullScreenAlertPlugin.isFirebaseAvailable()` (native, added the same
 * day) is what actually prevents this, by checking Firebase's real
 * process-level init state BEFORE the crash-prone call, not by reacting
 * to a failure JS can't observe.
 */
export async function getFcmToken(): Promise<string | null> {
  if (Capacitor.getPlatform() !== 'android') {
    // The web platform's PushNotifications implementation isn't a real
    // FCM registration and would return a value this codebase must not
    // trust — same "don't fake it" precedent as localDatabase.ts throwing
    // on the web platform rather than silently opening an unencrypted
    // store.
    return null;
  }

  try {
    const { available } = await FullScreenAlert.isFirebaseAvailable();
    if (!available) {
      return null;
    }

    const permission = await PushNotifications.checkPermissions();
    let granted = permission.receive === 'granted';
    if (!granted && permission.receive !== 'denied') {
      const requested = await PushNotifications.requestPermissions();
      granted = requested.receive === 'granted';
    }
    if (!granted) {
      return null;
    }

    let settled = false;
    let resolveToken: (value: string | null) => void = () => {};
    const tokenPromise = new Promise<string | null>((resolve) => {
      resolveToken = resolve;
    });

    // `addListener()` is itself async — it RESOLVES to a
    // PluginListenerHandle, it does not return one directly — so both
    // calls are awaited before `finish` can reference the handles it
    // needs to clean them up. `finish` is declared here (not called until
    // one of the listener callbacks or the timeout below fires, both of
    // which happen strictly after this point) and closes over
    // `registrationListener`/`errorListener` once they exist.
    const finish = (value: string | null): void => {
      if (settled) return;
      settled = true;
      registrationListener.remove();
      errorListener.remove();
      resolveToken(value);
    };

    const [registrationListener, errorListener] = await Promise.all([
      PushNotifications.addListener('registration', (token) => {
        finish(token.value || null);
      }),
      PushNotifications.addListener('registrationError', () => {
        finish(null);
      }),
    ]);

    setTimeout(() => finish(null), FCM_REGISTRATION_TIMEOUT_MS);
    PushNotifications.register().catch(() => finish(null));

    return await tokenPromise;
  } catch {
    return null;
  }
}
