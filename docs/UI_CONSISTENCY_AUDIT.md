# UI consistency audit, web dashboard (2026-10-17)

Method: every screen and tab was opened in headless Chrome at 1440 x 900 as the Admin on the demo database (22 views), screenshotted, and the buttons, inputs and chips in the top 300 px of each page were measured. Nothing was changed. "Fix" is a recommendation. Items are ordered by how visible they are.

## A. Primary and secondary buttons

| # | Inconsistency | Where | Recommended fix |
|---|---|---|---|
| A1 | Three looks for the main action: flat blue `#1d4ed8` (New Incident, Fit All), dark navy **gradient** (Add User, Add school, Broadcast Alert, Approve all, Save), and a white pill on red (Dashboard "Dispatch Now"). | Incident Management, Personnel, Safer School Zones, SMS Monitor, Swap requests, Dashboard | One `.btn-primary` token: flat blue, white text. Remove the gradient. Keep white-on-red only inside the red alert banner. |
| A2 | Corner radius differs: pill (9999) on Incident Management and Shift Handover, 12 px on Dashboard Refresh, 10 px on Live Map, 8 px on tab chips, 6 px on Live Map list chips. | all | One radius for buttons (8 px) and one for chips (pill). Define `--radius-button` and `--radius-chip`. |
| A3 | Heights differ: 40 px most, **48 px** for Fit All on Live Map, 29 to 30 px for chips, 26 px icon buttons in Dispatch. | Live Map, Dispatch Center | Control heights: 40 px buttons, 32 px chips, 32 px icon-only. |
| A4 | **Fit All and Full Screen swap roles** between the two map screens. Dispatch Center: Fit All is white, Full Screen is blue icon-only. Live Map: Fit All is blue with a label, Full Screen is white with a label. | Dispatch Center vs Live Map | One map toolbar component with the same order (Labels, Fit All, Full Screen) and the same style. The map-specific toggle may be primary, not these. |
| A5 | Icon-only versus labelled: Live Map has icon-only layers and zoom buttons next to labelled ones; Dispatch Center has icon-only GIS Console and Full Screen. | map toolbars | Labelled for actions, icon-only (with tooltip) only for zoom and layers. |
| A6 | Wording and case: "Preview & Print" (Analytics, Scheduler), "Preview & print Annex B", "Preview & Print Excerpt" (Audit), "Shift Handover / Export" (Incident). | print buttons | Always "Print preview"; export always "Export CSV" or "Export PDF". |

## B. Where things sit on the page

| # | Inconsistency | Where | Fix |
|---|---|---|---|
| B1 | Header actions are top right on most pages, but **missing** on Approvals, Referral Log and Accomplishment Reports (printing is per row or absent). | those three | Give every record page a header slot: Print / Export on the right, primary action last. |
| B2 | Summary numbers appear in four places: header KPI box (Dispatch Center, Live Map, SMS Monitor), cards under the header (Dashboard, Analytics, Service Health, Map Packages), tab-style tiles (Approvals), tile row inside the card (Referral Log). | all | Pick two: a header strip for live counts, cards under the header for reports. Use the same component. |
| B3 | Search box position and width vary: full width (Incident Management), half (Users), about 380 px (Accomplishment), 190 px inside the map header (Dispatch, Live Map), before the filters (Swap requests) or after the tabs (Audit). | all | One toolbar row: search on the left at a fixed minimum width, filters to the right, "Clear filters" last. |
| B4 | Filters wrap to a second line on Referral Log (Sort, Desc, Clear filters) and Safer School Zones C-1, but sit in one line elsewhere. Sort control exists only on Approvals and Referral Log. | Referral Log, C-1, Approvals | Same toolbar on every table page; add Sort everywhere or nowhere. |
| B5 | Page title: icon tile + title on most pages, **no tile and a smaller title** on SMS Monitor, a "Brgy. Dao" chip next to the Dashboard title only. SMS Monitor also starts 10 px further left. | SMS Monitor, Dashboard | Same header component for every page (tile, title, subtitle). Barangay chip stays in the top bar. |
| B6 | The floating **"?" help button overlaps "Next"** in the table pagination on Incident Management. | Incident Management (and other tables at the bottom right) | Keep the help button outside the pagination row or lift it above it. |
| B7 | The top-bar search shrinks page by page: "Sea", "Search incidents or jump to s", "Search" because the clock and duty text change width. The clock is cut off ("59:30 PM Manila") on Accomplishment Reports. | all pages | Give the clock a fixed width and let only the search flex, with a minimum width. |

## C. Tabs, chips and filters

| # | Inconsistency | Where | Fix |
|---|---|---|---|
| C1 | Page tabs come in four styles: outlined box with icons (Safer School Zones, Personnel, SMS Monitor), **no icons** (Analytics), full-width tiles with underline (Approvals), grouped pill (Live Map list). | those screens | One `.page-tab` (icons optional but consistent). Approvals can stay tiles because they are counts, but should not look like tabs elsewhere. |
| C2 | Filter chips come in at least six styles and heights: pill 40 px with outlined selected (Incident Management), 29 px rounded 8 (Dispatch category), grouped pill with coloured counts (Live Map), 30 px filled blue (Users, Audit, SMS log, Swap requests), pill filled blue (Heatmap category, C-1 escalation, SMS All/Inbox/Sent), outline with no selected state (Scheduler counts). | many | One `.filter-chip` (already in `base.css`): 32 px, pill, selected = filled blue, count badge. Replace the local variants. |
| C3 | Selected state differs: outline blue (Incident Management "All") versus filled blue elsewhere. | Incident Management | Filled blue everywhere. |
| C4 | Date controls: native `mm/dd/yyyy` inputs (Referral Log, C-1), a native month input showing dashes (Accomplishment), a "Last 30 days" select (Analytics), "Last 7 days" (Audit), "All Dates" (Incident), a custom navigator (Scheduler). | those screens | Use the shared `DateRangePicker` with presets on all of them. |
| C5 | "Reset filters" (Incident Management) versus "Clear filters" (elsewhere), in different positions. | tables | "Clear filters", always last in the toolbar. |

## D. Badges, tables and banners

| # | Inconsistency | Where | Fix |
|---|---|---|---|
| D1 | Badge case: uppercase (ACTIVE, TANOD, PREPARED, OPEN) on Personnel and Accomplishment Reports, sentence case (Resolved, Medium, Walk-in) on Incident Management and Referral Log. | tables | One status pill, sentence case (or all uppercase, but one rule). |
| D2 | Row actions: eye icon only (Incident Management), "View case →" (Referral Log), print icon plus "Review →" (Accomplishment), "Suspend" and "Deactivate" text buttons (Users), "Edit" plus a menu icon (Schools). | tables | One row-action pattern: a text "View" or "Review" as the main action, a kebab menu for the rest, icon-only always with a tooltip. |
| D3 | Info banners in four styles: blue with dismiss X (C-1), blue with no dismiss (Heatmap), blue with left bar and a chip (Map Packages), blue boxed with bold lead-in (SMS advisory), red full-width (Service Health). | several | One `Banner` component with `info`, `warning`, `danger` variants. |
| D4 | Subtitles: some end with a period, some use an em dash ("Monthly reports by Barangay Tanods — review, print for signing on paper or return"). | page headers | Plain sentence, no dash, no period. |

## E. Suggested order of work

1. Tokens first: `--radius-button`, `--radius-chip`, control heights, one primary colour (A1 to A3, C3). This fixes most of what you see at once.
2. Shared components: map toolbar (A4, A5), toolbar row (B3, B4, C5), chip (C2), date range (C4), banner (D3).
3. Page header and the "?" overlap and top-bar search (B1, B5, B6, B7).
4. Row actions, badge case, wording (A6, D1, D2, D4).

Not verified: dark theme, screens narrower than 1440 px, the Annex C-1 and Annex D tables, and the Tanod mobile app.
