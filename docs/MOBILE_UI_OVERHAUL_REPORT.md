# Mobile UI/UX overhaul: final report (2026-10-15)

Branch `mobile-ui-overhaul` (not pushed). Commits: `e2e62b3` Phase 1, `b8c8faf` Phase 2, `59b8e2f` Phase 3, `3115f63` Phase 4, `e80b498` Phase 5, `9b76c5d` Phase 6. Tag `pre-mobile-overhaul` marks the start.

**Read this first: what was and was not tested.**

| Kind | What it covers |
|---|---|
| Automated | tsc, eslint, vitest (jsdom), contrast, touch-target and local-schema scripts, `vite build`, a dead-CSS static scan |
| Manual inspection | Login screen only, in the browser pane at 768x1024 and 812x375. The web build cannot open the encrypted local database, so no logged-in screen renders there |
| Device | **None this session's final pass.** No phone was connected over adb when Phase 7 ran. Phase 1 had one Home screenshot on the Infinix X6840 (light mode, SOS dock). Nothing else in this report has been seen on a device |

## Changes per option

| Phase | Option | Change |
|---|---|---|
| 1 | Safety and honesty | Pinned 56px SOS dock; hardcoded desk numbers removed (tile uses the cached SOS backup number, hidden when none); incident draft autosave (schema v9); dispatch screens no longer claim states they have not reached; hardware-back handling; Chief Tanod SOS badge; Resolve offered only after Acknowledge; push-tap routing |
| 2 | Contrast, tokens, components | Darker status fills with on-fill text tokens, link and placeholder tokens, global focus ring, reduced-motion; font sizes 50 to 25 distinct, radii 33 to 12, hex colours 95 to 7; shared `ui/` components; viewport allows zoom |
| 3 | Touch, states, wording | 48dp targets enforced by a script; about 16 empty and error states and 14 banners on shared components; one sync wording; sync queue sheet rewritten |
| 4 | Screens | Home in priority order with one status card; report form with required fields first and optional detail collapsed; consistent workflow forms with inline validation; dispatch detail leads with one next-step card and collapsible sections; live map polling pauses off-screen, shows data freshness and basemap, thins labels, reuses markers; Chief Tanod console with danger-styled cancel, search and filters, honest SOS location source |
| 5 | Layout and performance | Route-level code splitting; `dvh` units; safe-area on left and right; keyboard `adjustResize` in the manifest; blur removed from sticky and moving surfaces; background polling pauses when the app is hidden; Home uses a COUNT query instead of loading every incident |
| 6 | Cleanup | 334 dead selectors removed (CSS 248 KB to 195 KB); `phase*` stylesheets merged into `screens-base`, `screens`, `layout`, `x-*`; 8 files over 600 lines split (largest: `live-map` 1318 to 344, `assignment-detail` 944 to 486); about 150 static inline styles moved to classes |

## Before and after (measured)

- Entry JavaScript chunk: 2,824 KB to 328 KB (the map library now loads only on the map screen). A shared 1,220 KB chunk (`MobileHeader-*`) still loads at start; I did not find out why it is that large. **Cold-start time was not measured** (no device).
- Vitest: 73 to 159 tests. Contrast: 184/184. Touch targets: 0 violations. Local schema: 259/0.
- Files over 600 lines: 8 to 1 (`home.tsx`, 613).

## Decluttering rationale

Home answers "am I on duty and is anything active" first; SOS and Report stay one tap away in a pinned dock. The report form shows only type, location and description before optional detail. Dispatch detail shows the single next action first and tucks evidence, referral and route into collapsible sections that stay mounted so a recording or half-filled form is never lost.

## Accessibility checks

Automated only: contrast on the token pairs (184), 48dp touch targets by script, focus ring and reduced-motion in CSS, `aria-describedby` on inline errors. No screen reader, TalkBack or colour-blind pass was done.

## Regression tests

159 vitest tests (new helpers for dispatch list and next step, map policy, map HUD, polling, workflow forms, admin formatting, visible-only interval, sync queue summary, shifts page).

## Build, lint, test results (final run)

tsc clean; eslint 0 problems; vitest 159/159; contrast 184/184; touch 0; schema 259/0; `vite build` succeeds.

## Known limitations and risks

- **No device verification of Phases 4 to 6.** Layout of collapsed sections, landscape, dark mode, the map overlay chips against the drawer, and the nested-card override on the report form are unseen.
- **Dead-CSS removal is a static scan**, conservative (it keeps anything a source file mentions or a dynamic prefix could build), not a runtime check. A class built in an unusual way could have been dropped; `tab-selected` (added by Ionic) is explicitly kept. Look for unstyled elements on first device run.
- The split of large files was done by agents as behaviour-preserving moves; tests pass but screens were not exercised.
- Small visual deltas: some buttons grew from 44-46px to 48px; two checkboxes on the map filter rely on their 48dp label row and are exempted in the touch script.
- The Chief Tanod assign picker cannot show tanod availability: `/availability` is outside the Admin device allowlist.
- `assignment-detail.tsx` comments and some note strings contain garbled characters that predate this work.
- Dispatch SMS and push still include coordinates (open owner decision).
- The Android manifest change (`adjustResize`) needs a native rebuild to take effect.
- Dev server on 5173 and live reload on the phone are not set up now; the normal bundled build still needs to be rebuilt and installed.
