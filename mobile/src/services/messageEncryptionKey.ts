/**
 * messageEncryptionKey.ts — stores the per-device symmetric key that `POST /devices/register` issues
 * once, on a device_id's first-ever registration (see backend/controllers/DevicesController.php). This
 * is the SAME symmetric key `EnvelopeCrypto` on the server uses for AES-256-GCM: the device must hold the
 * exact raw bytes, not a hash, so it is a true secret, not a "recreate if lost" value. Losing it means
 * this device can no longer produce SMS envelopes the server will accept, and only a fresh device_id
 * (which mints a fresh key) recovers.
 *
 * Storage follows `db/passphrase.ts`'s Keystore approach (`@aparajita/capacitor-secure-storage`,
 * Android-Keystore-backed AES-GCM).
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
