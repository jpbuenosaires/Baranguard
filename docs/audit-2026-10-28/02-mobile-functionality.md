# Mobile functionality and correctness audit (2026-10-28)

Scope: `mobile/src/services/*`, `pages/*`, `App.tsx`, `mobile/android/` native code. Read-only; no source edited.
Method: read the code, grepped `backend/routes/*.php` and controllers to confirm every endpoint, method and field.
Labels: **[V]** verified by reading the cited lines. **[S]** suspected (needs a device or a run).

## Tool results (real output, run today)

| Check | Result |
|---|---|
| `npx tsc --noEmit` | 0 errors. The docs say 1; that count is stale. |
| `npm run lint` (eslint) | 0 problems. The docs say 18; stale. |
| `node scripts/verify-local-schema.mjs` | 266 passed, 0 failed. |
| `npx vitest run` | 27 files, 185 tests, all passed. |

All of these are static or jsdom-level. None of them covers the findings below. They are race, lifecycle and device issues.

## Endpoint check (mobile calls vs backend routes)

About 45 calls were matched against `backend/routes/*.php`. No mismatch found. The main ones:
- `/auth/*`, `/devices/register`, `/duty-status`, `/tanod-sos`, `/tanod-sos/fallback-contact`, `/dispatch`
- `/dispatch/:id/status`, `/dispatch/:id/route`, `/gps`, `/gps/live`, `/incidents/nearby`, `/incidents/:id/evidence`
- `/sync/batch`: the body keys `incidents, gps_tracks, duty_status_updates, dispatch_status_updates, sos, referrals, availability, accomplishment_entries, school_checkins` equal `SyncController` lines 101-111. The server cap is 200 items per batch and the client chunk is 50, which is fine.
- `/shifts`, `/shift-swap-requests` (`client_request_id` is accepted), `/availability`, `/accomplishment-*`, `/schools`, `/dispatch-offers*`
- The admin calls are all in `SessionPolicy::ADMIN_DEVICE_ALLOWLIST`.

Dispatch status replay is idempotent on the server (`DispatchController.php:798`, same status returns current state). So a timed-out PATCH that actually landed, followed by a queued replay, is safe.

## P0

### P0-1 [V pattern, S impact]: SQLite transactions are not serialised, and only the dispatch cache is
- `localDatabase.ts` uses one connection. `db.beginTransaction()` is called at six sites: `incidentRepository.ts:115`, `evidenceRepository.ts:37`, `availabilityRepository.ts:90`, `schoolRepository.ts:30`, `dispatchRepository.ts:47` and the migrations.
- Only the dispatch cache is queued (`dispatchRepository.ts:111-117`). The comment at lines 105-110 records a real-device failure of exactly this class: "second begin fail and its rollback undo the first" (Realme, 2026-10-22).
- Every other write runs as `db.run(..., false)` with no transaction of its own, for example:
  - the SOS enqueue (`offlineQueueRepository.ts:140`)
  - the dispatch-status enqueue (`:37`)
  - `markIncidentSynced`
  - the `mark*Synced` functions
- On a single connection these writes join whichever transaction is open. If that transaction rolls back, they vanish.
- Concrete bad case: Home's 30 s dispatch refresh is mid-transaction while the Tanod raises SOS offline. The SOS queue row is inserted inside that transaction. A failure rolls it back, so the row is lost while the UI says "saved locally".
- Related: `saveIncidentLocally` (the Rule 7 capture path) can throw "cannot start a transaction within a transaction" while `cacheSchools`, `saveEvidenceLocally` or a dispatch write is in flight.
- Fix: one module-level async mutex wrapping every `beginTransaction` block. Or stop using explicit transactions where one statement is enough.

## P1

### P1-1 [V]: a sync trigger is dropped while a pass is in flight
- `syncScheduler.ts:67` returns immediately if `isSyncing`, on the assumption that the running pass covers the new trigger.
- `runSyncPass` snapshots its work at the start (`syncService.ts:191-194`). Anything enqueued after that is not covered.
- Worst case: a Tanod raises SOS offline. `useSosFlow.ts:90` calls `forceSyncNow()` and it returns at once. The SOS waits for the next trigger. That is up to 60 s on duty, and unbounded off duty, because the 60 s timer is gated on `knownDutyStatus === 'on_duty'` (`syncScheduler.ts:167`).
- Fix: a "dirty" flag, and re-run once when the current pass ends.

### P1-2 [V]: evidence upload and map download have no timeout. This can wedge the whole sync.
- `uploadEvidence` `fetch` at `apiService.ts:915` has no `AbortSignal`. `downloadMapPackage` at `:392` has none either.
- `isSyncing` is held across the evidence loop (`syncService.ts:251-272`). One hung upload on a weak link blocks every later sync, including queued SOS, until the OS gives up.
- `response.text()` at `apiService.ts:169` and `:927` sits outside the `try`. With `AbortSignal.timeout`, a timeout during the body read throws a raw DOMException, not an `ApiError`.
- In the evidence loop, `transient` is false for a non-`ApiError` (`syncService.ts:267-269`). A slow link therefore spends the attempt budget and pushes evidence to "needs attention".
- Fix: wrap the body read in the same catch, mapped to `NETWORK_ERROR`. Add a timeout, for example 60-120 s, to the upload and a longer one to the map download.

### P1-3 [V]: four call sites bypass the sync mutex
- `profile.tsx:150`, `SyncQueueModal.tsx:130` and `:156`, and `my-reports.tsx:203` call `runSyncPass()` directly.
- The scheduler header (`syncScheduler.ts:25-31`) says concurrent passes race. Server idempotency (Rule 3) keeps the data correct, but:
  - bandwidth is wasted
  - `markQueueItemResolved` double-increments `sync_attempts`
  - the scheduler's listeners (Home off-duty refresh, the failed-SOS banner) are not notified after a manual pass, so UI counts go stale
- Fix: route them through `forceSyncNow()` and have it return the summary.

### P1-4 [V]: the SOS path has two weak points
- `useSosFlow.ts:84-90`: if `enqueueSosItem` throws (DB error), control jumps to the outer catch and the SMS fallback is never attempted. Wrap the enqueue in its own try so the SMS fallback always runs.
- `useSosFlow.ts:73` awaits `getCurrentPosition()` (10 s timeout, `geolocation.ts:69`) before the 5 s POST. A bad-GPS SOS starts after about 10 s and falls back after about 15 s. Rule 27 says never blocked on a fix. Use a short race, or take the last known fix, and send immediately.

### P1-5 [V]: Rule 7 gap, queue rows are written only after the live call fails
- `assignment-detail.tsx:208-229`: `applyLocalStatusChange` writes the new status with `synced=0`. Then the PATCH runs for up to 15 s. Only on failure is `enqueueDispatchStatusChange` called.
- If the process dies in that window, the status exists locally with no queue row. The next `GET /dispatch` overwrites it. The cache upsert (`dispatchRepository.ts:57-72`) has no `WHERE synced = 1` guard.
- Same shape for the off-duty toggle (`home.tsx:359-383`) and the first SOS attempt.
- Related UI flip-flop: a refresh landing before the queued sync reverts the displayed status. The server replay is idempotent, so this is cosmetic. The Tanod may tap again.
- Fix: enqueue first, send, then mark resolved. Guard the upsert on `synced = 1`.

### P1-6 [V]: the foreground GPS service outlives logout and session expiry and has no duty check
- `stopPatrolTracking()` is called only from `home.tsx:400` (the off-duty path). A grep shows no call from sign-out (`profile.tsx:179-187`, `admin-profile.tsx:34-38`), from `request()`'s 401 handler, or from login.
- `PatrolLocationService.java:146-151` reads the session token from SharedPreferences on every point.
- So after logout the "Patrol Active / Transmitting" notification stays up (Rule 6 honesty). If another Tanod logs in on the same phone, the service posts that user's location, on duty or not. If the session is cleared it silently posts nothing and still drains battery.
- Also: the service never handles 401 and never reads `X-Renewed-Token`. Dropped points are not queued (documented tradeoff, `PatrolLocationService.java:52-61`).
- Fix: stop the service on `clearSession()`. Have the service stop itself when the session key is missing.

### P1-7 [V]: Live Map broadcasts GPS regardless of duty, and never stops
- `useDeviceBroadcast.ts` starts `watchPosition` and posts `/gps` every 15 s. There is no duty check, and the cleanup runs only on unmount.
- Tab pages stay mounted (the comment at `home.tsx:302` says so). After the first visit to the Map tab, an off-duty Tanod's position keeps going to HQ for as long as the app lives. The header says "On-Duty GPS".
- It also duplicates the native service's posts when on duty.
- Privacy and battery. The server accepts GPS without a duty check (`GpsController::createItem`).
- Fix: gate on duty status and on the page being active (`useIonViewWillEnter` and `DidLeave`). Prefer one GPS source, the native service.

### P1-8 [V]: local data is not user-scoped, and logout wipes nothing
- `listAllLocalIncidents()` (`incidentRepository.ts:197`) has no `reported_by` filter. `my-reports.tsx:161-230` lists and searches `raw_narrative`.
- On a shared phone the next Tanod sees the previous Tanod's reports, including narratives.
- `getOpenSchoolCheckin`, `dispatch_local`, availability and accomplishment tables are the same.
- `clearSession` removes only `lastKnownDutyStatus`. `baranguard.shiftStartTime` in localStorage survives (`home.tsx:184`).
- Sync under a different user is blocked server-side (`DEVICE_NOT_REGISTERED`), but the on-screen leak is not.
- Fix: filter by the current user id in the list queries, or purge unsynced-free rows on user change.

### P1-9 [V]: `localDatabase.ts` caches a half-initialised connection
- `database` is assigned at `localDatabase.ts:121-129`, before `open()` (`:132`) and `migrateLocalDatabase` (`:134`).
- If `open()` or a migration throws, `opening` clears, but `database` stays set. Every later `openLocalDatabase()` returns the unopened or un-migrated handle (`:65-67`).
- Result: permanent "table missing" or "not opened" errors until the process is killed.
- Fix: assign `database` only after migration succeeds.

### P1-10 [V config, S impact]: Android manifest and network hygiene
- `AndroidManifest.xml:6` has `allowBackup="true"` and no `dataExtractionRules`. The session JWT (plain SharedPreferences, `session.ts:4`) and the SQLCipher DB are eligible for Auto Backup. A restore on a new device gives an undecryptable DB.
- `network_security_config.xml` has `cleartextTrafficPermitted="true"` in `base-config` for every host. The comment still describes a LAN-only HTTP deployment. Production is now `https://api.baranguardph.win`, so scope cleartext to debug or localhost only.
- `PatrolLocationService.java:78` has a stale default `http://192.168.1.10/baranguard-api/api/v1`. `capacitor.config.ts` has `androidScheme:'http'` with an outdated comment.
- No code minification or R8 (`minifyEnabled false`). `versionCode 1`.

### P1-11 [S]: older WebViews could look permanently offline
- minSdk is 24. `AbortSignal.timeout` (Chrome 103+) is used inside the `try` in `request()` (`apiService.ts:154`) and `checkHealth` (`:1592`).
- `crypto.randomUUID` (Chrome 92+) falls back to a non-UUID in `uuid.ts` and `incidentRepository.ts:79-83`. The server requires a UUID `client_event_id`, and `SessionPolicy.php:48` requires the device id to match `and-<uuid v4>`.
- On a WebView older than that, `AbortSignal.timeout is not a function` is caught and reported as `NETWORK_ERROR` for every call. The app would look offline and the device session would not be granted.
- Fix: feature-detect with a manual `AbortController` timer, and use `crypto.getRandomValues` for UUIDs.

### P1-12 [V]: no React ErrorBoundary
- A grep for `ErrorBoundary` or `componentDidCatch` finds nothing. Any render exception blanks the whole app, including the SOS button, in a field tool.

## P2

- **Critical alerts overwrite each other** [V]. `criticalAlertStore.ts:154` and `:174` hold a single slot. A later dispatch alert replaces an unacknowledged SOS alert.
- **`pushNotifications` and `FullScreenAlert.getPendingAlert` have no catch** [V]. See `checkForPendingNativeAlert` (`criticalAlertStore.ts:193-210`) and the scheduler's `Network.addListener` (`syncScheduler.ts:158`). These are unhandled rejections if a plugin is missing.
- **FCM is not device-verified** [per HANDOFF]. Dispatch push depends on it. There is no background polling, so a Tanod learns of a dispatch only from foreground polls (30 s Home, `visibleInterval`) or push.
- **`upsertServerIncidents` bails if any local row is unsynced** (`incidentRepository.ts:268`). That includes permanently failed rows, so one poison row stops the server pull forever.
- **Pending badge undercounts** [V]. `usePendingSyncCount.ts` counts only incidents, dispatch status and SOS. It ignores GPS, offline off-duty, availability, accomplishments, school check-ins and evidence. The header can say 0 while data is unsent.
- **Fake or hardcoded identity (Rule 6)** [V]. `profile.tsx:216-219` always shows an "Active Duty" badge. `home.tsx:60` and `profile.tsx:200` default the barangay to "Dao".
- **Admin outbox treats 5xx as a refusal** [V]. `adminIncidentOutbox.ts:45-53` records a failure for anything except offline or 401. After 3 attempts the row is `refused` forever, with no manual retry shown.
- **Map package** [V]. `mapPackageService.ts:67-74` and `:121` build the whole file as a base64 string in memory (tens of MB, OOM risk on low-end phones). There is no timeout, no Wi-Fi check, and old versions are never deleted. A checksum mismatch returns silently (`:112-117`).
- **Evidence memory** [V]. `evidenceCapture.ts:165-166` and `:272-277` read the whole file as base64, then decode it into a `Uint8Array`, then a `Blob`. Voice has no length cap in the client; 25 MB is only the server limit.
- **Unguarded `JSON.parse` of queue payloads** [V]. `offlineQueueRepository.ts:73`, `:166` and `:251`. One corrupt row throws inside `runSyncPass` and blocks every pass.
- **Items with no result are never counted** [V]. Every apply loop in `syncService.ts` does `if (!result) continue`. The row is retried forever with no attempt cap.
- **Possible stale form** [S]. `new-incident.tsx` never resets `narrative` or `submittedRef` after a successful save (`:317-320`). If Ionic keeps the view mounted, the next report is pre-filled (duplicate risk) and draft autosave is off. Needs a device check.
- **`responding` duty state** is not handled in the sync interval (`syncScheduler.ts:167`) or the patrol-start check (`home.tsx:273`). Low impact, since nothing in the app sets it.
- **Native service details**. `PatrolLocationService.java:118` uses high accuracy every 30 s for the whole shift, so battery cost is high. `startForeground` is not guarded against `ForegroundServiceStartNotAllowedException` (Android 12+ background start) [S].
- **Offline sign-out** (`profile.tsx:180-185`) clears the local session if `logout()` fails. The server device session (24 h, up to 7 days) stays valid.
- **Third-party leaks** [V]. Online OSM tile fallback (`mapBasemap.ts:77`), Google Maps links (`live-map.tsx:117`, `sosFallbackSms.ts`). Already listed as an owner decision in HANDOFF.
- **Silent catches**. Many `catch {}` blocks are by design (offline-first), but they hide errors from diagnosis. There is no client-side error log.

## Not found / checked and fine

- Sync ordering (SOS, dispatch, duty, incidents, referrals, workflow, GPS, then evidence) and the per-chunk apply are correct. Failure classification (`syncFailureClass.ts`) matches the server strings.
- `X-Device-Id` / signature handling and the 401-vs-signature split (`authErrors.ts`) are correct. The clock skew limit is 300 s.
- School check-in close-by-reference logic is careful and correct.
- Idempotency fields (`client_event_id`, `Idempotency-Key`, `request_id`, `client_request_id`) match the backend on every route read.
- No dead controls found in the routes I read. The two Rule 6 items are above.

## Top 5 to fix first

1. Serialise SQLite transactions (P0-1).
2. Sync dirty-flag plus evidence/map timeouts and body-read catch (P1-1, P1-2).
3. SOS: enqueue failure must not skip SMS, and do not wait 10 s for GPS (P1-4).
4. Stop the GPS service on logout or 401, and gate Live Map broadcast on duty (P1-6, P1-7).
5. User-scope the local lists, and fix the `localDatabase` half-open handle (P1-8, P1-9).
