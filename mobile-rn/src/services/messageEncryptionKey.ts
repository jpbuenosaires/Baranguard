/**
 * The per-device AES-256-GCM key `POST /devices/register` issues once, on
 * a device_id's first registration — the same raw key the server's
 * `EnvelopeCrypto` uses for SMS envelopes. A real secret (losing it means
 * this device can no longer produce envelopes the server accepts), so it
 * lives in the Keystore-backed store.
 */
import { secrets } from './storage';

const MESSAGE_ENCRYPTION_KEY = 'baranguard.messageEncryptionKey';

export function storeMessageEncryptionKey(base64Key: string): Promise<void> {
  return secrets.set(MESSAGE_ENCRYPTION_KEY, base64Key);
}

export function getMessageEncryptionKey(): Promise<string | null> {
  return secrets.get(MESSAGE_ENCRYPTION_KEY);
}
