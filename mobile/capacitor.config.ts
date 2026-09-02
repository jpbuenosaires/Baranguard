import type { CapacitorConfig } from '@capacitor/cli';

/**
 * Capacitor config for the Baranguard Tanod app (§1: Capacitor 8,
 * Android target).
 *
 * `androidIsEncryption: true` is what puts @capacitor-community/sqlite
 * into its SQLCipher-backed mode on Android — §5 requires the local store
 * (which holds `incident_local.raw_narrative`) to be encrypted at rest,
 * and Rule 1 forbids unprotected raw narrative leaving the trusted
 * environment. Without this flag the plugin would silently create an
 * ordinary plaintext SQLite file.
 *
 * `appId` is a placeholder-but-real reverse-domain identifier; it becomes
 * the Android package name, so change it deliberately (and only before
 * first release) rather than casually — it is not a value that can be
 * edited freely once an APK is distributed.
 */
const config: CapacitorConfig = {
  appId: 'ph.baranguard.tanod',
  appName: 'Baranguard',
  webDir: 'dist',
  plugins: {
    CapacitorSQLite: {
      androidIsEncryption: true,
      // Biometric unlock of the DB passphrase is deliberately NOT enabled:
      // §5/§6 never specify a biometric requirement, and a Tanod must be
      // able to capture an incident one-handed in the field. Revisit only
      // as an explicit, documented decision.
      androidBiometric: {
        biometricAuth: false,
        biometricTitle: 'Baranguard',
      },
    },
  },
};

export default config;
