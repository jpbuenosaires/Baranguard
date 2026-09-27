/**
 * SQLCipher passphrase: 32 CSPRNG bytes, hex-encoded, generated on the
 * device at first run and kept in the Keystore-backed secret store. Never
 * derived from the password (unavailable offline, and a password change
 * would orphan the DB) and never server-issued (a fresh install must be
 * able to capture before it ever reaches the workstation — Rule 7).
 *
 * Losing it (app data cleared, uninstall) makes the local DB unreadable;
 * that is outside the app's guarantee, and the server is authoritative for
 * anything already synced. No legacy-migration path: this app has its own
 * applicationId, so it can never see the Capacitor app's stored secret.
 */
import { getRandomBytes } from 'expo-crypto';
import { secrets } from '../storage';

const PASSPHRASE_KEY = 'baranguard.dbPassphrase';

function generatePassphrase(): string {
  return Array.from(getRandomBytes(32), (b) => b.toString(16).padStart(2, '0')).join('');
}

export async function getOrCreatePassphrase(): Promise<string> {
  const existing = await secrets.get(PASSPHRASE_KEY);
  if (existing) return existing;
  const passphrase = generatePassphrase();
  await secrets.set(PASSPHRASE_KEY, passphrase);
  return passphrase;
}
