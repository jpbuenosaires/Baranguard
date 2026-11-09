---
version: 1
slug: "mobile-src"
primary_target: "mobile/src"
related_targets: []
---

# Tanod mobile app (mobile/src)

Scope: every Tanod screen of the Capacitor app, plus login. Mode: Operate. Platform: android (Material 3 structure and controls).
Audience and job: tanods on budget Android phones, outdoors day and night, acting on a call in seconds (PRODUCT.md).
Constraints: no behaviour, route, field or state change; Silent SOS default; EN/Filipino toggle to add; UAT ran on the old look (note as post-UAT change).
Before evidence: docs/ui-review-2026-11-05/before/ (defects: floating SOS covers controls, tel rows dial on a stray tap, My Shifts mis-titled, privacy says 90 days, role label mismatch, map chip overlaps, inconsistent headers).

## Direction contract

THESIS: The app wears the tanod uniform. A navy shell with one retroreflective band whose only job is duty state: lit silver when on duty and sharing GPS, dull when off. Refuses the grey-card-plus-one-blue-accent utility app.

OWN-WORLD: Navy vest cloth (#0f1f3d family) owns the top app bar and navigation bar; light cool ground for work areas; silver reflective band (gradient sheen) under the top bar; safety yellow (#ffd23f) for the TANOD print: selected nav indicator, active-call edge, avatar; red (#d7263d) only for SOS and critical. Roboto Flex via Material type roles, sp units. Material 3 components only.

STORY: The tanod sees at once whether they are on duty, what call is active, and how to respond; SOS is always one deliberate action away and never covers anything.

FIRST VIEWPORT: Home: navy top bar; reflective duty band (state, GPS, elapsed); active-call card with yellow edge, incident code, type, place, distance, filled Respond button; duty card; Report and SOS side by side above the navy navigation bar. Other tabs: SOS lives in the top app bar as an action, not floating.

FORM: Tanod Reflective Vest, my top-ranked grounded candidate (rank 1 of 7), chosen by the user over the rolled Jeepney Route Board. seed: none (unavailable)

FINISH: unreviewed and undocumented is unfinished; this build ends with the finish review, the verdict, DESIGN.md, and every shipping raster carrying its provenance

Status 2026-11-05: redesign cancelled by the owner; UI/UX fixes on the current look only. This contract is not in use.
