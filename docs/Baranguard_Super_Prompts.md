# Baranguard — Super Prompt Library

One prompt to paste at the start of **every** AI coding session (the Base
Prompt), plus one tailored super prompt per sprint. Each sprint prompt
already includes the Base Prompt's rules by reference — you don't need to
paste both in full every time, but do paste the Base Prompt fresh at the
start of any new chat/session, then follow with that sprint's prompt.

**Where these pull from:** `PROJECT_CONTEXT.md`, `Naming_Conventions.md`,
`Baranguard_Screen_Reference.md` (design system + per-screen specs),
`Role_Permission_Matrix.md`, `API_Contract.md`, `Database_Schema.md`,
`Feature_Backlog.md`. If any of those files change, update the relevant
section here too — this doc is a distillation, not a replacement.

---

## 0. Base Prompt (paste at the start of every session, no exceptions)

```
You are working on Baranguard, a Barangay Intelligence and Emergency
Dispatch System — a real offline-first, cloud-assisted incident reporting
and dispatch platform for four barangays in Pilar, Sorsogon, Philippines.
This is a production system being built for a BSIT capstone at Bicol
University, not a demo or prototype. Treat it accordingly.

STACK
- Backend: PHP 8.2 + Node.js
- Web frontend: Vanilla JS (ES2023+), plain CSS — NO CSS framework, no
  Tailwind, no Bootstrap. Custom properties for all design tokens.
- Mobile: Ionic 8.8.5 + Capacitor 8.0 (Android)
- Cloud DB: MySQL 8.0 — system of record
- Mobile local DB: SQLite/Room — offline-first cache, mirrors cloud schema
- AI: Llama-SEA-LION-v3.5-8B-R via Ollama, local inference only — NEVER
  call an external AI API for narrative text
- SMS: Semaphore SMS Gateway (+ tethered phone as GSM modem fallback)

NON-NEGOTIABLE ARCHITECTURE RULES
1. No unredacted PII ever leaves the local environment.
2. All incident capture works fully offline; sync is opportunistic.
   SQLite local cache is the source of truth until synced.
3. AI redaction requires human approval before permanent storage — only
   POST /incidents/:id/ai-draft/approve (secretary role) may write to
   incident.redacted_narrative. No other code path writes that field.
4. SMS fallback triggers only after 3 failed health-check pings (5s
   timeout, 2s apart, ~21s total) — don't fall back prematurely.
5. No Class 0/Flash SMS, no telecom-layer silent SMS — both are
   unsupported by any third-party gateway. Critical alerts use Semaphore's
   /priority endpoint + an app-layer full-screen overlay. Background
   coordinate pings are regular SMS parsed silently server-side, not
   silent at the protocol level.
6. RBAC is enforced server-side only. Client-side role checks are UX
   convenience, never the actual security boundary.
7. Cloud hosts the database + web dashboard; AI inference runs locally on
   the unified administrative workstation — never split across servers.

NAMING CONVENTIONS
- DB fields + API JSON keys: snake_case
- PHP: snake_case (idiomatic) — JS/TS: camelCase (idiomatic)
- Boundary rule: snake_case → camelCase conversion happens in exactly ONE
  central file per platform (web: apiClient.js, mobile: apiService.ts).
  Never convert ad-hoc inside a component.
- JS components/classes: PascalCase. JS files: kebab-case for pages/routes,
  PascalCase for components.
- CSS classes: kebab-case with BEM-style modifiers (.dispatch-card,
  .dispatch-card__header, .dispatch-card--priority)
- CSS custom properties: kebab-case, -- prefix (--color-primary)
- Git commits: [SprintN][USx] Short description

FOLDER STRUCTURE — put new files in the right place, don't invent new
top-level folders:
/backend    → /routes /controllers /models /middleware
              /services(/sms /ai /sync) /config /migrations
/web        → /src/pages /src/components /src/styles /src/services /src/assets
/mobile     → /src/pages /src/components /src/services /src/db /android
/ai         → /prompts /test-data
/docs       → planning docs + DEVLOG.md + /evidence
- One table = one model file on the backend. Never combine multiple
  tables' access logic into one file.
- Schema changes go through numbered migration files. Never a raw
  ALTER TABLE typed into a terminal.
- AI prompt templates live in /ai/prompts as their own versioned files,
  never as inline strings in service code.

DESIGN SYSTEM — enterprise government-tech SaaS, not a prototype look
- Tone: clean, premium, modern, trustworthy — comparable to real CAD
  (computer-aided dispatch) systems and civic-tech dashboards. Never
  playful, never cluttered, never "student project" looking.
- Typography: Inter throughout. H1 bold/large hero, H2 strong section
  headers, H3 clean card titles, body readable, labels subtle uppercase.
- Colors are CSS custom properties only — never hardcode a hex value:
  --color-navy: #1E3A6E;   --color-primary: #1D4ED8;
  --color-accent: #3B82F6; --color-surface-blue: #E0F2FE;
  --color-critical: #DC2626; --color-warning: #D97706;
  --color-success: #16A34A;  --color-info: #0891B2;
  --color-bg: #F8FAFC; --color-border: #E2E8F0;
  --color-text-primary: #0F172A; --color-text-secondary: #475569;
- Rounded corners 12–16px, soft borders, elevated cards
  (shadow: 0 1px 3px rgba(15,23,42,0.08)), generous premium spacing.
- Status pills: fully rounded, tinted background at low opacity, solid
  status color as text — never a flat solid-fill badge.
- Nav shell: dark navy collapsible sidebar (web), white top bar with
  breadcrumbs + search + notification bell + user avatar dropdown.
  Mobile: sidebar becomes a bottom nav bar.
- Every data screen needs Loading / Empty / Error / Populated states
  (+ Offline on mobile) — never leave a state undesigned.

PRODUCTION-REALISM RULE — READ THIS CAREFULLY
This must look and behave like the actual system that will be deployed and
used by real barangay staff, not a demo or a portfolio piece. Concretely:
- NEVER add visible "demo account" credentials, "test login: admin/admin123"
  hints, sample-data disclaimers, watermarks, "DEMO MODE" banners, or any
  UI text that tells the viewer this is a prototype. The login screen, the
  dashboard, every screen must look like it belongs to a live, deployed
  government system — because it is meant to become one.
- Seed/mock data used during development must be realistic in content
  (plausible Filipino names, real barangay names — Dao, Binanuahan,
  Marifosque, Banuyo — plausible incident types) but must never be
  labeled as fake in the UI. If you need to distinguish test data
  internally, do it in code comments or a README, never in user-facing text.
- Don't add placeholder Lorem Ipsum, "Company Name", "Your Logo Here", or
  any other prototype tell. Use "Baranguard" and real barangay names.
- Don't hardcode credentials anywhere in committed code — .env only, and
  never echoed to the UI, console.log, or committed to git.
- If you need to simulate an unbuilt dependency (e.g. a backend endpoint
  that doesn't exist yet), mock it invisibly at the service layer, not
  with a visible "MOCK DATA" label in the interface.

BEFORE YOU START
- Ask which specific Screen Inventory ID(s) (e.g. W3, M6) or backlog item
  number this session is scoped to — don't build multiple screens/features
  in one prompt unless explicitly asked.
- If schema or API contract details are unclear, check
  Database_Schema.md / API_Contract.md rather than inventing a field name.
```

---

## 1. Sprint 0 — Cloud Setup + DB Schema

```
[paste Base Prompt above, then:]

SPRINT 0 — Cloud environment + database schema.

Scope for this session: [pick one]
- Set up the MySQL 8.0 cloud instance connection config in
  /backend/config (env-driven, no hardcoded credentials)
- Generate numbered migration files in /backend/migrations from
  Database_Schema.md — one migration per logical group of tables
  (e.g. 001_core_entities.sql for barangay/user, 002_incidents.sql, etc.),
  not one giant migration file
- Scaffold /backend/models — one file per table, matching field names
  exactly as specified in Database_Schema.md (snake_case, exact types)

Do NOT invent fields not in Database_Schema.md. Do NOT seed the cloud DB
with anything — synthetic/test data belongs only in /ai/test-data later,
never in the live MySQL instance per the architecture rules.

Output: migration files + model files, following the folder structure and
naming conventions above. Confirm which tables/migrations you created.
```

---

## 2. Sprint 1 — Web Command Center + GIS Dashboard

```
[paste Base Prompt above, then:]

SPRINT 1 — Web-based command center, screens W1–W9 (login through
statistical reports; W10–W15 are later sprints unless explicitly scoped
here).

Scope for this session: Build screen [W#] — [screen name], per its full
spec in Baranguard_Screen_Reference.md (Purpose / Roles / API / Features /
Design sections for that screen).

Build order within the sprint: static layout first (with realistic mock
data matching the API Contract's response shape), then wire up the mock
data through the apiClient.js boundary, then swap in real API calls once
the backend endpoint exists. Don't ask for "the whole dashboard with live
data" in a single pass — build and verify incrementally.

Requirements for this screen specifically:
- Match the Design section for [W#] in Baranguard_Screen_Reference.md
  exactly — layout, which components (cards/tables/pills/etc.), and the
  required states (Loading/Empty/Error/Populated).
- Enforce the role restriction listed for [W#] in the Role/Permission
  Matrix — but remember this is UX only; note in a comment that the real
  enforcement happens server-side in Sprint 7's RBAC middleware.
- Use only the shared components/tokens defined in the Global Design
  System — don't invent new colors, radii, or spacing values for this
  screen.
- No demo/prototype tells anywhere in the UI (see Production-Realism Rule
  in the Base Prompt).

Output: page file(s) under /web/src/pages/[kebab-case-screen-name]/,
using shared components from /web/src/components where applicable.
```

---

## 3. Sprint 2 — Mobile UI + Offline SQLite Cache

```
[paste Base Prompt above, then:]

SPRINT 2 — Mobile Tanod Operations App, screens M1–M4 + M11 (offline
indicator) primarily; M5–M13 may extend into Sprint 3.

Scope for this session: Build screen [M#] — [screen name], per its full
spec in Baranguard_Screen_Reference.md.

Critical constraint: this screen must work with zero network connectivity.
Every write goes to the local SQLite/Room schema first — build that local
table (mirroring the matching cloud table from Database_Schema.md field-
for-field, plus the synced boolean + created_offline_at timestamp pattern
documented there) before wiring up any UI. The UI's "submit" action is a
local save, not a network call — sync happens separately and later.

Requirements for this screen specifically:
- Match the Design section for [M#] — mobile-first, 44×44px minimum tap
  targets, offline-safe by default.
- If this screen reads/writes data, design the Offline state explicitly
  (not just Loading/Empty/Error/Populated) — what does the user see with
  zero connectivity?
- M11's offline banner behavior (only visible when offline or pending
  syncs exist) should be a shared component other screens can include, not
  rebuilt per-screen.
- No demo/prototype tells anywhere in the UI.

Output: page file(s) under /mobile/src/pages/[kebab-case-screen-name]/,
local DB schema/migration under /mobile/src/db/, matching the cloud
migration naming pattern from Sprint 0.
```

---

## 4. Sprint 3 — GPS Tracking + Async Cloud Sync

```
[paste Base Prompt above, then:]

SPRINT 3 — GPS tracking (M5–M7, W4) + offline→cloud sync logic.

Scope for this session: [pick one]
- Build the sync engine in /backend/services/sync — processes
  offline_queue_local entries in created_offline_at order (oldest first),
  checks for duplicate device_id + local_id before inserting, per the Sync
  Logic Notes in Database_Schema.md. Cloud NEVER overwrites a field-
  captured incident — only accepts new records or separate status-update
  writes from the dispatch path. Do not build naive last-write-wins logic.
- Build screen [W4 / M5 / M6 / M7] per its Screen Reference spec — GPS
  live map / assignments list / navigation / own live map respectively.
- Write a test script simulating N offline records queued, then
  reconnected, verifying all N sync with zero duplication (per the Feature
  Backlog's acceptance test for 1.4).

Match POST /sync/batch's exact request/response shape from
API_Contract.md — don't invent a different sync payload structure.

No demo/prototype tells anywhere in the UI or test output labeling.
```

---

## 5. Sprint 4 — SMS Gateway Integration

```
[paste Base Prompt above, then:]

SPRINT 4 — Semaphore SMS integration, resiliency features 4.1–4.5, and
mobile screens M12 (critical alert overlay) + M13 (SMS fallback toast).

Scope for this session: [pick one]
- Build /backend/services/sms — wraps Semaphore's three real endpoints
  only (POST /api/v4/messages, /api/v4/priority, /api/v4/otp). Do not
  invent or assume any other Semaphore endpoint exists — verify against
  real Semaphore docs (semaphore.co/docs) before implementing, don't guess
  at method names.
- Implement the offline-detection trigger exactly as resolved: 3 failed
  health-check pings, 5s timeout each, 2s apart → declare offline at ~21s
  → trigger SMS fallback. Recheck on next user action + background ping
  every ~30s.
- Build M12 (Critical Alert Overlay) — full-screen, SHOW_WHEN_LOCKED +
  TURN_SCREEN_ON, alarm-stream audio bypassing silent mode, triggered by
  the native SMS listener watching for the priority tag prefix. This is an
  app-layer alert, not a telecom-layer Flash SMS — do not build or
  reference Class 0/binary flash SMS anywhere.
- Build M13 (SMS Fallback Confirmation) as the shared toast component per
  its Screen Reference design note.

Test with Semaphore's sandbox/test credits, never production quota, during
this session. Use Semaphore SMS Gateway (with tethered phone fallback) —
credentials come from .env only, never hardcoded or logged.

No demo/prototype tells anywhere in the UI.
```

---

## 6. Sprint 5 — Ollama + Llama-SEA-LION Setup

```
[paste Base Prompt above, then:]

SPRINT 5 — Local AI infrastructure. This is infrastructure work, not
application/UI code — go step by step, verify manually before wiring
anything into the app.

Scope for this session: [pick one]
- Set up Ollama + Llama-SEA-LION-v3.5-8B-R locally, confirm a basic
  request/response works against the real Ollama REST API (verify the
  actual endpoint shape against Ollama's docs — don't assume a method
  exists).
- Build /backend/services/ai — the service layer that calls the local
  Ollama instance. This service must NEVER call an external AI API for
  narrative text, per the architecture rules; enforce that at the code
  level, not just as a comment.
- Benchmark inference speed on the actual target hardware and log the
  result — this number is needed for the Performance Efficiency ISO 25010
  evaluation later.

Prompt templates for redaction/summarization/translation go in
/ai/prompts as their own versioned files (e.g. redact-v1.txt), never as
inline strings inside the service code.

No demo/prototype tells anywhere — this is backend infrastructure, but
any logging should describe real operation, not "TEST MODE" language that
would leak into production logs.
```

---

## 7. Sprint 6 — PII Redaction Pipeline + Validation

```
[paste Base Prompt above, then:]

SPRINT 6 — PII redaction/summarization pipeline, screens W7 (blotter
detail + AI panel) and W8 (AI Redaction Review).

Scope for this session: [pick one]
- Build the 200-record synthetic PII test set in /ai/test-data — realistic
  but clearly synthetic content (never seeded into the actual cloud MySQL
  instance, per the architecture rules). Pre-tag the PII entities in each
  record for later scoring.
- Build the SLM redaction/summarization call in /backend/services/ai,
  writing results only to a draft location — NEVER directly to
  incident.redacted_narrative. Only POST /incidents/:id/ai-draft/approve
  may write that field; enforce this as a real constraint in the code
  (e.g. that field isn't even in the /redact endpoint's write path), not
  just a comment.
- Build the baseline regex-only redaction filter (comparator) — runs
  independently of the SLM, used only for precision/recall benchmarking.
- Build the scoring script that compares model output against the
  pre-tagged 200-record set and computes precision/recall automatically —
  target recall ≥95%, precision ≥90% per the Feature Backlog's acceptance
  test.
- Build W7's AI Assistant panel and W8 (AI Redaction Review) per their
  full Screen Reference specs — W8 stays a visually and functionally
  distinct screen from W7, never merged into one page, per the human-in-
  the-loop design guardrail.

No demo/prototype tells anywhere in the UI — the redaction review screen
in particular must look like the real compliance tool it is, not a
mockup.
```

---

## 8. Sprint 7 — RBAC, Security Hardening, Integration Testing

```
[paste Base Prompt above, then:]

SPRINT 7 — Server-side RBAC enforcement, security hardening, integration
testing. Also covers remaining web screens W10–W15 if not yet built.

Scope for this session: [pick one]
- Implement /backend/middleware RBAC checks — every endpoint's allowed
  roles from API_Contract.md enforced server-side, matching the full
  Role/Permission Matrix exactly (including field-level restrictions,
  e.g. dispatcher never receives raw_narrative even from GET
  /incidents/:id). Client-side role checks built in earlier sprints are
  UX only and must not be the actual security boundary — this session
  makes the server the real enforcement point.
- Run a security audit pass specifically for: SQL injection,
  unauthenticated endpoints, and PII appearing in logs or error messages.
  This is a real audit, not a formality — flag and fix every finding.
- Build remaining screens W10 (User Management), W11 (Shift Scheduler),
  W12 (Shift Swap Requests), W13 (Fatigue Flags), W14 (SMS Activity Log),
  W15 (Settings) per their Screen Reference specs.
- Full end-to-end test of the DFD Level 1 process path: Incident Capture
  → Sync → AI Processing → Cloud DB → Dispatch → Analytics.

No demo/prototype tells anywhere in the UI, including newly-built admin
screens like User Management — no "sample users," no visible test
credentials in seed data shown through the interface.
```

---

## 9. Sprint 8 — UAT + ISO/IEC 25010:2023 Evaluation

```
[paste Base Prompt above, then:]

SPRINT 8 — UAT + evaluation. This sprint is about stability and
measurement, not new features — the system should be feature-frozen
before UAT starts.

Scope for this session: [pick one]
- Fix bugs surfaced during UAT — scope each fix narrowly, don't refactor
  unrelated code while fixing a reported issue.
- Instrument any remaining Evaluation Framework Hooks (5.1–5.6 in the
  Feature Backlog) that aren't yet logging — sync latency, SLM inference
  time, SQLite cache success rate, SMS fallback delivery rate, PII
  exposure audit points, GPS/dispatch delivery confirmation, Android
  device-tier test results, JSON/eGIF v2.0 compliance checks.
- Do NOT add new user-facing features this sprint — if something looks
  like scope creep, log it in DEVLOG.md's Future Work section instead per
  the vibe-coding ground rules, don't build it now.

No demo/prototype tells anywhere — by this sprint the system must be
indistinguishable from a real deployed instance for evaluators.
```

---

## Reusable Single-Screen Prompt Template

For any one-off screen build outside a full sprint session, use this
compact form:

```
[paste Base Prompt above, then:]

Build screen [ID] — [name] per its full spec in
Baranguard_Screen_Reference.md: Purpose, Roles, API endpoint(s), Features,
and Design notes for that screen exactly as written there.

Constraints:
- Use only shared components/tokens from the Global Design System — no new
  colors, radii, spacing, or fonts invented for this screen.
- Design all required states (Loading/Empty/Error/Populated, +Offline on
  mobile).
- Enforce the listed role restriction (client-side UX layer; note that
  real enforcement is server-side per Sprint 7).
- Follow the folder structure and naming conventions from the Base Prompt.
- No demo/prototype tells anywhere in the UI or seed data labeling.

Output: file(s) in the correct folder per the structure above. Tell me
what you built and where.
```

---

## Daily Session Checklist (run before AND after every session)

**Before:**
- [ ] Paste the Base Prompt fresh if this is a new chat session
- [ ] Confirm current schema/API state hasn't drifted (check migrations)
- [ ] Scope today's task to ONE backlog item or ONE screen, not multiple

**After:**
- [ ] Test the feature manually — don't just trust AI output
- [ ] Scan the diff for any demo/prototype tells before committing (visible
      test credentials, "DEMO" labels, Lorem Ipsum, placeholder branding)
- [ ] Commit with `[SprintN][USx] Short description`
- [ ] Log bugs/deviations/future-work ideas in DEVLOG.md
- [ ] Save evidence (screenshot/test log) for demoable features
