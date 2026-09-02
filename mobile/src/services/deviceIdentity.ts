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

const DEVICE_ID_KEY = 'baranguard.deviceId';

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
 * The device's FCM registration token, or null when push messaging is not
 * set up.
 *
 * DELIBERATELY RETURNS NULL FOR NOW. FCM registration is Sprint 4 work
 * (§10 "Resiliency & Connectivity — FCM registration/critical
 * notifications (S4)"), but `POST /devices/register` requires a
 * `fcm_token` and §5's `mobile_device.fcm_token` is NOT NULL — so device
 * registration genuinely cannot complete honestly until Sprint 4 lands.
 *
 * The alternative — sending a placeholder string — would write a row that
 * Sprint 4's notification path would later try to push to, producing
 * silent delivery failures for a Tanod the system believes is reachable.
 * §8 forbids exactly that kind of real-looking-but-fake state, and §12's
 * notification model depends on "no active FCM registration" being a
 * truthful signal that routes straight to SMS.
 *
 * Sprint 4 replaces this body with the real @capacitor/push-notifications
 * token; nothing else in the calling code has to change.
 */
export async function getFcmToken(): Promise<string | null> {
  return null;
}
