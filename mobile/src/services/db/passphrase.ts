/**
 * passphrase.ts — provisions the SQLCipher passphrase for the local
 * encrypted store (§5 "encrypted with SQLCipher-backed plugin").
 *
 * DECISION (2026-09-02, confirmed with the user; §5 requires encryption
 * at rest but never says where the key comes from, and §6 defines no
 * key-provisioning endpoint):
 *
 *   A cryptographically-random passphrase is generated ON THE DEVICE at
 *   first run and persisted app-privately. It is never derived from the
 *   user's password, and never fetched from the server.
 *
 * Why not server-issued: a brand-new install would then be unable to
 * capture ANYTHING until it had first reached the workstation, which
 * directly contradicts §2 Rule 2 ("offline capture is durable") and Rule
 * 7 ("mobile capture must continue while the local workstation is
 * unavailable"). Why not derived from the password: it is unavailable
 * offline after login, and a password change would orphan the database.
 *
 * STORAGE CAVEAT, stated plainly rather than overstated: this uses
 * @capacitor/preferences, i.e. Android SharedPreferences — app-private
 * (not readable by other apps on a non-rooted device) but NOT
 * hardware-backed. That is a large improvement over a key hardcoded in
 * the APK, and it is not equivalent to Android Keystore. The documented
 * upgrade path is to move this one function to a Keystore-backed secure
 * storage plugin; nothing else in the codebase has to change, because
 * localDatabase.ts only ever asks for a PassphraseProvider.
 *
 * Consequence worth knowing: if this value is lost (app data cleared,
 * uninstall), the local database is unrecoverable. §2 Rule 2 already
 * places device loss/uninstall outside the application guarantee, and the
 * server is authoritative after reconciliation.
 */

import { Preferences } from '@capacitor/preferences';

const PASSPHRASE_KEY = 'baranguard.dbPassphrase';

/** 32 random bytes, hex-encoded — 256 bits of entropy. */
function generatePassphrase(): string {
  const bytes = new Uint8Array(32);
  crypto.getRandomValues(bytes);
  return Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('');
}

/**
 * Returns this install's database passphrase, creating and persisting one
 * on first call. Suitable to pass directly to
 * `configureLocalDatabase()`.
 */
export async function getOrCreatePassphrase(): Promise<string> {
  const { value } = await Preferences.get({ key: PASSPHRASE_KEY });
  if (value) return value;
  const passphrase = generatePassphrase();
  await Preferences.set({ key: PASSPHRASE_KEY, value: passphrase });
  return passphrase;
}
