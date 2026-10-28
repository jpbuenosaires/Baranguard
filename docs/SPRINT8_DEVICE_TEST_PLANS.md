# Device test plans (offline durability, notification reliability)

Purpose: step-by-step plans for the two evaluation items that need a real Android device.
Status/Last updated: 2026-10-28.

**Status: PLANS ONLY. Nothing here has been run.** Written 2026-10-23 for two
evaluation items that need hardware (the former "Sprint 8" boxes). Results go in
`backend/DEVLOG.md`; an item counts as done only with the evidence listed under
"Pass evidence".

Baseline already proven (do **not** redo, only regress if code changed since):
Infinix X6840, 2026-09-19/24 (`docs/evidence/2026-09-19-device/`):
SQLCipher header, one offline report surviving force-stop, keystore round-trip,
one queue drain (incident 119), real FCM critical alert + ack, M13 `sent_by_sms`,
real GSM outbound SMS. These were **n = 1** each. The plans below turn them into
measured rates.

## 0. Pre-flight (both plans)

1. Build the APK with the real URL, then grep the bundle (HANDOFF "Mobile build"):
   `VITE_API_BASE_URL=https://api.baranguardph.win/api/v1 npx vite build`, then
   `grep -l api.baranguardph.win mobile/dist/assets/index-*.js`. If the device
   run is on the LAN instead, use `adb reverse tcp:8081 tcp:8081` (it drops on
   every reconnect).
2. Check `DB_NAME` in `backend/.env`. **Use a disposable or demo DB** (`baranguard_uiseed`
   or a fresh seed), not the real one. Note: the real DBs lack migrations 0029+.
3. Record: git commit (`git rev-parse HEAD`), APK build time, device model, Android
   version, SIM/carrier, date. Use `tanod.reyes` / `tanod.delacruz` (password in HANDOFF).
4. `adb` is at `C:\Users\JAYSON~1\AppData\Local\Android\Sdk\platform-tools\adb.exe`.
5. Make a folder `docs/evidence/<date>-offline-notif/` and save everything there.

## Plan A — Offline cache durability + duplicate reconciliation

**Question answered:** of records created offline, what % survive kill/reboot and
reach the server, and does forced retry ever create a second row?
Maps to `docs/ISO25010_EVALUATION_PLAN.md` metrics (a), (b), (c).

Backend side is already proven by `verify-sprint3.sh` and
`verify-offline-sync-conflicts.sh` (see `docs/OFFLINE_SYNC_CONFLICT_RULES.md`).
This plan covers only what needs the phone.

### A1. Durability trial (N = 20 incidents, 10 per kill type)

| Step | Action |
|---|---|
| 1 | Log in online (device session). Let the dispatch cache fill. |
| 2 | Make the server unreachable for real: `adb reverse --remove tcp:8081` (LAN) or airplane mode (tunnel). Confirm in-app offline state. |
| 3 | Create incident *i* with a unique marker in the location text (`DUR-01`..`DUR-20`). Add a photo to 5 of them. Note the screen shown after save. |
| 4 | Kill type, alternating: **(a)** `adb shell am force-stop ph.baranguard.tanod` · **(b)** swipe from recents · **(c)** (3 of the 20) `adb reboot` before relaunch. |
| 5 | Relaunch still offline. Record the Unsynced count. Open each record: is the content intact? |
| 6 | Restore connectivity, sign in if asked. Wait for drain (poll the in-app count). |
| 7 | Server check (below). |

```sql
-- how many of the 20 arrived, and how many times each
SELECT location_description, COUNT(*) n, MIN(incident_id), MAX(incident_id)
FROM incident WHERE location_description LIKE 'DUR-%' GROUP BY location_description;
-- evidence arrived for the 5 with photos
SELECT incident_id, COUNT(*) FROM evidence_attachment
WHERE incident_id IN (SELECT incident_id FROM incident WHERE location_description LIKE 'DUR-%') GROUP BY incident_id;
```

**Pass evidence:** durability = rows found / 20 (target 100%, report the real number);
local count after relaunch = 20 minus none lost; every row `n = 1`; photos present;
no raw narrative in `adb logcat` (`adb logcat -d | grep -i DUR-` should show nothing
from plugin result dumps; `loggingBehavior` is `none`).

### A2. Forced duplicate (N = 10)

Goal: the same event sent twice must yield one row (`UNIQUE (device_id, client_event_id)`).

1. Create 10 incidents offline (`DUP-01`..`DUP-10`).
2. Reconnect for a few seconds so the batch is accepted, then cut the link
   **before the app sees the response**: easiest is `adb reverse --remove` right after
   the request leaves (watch `backend` access log), or toggle airplane mode on
   the first `POST /sync/batch`. The app should keep the item queued and retry.
3. Reconnect and let it retry. Repeat the cut once more for 5 of the 10.
4. Check:

```sql
SELECT location_description, COUNT(*) FROM incident WHERE location_description LIKE 'DUP-%' GROUP BY 1 HAVING COUNT(*) > 1;  -- expect 0 rows
SELECT status, COUNT(*) FROM offline_queue WHERE client_event_id IN
  (SELECT client_event_id FROM incident WHERE location_description LIKE 'DUP-%') GROUP BY status;
```

Then `php backend/scripts/metrics-report.php --since=<test date>` for server-side
success / duplicate / failed counts (written by every `/sync/batch` to
`backend/storage/metrics/sync-*.jsonl`).

**Pass evidence:** zero duplicate rows; `duplicate` count in the metrics report is
> 0 (proves the retry path really ran and was deduplicated, not that nothing was
resent); all 10 present once.

### A3. Mixed-kind and ordering spot-check (1 pass)

Offline on one on-duty shift: duty change, 3 GPS points, a dispatch status step,
an SOS (if on a test barangay), a referral, an accomplishment entry. Reconnect.
Confirm SOS-first ordering and that each kind landed once (processing order in
`SyncController`: sos · incident · referral · gps · duty_status · dispatch_status ·
availability · accomplishment_entry · school_checkin).

### A4. Known open items to observe, not fix (record as found)

- Offline > 15 min then cold start: DEVLOG 2026-09-19 (4) found Login being shown;
  option B was built 2026-09-19 (6). Re-verify: stay offline 20 min, force-stop, relaunch;
  expected = cached view opens, writes queue.
- The local-schema upgrade path through v10 (`admin_incident_outbox`) and the
  workflow tables (`availability_local`, `accomplishment_entry_local`,
  `referral_local`, `school_checkin_local`) has never run on a device. Install the new
  APK **over** an older one (don't clear data) and confirm the old queue survives.
- `closes_client_event_id` school check-out path: never device-run (HANDOFF).
- Discard SQL never run against SQLCipher (HANDOFF).

### A5. Report format

Table: trial · N · survived · reached server · duplicates · notes. Plus
sync latency (reconnect → last row in DB) per trial, since "Sync latency" is its
own evaluation item and the same data feeds it. Log in DEVLOG; reconcile
`docs/OFFLINE_SYNC_CONFLICT_RULES.md` if behaviour differs from its table.

---

## Plan B — Notification end-to-end reliability (FCM → ack → SMS fallback)

**Question answered:** how often does each tier of Rule 12's ladder deliver, and
does a failure ever vanish silently? Maps to ISO plan metric (d).

Ladder under test (`NotificationDispatcher`, `notification-worker.php`):
no device / FCM fail → retry once → SMS on 2nd failure · FCM `sent` and no ack in
60 s → `ack_timeout` only, **no auto-SMS** (Rule 24).

### B0. Prerequisites

- `FCM_SERVICE_ACCOUNT_PATH` set in `backend/.env`; `mobile/android/app/google-services.json`
  present (gitignored, per machine). `GET /system/health` shows `fcm` not `not_configured`.
- `GSM_GATEWAY_ENABLED=true`, gateway phone adb-visible (serial in `GSM_GATEWAY_DEVICE_SERIAL`),
  gateway app launched once after install, `php backend/scripts/gsm-ingest-daemon.php --status` OK.
- `php backend/scripts/notification-worker.php --daemon` running (it is the only thing that
  sets `ack_timeout`). Without it scenario B3 can't pass.
- Use a **test Tanod phone number you control** so real SMS cost/PII is nil.

### B1. Scenario matrix (run each; N shown)

| # | Scenario | How to force it | N | Expected delivery rows |
|---|---|---|---|---|
| B1 | Happy path, app foreground | Admin web: dispatch the Tanod | 10 | fcm `sent` (attempt 1), `acknowledged_at` set after tap |
| B2 | App backgrounded / screen locked | lock screen, dispatch | 10 | fcm `sent`, full-screen critical alert shows, ack on tap |
| B3 | Sent, **never acknowledged** | ignore the alert 70 s | 5 | fcm `sent` → `ack_timeout` within ~15 s of 60 s; **no SMS row** |
| B4 | Phone offline (airplane) at send | airplane mode, dispatch | 5 | FCM accepted by Google but undelivered, or fails; record what the ladder does and what the Tanod sees on reconnect |
| B5 | No registered device | deactivate the device (`PATCH /devices/:id/deactivate`), dispatch | 3 | SMS `sms_log` row, no fcm row |
| B6 | FCM hard failure | temporarily blank `FCM_SERVICE_ACCOUNT_PATH` (restore after) or revoke token | 3 | fcm `failed` attempt 1 + attempt 2, then SMS |
| B7 | SMS fallback itself fails | B6 with the gateway phone unplugged | 2 | `sms_log.failure_reason` set, `GET /system/health` flags exhaustion |
| B8 | `dispatch_offer` critical alert | night window offer (or set test hours) | 3 | critical overlay; **Android side never compiled/run** (HANDOFF open item 2) |
| B9 | Tanod SOS → Admin/SMS path | raise SOS | 3 | per Rule 27, incl. no-GPS fix |

Every scenario: record dispatch→buzz time with a stopwatch or screen recording
(`adb shell screenrecord`) and compare to `notification_delivery.initiated_at / sent_at`.

### B2. Queries

```sql
SELECT n.notification_id, n.notification_type, d.channel, d.attempt_no, d.status,
       d.failure_reason, d.initiated_at, d.sent_at, d.ack_timeout_at, t.ack_status, t.acknowledged_at
FROM notification n
JOIN notification_target t ON t.notification_id = n.notification_id
LEFT JOIN notification_delivery d ON d.notification_target_id = t.notification_target_id
WHERE n.notification_id >= <first id of the run> ORDER BY n.notification_id, d.channel, d.attempt_no;

SELECT message_type, status, failure_reason, receiver_number, created_at FROM sms_log
WHERE created_at >= '<run start UTC>' ORDER BY created_at;
```

Also `adb shell content query --uri content://sms/sent` on the **gateway** phone to prove
the SMS physically left (the M13 method), and `adb logcat -d | grep -i correlation` to match
the backend `correlation_id`.

### B3. Pass evidence

- Per scenario: delivered / total, median and worst latency, and the DB rows above saved as a CSV.
- Rule 24: in B3 there is **zero** `sms_log` row for that notification.
- Rule 8/1: `raw_narrative` and coordinates absent from the FCM payload and from SMS bodies
  (read the actual delivered message on the phone).
- Nothing disappears: every notification has either an `acknowledged_at`, an `ack_timeout`,
  or a `failed`+SMS trail. An orphan with no delivery row is a **finding**.

### B4. Known gaps to watch

- `sms_pending` / `sms_failed` badge states on the Tanod phone were never exercised
  (airplane mode / no SIM needed, DEVLOG 2026-09-24 (7)).
- Do Not Disturb bypass for critical alerts is deliberately not built.
- `CRITICAL_TYPES` in `criticalAlertStore.ts` and `CriticalAlertMessagingService.java`
  are kept in sync by hand: confirm all four types (`sos`, `priority_alert`, `dispatch`,
  `dispatch_offer`) raise the overlay on the device.
- Infinix `Usf_Hiber` freezer can delay broadcasts to the gateway app: note any lag in B6/B7.

---

## What I need from you to start

1. The phone (USB debugging on) and whether the gateway phone is the same device or a second one.
2. Confirmation that `google-services.json` and the Firebase service-account file are on this machine.
3. A test SIM/number for B5-B7, and the DB to use (recommended: a fresh disposable seed).
4. About 2-3 hours for Plan A and 2 hours for Plan B.
