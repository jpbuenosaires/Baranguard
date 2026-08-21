# Baranguard — Screen Inventory

Full list of screens needed, expanding beyond the 8 mockups in Appendix D.
For each: what it shows, primary actions, and which role(s) can access it
(cross-reference the Role/Permission Matrix for detail).

---

## Web — Command Center

| # | Screen | Shows | Key actions | Roles |
|---|---|---|---|---|
| W1 | Login | Role selector, credentials | Sign in | All |
| W2 | Admin Dashboard | KPI cards (total incidents, resolved, avg response time, active tanods), incident trend chart, incident type breakdown | Navigate to other modules | Admin, Punong Barangay |
| W3 | Dispatch Center | Emergency queue, live map, priority alert banner | Dispatch tanod, view live map | Dispatcher, Admin |
| W4 | GIS Live Tracking | Real-time map of all field personnel + incidents, filters | Track responder, recenter map | Admin, Dispatcher |
| W5 | Historical Heatmap | Incident density overlay, date range filter | Filter by date/type, export view | Admin, Dispatcher |
| W6 | Electronic Blotter (List) | Searchable/filterable incident records table | Search, filter, open record, new entry | Admin, Secretary, Dispatcher, Lupon (redacted view only) |
| W7 | Electronic Blotter (Detail) | Full incident record, AI Assistant panel | Generate summary, redact PII, edit, finalize | Secretary (full), others (redacted view only) |
| W8 | AI Redaction Review | Draft redaction side-by-side with raw narrative | Approve/edit/reject AI draft | Secretary only |
| W9 | Statistical Reports | Charts/tables by incident type, response time, date range | Generate report, export | Admin, Dispatcher |
| W10 | User Management | List of all system users by role | Add/edit/deactivate user | Admin only |
| W11 | Shift & Roster Scheduler | Drag-and-drop weekly calendar per tanod | Assign shift, view coverage, view fatigue flags | Admin |
| W12 | Shift Swap Requests | List of pending/resolved swap requests | Approve/deny request | Admin |
| W13 | Fatigue Flags | List of tanods exceeding rolling 7-day hour threshold | Acknowledge flag, adjust schedule | Admin |
| W14 | SMS Activity Log | List of sent/received SMS with status | Filter by date/status, view for reliability audit | Admin |
| W15 | Settings / Account | System config, own account settings | Update profile, change password | All (own account only) |

## Mobile — Tanod Operations App

| # | Screen | Shows | Key actions | Roles |
|---|---|---|---|---|
| M1 | Login | Credentials | Sign in | Tanod |
| M2 | Home | Duty status, quick actions, active alerts, today's stats | Toggle duty status, quick emergency SOS | Tanod |
| M3 | Log New Incident | Form: type, location, description, evidence | Add photo, add voice note, submit (works offline) | Tanod |
| M4 | Incident Submitted Confirmation | Sync status (queued locally vs. synced to cloud) | View sync status | Tanod |
| M5 | Assignments List | Active dispatch assignments, priority-coded | Navigate, call dispatch, mark arrived | Tanod |
| M6 | Assignment Detail / Navigation | Route map, incident details for the assignment | Start navigation, update status | Tanod |
| M7 | Live Map | Own location, nearby active incidents | View map, recenter | Tanod |
| M8 | Shift Schedule | Upcoming assigned shifts | View schedule | Tanod |
| M9 | Shift Swap Request | Form to request swap/time-off | Submit request, view request status | Tanod |
| M10 | Profile | Own info, duty history stats | Edit limited profile fields | Tanod |
| M11 | Offline Indicator (persistent banner/badge) | Connection status, pending sync count | — (informational) | Tanod |
| M12 | Critical Alert Overlay (full-screen, triggers on priority SMS) | Emergency alert details | Acknowledge, navigate immediately | Tanod |
| M13 | SMS Fallback Confirmation (in-app toast/banner) | Confirms an action was sent via SMS instead of API | — (informational) | Tanod |

---

## Notes

- **W7/W8 split matters:** keep the raw redaction review (W8) as a distinct
  screen/panel from the general blotter detail view (W7) — this makes the
  human-in-the-loop approval step visually and functionally distinct, which
  is useful both for actual security (fewer accidental approvals) and for
  demonstrating the RA 10173 compliance mechanism clearly during your defense.
- **M11 and M13 aren't separate "pages"** in the navigation sense — they're
  persistent UI elements (banner/toast) that should appear across relevant
  screens, not screens you navigate to.
- **M12 (Critical Alert Overlay)** needs to be capable of rendering over the
  lock screen — flag this early to whoever builds the native Android
  permissions handling (Sprint 4).
