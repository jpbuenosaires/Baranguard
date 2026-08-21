# Baranguard — Screen & Page Reference Guide

Master reference for every screen in the system: what it's for, what
features live on it, which roles can see/use it, which API endpoints it
calls, and how it should look. Built from `Screen_Inventory.md`,
`Feature_Backlog.md`, `Role_Permission_Matrix.md`, `API_Contract.md`, and
`Naming_Conventions.md` — paste the relevant screen section into an AI
session alongside `PROJECT_CONTEXT.md` when building that screen, instead of
re-explaining it from scratch each time.

**How to use this doc:** each screen entry is self-contained. You should be
able to hand a single screen's section to an AI session and get a
build-ready spec — purpose, roles, data, actions, states, and layout — without
needing to dig through five other files first.

---

## Global Design System

Applies to every screen before any screen-specific notes below.

### Visual language
- **No CSS framework.** Plain CSS only, custom properties for all design
  tokens (see below). No Tailwind, no Bootstrap.
- **Tone:** clean, premium, modern, enterprise government-tech SaaS — the
  visual bar is a real deployed LGU emergency dispatch platform, not a
  student project. Think modern CAD (computer-aided dispatch) systems and
  civic-tech dashboards: polished spacing, strong hierarchy, elevated
  cards, soft borders, restrained color use. The aesthetic communicates
  trust, reliability, security, emergency readiness, and government
  professionalism — never playful, never cluttered.
- **Color is functional as well as premium.** The blue-and-white base
  carries the "government-tech" identity; status colors (pending,
  dispatched, resolved, offline, critical) layer on top and must stay
  consistent across every screen they appear on — a "pending" pill on the
  blotter list must look identical to a "pending" pill on the dispatch
  center.
- Despite the polish, this is still dispatch software: a Tanod or
  dispatcher glancing at a screen during an active incident needs to find
  status, location, and next action in under 2 seconds. Premium and fast
  to read are not in tension here — generous whitespace and strong
  hierarchy are what make it scannable.

### Design tokens (define once in `/web/src/styles/base.css`)
```css
:root {
  /* Brand — blue-and-white government-tech palette */
  --color-navy: #1E3A6E;          /* deep navy — sidebar, headers */
  --color-primary: #1D4ED8;       /* primary blue — primary actions, links */
  --color-accent: #3B82F6;        /* accent blue — hover states, highlights */
  --color-surface-blue: #E0F2FE;  /* sky blue surface — subtle tinted panels */

  /* Neutrals */
  --color-white: #FFFFFF;
  --color-bg: #F8FAFC;            /* off-white app background */
  --color-border: #E2E8F0;
  --color-text-primary: #0F172A;
  --color-text-secondary: #475569;

  /* Status colors */
  --color-critical: #DC2626;      /* emergency red — priority alerts, SOS */
  --color-warning: #D97706;       /* warning orange — fatigue, pending, offline */
  --color-success: #16A34A;       /* success green — resolved, synced, on duty */
  --color-info: #0891B2;          /* info teal — dispatched, en route, informational */

  /* Spacing scale — premium, breathable, intentional */
  --spacing-xs: 4px;
  --spacing-sm: 8px;
  --spacing-md: 16px;
  --spacing-lg: 24px;
  --spacing-xl: 32px;
  --spacing-2xl: 48px;

  /* Typography — Inter throughout */
  --font-base: "Inter", system-ui, -apple-system, sans-serif;
  --font-size-label: 0.75rem;     /* uppercase system labels */
  --font-size-sm: 0.875rem;       /* body / secondary */
  --font-size-md: 1rem;           /* body */
  --font-size-lg: 1.25rem;        /* H3 — card titles */
  --font-size-xl: 1.75rem;        /* H2 — section headers */
  --font-size-2xl: 2.25rem;       /* H1 — hero / page title */

  /* Radius / elevation — rounded, soft, elevated */
  --radius-sm: 8px;
  --radius-md: 12px;
  --radius-lg: 16px;
  --shadow-card: 0 1px 3px rgba(15, 23, 42, 0.08), 0 1px 2px rgba(15, 23, 42, 0.06);
  --shadow-elevated: 0 4px 12px rgba(15, 23, 42, 0.10);
}
```
Reference these variables everywhere — never hardcode a hex value, a pixel
spacing number, or a font name directly in a component file.

**Typography hierarchy**
- **H1** — bold, large, premium hero style (`--font-size-2xl`); used sparingly,
  mainly page-level titles like "Dispatch Center."
- **H2** — strong section headers (`--font-size-xl`); groups within a page.
- **H3** — clean card titles (`--font-size-lg`); one per card/panel.
- **Body** — readable enterprise text (`--font-size-md` / `--font-size-sm`).
- **Labels** — subtle uppercase system labels (`--font-size-label`,
  letter-spacing ~0.05em, `--color-text-secondary`) for field labels, table
  headers, and status pill text.

### Status pill convention (used across almost every screen)
Pills are fully-rounded (`border-radius: 999px`), small uppercase label
text, a light tinted background of the status color at low opacity with the
solid status color as text/icon — polished and easy to scan at a glance,
not a flat solid-fill badge.

| Status | Color token | Used on |
|---|---|---|
| Pending | `--color-warning` | Incidents, redaction approval, swap requests |
| Dispatched / En Route | `--color-info` | Incidents, dispatch |
| Resolved / Completed / Approved | `--color-success` | Incidents, dispatch, swap requests |
| Active / Online / On Duty | `--color-success` | Duty status, live connections |
| Offline / Off Duty | `--color-text-secondary` (neutral) | Duty status, sync indicator |
| SOS / Critical / Priority Alert | `--color-critical` | Dispatch, SMS log, alert overlay |

### Required states — every data-driven screen must design for all four
1. **Loading** — skeleton or spinner, never a blank white screen.
2. **Empty** — polished empty state: icon, short explanation ("No incidents
   reported yet"), never just a blank table.
3. **Error** — alert banner with the failure reason and a retry action,
   matches the `error_response_format` in the API Contract (`code`,
   `message`).
4. **Populated** — the normal case.

On mobile screens, add a fifth: **Offline** — if the screen reads or writes
data, show what happens when there's no connection (queued locally, banner
shown via M11).

### Navigation shell
- **Sidebar (web):** dark navy (`--color-navy`) collapsible sidebar,
  role-filtered — only show links the current role can access, per
  Role/Permission Matrix. Active item gets a subtle accent-blue highlight,
  not a jarring color swap.
- **Top bar (web):** white, sits above the content area — breadcrumbs
  (left), search bar (center/left), notification bell + user avatar
  dropdown (right). Consistent across every authenticated screen.
- **Mobile:** sidebar becomes a bottom navigation bar (Home, Assignments,
  Map, Schedule, Profile); persistent offline banner (M11) docks at the
  very top when active, above the bottom nav.

### Reusable components
Build once, reuse everywhere — cards, tables, status pills, buttons,
inputs, modals, empty states, alert banners, charts, toast notifications,
mobile bottom navigation. Cards use `--shadow-card` (or `--shadow-elevated`
for anything meant to feel "lifted," like the AI Assistant panel on W7 or
an active modal) + `--radius-md`/`--radius-lg`, soft `--color-border`
outlines, generous internal padding (`--spacing-lg`).

### Responsive breakpoints
- **Desktop-first, 1440px** — primary target for the web Command Center;
  design here first.
- **Tablet, 768px** — sidebar collapses to icons-only or an overlay drawer;
  multi-column layouts (e.g. W7's two-column detail + AI panel) stack.
- **Mobile, 375px** — tables become stacked cards, not horizontally
  scrolling tables; fast emergency actions (SOS, duty toggle, dispatch
  acknowledge) stay large and reachable one-handed.

### Accessibility / field-use notes
- Minimum tap target 44×44px on mobile — Tanods may be using gloves or
  operating one-handed in the field.
- Don't rely on color alone for status — every pill pairs its color with a
  text label (color blindness, and screen glare in outdoor use).
- Critical alert overlay (M12) must be readable at arm's length in direct
  sunlight — high contrast, large type, minimal text; this is the one
  screen where "premium and understated" gives way entirely to maximum
  legibility.

---

## Web — Command Center

### W1 — Login
**Purpose:** Authenticate any system role into the web dashboard.
**Roles:** All (unauthenticated entry point).
**API:** `POST /auth/login` → `{ token, user }`.
**Features:**
- Username + password fields, no role selector shown to the user — role is
  returned by the server from the credential, not chosen client-side (avoid
  letting the UI imply the client can self-assign a role).
- Inline validation error using the standard error response shape
  (`UNAUTHORIZED` → "Invalid username or password").
**Design:**
- Centered elevated card (`--shadow-elevated`, `--radius-lg`) on a subtle
  `--color-surface-blue`-tinted or deep-navy background, no sidebar
  (pre-auth) — this is the one screen that gets to lead with brand: navy
  and blue, "Baranguard" wordmark, understated public-safety iconography.
- Loading state on submit (disable button, spinner) so a slow connection
  doesn't invite double-submits.

### W2 — Admin Dashboard
**Purpose:** At-a-glance operational overview on login.
**Roles:** Admin, Punong Barangay (Punong Barangay is read-only here).
**API:** `GET /reports/summary`.
**Features:**
- KPI cards: total incidents, resolved count, avg response time, active
  tanods on duty.
- Incident trend chart (time series).
- Incident type breakdown (bar or donut).
- Nav shortcuts into other modules.
**Design:**
- Card grid at top (KPIs), chart row below. Cards use `--shadow-card` +
  `--radius-lg`, one stat per card, large H1-weight numeral + uppercase
  label underneath, generous internal padding — this is the page that sets
  the "premium enterprise dashboard" impression, so give the grid room to
  breathe rather than packing cards edge-to-edge.
- Empty state matters here for a fresh deployment: "No incidents recorded
  yet this period" rather than a chart rendering as an empty axis.

### W3 — Dispatch Center
**Purpose:** Real-time operational hub for assigning responders to
incidents.
**Roles:** Dispatcher, Admin.
**API:** `GET /incidents?status=pending`, `GET /gps/live`, `POST /dispatch`.
**Features:**
- Emergency queue (list of pending incidents, newest/most-critical first).
- Live map panel (shares map component with W4).
- Priority alert banner for new/unhandled critical incidents.
- Dispatch action: select tanod → confirm → `POST /dispatch`.
**Design:**
- Split-pane layout: queue list (left/top), live map (right/bottom) — this
  is the screen most likely to be open during an actual active incident, so
  prioritize information density and speed of the dispatch action (2 clicks
  max: select incident → assign tanod).
- Priority banner uses `--color-critical`, persistent until acknowledged,
  not a toast that auto-dismisses.

### W4 — GIS Live Tracking
**Purpose:** Real-time map of all field personnel and incidents.
**Roles:** Admin, Dispatcher.
**API:** `GET /gps/live`.
**Features:** Live responder markers (color-coded by duty status), incident
markers (color-coded by status), filters (by status/type), recenter action.
**Design:**
- Map-first, full-bleed within content area, minimal chrome. Filter
  controls as a collapsible panel, not permanently blocking map area.
- Marker legend always visible (small fixed panel) since color is doing a
  lot of work here.

### W5 — Historical Heatmap
**Purpose:** Visualize incident density over time for resource planning —
**explicitly non-predictive** (historical data only, no forecasting).
**Roles:** Admin, Dispatcher.
**API:** `GET /reports/heatmap`.
**Features:** Heatmap overlay, date range filter, export view.
**Design:**
- Same map component as W4 for visual consistency, heatmap layer instead
  of discrete markers. Date range picker prominent at top — this screen is
  useless without a scoped range, so don't let it load with an unbounded
  "all time" default on a growing dataset.
- Label the view clearly as historical/non-predictive somewhere visible —
  this matters for your Chapter 3 "Safety" framing (§5.4), not just UI copy.

### W6 — Electronic Blotter (List)
**Purpose:** Searchable/filterable record list — the front door to incident
records.
**Roles:** Admin, Secretary, Dispatcher, Lupon (Lupon sees redacted view only).
**API:** `GET /incidents?barangay_id=&status=&date_from=&date_to=&incident_type=`.
**Features:** Search, filter (status/date/type), open record (→ W7), new
entry action (web-side citizen intake, per API contract).
**Design:**
- Table view, one row per incident: type, status pill, source icon
  (app/sms/web), date, short excerpt of redacted narrative (never raw —
  `raw_narrative` is never returned by this endpoint, so the UI can't leak
  it even by mistake).
- Filter bar pinned above the table in a white elevated panel
  (`--shadow-card`), not a separate modal — this is a screen used
  constantly, filtering should be zero-friction.
- Role-aware: Lupon's version of this screen simply never receives
  `raw_narrative` in the response, so no client-side hiding logic is
  needed or should be relied on (server already enforces it).

### W7 — Electronic Blotter (Detail)
**Purpose:** Full incident record view + entry point to the AI redaction
workflow.
**Roles:** Secretary (full, including raw narrative), others (redacted
view only).
**API:** `GET /incidents/:id`, `PATCH /incidents/:id/status`.
**Features:** Full record fields, AI Assistant panel (trigger summary/redraft
via `/redact`), edit, finalize.
**Design:**
- Two-column: record detail (left), AI Assistant panel (right) — visually
  distinct panel (bordered card, different background tint) so it's clear
  AI-generated content is a draft, not the record of truth, until approved.
- **Keep this visually and functionally separate from W8** — this screen
  shows the record; the actual approve/reject action for a redaction draft
  lives on W8, not here. Don't merge them even though it's tempting for a
  single AI session to build both as one page. This split exists as a
  security/UX guardrail per the Screen Inventory notes: fewer accidental
  approvals, and a clean human-in-the-loop story for your defense.

### W8 — AI Redaction Review
**Purpose:** The human-in-the-loop gate — dedicated screen for a Secretary
to approve, edit, or reject an AI redaction draft before it's committed.
**Roles:** Secretary only.
**API:** `GET /incidents/:id/ai-draft`, `POST /incidents/:id/ai-draft/approve`.
**Features:** Side-by-side raw narrative vs. draft redacted narrative,
edit-before-approve, approve/reject actions.
**Design:**
- Side-by-side diff-style layout: raw on the left (clearly labeled
  "UNREDACTED — Secretary only"), AI draft on the right, editable inline.
- Approve button should feel deliberately weighty (not a casual default
  action) — this single click is what RA 10173 compliance hinges on. Use a
  confirm step or a clearly separated, non-default-styled button rather
  than a bright primary-colored one-click approve.
- Show `model_version` and `status` (completed/processing/failed) so the
  Secretary knows if they're looking at a stale or still-processing draft.

### W9 — Statistical Reports
**Purpose:** Generate/export operational reports.
**Roles:** Admin, Dispatcher.
**API:** `GET /reports/summary`.
**Features:** Charts/tables by incident type, response time, date range;
generate, export.
**Design:**
- Report configuration panel (date range, filters) above the output area.
- Export action clearly separated from "generate" — generating populates
  the on-screen view, exporting produces a file; don't conflate the two
  into a single ambiguous button.

### W10 — User Management
**Purpose:** Manage system user accounts.
**Roles:** Admin only.
**API:** `GET /users`, `POST /users`, `PATCH /users/:id`.
**Features:** List all users by role, add/edit/deactivate.
**Design:**
- Table with role as a filterable column, `is_active` shown as a toggle,
  not a separate edit-then-save action — deactivation should be one click
  with a confirm step (this affects login access immediately).
- New-user form should default role to the empty/unselected state — never
  pre-select "admin" as a default, minimize risk of accidental privilege
  escalation via a careless form submit.

### W11 — Shift & Roster Scheduler
**Purpose:** Drag-and-drop weekly scheduling per tanod.
**Roles:** Admin only.
**API:** `POST /shifts`, `GET /shifts`, `GET /shifts/fatigue-flags`.
**Features:** Assign shift, view coverage, view fatigue flags inline.
**Design:**
- Calendar grid (week view), one row per tanod, drag to create/resize a
  shift block. Patrol zone shown as a label/color on the block.
- Surface fatigue flags directly on this screen (not just on W13) — a
  small warning icon on any tanod approaching the 48-hour/7-day threshold,
  so the admin sees the risk at the moment they're about to schedule more
  hours, not after the fact.

### W12 — Shift Swap Requests
**Purpose:** Review pending shift swap/time-off requests.
**Roles:** Admin only.
**API:** `PATCH /shift-swap-requests/:id`.
**Features:** List pending/resolved requests, approve/deny.
**Design:**
- Simple list/table, pending requests visually prioritized above resolved
  history (e.g. pending section expanded by default, resolved collapsed).
- Approve/deny as clear paired actions per row — avoid a separate "edit
  then save status" flow for something this binary.

### W13 — Fatigue Flags
**Purpose:** Dedicated view of tanods exceeding the rolling 7-day hour
threshold.
**Roles:** Admin (full), Punong Barangay (read-only).
**API:** `GET /shifts/fatigue-flags`.
**Features:** List of flagged tanods, acknowledge flag, adjust schedule
(links back to W11).
**Design:**
- List sorted by severity (hours over threshold, descending). Each row:
  tanod name, hours worked (7-day), flagged timestamp, acknowledge action.
- Acknowledging a flag should not silently delete it from any audit trail —
  this is safety-relevant data for your ISO 25010 Safety characteristic
  evaluation; keep `acknowledged_by` visible even after acknowledgment.

### W14 — SMS Activity Log
**Purpose:** Audit trail of all sent/received SMS, primarily for the 95%
delivery reliability metric.
**Roles:** Admin only.
**API:** `GET /sms/logs`.
**Features:** Filter by date/status, view for reliability audit.
**Design:**
- Dense table view — this is an audit screen, not a dashboard; prioritize
  scanability over visual flourish, though it still sits inside the same
  card/border/spacing system as everywhere else. Columns: type, direction,
  status, timestamp, gateway message ID.
- Status column uses the same status pill convention as elsewhere
  (`queued`, `pending`, `sent`, `failed`, `refunded` — map
  `failed`/`refunded` to `--color-critical`, `sent` to `--color-success`).

### W15 — Settings / Account
**Purpose:** Own-account management, available to every role.
**Roles:** All (own account only).
**API:** `PATCH /users/:id` (self).
**Features:** Update profile, change password.
**Design:**
- Simple single-column form, no role-specific variation needed — this is
  the one screen every role sees identically.

---

## Mobile — Tanod Operations App

### M1 — Login
**Purpose:** Authenticate a Tanod into the mobile app.
**Roles:** Tanod.
**API:** `POST /auth/login`.
**Design:** Same pattern as W1 but mobile-first — large tap targets,
single-column, works fine on a locked-down low-tier Android device (per
Portability requirement §5.5).

### M2 — Home
**Purpose:** Primary landing screen — duty status + quick actions.
**Roles:** Tanod.
**API:** `POST /duty-status`, `GET /duty-status` (own).
**Features:** Duty status toggle (On Duty / Responding / Off Duty), quick
emergency SOS, active alerts, today's stats.
**Design:**
- Duty status toggle should be the single largest, most prominent element
  on the screen — this is pressed constantly, often one-handed, sometimes
  urgently. Three-state segmented control, not a dropdown.
- SOS action visually distinct (critical color) and separated from the
  duty toggle to prevent mis-taps — different region of the screen
  entirely, ideally requiring a confirm (press-and-hold or two-step).

### M3 — Log New Incident
**Purpose:** Core field data capture — must work fully offline.
**Roles:** Tanod.
**API:** `POST /incidents` (queued locally if offline, synced via
`/sync/batch` on reconnect).
**Features:** Type, location, description form; add photo, add voice note;
submit (offline-capable).
**Design:**
- Form should never block on network — every field writes to local SQLite
  immediately; submit is "save," not "send." Sync happens transparently in
  the background per the offline-detection/sync logic.
- Location field auto-fills from GPS but remains editable (device GPS can
  be inaccurate indoors/under cover).
- Voice note recorder needs a visible waveform/timer while recording so the
  Tanod knows it's actually capturing, especially useful in noisy field
  conditions.
- Explicit "Saved locally" confirmation on submit even with zero
  connectivity — this is the screen where "zero data loss" has to be
  visibly true to the user, not just true in the backend.

### M4 — Incident Submitted Confirmation
**Purpose:** Confirms the M3 submission and shows sync status.
**Roles:** Tanod.
**Features:** Sync status (queued locally vs. synced to cloud).
**Design:**
- Simple state screen: icon + status text + "View sync status" or "Log
  another incident" actions. Sync status uses the same offline/pending
  pill convention as M11.

### M5 — Assignments List
**Purpose:** Active dispatch assignments for this Tanod.
**Roles:** Tanod.
**API:** `GET /dispatch?status=` (filtered to own), `PATCH /dispatch/:id/status`.
**Features:** Priority-coded list, navigate, call dispatch, mark arrived.
**Design:**
- List sorted by priority/recency, each row shows incident type + distance/
  ETA if available. Critical assignments get the `--color-critical` accent
  and should sit at the top regardless of chronological order.

### M6 — Assignment Detail / Navigation
**Purpose:** Route + incident details for one active assignment.
**Roles:** Tanod.
**API:** `PATCH /dispatch/:id/status`.
**Features:** Route map, incident details, start navigation, update status.
**Design:**
- Map-dominant layout, incident details collapsible below/behind the map
  rather than competing for the same screen space. Status update
  (en_route/arrived/completed) as large, unambiguous buttons — this is used
  while moving/driving, not while carefully reading a screen.

### M7 — Live Map
**Purpose:** Own location + nearby active incidents.
**Roles:** Tanod.
**API:** `POST /gps` (periodic ping), `GET /incidents` (nearby).
**Design:** Full-bleed map, recenter action as a floating button (standard
map UX pattern), minimal chrome.

### M8 — Shift Schedule
**Purpose:** Read-only view of upcoming assigned shifts.
**Roles:** Tanod.
**API:** `GET /shifts?user_id=` (self).
**Design:** Simple list/agenda view grouped by day, patrol zone shown per
shift.

### M9 — Shift Swap Request
**Purpose:** Submit a swap or time-off request.
**Roles:** Tanod.
**API:** `POST /shifts/:id/swap-request`.
**Features:** Submit request, view request status.
**Design:** Short form (target tanod optional, reason field), plus a status
list of previously submitted requests (pending/approved/denied) using the
same status pill convention as W12.

### M10 — Profile
**Purpose:** Own info + duty history stats.
**Roles:** Tanod.
**API:** `PATCH /users/:id` (self, limited fields).
**Design:** Simple profile form, read-only duty history stats block above
the editable fields.

### M11 — Offline Indicator (persistent element, not a page)
**Purpose:** Always-visible connection status.
**Roles:** Tanod.
**Design:**
- Thin persistent banner docked at the very top of the app, appears only
  when offline or when there's a non-zero pending sync count (e.g. "Offline
  — 3 reports queued"). Uses `--color-warning`. Disappears entirely when
  fully synced and online — don't show a permanent "online" state, only
  surface the exception.

### M12 — Critical Alert Overlay
**Purpose:** Full-screen, lock-screen-overriding alert on priority dispatch.
**Roles:** Tanod.
**Design:**
- Full-screen takeover, `--color-critical` dominant, large type readable at
  arm's length in sunlight. Minimal content: incident type, location,
  acknowledge action. No secondary/tertiary actions competing for
  attention — acknowledge, then it routes into M6.
- Must render over Android's lock screen (`SHOW_WHEN_LOCKED` +
  `TURN_SCREEN_ON`, per the API Contract's priority-alert design) with
  alarm-stream audio that bypasses silent mode.

### M13 — SMS Fallback Confirmation (persistent element, not a page)
**Purpose:** Confirms an action was sent via SMS instead of the API.
**Roles:** Tanod.
**Design:** Toast/banner, brief and auto-dismissing (unlike M11, this is a
one-time confirmation, not an ongoing state) — e.g. "Duty status sent via
SMS" — uses `--color-info`, not warning/critical, since this is the system
working as designed, not a problem.

---

## Cross-Screen Consistency Checklist

Before marking any screen "done," confirm:
- [ ] Status colors match the Status Pill Convention table above, not
      invented per-screen
- [ ] All four (or five, on mobile) required states are handled, not just
      the happy path
- [ ] Role restrictions match the Role/Permission Matrix exactly — no
      client-side-only hiding without the server enforcing the same rule
- [ ] Every API call matches the exact request/response shape in the API
      Contract (snake_case in, camelCase in JS via the central `apiClient`
      boundary)
- [ ] No screen displays `raw_narrative` to a role not cleared for it, even
      transiently in a loading/error state
- [ ] Design tokens (`base.css` custom properties) used exclusively — no
      hardcoded colors/spacing/font names in component styles
- [ ] Typography uses Inter and the defined H1/H2/H3/body/label hierarchy —
      no ad-hoc font sizes
- [ ] Cards, tables, pills, buttons, and inputs are pulled from the shared
      component set, not rebuilt one-off per screen
- [ ] The screen still feels premium/enterprise at a glance — generous
      spacing, elevated cards, soft borders — not just functionally correct
