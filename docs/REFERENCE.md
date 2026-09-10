# Baranguard — Working Reference (compact)

**This is the auto-loaded working reference.** It carries what a coding
session actually needs. The full `Baranguard_Master_Reference_FINAL .md`
(7.3k words, reconciled 2026-09-07) stays in `docs/` as the authority —
open it by section number when you need the full wording. Section
markers below (§n) point into it.

**Never invent a field, route, role, or state transition that isn't
here or there.** If something seems missing, stop and ask.

---

## 1. What this is

Offline-first, locally hosted Barangay Intelligence and Emergency
Dispatch System for four barangays in Pilar, Sorsogon. Production
system, not a demo. Single workstation, LAN-only, no cloud.

> **⚠️ LAN-only is currently violated — P0, open.** `web/index.html`
> points at a public tunnel; see `docs/HANDOFF.md` / `docs/REMAINING.md`
> §F1 / `docs/AUDIT_2026-09-07.md` for the evidence and fix.

**Stack:** PHP 8.2 serves all of `/api/v1/*` (resolved Sprint 1 — Node is
CLI tooling only). MariaDB 10.4 via XAMPP. Web: vanilla JS, **no bundler,
no npm step** (that constraint drives a lot — hand-rolled charts, inline
SVG icons, vendored MapLibre). Mobile: Ionic React 9 + Capacitor 8.5,
encrypted SQLite (SQLCipher). AI: Llama-SEA-LION-v3.5-8B-R via **local
Ollama only**.

**Four barangays, fixed:** Dao=1, Binanuahan=2, Marifosque=3, Banuyo=4.

**Relationship to DILG BIMSS — settled 2026-09-10, do not re-litigate.**
DILG BIMSS/BIMS is mandated for all barangays by Memorandum Circular. It
is an 11-subsystem suite, and one of those subsystems (**KPIS**) already
*is* the Katarungang Pambarangay case database; BIMS also ships its own
electronic blotter. **Baranguard complements BIMSS and may never be
positioned as replacing it** — a legal constraint stated by the user, not
a design preference. Baranguard's value is the layer BIMSS has none of:
real-time dispatch, GPS, SOS, offline field capture, and local-AI
redaction. Anything that duplicates a BIMSS *records* function is
liability, which is why the walk-in blotter endpoint and the standalone
blotter records list were both removed on 2026-09-10.

---

## 2. Non-negotiable rules (§2 — the ones that actually bite)

**This numbered list is its own sequence (1-11), not the Master
Reference's 32-rule list under its own §2** — they cover overlapping
ground but don't share numbering (this reference's "Rule 5" here is "the
API never calls Ollama"; the Master Reference's own Rule 5 is about
telecom SMS). A "Rule N" citation anywhere in this docs set means
whichever list its own context makes clear — check before assuming they
match. (Cost real time once — see the Master Reference rewrite's DEVLOG
entry, 2026-09-07.)

1. **`raw_narrative` never leaves the system** except through the
   approved AI pipeline. Never to FCM, Semaphore, cloud, logs, terminal
   output, or audit metadata. **`GET /incidents/:id` is the only endpoint
   that returns it, and only to a Secretary** — §3: RA 7160 §394(c)
   makes the Secretary the statutory records custodian, which is why the
   higher-privileged Admin gets *less* here. Do not "fix" that asymmetry.
   **The AI Tools endpoints add a second reader of `raw_narrative`:** the
   Blotter Assistant (`POST /incidents/:id/ai-tools/blotter-assist`),
   Secretary-only for exactly this reason, whose prompt redacts as it
   drafts. The Incident Classifier deliberately reads only the APPROVED
   redacted narrative — that is what makes it safe to expose to Admin.
   *(The former open exception here — `POST /blotter`'s walk-in path,
   `AUDIT_2026-09-07.md` F7 — is closed: the endpoint was removed
   2026-09-10, see §5.)*
2. **Every protected endpoint verifies role + tenant + ownership
   server-side.** No client-side check is a security boundary. Cross-
   tenant is **404, never 403** — a 403 confirms the resource exists.
3. **Idempotency, not interchangeable:** web writes use the
   `Idempotency-Key` UUID header; mobile writes use `client_event_id`
   (+ `X-Device-Id` header, which the server verifies belongs to the
   caller). A retry must return the original row, never create a second.
4. **AI pipeline order:** raw → redaction draft → summary derived from
   the draft (never from raw) → Secretary review → approve. Only
   `POST /incidents/:id/ai-draft/approve` may commit
   `incident.redacted_narrative`. Draft edits use exact `draft_version`
   equality (stale → 409). **The four AI Tools assistants are NOT part
   of this pipeline** — they write `ai_processing_log.tool_output` and
   nothing else. None may write a record; their output is text a human
   reads and retypes (§7).
5. **The API never calls Ollama.** It only enqueues; `scripts/ai-worker.php`
   is the only process that talks to the model. No external AI fallback
   exists under any failure mode. This covers the AI Tools endpoints too —
   they enqueue and the screen polls.
6. **No demo/prototype tells.** No fabricated statistics, no hardcoded
   identities, no confidence numbers not backed by a real
   `ai_evaluation_run`, no control that looks functional and does
   nothing, no "All Systems Operational" badge that isn't a real probe.
   A `not_configured` dependency is neutral — not green, not red.
7. **Offline capture is durable state.** A mobile write persists to
   encrypted SQLite before the user can leave the screen, and is never
   claimed synced until the server confirms.
8. **Audit metadata is allow-listed** — identifiers and statuses only.
   Never narrative, credentials, tokens, coordinates, or personal data.
9. **Never edit a completed migration.** Add a new numbered one.
10. **Retention numbers are constants, not config** (§11) — changing one
    needs an architecture review, not a runbook edit.
11. **Timestamps stored UTC; operational/display times Asia/Manila.**
    Day-bucketing is done in PHP against a fixed +08:00, never
    `CONVERT_TZ()` (the tz tables aren't loaded on stock XAMPP).

---

## 3. Roles (§3, §7)

| Role | Reach |
|---|---|
| **Admin** | Full operations: dispatch, GPS, scheduler, users, devices, audit log, service health, exports. **Cannot** touch blotter finalize/amend, Lupon packet, or any AI draft. |
| **Secretary** | Records custodian: the only reader of `raw_narrative`; the only role that may run the AI pipeline, approve a redaction, finalize/amend a blotter, or generate a Lupon packet. |
| **Punong Barangay** | Read-only oversight: dashboard, map, heatmap, analytics, fatigue, Threat Analyzer. No evidence files, no AI drafts, no writes. **No blotter LIST since 2026-09-10** (W6 removed — see §7); individual incidents still reachable from the dashboard. |
| **Tanod** | Mobile only. Own incidents/dispatches/shifts. Web login succeeds but lands on an honest "no screen" page. |
| **Lupon** | **No system account at all.** Receives the generated PDF packet. |

---

## 4. Schema map (§5 — 27 tables)

Core chain: `barangay → user → mobile_device → incident → dispatch →
tanod_sos → notification → notification_target → notification_delivery`.

**Key tables:** `incident` (raw_narrative NULLable since 0007,
redacted_narrative, legal_hold, raw_narrative_purged_at,
complainant_name/respondent_name/complainant_contact_number since 0008,
Secretary-only — see AiDraftController::approveExtraction() —
location_description since 0010, display_id since 0014) · `dispatch` ·
`evidence_attachment` (files outside web root, legal_hold) ·
`blotter_record` + `blotter_revision` (0004; same three party fields
since 0008, shared with Admin/PB once finalized; case_status enum since
0009 — active/under_investigation/settled/resolved, forward-only past
`active`, `resolved` set only by an incident status change, never a
manual amend; display_id since 0014) · `citizen_report` (legal_hold) ·
`duty_status` · `gps_track` · `shift_schedule` (user_id nullable since
0003) · `shift_swap_request` · `fatigue_flag` · `ai_processing_log` (IS
the AI job queue; `task_type` gained `'extraction'` in 0008 and the four
AI Tools types in 0015; **`incident_id` is NULLable since 0015** —
`sms_compose`/`threat_analysis` have no incident, so 0015 also adds
`barangay_id` (their only tenant scope, §2 Rule 2),
`requested_by_user_id`, `tool_input`, `tool_output`) ·
`ai_evaluation_run` · `sms_log` (barangay_id since 0006;
message_body/read_at since 0013, `message_type` gained `'manual'`) ·
`sms_envelope_replay` (0005) · `audit_log` (write-once except
retention) · `offline_queue` · `auth_session` · `map_package` · `user`
(is_suspended/suspended_reason/suspended_at since 0011 — a third,
independent axis from is_active; see §3) · `system_settings` (new
table, 0012 — see §7's W21 note).

**Migrations:** 0001 baseline · 0002 seed barangays · 0003 nullable
shift user · 0004 blotter_revision · 0005 sms_envelope_replay · 0006
sms_log.barangay_id · 0007 retention columns · 0008 incident party
fields · 0009 blotter case_status · 0010 incident location_description ·
0011 user suspension · 0012 system_settings (§7 W21 override) · 0013 sms
manual send · 0014 incident/blotter display_id · **0015 ai_tools**
(nullable incident_id + tenant/requester/tool columns + four task types;
verified up, down and idempotent against a disposable MariaDB 10.4 first).
**All fifteen are applied to the real local `baranguard` DB** (0008–0014
on 2026-09-05, 0015 on 2026-09-10). On a new machine, apply all fifteen
in order — as
DBA/root, **not** as `baranguard_app`, which has no `ALTER`/`CREATE
TABLE` (see §8).

**FK trap:** `ai_processing_log`, `evidence_attachment`, `blotter_record`
and `dispatch` are all `ON DELETE RESTRICT` against `incident` — deleting
an incident is an ordered cascade (see `RetentionService::purgeOneIncident`).

**MariaDB 10.4 limits:** no `SKIP LOCKED`; a table-level CHECK on
`notification`'s entity matrix fails with ERROR 1901 (enforced in PHP
instead).

---

## 5. Endpoints (82 live `/api/v1` routes, all built)

Read the route tables in `backend/routes/*.php` for the authoritative
list; controllers carry the per-endpoint contract in their class docs.

**Auth** login · logout · change-password
**Incidents** list (+`q=` search since the UX overhaul) · show · create ·
**update** (`PATCH /incidents/:id`, 2026-09-06) · nearby · evidence ·
status (also flips a linked finalized blotter's case_status to
`resolved`, non-destructive, audited) · blotter · finalize · amend
(+optional forward-only case_status transition) · lupon-packet
(+download) · redact · ai-draft (+approve, regenerate-summary, translate,
extraction+approve — extraction is independent of redaction, migration
0008)

> **`PATCH /incidents/:id` is an operational-correction endpoint, NOT a
> narrative editor.** Admin+Secretary may set `priority`,
> `incident_type`, `location_description`; `complainant_name` is
> **Secretary-only** (migration 0008's party fields are extracted from
> RAW narrative and preserve exactly the identifiers redaction strips, so
> they carry `raw_narrative`'s protection — the same rule
> `IncidentsController::show()` applies). Sending `raw_narrative` or
> `redacted_narrative` is a hard 400: Rule 4 keeps
> `ai-draft/approve` the only writer of `redacted_narrative`, and the
> legal record is corrected through blotter amend, which has a
> `blotter_revision` trail this endpoint does not.
> `Idempotency-Key` required. Audit metadata records changed field
> **names**, never values (Rule 8). See `backend/DEVLOG.md`'s "Review of
> the second Antigravity pass" for what the first draft of this endpoint
> did and why it never shipped.
**Dispatch** list (tanod_name joined) · create · cancel · status
**GPS** live · history · post · `/sync/batch`
**Scheduling** shifts (list/create/update) · swap requests · fatigue flags
**Notifications/SOS** notifications · ack · tanod-sos (+ack/resolve)
**Devices/Map** register · deactivate · map-packages (get/upload/download)
**Reports** summary · heatmap · nav-counts · **export (+download)**
**Ops** `/audit-log` · `/system/health` · `/search` ·
`/barangays` · `/users` (list gains `q=`, last_login_at, is_suspended;
suspend/unsuspend alongside the existing is_active toggle) ·
`/citizen-reports` (+`/:id/convert` since 2026-09-05 — always speced in
§6, never built until now; see `backend/DEVLOG.md`'s workflow-audit
entry; list `status=` gains `converted`/`all` since 2026-09-06, was
`unconverted`-only) · `/duty-status` · `/blotter` (list gains `q=`, `status=`,
case_status, display_id, location_description)
**AI Tools** (0015) `POST /incidents/:id/ai-tools/blotter-assist` ·
`POST /incidents/:id/ai-tools/classify` · `POST /ai-tools/sms-compose` ·
`POST /ai-tools/threat-analysis` · `GET /ai-tools/jobs/:id` ·
`GET /ai-tools/availability`

> **`POST /blotter` (walk-in entry) was REMOVED 2026-09-10.** A walk-in
> complaint with no prior incident is exactly a native DILG BIMSS/KPIS
> case, and §1 makes Baranguard a complement to BIMSS, never a
> replacement. Removing it also closed `AUDIT_2026-09-07.md` **F7** (the
> one path where unredacted intake text reached Admin/PB) and **F9's
> first bullet** (`200 []` on a replayed key), by deletion rather than by
> fix. `GET /blotter` stays — Analytics' case-status widget consumes it.
> The rest of the blotter family (finalize/amend/lupon-packet) is
> untouched: it is incident-originated, and BIMSS has no dispatch layer
> to feed it.

> **AI Tools — four drafting aids, one per role-appropriate job.** None
> writes a record; each enqueues an `ai_processing_log` row and the
> screen polls `GET /ai-tools/jobs/:id`. Per-tool gates differ *because
> the data differs*, not by seniority: **blotter-assist** Secretary-only
> (reads `raw_narrative`); **classify** Admin+Secretary (reads only the
> approved redaction — 409 if there is none); **sms-compose** Admin-only,
> matching `/sms/send`, and takes an operator-typed `prompt` and nothing
> else (its output leaves via Semaphore, so Rule 1 bars narrative input);
> **threat-analysis** Admin+PB, aggregate counts only, scope always the
> caller's own barangay resolved server-side. `GET /ai-tools/jobs/:id` is
> owner-scoped as well as tenant-scoped — an Admin cannot poll a
> Secretary's blotter-assist job (404, never 403).
> `GET /ai-tools/availability` returns the same coarse
> `healthy|unhealthy|not_configured` as `/system/health`'s `ollama` field
> but is readable by all three roles; it exists so a panel can disable
> Generate honestly instead of queueing work nothing can run (§2 Rule 6).
> **There is no AI Tools screen** — each tool is embedded in its host
> screen via `components/AiToolPanel.js` (§6, §7).
**SMS** `/sms/logs` (read-only activity log, unchanged) ·
`/sms/conversations` (+`/:phone/messages`, +`/:phone/resolve` — grouped
by contact, Admin-only) · `/sms/send` · `/sms/broadcast` (both
Admin-only, Idempotency-Key required, recipient always resolved to a
real in-tenant contact server-side — never an arbitrary client-supplied
number; broadcast scope is always the caller's own barangay, never
cross-tenant)
**Settings** `GET/PATCH /system-settings` (Admin-only; `sms_gateway.
api_key`/`sms_gateway.sender_name` + three `general.*` keys only — see
§7's W21 note for what this deliberately does NOT cover)
**Internal only** `/internal/sms/*` (6 handlers, loopback + token gated,
served by `public/internal.php` — structurally separate from `/api/v1`)

**Response envelope:** success = the object; error =
`{"error":{"code":"...","message":"..."}}`. Pagination: `page`/`limit`,
default 25, max 100.

> **⚠️ Three routes above still don't match their documented contract** —
> evidence upload doesn't exist server-side, `PATCH /incidents/:id` isn't
> actually idempotent, `avg_response_time_minutes` double-counts
> multi-dispatch incidents, and `POST /citizen-reports` is the head of a
> stored-XSS chain. Full evidence: `docs/AUDIT_2026-09-07.md` (findings
> F2–F5, F8); tracked as `docs/REMAINING.md` §F. *(`POST /blotter`'s
> `200 []` left this list on 2026-09-10 — the endpoint was removed.)*

---

## 6. Design system (§8) — web

Tokens only, never a hardcoded hex/px/font in a component file.
`--color-*` in `base.css`; dark mode is a second value set on the same
tokens (`--dark-*` defined once, remapped by both
`prefers-color-scheme` and `[data-theme]`).

**Use `--color-*-solid` for white text/icons on a saturated fill** — the
plain status tokens lighten in dark mode and fail contrast there.

**Every data-driven screen needs all four states:** Loading / Empty /
Error-with-retry / Populated.

Shared components: `AppShell` · `PageHeader` · `DataTable` (+ CSV export,
pagination) · `KpiCard` · `LineChart` · `BarChart` · `DonutChart` ·
`LiveMap` · `Menu` · `Toast` · `ConfirmDialog` (+`promptSelect`) ·
`StatStrip` · `Avatar` · `DateRangePicker` · `icons` · **`AiToolPanel`**
(2026-09-10 — one local-AI assistant embedded in a host screen; returns
`{el, stop}`. **A host MUST call `stop()` before wiping the panel's DOM
and chain it into the page's stop handle** — wiping `innerHTML` does not
clear its poll interval. Its availability probe is module-cached so
remounts don't re-probe. It is also the app's only shared collapsible
primitive: the toggle button is the sole interactive element and carries
`aria-expanded`.)

**Shared CSS entities — use these, do not re-roll them** (2026-09-06 UI/UX
audit; each of these previously existed 2-4 times under different page
prefixes and had drifted):

| Entity | Classes | Where |
|---|---|---|
| Tab bar | `.page-tabs` / `.page-tab` (+`__icon`, `__badge`) | `PageHeader.css` |
| Filter chip | `.filter-chips` / `.filter-chip` (+`__count`) | `base.css` |
| Stat card grid | `.stat-card-grid` / `.stat-card` (+`__value`, `__label`) | `base.css` |
| Role badge | `.role-badge--{admin,secretary,punong_barangay,tanod}` | `base.css` |
| Date range | `DateRangePicker()` | `components/DateRangePicker.js` |

**Sizing/spacing tokens added by the same audit:** `--control-height`
(2.5rem, every text control and button) · `--control-height-prominent`
(2.625rem, detail-pane CTAs) · `--pad-panel` / `--pad-panel-lg` (the only
two card/panel paddings) · `--spacing-md-lg` (1.25rem).

**Dark mode:** `index.html` now stamps a *resolved* `data-theme` on every
load and follows the OS until the user stores a preference, so a page-level
`[data-theme="dark"] .x` rule is sufficient and needs no
`prefers-color-scheme` twin. Before 2026-09-06 it was not, and 28 page
rules silently never fired for system-dark users.

**`--color-*-solid` is a FILL for white text, never a text colour** — it
stays dark in dark mode. For coloured text use `--color-*-text`, and
`--color-link` (not `--color-primary`) for primary-coloured text. The
`*-text` tokens are specced against white, so putting them on a tint eats
their margin: keep badge tints at 8%.

**Run `node web/scripts/verify-web-wiring.mjs` after any web change** —
it catches imports and CSS classes that don't resolve, which no other
check in this stack can see. Currently **508/508** (this line said 453
until 2026-09-07; the total moves in both directions as screens are
added and merged — the number that matters is failures = 0).

**Never interpolate server data into an `innerHTML` template.** Use
`textContent`, or escape. The 2026-09-07 audit found ~45 sites that do
interpolate unescaped, one of which lets an *unauthenticated* citizen
report execute script in the Secretary session — the one session that
can read every `raw_narrative` in the barangay (§2 Rule 1). Three page
modules each define their own private `escapeHtml`; none applies it
consistently. See `docs/AUDIT_2026-09-07.md` F2/F3. Note that neither
`verify-web-wiring.mjs` nor `node --check` can see this class of defect.

---

## 7. Screens (§9)

**Built:** W1 login · W2 dashboard · W3 dispatch (map incident markers +
assign-from-map, migration-free) · W4 GIS · **W7 incident detail**
(still routed as `blotter-detail`; case_status transition control) ·
W8 AI review ·
**Analytics** (2026-09-05 merge of W5 Historical Heatmap + W9
Statistical Reports into one tabbed screen — Reports/Heatmap — see
`web/src/pages/analytics.js`; same role pair both already had, Admin +
Punong Barangay read-only, so no per-tab gating unlike Personnel below.
Reports tab: export+audited, see §5) · **Personnel** (2026-09-05 merge of W10-W13 into one
tabbed screen — Users/Scheduler/Swap requests/Fatigue flags — see
`web/src/pages/personnel.js`; only Fatigue is Punong Barangay-visible,
same role split each had standalone. Users tab: create/deactivate/
reactivate/**suspend** since 0011, StatStrip, real last-login, scoped —
see §3's role matrix note) · W14 **SMS
Monitor** (renamed from SMS log; read-only Activity Log tab unchanged +
new Conversations tab — compose/broadcast, see §5) · W15 settings
(+General/SMS Gateway sections, Admin-only, since 0012 — see the W21
note below) · W16 citizen inbox (+Convert to Incident, +Location column,
since 2026-09-05) · W17 audit log · W18 map package
management · W19 public report · W20 service health · Incident
Management (search, Resolve action, location_description,
complainant/respondent/contact fields on create; **+AI Classifier** in
the detail pane and **+Incident Type select** on the Edit form, both
2026-09-10).
**Mobile:** M1–M7, M12, M13.

> **W6 Electronic Blotter (records list) was REMOVED 2026-09-10** — DILG
> BIMSS's KPIS module is the mandated case ledger and a second one was
> liability, not a feature (§1). **W7 survives and is load-bearing:** it
> is the app's ONLY per-incident detail view, tolerates having no blotter
> record, and is where Incident Management, the dashboard, SMS Monitor,
> the audit log, global search and notification clicks all land. It keeps
> the `blotter-detail` route key deliberately — ~12 `navigate()` call
> sites use it and nothing in this stack validates a navigate key, so
> renaming it is its own pass. Its back button is role-aware
> (`incident-management`, or `dashboard` for PB).
>
> **Role consequence, stated because it is a real reduction:** Punong
> Barangay no longer has a list-of-cases screen; §3's "blotter list" reach
> is now dashboard + Analytics + individual incident detail.

> **AI assistants live in their host screens, not on an AI screen**
> (2026-09-10 — a standalone AI Tools screen shipped and was dissolved
> the same day; an operator is mid-task and wants help with that task).
> Each is an `AiToolPanel` (§6):
> - **AI Classifier** — Incident Management detail pane, under the
>   priority/status badges, collapsed by default. *Apply in Edit* opens
>   the Edit form with the suggested type/priority preselected; the human
>   still saves. Invalid model values never reach the select.
> - **AI Blotter Assistant** — incident detail (`blotter-detail`), main
>   column, inside the Secretary-only branch. Framed as a draft to
>   transcribe into DILG BIMSS/KPIS; it writes nothing to Baranguard.
> - **AI Message Composer** — SMS Monitor › Conversations, top of the
>   right-hand feed pane, collapsible. *Use this draft* fills the compose
>   textarea; **no send button** — sending stays on the audited path.
> - **Threat Analyzer** — Analytics › third tab, not collapsible, with an
>   explicit "describes what was recorded, not a forecast" label
>   matching the Heatmap's own non-predictive framing.
>
> Every panel polls like W8 (3s) because the API only enqueues, and
> **renders a real probe-driven unavailable banner and disables Generate
> when the model is unreachable** — §2 Rule 6, and not hypothetical: this
> workstation cannot complete a generation (A2). Model output is rendered
> with `textContent`, never interpolated.

**W21 system settings — narrow, deliberate exception, not a full
build-out.** The blanket "no schema/endpoints, gateway credentials must
never live in a settings row" blocker above was true through Sprint 7.
Migration 0012 + `SettingsController` (2026-09-05, explicit user
authorization) override it for exactly two keys:
`sms_gateway.api_key`/`sms_gateway.sender_name`, surfaced Admin-only via
`GET/PATCH /system-settings` and the Settings screen's SMS Gateway
section, masked on every read. This does **not** extend to
`DEVICE_SECRET_MASTER_KEY`, `INTERNAL_SERVICE_TOKEN`, `JWT_SECRET`, or
`FCM_SERVICE_ACCOUNT_PATH` — those stay in `.env`/PHP constants, never a
DB row, and a future session must not "complete" W21 by moving them
there without the same kind of explicit sign-off this narrow exception
got. `system_settings` also holds three non-secret `general.*` display
keys (system name, municipality, region). Full architecture-review-grade
system settings (Notifications/Security/GIS/Backup sections) remain
**not built** — no schema or endpoints exist for them, and §2 Rule 6
forbids shipping a control that looks functional and does nothing.

---

## 8. Environment gotchas (each cost hours once — don't rediscover)

- **Apache doesn't forward `Authorization`** — fixed by a rewrite in
  `backend/public/.htaccess`. Only bites under real Apache, never `php -S`.
- **`config/env.php` precedence:** an already-set env var wins over
  `.env`. Never `set -a; . .env` in a script — it inverts that and
  silently points tests at the real database.
- **Empty `DB_PASSWORD` is rejected by design.** Disposable-DB tests must
  mint a throwaway MySQL user with a real password.
- **The app DB user has no `CREATE DATABASE`, and no `ALTER`/`CREATE
  TABLE` either** (correct least-privilege — confirmed 2026-09-05
  applying migrations 0008-0014 to the real DB: `baranguard_app` got
  `ERROR 1142 ... ALTER command denied`). Migrations need DBA
  credentials (root on this XAMPP install has no password), same as
  drills/tests needing elevated access — not a new grant on the app user.
- **Git-Bash `/c/...` paths break native `php.exe`** — `cygpath -m` first.
- **Space in the Windows username breaks Gradle and SDK `.bat` tools** —
  use the short path (`C:\Users\JAYSON~1\...`), and `C:\gtmp` for
  `java.io.tmpdir`.
- **XAMPP MySQL isn't always running:** `tasklist //FI "IMAGENAME eq mysqld.exe"`,
  start with `cmd //c "C:\xampp\mysql_start.bat"`.
- **Browser tool:** a backgrounded tab can show a stale screenshot while
  the DOM is already correct. Prefer `read_page`/`get_page_text` over
  screenshots; do a whole flow in one evaluation.
- **Case-sensitivity in test assertions** has caused three separate false
  failures — `.status-pill` etc. render uppercase via CSS while the DOM
  string isn't.

---

## 9. Verification suites (all green — re-run before trusting a change)

| Script | Checks |
|---|---|
| `verify-sprint0.sh` | 19 |
| `verify-sprint1-auth.sh` | 22 |
| `verify-w2-reports.sh` | 30 |
| `verify-w3-w4-dispatch-gis.sh` | 37 |
| `verify-sprint1-remaining.sh` | 34 |
| `verify-scheduler-fatigue.sh` | 42 |
| `verify-devices-map-packages.sh` | 54 |
| `verify-duty-status-map-upload.sh` | 40 |
| `verify-sprint4.sh` | 48 |
| `verify-sprint4-phase2-3.sh` | 69 |
| `verify-sprint6.sh` | all green (re-runs 2026-09-10) |
| `verify-sprint7-retention.sh` | 62 |
| `verify-sprint7-audit.sh` | 52 |
| `verify-sprint7-pentest-incidents.sh` | 68 |
| `verify-ai-tools.sh` | 63 (new 2026-09-10) |
| `restore-drill.sh` | 12 (against the real DB) |
| `verify-web-wiring.mjs` | 508 (moves as screens change; see §6 above) |
| `mobile: verify.schema` | 113 |

All use a disposable database + disposable app user + throwaway port and
never touch the real `baranguard` database.

> **⚠️ Every suite that logs in was silently broken from 2026-09-05 to
> 2026-09-10, and this table said otherwise the whole time.** Migration
> 0011 added `user.is_suspended`, `AuthController::login()` selects it,
> but sprint6 / sprint7-retention / sprint7-pentest-incidents /
> sprint7-audit each applied only their own sprint's subset of
> migrations — so every login 500'd and each suite exited at setup
> without reaching one assertion. All four now apply the FULL chain
> 0001-0015. **Never pin a suite to a partial schema:** it expires the
> next time a migration touches a table the suite logs in through, and it
> fails in the one way that looks like infrastructure trouble rather than
> a stale script. Counts above are what they report now, re-measured.

---

## 10. Where the full detail lives

- **`docs/Baranguard_Master_Reference_FINAL .md`** — the authority. §5
  schema DDL, §6 per-endpoint contracts, §7 role matrix, §8 design
  system, §9 screen specs, §11 retention table.
- **`backend/DEVLOG.md`** (7.2k+ lines) — every decision and why. **Don't
  read it front to back.** `grep` for the feature you're touching.
- **`docs/REMAINING.md`** — what's left before Sprint 8.
- **`docs/HANDOFF.md`** — current state and next step.
- Controller/component class docs carry the resolved decisions for that
  file specifically, and are usually the fastest answer.
