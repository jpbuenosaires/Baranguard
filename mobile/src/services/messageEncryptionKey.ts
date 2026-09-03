/**
 * messageEncryptionKey.ts — stores the per-device symmetric key Sprint 4
 * Phase 3's `POST /devices/register` now issues once, on a device_id's
 * first-ever registration (see backend/controllers/DevicesController.php's
 * own doc for the server side of this). This is the SAME symmetric key
 * `EnvelopeCrypto` on the server uses for AES-256-GCM — the device must
 * hold the exact raw bytes, not a hash, so this is genuinely a secret,
 * not a passphrase-style "recreate if lost" value: losing it means this
 * device can no longer produce SMS envelopes the server will accept, and
 * only a fresh device_id (which mints a fresh key) recovers from that.
 *
 * Storage pattern is a direct copy of `db/passphrase.ts`'s Keystore
 * approach (`@aparajita/capacitor-secure-storage` — Android-Keystore-
 * backed AES-GCM under the hood, confirmed against that plugin's own
 * README) — no separate design decision needed here, this is the same
 * secret-at-rest problem passphrase.ts already solved. Unlike that file,
 * there is no legacy-migration case: this key never existed before
 * Sprint 4 Phase 5, so there is nothing older to migrate from.
 *
 * NOT DEVICE-VERIFIED — same standing caveat as every other file in this
 * local-storage layer (see passphrase.ts's own note).
 */

import { SecureStorage } from '@aparajita/capacitor-secure-storage';

const MESSAGE_ENCRYPTION_KEY = 'baranguard.messageEncryptionKey';

/** Persists the raw key (base64, exactly as `POST /devices/register` returns it). */
export async function storeMessageEncryptionKey(base64Key: string): Promise<void> {
  await SecureStorage.setItem(MESSAGE_ENCRYPTION_KEY, base64Key);
}

/** Returns the stored key (base64), or null if this device has never received one. */
export async function getMessageEncryptionKey(): Promise<string | null> {
  return (await SecureStorage.getItem(MESSAGE_ENCRYPTION_KEY)) ?? null;
}
