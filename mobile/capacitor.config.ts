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
  // Capacitor's default local-page origin is https://localhost. The
  // workstation this app talks to is plain HTTP (LAN-only, no TLS
  // infrastructure — §1), and fetching http:// from an https:// origin is
  // blocked as mixed content by the WebView engine itself, independent of
  // Android's OS-level cleartext-traffic policy (network_security_config,
  // already permitted). Setting the scheme to http:// makes the app's own
  // origin match the backend's, removing that separate restriction. If a
  // TLS-fronted deployment is ever set up (revisit alongside REFERENCE.md
  // F1's still-open API base URL decision), switch this back to 'https'.
  server: {
    androidScheme: 'http',
    // Opt-in live reload for UI iteration: when CAP_LIVE_RELOAD=1, the
    // WebView loads straight from the Vite dev server instead of the
    // bundled dist/ — UI edits hot-reload on the device with no
    // rebuild/reinstall cycle. Reached over `adb reverse tcp:5173
    // tcp:5173` (USB), not LAN, so it works regardless of WiFi/firewall.
    // Gated behind the env var so a plain `npx cap sync android` (no var
    // set) always produces the normal bundled build — never silently
    // ships a build wired to a dev server.
    ...(process.env.CAP_LIVE_RELOAD === '1'
      ? { url: 'http://localhost:5173', cleartext: true }
      : {}),
  },
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
