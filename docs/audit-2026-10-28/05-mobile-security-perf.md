# 05 - Mobile security, privacy, performance audit (2026-10-28)

Scope: `mobile/` (Ionic React + Capacitor, Android) and the message paths (FCM, SOS envelope SMS). Read-only. "V" = verified by reading code or a measured build; "S" = suspected, needs device or runtime proof. Nothing was run on a device.

## P0

**P0-1 (V) Cleartext HTTP allowed app-wide while the live API is HTTPS-only.**
`mobile/android/app/src/main/res/xml/network_security_config.xml:14` sets `<base-config cleartextTrafficPermitted="true" />`. Its comment says it exists for a DHCP LAN IP, a problem the Cloudflare tunnel removed (REFERENCE.md §1). `capacitor.config.ts:41` also sets `androidScheme: 'http'`. With the JWT, device id and incident data now crossing the public internet, any downgraded or mis-set base URL, or any `http://` sub-resource, goes out in clear, and a MITM can inject script because the WebView origin is `http://localhost`. Fix: remove cleartext from `base-config`, allow `localhost`/`10.0.2.2` only through a debug-only resource set, and return `androidScheme` to `https` (check that the origin change losing localStorage values such as `baranguard.shiftStartTime` is acceptable).

**P0-2 (V) `allowBackup="true"` exposes the session token and device identity.**
`AndroidManifest.xml:6`. The JWT (`baranguard.session`), `deviceId`, SOS contact numbers and map-package metadata sit in the plaintext `CapacitorStorage` SharedPreferences (`session.ts:44-70`, `deviceIdentity.ts:37-40`). `adb backup` or device transfer copies them. `session.ts:6-8` says they are not reachable, true for the WebView but not for backup. The 24 h device session (7-day cap) is a bearer token. The SQLCipher passphrase is Keystore-wrapped so the DB file is useless off-device; the token is not. Fix: `android:allowBackup="false"` plus `fullBackupContent`/`dataExtractionRules` excluding everything. Moving the token to `SecureStorage` also needs a native Keystore read, because `PatrolLocationService.java:122-126` reads it straight from `CapacitorStorage`.

**P0-3 (V, severity depends on cutover) Debug APKs on UAT devices; release build unhardened.**
`app/build.gradle:21` `minifyEnabled false`, no shrink. UAT devices run debug APKs (per the comment in `capacitor.config.ts`), so `chrome://inspect` reaches the WebView where the session and all API data are readable. Verified fine: `loggingBehavior: 'none'` unless `CAP_DEBUG_LOGGING=1` (`capacitor.config.ts:25`). Fix: real devices run a release-signed build; enable minify for release; check the APK is not `debuggable` before install. P0 once real citizen data is on those phones; today the DB is the demo DB, so P1 until cutover.

## P1

**P1-1 (V) Patrol GPS native service ignores sign-out and has an unsafe default URL.**
`PatrolLocationService.java:66` default base URL `http://192.168.1.10/baranguard-api/api/v1` (cleartext, stale host) is used if the Preferences mirror is missing, and the Bearer token would be sent there. `handleSignOut` (`pages/profile.tsx:178-186`) never calls `stopPatrolTracking()`; only `home.tsx:400` does. After sign-out the foreground service keeps polling high-accuracy GPS every 30 s with its "Transmitting real-time coordinates" notification, and `START_STICKY` restarts it. Posts stop only because the session is gone. `connection.getResponseCode()` is ignored, so a 401 never ends the service. Fix: call `stopPatrolTracking()` in every sign-out path (`profile.tsx:185`, `admin-profile.tsx:38`, `apiService.ts:181`); delete the hardcoded default (no URL means no post); stop the service on 401/403.

**P1-2 (V) Sign-out does not clear the local encrypted DB, evidence files or caches.**
`clearSession()` callers (`profile.tsx:185`, `admin-profile.tsx:38`, `login.tsx:80`, `apiService.ts:181`) remove only the token and one localStorage key. `incident_local.raw_narrative` (`localSchema.ts:68`), evidence under `Directory.Data/evidence/` (`evidenceCapture.ts:155,231`) and drafts survive. `incidentRepository.ts:199` lists every `incident_local` row with no user filter. On a shared or lost phone the next login sees the previous Tanod's local reports. RA 10173 data-minimisation concern. Fix: on explicit sign-out with nothing unsynced, delete local rows and evidence; with unsynced rows, warn and keep them bound to the user id; filter lists by `reported_by`.

**P1-3 (V) Evidence files are unencrypted at rest.**
`evidenceCapture.ts:155-161,231` write JPEG and audio as plain files; only SQLite metadata is SQLCipher. App-private storage stops other apps but not backup (P0-2), root or forensic extraction. Photos may show faces or minors (school zones). `Camera.takePhoto({ includeMetadata: true })` (`:135`) may leave the camera's cache original with EXIF GPS (S: confirm it is deleted). The canvas re-encode (`:110-122`) does strip EXIF from the stored copy (V). Fix: AES-GCM with a Keystore-wrapped key, or at least exclude from backup and delete the cache original.

**P1-4 (V) Device signature has no body binding and no replay cache.**
`deviceIdentity.ts:97-100` signs only `METHOD\nPATH\nDEVICE_ID\nTIMESTAMP`; `backend/lib/DeviceSignature.php:45,75` accepts +/-300 s with no nonce store. A captured header set can be replayed with a different body for up to 10 minutes. The attacker also needs the bearer token, which is the P0-2/P0-3 scenario, so impact is bounded. Verification is also optional: a device with no key on file is not checked (`verify()` returns null), and `signDeviceRequest` returns null on any failure. Fix: include a body hash in the canonical string, and require a registered key for tanod logins from a set date.

**P1-5 (V) SOS envelope SMS: crypto and replay are sound, with gaps.**
Good: AES-256-GCM with full AAD, 12-byte random nonce, TTL 1500 s under the 1800 s server cap (`sosEnvelopeCore.ts:36,98-125`), server-side `sms_envelope_replay` insert keyed on message_id (`SmsGatewayService.php:247-252`), expiry and future-skew checks (`:236-242`). Gaps: (a) authenticity rests only on the shared symmetric key, with no device ECDSA signature on the envelope; (b) `SosSmsPlugin` also sends a plaintext backup-contact SMS with the Tanod's coordinates over the carrier, by design but PII leaving the system, so confirm the Tanod is told; (c) `device_id` is in clear in the SMS (identifier only); (d) an SMS delayed past 30 minutes is rejected and the SOS then depends on the queued sync (document it).

**P1-6 (V) Push bodies carry names and coordinates, and show over the lock screen.**
`NotificationDispatcher.php` (~lines 167, 189, 254) builds `"{full_name} needs help{location}"` and `"assigned a {incident_type} incident{location}"`, where `formatLocation()` is built from latitude/longitude. So coordinates and a Tanod's name reach FCM/Google and `sms_log`. Rule 1 (raw_narrative) holds: no narrative is interpolated (V). But this sits uneasily with Rule 8's intent. Natively, `CriticalAlertMessagingService.java:41-62` feeds title/body to a full-screen alert over the lock screen (`USE_FULL_SCREEN_INTENT`), so anyone near a locked phone can read name and position. Fix: owner decision on whether coordinates may be in push/SMS, recorded in REFERENCE.md; otherwise send "Open the app" with data-only ids and `VISIBILITY_PRIVATE`.

**P1-7 (V) Online OSM tile fallback leaks patrol position and breaks the OSM tile policy.**
`mapBasemap.ts:79,89` fetch `https://tile.openstreetmap.org/{z}/{x}/{y}.png` whenever the offline package misses a tile or none is loaded. Each request discloses approximate location to a third party, with the default WebView User-Agent and no caching control; OSM's policy bars app-scale use. Fix: offline-only in production, or a self-hosted tile source.

**P1-8 (V) Bundle weight.**
Measured with `VITE_API_BASE_URL=https://api.baranguardph.win/api/v1 npx vite build` into a temp dir: `dist` is 11 MB across 283 files, because `@vitejs/plugin-legacy` (`vite.config.ts:11`) emits a full second legacy copy of every chunk. Entry `index-*.js` 335.7 kB (105 kB gzip). `LiveMapCanvas` 1,094 kB (300 kB gzip, MapLibre, lazy, fine). `MobileHeader` chunk 1,250 kB (260 kB gzip): a shared chunk named after a tiny component, so a heavy dependency (probably the SQLite web shim; S, chunk not opened) is pulled into a chunk used on nearly every screen. Pages are `React.lazy` (V, `App.tsx:35-46`). Fix: drop `legacy()` (Android WebView target is modern), run a bundle visualizer, make the SQLite web shim a dynamic import used only on web.

## P2

- **P2-1 (V) Component exposure is minimal:** only `MainActivity` is exported. `CriticalAlertActivity`, both services and the FileProvider are `exported=false`; the SMS result receiver uses `RECEIVER_NOT_EXPORTED`. No deep-link intent filters and no `appUrlOpen` handler.
- **P2-2 (V) `file_paths.xml`** grants `external-path path="."` and `cache-path path="."`. Not exported, so low risk, but scope it to the evidence subdir.
- **P2-3 (V) Permissions are broad but each is justified in the manifest comments.** `SosSmsPlugin.sendDirect` accepts any format-valid number from JS, so a WebView script bug could send SMS anywhere. No `innerHTML` with server data was found (only static SVG, `mapPins.ts:29`), so the precondition is absent today. Consider limiting native sends to the cached backup and gateway numbers.
- **P2-4 (V) SQLCipher key handling is good:** 32 bytes from `crypto.getRandomValues`, Keystore-backed SecureStorage, legacy plaintext copy removed after migration (`db/passphrase.ts:55-86`), never logged. `messageEncryptionKey.ts` uses the same pattern. Key loss means data loss (documented, accepted).
- **P2-5 (V) apiService:** base URL fixed at build time (`apiService.ts:48-49`), no on-device override, 15 s and 5 s (SOS) timeouts, errors surface only the server's `message`. Only 4 `console.warn` in non-test code, none print payloads (`assignments.tsx:93,122`, `mapRoute.ts:82`, `patrolLocationService.ts:80`). No certificate pinning (acceptable behind Cloudflare, but note it).
- **P2-6 (V) Polling and GPS cadence:** polls use `visibleInterval` (pauses when hidden): home 30 s, admin dispatch/SOS/pending 20 s, header probe 30 s. Reasonable. The native service uses `PRIORITY_HIGH_ACCURACY` every 30 s with no minimum update distance (`PatrolLocationService.java` ~line 95), so a standing Tanod still burns GPS; `watchPosition` (`geolocation.ts:79`) is also unthrottled high accuracy.
- **P2-7 (V) Native GPS points are dropped when offline** (documented tradeoff in the class doc), whereas the JS path queues. The loss is worst exactly where connectivity is bad.
- **P2-8 (V) SQLite:** indexes exist for the hot paths (`localSchema.ts:82,128,164,166,221,235,248,331-398`). There are 26 `SELECT *` sites, and `incidentRepository.ts:199` loads every `incident_local` row, narrative included, with no LIMIT. Add pagination and list-only columns.
- **P2-9 (V) Evidence size:** photos capped at 1600 px and JPEG 0.75 (`evidenceCapture.ts:30,50`) but pass through a base64 round trip (`:155,165`), a roughly 4/3 memory spike on low-RAM phones. Voice records to a file path (good). Upload cap 25 MB matches the server.
- **P2-10 (V) localStorage:** `baranguard.shiftStartTime` (`home.tsx:74,184,367`) is not cleared on sign-out (`session.ts:93` clears only the duty-status key). Low sensitivity.
- **P2-11 (S) Accessibility:** not reviewed systematically. Check icon-only buttons for `aria-label` and 48 dp touch targets; consider `eslint-plugin-jsx-a11y` (lint already has 18 pre-existing errors per HANDOFF.md).
- **P2-12 (V)** `versionCode 1` and no minify; bump `versionCode` before first real distribution so updates install.

## Rules cross-check (REFERENCE.md §2)

- Rule 1: no narrative in push/SMS builders or logs. Weak point is the local copy (P1-2, P1-3).
- Rule 7: holds in JS; the native GPS path is an accepted exception (P2-7).
- Rule 8: outside the files audited; coordinates in push bodies are the nearest conflict (P1-6).
- Rule 12: token storage plus backup exposure (P0-2) is the practical weak spot of the 24 h device session.

## Top 5 fixes by value

1. Remove cleartext and `androidScheme:'http'` (P0-1).
2. `allowBackup=false` plus exclusions; stop keeping the token in plain prefs (P0-2).
3. Sign-out must stop the patrol service and clear or user-scope local data (P1-1, P1-2).
4. Release-signed, minified builds on any real device (P0-3).
5. Drop `legacy()`, split the 1.25 MB `MobileHeader` chunk, remove the OSM online tile fallback (P1-7, P1-8).

Not checked: any behaviour on a device; `PatrolLocationPlugin` and `CriticalAlertActivity` line by line; the contents of the `MobileHeader` chunk; FCM `data` payload fields beyond the builders listed.
