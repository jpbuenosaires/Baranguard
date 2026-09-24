# Baranguard — Working Reference (compact)

**This is the auto-loaded working reference.** The full
`Baranguard_Master_Reference_FINAL .md` (reconciled 2026-09-07) stays in
`docs/` as the authority — open it by section number (§n below) for full
wording.

**Never invent a field, route, role, or state transition that isn't
here or there.** If something seems missing, stop and ask.

---

## 1. What this is

Offline-first, locally hosted Barangay Intelligence and Emergency
Dispatch System for four barangays in Pilar, Sorsogon. Production
system, not a demo. Single workstation, LAN-only, no cloud.

**API base URL — reopened 2026-09-15.** A private-mesh VPN briefly gave
both mobile and web one fixed remote hostname (closed 2026-09-13,
decommissioned 2026-09-15 — see `DEVLOG.md` for both entries); nothing
persistent replaces it now. The base architecture (§1) is plain LAN
reachability: `mobile/src/services/apiService.ts`'s `DEFAULT_API_BASE_URL`
and `web/index.html`'s `window.BARANGUARD_API_BASE_URL` both default to
`http://localhost:8081/api/v1`, and each has its own runtime override
(mobile: Profile's connection-settings card via `setApiBaseUrlOverride()`;
web: a `?api_base=` query param or `localStorage`, see `web/index.html`'s
own note) for whatever address is actually correct on the day. For
temporary remote testing only — never a production access path — a
Cloudflare Quick Tunnel (`cloudflared tunnel --url http://localhost:8081`)
can front the API: its hostname is random, changes every run, and has no
Cloudflare-side authentication in front of it, so anyone who obtains that
URL can reach the API (§2 Rule 7 still holds for anything meant to stay
non-public; this is a deliberate, disclosed exception for short-lived
testing, not a resolution of it). `backend/.env`'s `CORS_ALLOWED_ORIGIN`
stays a real multi-origin allow-list (not a wildcard) once more than one
origin needs access — see `backend/public/index.php`'s CORS block. A
real persistent remote-access mechanism is an open item again
(`docs/REMAINING.md` §F, F1).

**Stack:** PHP 8.2 serves all of `/api/v1/*` (Node is CLI tooling only).
MariaDB 10.4 via XAMPP. Web: vanilla JS, no bundler, no npm step (hand-
rolled charts, inline SVG icons, vendored MapLibre). Mobile: Ionic React
9 + Capacitor 8.5, encrypted SQLite (SQLCipher). AI: Llama-SEA-LION-
v3.5-8B-R via **local Ollama only**.

**Four barangays, fixed:** Dao=1, Binanuahan=2, Marifosque=3, Banuyo=4.

**Relationship to DILG BIMSS — settled, do not re-litigate.** DILG
BIMSS/BIMS is mandated for all barangays by Memorandum Circular; its
KPIS subsystem already *is* the Katarungang Pambarangay case database
and BIMS ships its own electronic blotter. **Baranguard complements
BIMSS and may never be positioned as replacing it** — a legal
constraint, not a design preference. Baranguard's value is real-time
dispatch, GPS, SOS, offline field capture, and local-AI redaction —
none of which BIMSS has. Anything duplicating a BIMSS *records* function
is liability, which is why the walk-in blotter endpoint and the
standalone blotter records list were both removed 2026-09-10.

---

## 2. Non-negotiable rules — the ones that actually bite

**This numbered list (1-12) is not the Master Reference's own 32-rule
§2 list** — overlapping ground, different numbering. A "Rule N" citation
elsewhere means whichever list context makes clear.

1. **`raw_narrative` never leaves the system** except through the
   approved AI pipeline. Never to FCM, the SMS gateway, cloud, logs,
   terminal output, or audit metadata. **`GET /incidents/:id` is the only endpoint
   that returns it, and only to a Secretary** (RA 7160 §394(c) makes the
   Secretary the statutory records custodian — Admin gets *less* here on
   purpose, don't "fix" that). The Blotter Assistant
   (`POST /incidents/:id/ai-tools/blotter-assist`) is a second reader,
   Secretary-only for the same reason, redacting as it drafts. The
   Incident Classifier reads only the APPROVED redacted narrative —
   that's what makes it safe for Admin.
2. **Every protected endpoint verifies role + tenant + ownership
   server-side.** No client-side check is a security boundary.
   Cross-tenant is **404, never 403** (403 confirms the resource exists).
3. **Idempotency, not interchangeable:** web writes use the
   `Idempotency-Key` UUID header; mobile writes use `client_event_id`
   (+ `X-Device-Id`, server-verified). A retry returns the original row,
   never a second one.
4. **AI pipeline order:** raw → redaction draft → summary derived from
   the draft (never raw) → Secretary review → approve. Only
   `POST /incidents/:id/ai-draft/approve` may commit
   `incident.redacted_narrative`. Draft edits use exact `draft_version`
   equality (stale → 409). **The four AI Tools assistants are NOT part
   of this pipeline** — they write `ai_processing_log.tool_output` only,
   never a record; output is text a human reads and retypes (§7).
5. **The API never calls Ollama.** It only enqueues; `scripts/ai-worker.php`
   is the only process that talks to the model. No external AI fallback
   under any failure mode. Covers the AI Tools endpoints too.
6. **No demo/prototype tells.** No fabricated statistics, hardcoded
   identities, confidence numbers not backed by a real
   `ai_evaluation_run`, controls that look functional and do nothing, or
   a health badge that isn't a real probe. `not_configured` is neutral.
7. **Offline capture is durable state.** A mobile write persists to
   encrypted SQLite before the user can leave the screen, never claimed
   synced until the server confirms.
8. **Audit metadata is allow-listed** — identifiers and statuses only.
   Never narrative, credentials, tokens, coordinates, or personal data.
9. **Never edit a completed migration.** Add a new numbered one.
10. **Retention numbers are constants, not config** (§11) — changing one
    needs an architecture review, not a runbook edit.
11. **Timestamps stored UTC; operational/display times Asia/Manila.**
    Day-bucketing is done in PHP against a fixed +08:00, never
    `CONVERT_TZ()` (tz tables aren't loaded on stock XAMPP).
12. **Two session kinds, one revocation rule** (§2 Rule 9, amended
    2026-09-19; `services/auth/SessionPolicy.php`): the web dashboard
    gets a 15-minute sliding JWT (an open dashboard polls every 15s and
    never expires; a closed tab/sleeping PC does); a Tanod login with a
    well-formed `X-Device-Id` gets a **device** session — 24h sliding,
    hard cap 7 days from issue, tanod role only. Both die on the next
    request after logout/suspension/deactivation/password change because
    `AuthMiddleware` checks `auth_session` every time — never lengthen
    a token on the assumption that it can't be revoked. The mobile shell
    also opens on an *expired-but-stored* session (cached view only) so
    an out-of-range Tanod isn't locked out of their own queue.

---

## 3. Roles (§3, §7)

| Role | Reach |
|---|---|
| **Admin** | Full operations: dispatch, GPS, scheduler, users, devices, audit log, service health, exports. **Cannot** touch blotter finalize/amend, Lupon packet, or any AI draft. |
| **Secretary** | Records custodian: only reader of `raw_narrative`; only role that may run the AI pipeline, approve a redaction, finalize/amend a blotter, or generate a Lupon packet. |
| **Punong Barangay** | Read-only oversight: dashboard, map, heatmap, analytics, fatigue, Threat Analyzer. No evidence files, no AI drafts, no writes, no blotter LIST (individual incidents still reachable from dashboard). |
| **Tanod** | Mobile only. Own incidents/dispatches/shifts. Web login succeeds but lands on an honest "no screen" page. |
| **Lupon** | **No system account at all.** Receives the generated PDF packet. |

---

## 4. Schema map (§5 — 27 tables)

Core chain: `barangay → user → mobile_device → incident → dispatch →
tanod_sos → notification → notification_target → notification_delivery`.

**Key tables:** `incident` (raw_narrative NULLable, redacted_narrative,
legal_hold, raw_narrative_purged_at, complainant_name/respondent_name/
complainant_contact_number — Secretary-only, location_description,
display_id) · `dispatch` · `evidence_attachment` (files outside web
root, legal_hold) · `blotter_record` + `blotter_revision` (party fields
shared with Admin/PB once finalized; case_status enum
active/under_investigation/settled/resolved, forward-only past `active`,
`resolved` set only by an incident status change) · `citizen_report`
(legal_hold) · `duty_status` · `gps_track` · `shift_schedule` (user_id
nullable) · `shift_swap_request` · `fatigue_flag` · `ai_processing_log`
(IS the AI job queue; `task_type` incl. `extraction` + 4 AI Tools types;
`incident_id` NULLable — `sms_compose`/`threat_analysis` have no
incident, use `barangay_id`/`requested_by_user_id`/`tool_input`/
`tool_output` instead) · `ai_evaluation_run` · `sms_log` (barangay_id,
message_body/read_at, `message_type` incl. `manual`, legal_hold) ·
`sms_envelope_replay` · `audit_log` (write-once except retention) ·
`offline_queue` · `auth_session` · `map_package` · `user`
(is_suspended/suspended_reason/suspended_at — independent axis from
is_active) · `system_settings` (§7 W21 note) · `sms_subscriber`
(consent-tracked broadcast list — `consent_at`/`consent_source` NOT
NULL, removal is `opted_out_at` not a DELETE) · `health_check_log`
(dependency-status CHANGE log, includes `ors_status`).

**Migrations 0001–0022, all applied to both real DBs** (`baranguard`,
`baranguard_uiseed`). On a new machine apply all in order as DBA/root —
`baranguard_app` has no `ALTER`/`CREATE TABLE` (§8). Notable ones:
0008 incident party fields · 0009 blotter case_status · 0011 user
suspension · 0012 system_settings (W21) · 0014 display_id · 0015 ai_tools
(nullable incident_id + tenant/requester/tool columns) · 0016 retention
hold + device scrub · 0017 health_check_log · 0018 sms_subscriber ·
0019 audit_log idempotency index · 0020 health_check_log.ors_status ·
0021 generic metric columns on `ai_evaluation_run` · 0022
`auth_session.session_kind` (web/device — see §2 rule 12).

**FK trap:** `ai_processing_log`, `evidence_attachment`, `blotter_record`
and `dispatch` are all `ON DELETE RESTRICT` against `incident` — deleting
an incident is an ordered cascade (`RetentionService::purgeOneIncident`).

**MariaDB 10.4 limits:** no `SKIP LOCKED`; a table-level CHECK on
`notification`'s entity matrix fails with ERROR 1901 (enforced in PHP).

---

## 5. Endpoints (84 live `/api/v1` routes, all built)

Read the route tables in `backend/routes/*.php` for the authoritative
list; controllers carry the per-endpoint contract in their class docs.

**Auth** login · logout · change-password
**Incidents** list (+`q=` search) · show · create · **update** (`PATCH
/incidents/:id`) · nearby · evidence (GET+POST — Tanod-only multipart,
tenant+device+tanod-access checked server-side) · status (flips a linked
finalized blotter's case_status to `resolved`) · blotter · finalize ·
amend (+optional case_status transition) · lupon-packet (+download) ·
redact · ai-draft (+approve, regenerate-summary, translate,
extraction+approve)

> `PATCH /incidents/:id` is an **operational-correction endpoint, NOT a
> narrative editor**: Admin+Secretary may set `priority`/`incident_type`/
> `location_description`; `complainant_name` is Secretary-only (it
> carries `raw_narrative`'s protection, same rule as `show()`). Sending
> `raw_narrative`/`redacted_narrative` is a hard 400 (Rule 4 keeps
> `ai-draft/approve` the sole writer). `Idempotency-Key` required. Audit
> metadata records changed field **names**, never values (Rule 8).

**Dispatch** list (tanod_name joined) · create · cancel · status ·
route (`GET /dispatch/:id/route`)

> An incident may have **more than one concurrent active dispatch**
> (explicit architecture sign-off, no priority gate, unbounded count).
> `create` accepts `pending` OR `dispatched` incidents, rejecting only a
> Tanod already actively assigned. `cancel` reverts to `pending` only
> when no OTHER active dispatch remains. `GET /incidents/:id` has a
> `dispatches[]` array (every responder); its singular
> `dispatched_at`/`arrived_at` means "the primary/first responder."
>
> `GET /dispatch/:id/route?latitude=&longitude=&mode=car|foot` computes
> a road-snapped route from the CALLER's live position to the incident,
> via OpenRouteService (`OrsClient.php`), persisted onto
> `dispatch.route_json`/`route_status`. Own-Tanod-or-Admin gated,
> tenant-scoped. Never a 500 on routing failure — an existing route is
> kept and marked `stale` rather than discarded; only a never-successful
> dispatch falls to `unavailable`. Not audited (Rule 8 bars raw
> coordinates).

**GPS** live · history · post · `/sync/batch`
**Scheduling** shifts (list/create/update) · swap requests · fatigue flags
**Notifications/SOS** notifications · ack · tanod-sos (+ack/resolve)
**Devices/Map** register (`fcm_token` optional) · deactivate ·
map-packages (get/upload/download)
**Reports** summary · heatmap · nav-counts · export (+download, response
time is per-incident `MIN(arrived_at)`, de-duplicated)
**Ops** `/audit-log` · `/system/health` (+`/history`, Admin-only) ·
`/search` · `/barangays` · `/users` (list `q=`, last_login_at,
is_suspended; suspend/unsuspend + is_active toggle) ·
`/citizen-reports` (+`/:id/convert`, list `status=`) · `/duty-status` ·
`/blotter` (list `q=`, `status=`, case_status, display_id,
location_description)
**AI Tools** (Secretary-only unless noted) `POST
/incidents/:id/ai-tools/blotter-assist` · `POST
/incidents/:id/ai-tools/classify` (Admin+Secretary, reads only approved
redaction, 409 if none) · `POST /ai-tools/sms-compose` (Admin-only,
operator-typed `prompt` only) · `POST /ai-tools/threat-analysis`
(Admin+PB, aggregate counts only, own barangay; optional
`{days}`/`{from,to}`) · `GET /ai-tools/jobs/:id` (owner+tenant scoped) ·
`GET /ai-tools/availability` (all three roles)

> **`POST /blotter` (walk-in entry) was REMOVED 2026-09-10** — a walk-in
> with no prior incident is exactly a DILG BIMSS/KPIS case (§1). The
> rest of the blotter family (finalize/amend/lupon-packet) is untouched
> — it's incident-originated, BIMSS has no dispatch layer to feed it.
>
> **AI Tools write nothing** — each enqueues an `ai_processing_log` row,
> the screen polls `GET /ai-tools/jobs/:id`. No standalone AI Tools
> screen — each is embedded in its host screen via `AiToolPanel.js`.

**SMS** `/sms/logs` (read-only) · `/sms/conversations` (+`/:phone/messages`,
+`/:phone/resolve`, Admin-only) · `/sms/send` · `/sms/broadcast`
(Admin-only, Idempotency-Key required, recipient always resolved
server-side, own-barangay scope only)
**Settings** `GET/PATCH /system-settings` (Admin-only; three `general.*`
keys + `sos_fallback.backup_contact_number` — see §7 W21;
`sms_gateway.api_key`/`sender_name` REMOVED 2026-09-23 with Semaphore)
**Internal only** `/internal/sms/*` (6 handlers, loopback + token gated,
`public/internal.php`)

**Response envelope:** success = the object; error =
`{"error":{"code":"...","message":"..."}}`. Pagination: `page`/`limit`,
default 25, max 100.

---

## 6. Design system (§8) — web

Tokens only, never a hardcoded hex/px/font in a component file.
`--color-*` in `base.css`; dark mode is a second value set on the same
tokens (`--dark-*` remapped by both `prefers-color-scheme` and
`[data-theme]`).

**Use `--color-*-solid` for white text/icons on a saturated fill** —
plain status tokens lighten in dark mode and fail contrast there. Use
`--color-*-text` for colored text (never `-solid`, which stays dark in
dark mode), and `--color-link` (not `--color-primary`) for primary-
colored text. Keep badge tints at 8% (the `*-text` tokens are specced
against white).

**Every data-driven screen needs all four states:** Loading / Empty /
Error-with-retry / Populated.

Shared components: `AppShell` · `PageHeader` · `DataTable` (+CSV export,
pagination) · `KpiCard` · `LineChart` (treats `null` as a genuine gap,
not zero) · `BarChart` · `DonutChart` · `LiveMap` · `Menu` · `Toast` ·
`ConfirmDialog` (+`promptSelect`) · `StatStrip` · `Avatar` ·
`DateRangePicker` · `icons` · `AiToolPanel` (one local-AI assistant
embedded in a host screen, returns `{el, stop}` — a host MUST call
`stop()` before wiping the panel's DOM; availability probe is
module-cached; the app's only shared collapsible primitive).

**Shared CSS entities — use these, don't re-roll them:**

| Entity | Classes | Where |
|---|---|---|
| Tab bar | `.page-tabs` / `.page-tab` (+`__icon`, `__badge`) | `PageHeader.css` |
| Filter chip | `.filter-chips` / `.filter-chip` (+`__count`) | `base.css` |
| Stat card grid | `.stat-card-grid` / `.stat-card` (+`__value`, `__label`) | `base.css` |
| Role badge | `.role-badge--{admin,secretary,punong_barangay,tanod}` | `base.css` |
| Date range | `DateRangePicker()` | `components/DateRangePicker.js` |

**Sizing/spacing tokens:** `--control-height` (2.5rem) ·
`--control-height-prominent` (2.625rem) · `--pad-panel`/`--pad-panel-lg`
· `--spacing-md-lg` (1.25rem).

**Dark mode:** `index.html` stamps a resolved `data-theme` on every load
and follows the OS until the user stores a preference — a page-level
`[data-theme="dark"] .x` rule alone is sufficient.

**Run `node web/scripts/verify-web-wiring.mjs` after any web change** —
catches imports/CSS classes that don't resolve. Currently 537/537 (this
number moves as screens change; failures=0 is what matters).

**Never interpolate server data into `innerHTML`.** Use `textContent`,
or the shared `web/src/utils/escapeHtml.js`. An 2026-09-07 audit found
11 unescaped sites (one let an unauthenticated citizen report execute
script in the Secretary session); all fixed 2026-09-12. Neither
`verify-web-wiring.mjs` nor `node --check` can catch this class of
defect — verify by reading every interpolation site, not by script.

---

## 7. Screens (§9)

**Built:** W1 login · W2 dashboard · W3 dispatch (map markers,
assign-from-map; queues group multiple active dispatches on one
incident into one card) · W4 GIS · W7 incident detail (routed
`blotter-detail`; case_status transition control) · W8 AI review ·
Analytics (tabbed Reports/Heatmap/Threat Analyzer, Admin+PB) · Personnel
(tabbed Users/Scheduler/Swap requests/Fatigue flags — only Fatigue is
PB-visible) · W14 SMS Monitor (Activity Log + Conversations tabs) · W15
settings (+General/SMS Gateway, Admin-only) · W16 citizen inbox
(+Convert to Incident) · W17 audit log · W18 map package management ·
W19 public report · W20 service health · Incident Management (search,
Resolve action, AI Classifier, multi-responder support).
**Mobile:** M1–M7, M12, M13.

> **W6 Electronic Blotter (records list) was REMOVED 2026-09-10** — DILG
> BIMSS's KPIS is the mandated case ledger. **W7 survives and is
> load-bearing:** the app's ONLY per-incident detail view, tolerates no
> blotter record, and is where Incident Management/dashboard/SMS
> Monitor/audit log/search/notifications all land. Keeps the
> `blotter-detail` route key (~12 `navigate()` sites use it). Back
> button is role-aware. **Role consequence**: Punong Barangay has no
> list-of-cases screen anymore — reach is dashboard + Analytics +
> individual incident detail.

> **AI assistants live in their host screens, not a standalone AI
> screen** (an operator is mid-task and wants help with THAT task):
> - **AI Classifier** — Incident Management detail pane, collapsed by
>   default, auto-runs once per incident per visit once an approved
>   redaction exists, surfaces a chip only when its suggestion disagrees
>   with what's recorded. *Apply in Edit* preselects type/priority; a
>   human still saves.
> - **AI Blotter Assistant** — incident detail, Secretary-only branch,
>   framed as a draft to transcribe into DILG BIMSS/KPIS; writes nothing.
> - **AI Message Composer** — SMS Monitor › Conversations. *Use this
>   draft* fills the compose textarea; no send button — sending stays
>   audited.
> - **Threat Analyzer** — Analytics › third tab, explicit
>   "describes what was recorded, not a forecast" label. 7/30/90-day
>   preset or custom range.
>
> Every panel polls every 3s (API only enqueues) and shows a real
> probe-driven unavailable banner + disables Generate when the model is
> unreachable (§2 Rule 6 — not hypothetical, this workstation cannot
> complete a generation, §A2). Model output rendered with `textContent`.

**W21 system settings — narrow, deliberate exception, not a full
build-out.** Migration 0012 + `SettingsController` originally covered
`sms_gateway.api_key`/`sender_name` too; those two keys were REMOVED
2026-09-23 when Semaphore was replaced by a local GSM gateway (§1) — that
transport has no cloud credential or configurable sender name, so there
was nothing left for them to hold. `SettingsController` now covers only
three `general.*` display keys + `sos_fallback.backup_contact_number`,
masked on read where applicable, under explicit user authorization. Does **not** extend
to `DEVICE_SECRET_MASTER_KEY`/`INTERNAL_SERVICE_TOKEN`/`JWT_SECRET`/
`FCM_SERVICE_ACCOUNT_PATH` — those stay in `.env`/PHP constants, and a
future session must not "complete" W21 by moving them without the same
sign-off. Full Notifications/Security/GIS/Backup settings remain
**not built** — no schema/endpoints exist, §2 Rule 6 forbids shipping
controls that do nothing.

---

## 8. Environment gotchas (each cost hours once — don't rediscover)

- **Apache doesn't forward `Authorization`** — fixed by a rewrite in
  `backend/public/.htaccess`. Only bites under real Apache, never `php -S`.
- **`config/env.php` precedence:** an already-set env var wins over
  `.env`. Never `set -a; . .env` in a script — it inverts that.
- **Empty `DB_PASSWORD` is rejected by design.** Disposable-DB tests
  must mint a throwaway MySQL user with a real password.
- **The app DB user has no `CREATE DATABASE`/`ALTER`/`CREATE TABLE`**
  (correct least-privilege) — migrations need DBA credentials.
- **Git-Bash `/c/...` paths break native `php.exe`** — `cygpath -m` first.
- **Space in the Windows username breaks Gradle and SDK `.bat` tools** —
  use the short path (`C:\Users\JAYSON~1\...`), `C:\gtmp` for
  `java.io.tmpdir`. **Gradle's daemon JVM follows `JAVA_HOME`, not
  `java` on PATH** — `./gradlew --stop` then re-export before building.
- **XAMPP MySQL isn't always running:** `tasklist //FI "IMAGENAME eq mysqld.exe"`,
  start with `cmd //c "C:\xampp\mysql_start.bat"`.
- **Browser tool:** a backgrounded tab can show a stale screenshot while
  the DOM is already correct. Prefer `read_page`/`get_page_text`.
- **Case-sensitivity in test assertions** — `.status-pill` etc. render
  uppercase via CSS while the DOM string isn't; caused false failures.
- **Windows Firewall silently drops inbound** to a dev port unless a
  rule allows it. **Android blocks cleartext HTTP** (API 28+) — needs
  `network_security_config.xml`. **Capacitor's `https://localhost`
  fetching a plain `http://` backend is a SEPARATE mixed-content block**
  (`server.androidScheme:'http'` fixes it; symptom is an opaque `Failed
  to fetch`). `ACCESS_FINE_LOCATION`/`COARSE` must be declared in the
  manifest or geolocation silently fails. Vite needs `server.host:true`
  + the real LAN IP (not `localhost`, which means the phone itself).
- **`adb` is not on PATH** — full path is
  `C:\Users\JAYSON~1\AppData\Local\Android\Sdk\platform-tools\adb.exe`.
- **A named PDO parameter can only bind ONE placeholder occurrence**
  under native prepares (`ATTR_EMULATE_PREPARES => false`) — bit
  `GET /incidents/nearby` for its whole lifetime, fixed.

---

## 9. Verification suites (all green — re-run before trusting a change)

| Script | Checks |
|---|---|
| `verify-sprint0.sh` | 19 |
| `verify-sprint1-auth.sh` | 23 |
| `verify-w2-reports.sh` | 31 |
| `verify-w3-w4-dispatch-gis.sh` | 38 |
| `verify-sprint1-remaining.sh` | 35 |
| `verify-scheduler-fatigue.sh` | 43 |
| `verify-devices-map-packages.sh` | 57 |
| `verify-duty-status-map-upload.sh` | 41 |
| `verify-sprint4.sh` | 50 |
| `verify-sprint4-phase2-3.sh` | 70 |
| `verify-sprint6.sh` | 110 |
| `verify-sprint7-retention.sh` | 76 |
| `verify-sprint7-audit.sh` | 52 |
| `verify-sprint7-pentest-incidents.sh` | 68 |
| `verify-ai-tools.sh` | 63 |
| `verify-b2-pentest-remaining-resources.sh` | 59 |
| `verify-sprint3.sh` | 38 |
| `verify-f9-sms-broadcast-idempotency-index.sh` | 15 |
| `verify-second-responder.sh` | 22 |
| `verify-routing.sh` | 23 (real-ORS block SKIPs, not fails, if no key) |
| `verify-device-session.sh` | 20 |
| `restore-drill.sh` | 12 (real DB) |
| `verify-web-wiring.mjs` | 555 (moves as screens change) |
| `web/tests` (`npm test`) | 405 |
| `mobile: verify.schema` | 113 |

All use a disposable database + disposable app user + throwaway port,
never the real `baranguard` database. `web/tests` needs no backend at
all: it renders every page in jsdom against a fake `fetch` (one-time
`npm install` in `web/tests/`; the dashboard itself stays npm-free).

> **Lesson learned the hard way (2026-09-05 to 2026-09-12):** migration
> 0011 added `user.is_suspended`; every suite that logs in but applies
> only its own sprint's migration subset 500'd at setup and never
> reached an assertion, while this table said green for a week. Found
> and fixed twice (4 suites, then 9 more found by systematically
> checking every suite, not just the ones in front of you). **Never pin
> a suite to a partial schema** — apply the full migration chain. When
> you find this class of bug, check every suite, not just the current one.

---

## 10. Where the full detail lives

- **`docs/Baranguard_Master_Reference_FINAL .md`** — the authority. §5
  schema DDL, §6 per-endpoint contracts, §7 role matrix, §8 design
  system, §9 screen specs, §11 retention table.
- **`backend/DEVLOG.md`** — every decision and why. **Don't read front
  to back.** `grep` for the feature you're touching.
- **`docs/REMAINING.md`** — what's left before Sprint 8.
- **`docs/HANDOFF.md`** — current state and next step.
- Controller/component class docs carry the resolved decisions for that
  file specifically, usually the fastest answer.
