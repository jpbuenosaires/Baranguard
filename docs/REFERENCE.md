# Baranguard — Working Reference (compact)

**This is the auto-loaded working reference.** It carries what a coding
session actually needs. The full `Baranguard_Master_Reference_FINAL .md`
(16.8k words) stays in `docs/` as the authority — open it by section
number when you need the full wording. Section markers below (§n) point
into it.

**Never invent a field, route, role, or state transition that isn't
here or there.** If something seems missing, stop and ask.

---

## 1. What this is

Offline-first, locally hosted Barangay Intelligence and Emergency
Dispatch System for four barangays in Pilar, Sorsogon. Production
system, not a demo. Single workstation, LAN-only, no cloud.

**Stack:** PHP 8.2 serves all of `/api/v1/*` (resolved Sprint 1 — Node is
CLI tooling only). MariaDB 10.4 via XAMPP. Web: vanilla JS, **no bundler,
no npm step** (that constraint drives a lot — hand-rolled charts, inline
SVG icons, vendored MapLibre). Mobile: Ionic React 9 + Capacitor 8.5,
encrypted SQLite (SQLCipher). AI: Llama-SEA-LION-v3.5-8B-R via **local
Ollama only**.

**Four barangays, fixed:** Dao=1, Binanuahan=2, Marifosque=3, Banuyo=4.

---

## 2. Non-negotiable rules (§2 — the ones that actually bite)

1. **`raw_narrative` never leaves the system** except through the
   approved AI pipeline. Never to FCM, Semaphore, cloud, logs, terminal
   output, or audit metadata. **`GET /incidents/:id` is the only endpoint
   that returns it, and only to a Secretary** — §3: RA 7160 §394(c)
   makes the Secretary the statutory records custodian, which is why the
   higher-privileged Admin gets *less* here. Do not "fix" that asymmetry.
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
   equality (stale → 409).
5. **The API never calls Ollama.** It only enqueues; `scripts/ai-worker.php`
   is the only process that talks to the model. No external AI fallback
   exists under any failure mode.
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
| **Punong Barangay** | Read-only oversight: dashboard, map, heatmap, blotter list, analytics, fatigue. No evidence files, no AI drafts, no writes. |
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
the AI job queue; `task_type` gained `'extraction'` in 0008) ·
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
manual send · 0014 incident/blotter display_id. **0001–0007 are applied
to the real local `baranguard` DB; 0008–0014 are NOT** — only to the
disposable `baranguard_uiseed` DB so far (see `docs/HANDOFF.md`'s
warning banner for the exact apply commands). On a new machine, apply
all fourteen in order.

**FK trap:** `ai_processing_log`, `evidence_attachment`, `blotter_record`
and `dispatch` are all `ON DELETE RESTRICT` against `incident` — deleting
an incident is an ordered cascade (see `RetentionService::purgeOneIncident`).

**MariaDB 10.4 limits:** no `SKIP LOCKED`; a table-level CHECK on
`notification`'s entity matrix fails with ERROR 1901 (enforced in PHP
instead).

---

## 5. Endpoints (74 live `/api/v1` routes, all built)

Read the route tables in `backend/routes/*.php` for the authoritative
list; controllers carry the per-endpoint contract in their class docs.

**Auth** login · logout · change-password
**Incidents** list (+`q=` search since the UX overhaul) · show · create ·
nearby · evidence · status (also flips a linked finalized blotter's
case_status to `resolved`, non-destructive, audited) · blotter ·
finalize · amend (+optional forward-only case_status transition) ·
lupon-packet (+download) · redact · ai-draft (+approve,
regenerate-summary, translate, extraction+approve — extraction is
independent of redaction, migration 0008)
**Dispatch** list (tanod_name joined) · create · cancel · status
**GPS** live · history · post · `/sync/batch`
**Scheduling** shifts (list/create/update) · swap requests · fatigue flags
**Notifications/SOS** notifications · ack · tanod-sos (+ack/resolve)
**Devices/Map** register · deactivate · map-packages (get/upload/download)
**Reports** summary · heatmap · nav-counts · **export (+download)**
**Ops** `/audit-log` · `/system/health` · `/search` ·
`/barangays` · `/users` (list gains `q=`, last_login_at, is_suspended;
suspend/unsuspend alongside the existing is_active toggle) ·
`/citizen-reports` · `/duty-status` · `/blotter` (list gains `q=`,
case_status, display_id, location_description)
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
`StatStrip` · `Avatar` · `icons`.

**Run `node web/scripts/verify-web-wiring.mjs` after any web change** —
it catches imports and CSS classes that don't resolve, which no other
check in this stack can see. Currently 453/453.

---

## 7. Screens (§9)

**Built:** W1 login · W2 dashboard · W3 dispatch (map incident markers +
assign-from-map, migration-free) · W4 GIS · W5 heatmap · W6 blotter
(records view, case_status pill, display_id, search, CSV export) · W7
blotter detail (case_status transition control) · W8 AI review · W9
analytics+export · W10 user management (create/deactivate/reactivate/
**suspend** since 0011, StatStrip, real last-login, scoped — see §3's
role matrix note) · W11 scheduler · W12 swaps · W13 fatigue · W14 **SMS
Monitor** (renamed from SMS log; read-only Activity Log tab unchanged +
new Conversations tab — compose/broadcast, see §5) · W15 settings
(+General/SMS Gateway sections, Admin-only, since 0012 — see the W21
note below) · W16 citizen inbox · W17 audit log · W18 map package
management · W19 public report · W20 service health · Incident
Management (search, Resolve action, location_description,
complainant/respondent/contact fields on create).
**Mobile:** M1–M7, M12, M13.

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
- **The app DB user has no `CREATE DATABASE`** (correct least-privilege).
  Drills/tests needing it use DBA credentials, not a new grant.
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
| `verify-sprint6.sh` | 112 |
| `verify-sprint7-retention.sh` | 66 |
| `verify-sprint7-audit.sh` | 56 |
| `verify-sprint7-pentest-incidents.sh` | 68 |
| `restore-drill.sh` | 12 (against the real DB) |
| `verify-web-wiring.mjs` | 453 |
| `mobile: verify.schema` | 113 |

All use a disposable database + disposable app user + throwaway port and
never touch the real `baranguard` database.

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
