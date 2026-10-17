# Font audit and cleanup plan (2026-10-17)

Audit only. **No code has been changed.** Counts are from `grep` over `web/css`, `web/src`, `mobile/src`.

## 1. What is in use today

### Typefaces
| Typeface | Where | Notes |
|---|---|---|
| **Inter** (self-hosted woff2) | everything, via `--font-base` | 5 files: 400, 500, 600, 700, 800. Fallback stack: system-ui, Segoe UI, Roboto, Helvetica Neue, Arial. Same on mobile. |
| **Monospace stack** (`--font-mono`) | IDs, codes, clock, coordinates, hashes, JSON | Not a loaded font: SFMono, JetBrains Mono, Cascadia Mono, Consolas, Liberation Mono, Menlo. Which one shows depends on the PC, so the same screen looks different on each machine. This is the "INC-2026-159" look you want gone. |
| 3 stray stacks | `font-family: monospace`, `ui-monospace, SFMono-Regular, Menlo, monospace`, two inline `style="font-family:monospace"` | Bypass the token. |
| `font-family: inherit` | 22 places (form controls) | Fine, resolves to Inter. |

Already clean: the old Georgia serif in Tooltip was removed (D-21).

### Monospace usage on web (about 40 selectors in 21 files)
- **Incident / record codes (the "INC" look):** `.incident-id-badge` (dashboard, incident detail), `.page-header__id-pill`, `.citizen-id-badge`, `.citizen-linked-inc-badge`, `.ref-incident-id`, `.ref-incident-cell`, `.ref-no-cell`, `.ref-code-badge`, `.ref-log-sub`, `.c1-inc-code-pill`, `.d-report-id-pill`, `.appr-row__code`, `.sms-detail-code`, `.dispatch-map-drawer__code`, `.notification-card__code`, `.settings-user-id-chip`, `.user-identity-username`; inline in `incident-management.js:216` (handover print table) and the `font-mono` class on `incident-detail.js:242`, `swap-requests.js:227`.
- **Clock and key hints:** `.topbar__clock-digits`, `.topbar__search-kbd`, `.incident-kbd`.
- **Timeline / numbers:** `.timeline__delta`, `.timeline__value`, `.timeline__label--pending`, `.week-grid__hours`, `.citizen-location-coords`, `.citizen-location-badge--none`.
- **Genuine code-like content:** `.audit-json-viewer`, `.health-modal-runbook`, `.health-modal-code`, `.health-modal-val`, `.health-service-card__probe`, `.evidence-hash-badge`.
- **Privacy page chips:** `.privacy-toc__meta-tag`, `.privacy-meta-item`, `.privacy-meta-pill`, `.retention-pill`.
- Mobile: 10 declarations (e.g. `.report-blotter-code`, `.receipt-coords`).

### Sizes (too many)
- 9 tokens exist (`--font-size-label` 12, sm 14, md 16, lg 18, xl 20, 2xl 24, 3xl 30, plus the `--type-*` ones).
- But **28 different literal sizes** are also hardcoded. Top ones: 0.75rem (74), 0.6875rem (67), 0.8125rem (61), 0.875rem (16), 0.9375rem (12). The long tail is near-duplicates: 0.84375, 0.8, 0.78125, 0.775, 0.78 (all about 13px); 0.72, 0.725, 0.7, 0.68 (all about 11px); 1.05, 1.0625, 1.1, 1.15 (all about 17-18px); 1.35, 1.375, 1.4 (all about 22px); 1.625, 1.75.
- Token use: `--font-size-sm` 204, `-xs` 92, `-label` 75, `-md` 32, then single digits.

### Weights
700 (231), 600 (219), 500 (75), 800 (24), 400 (13). Five weights, and 600 vs 700 is hard to tell apart in Inter at small sizes.

## 2. Plan

**Target: one typeface (Inter), 4 weights, 8 sizes, no monospace.**

1. **Kill monospace (quick, reversible).** Set `--font-mono: var(--font-base)` and make `.font-mono` a no-op. Every INC code, clock and ID switches to Inter at once. Add `font-variant-numeric: tabular-nums` to the clock and tables so digits still line up. This is one edit, with no per-selector work.
2. **Delete the dead declarations.** Remove the ~40 `font-family: var(--font-mono…)` lines, the 3 stray stacks, the two inline styles and the `--font-mono` token itself, so it cannot come back. Same on mobile (10).
3. **Collapse sizes to 8 tokens:** 11, 12, 13, 14, 16, 18, 20, 24, plus 30 for KPI numbers only. Map every literal to the nearest: 0.68-0.72 to 11; 0.75 to 12; 0.775-0.84 to 13; 0.85-0.9375 to 14; 1.05-1.15 to 18; 1.35-1.4 to 20; 1.625-1.75 to 24. Replace literals with tokens.
4. **Weights to 400 / 500 / 600 / 700.** 800 maps to 700, and the `inter-latin-800.woff2` file is deleted (smaller download).
5. **Guard so it stays clean.** Add a check to `verify-web-wiring.mjs` that fails on any `font-family` other than `var(--font-base)` or `inherit`, any non-token `font-size`, and any weight outside the four.
6. **Verify.** Wiring script, `web/tests`, then screenshots of Dashboard, Incident Management, Incident Detail, Dispatch Center, Audit Log, Service Health and the mobile Home and Incident screens.

## 3. Decisions needed before I touch anything
1. **Keep monospace for true code only?** Three places genuinely read better in mono: the Audit JSON viewer, the Service Health runbook box and the evidence hash. Recommended: remove everywhere except those three, using one `.code-block` class. Alternative: remove everywhere with no exceptions.
2. **Weights:** drop 800 only (recommended), or go down to three weights (400/600/700) by turning all 500s into 400 or 600.
3. **Sizes:** the 11px size is used 67 times (badges, captions) and is small. Keep it, or lift it to 12px (cleaner, but things get slightly bigger)?
4. **Scope:** web and mobile together (recommended), or web first?

## 4. Risk
Replacing about 120 literal sizes and removing mono can shift layout in tight spots (badges, table cells, the topbar clock). That is why step 6 has screenshots, and why steps 1 and 3 can be done and checked separately.

## 5. Status
Applied to **web** on 2026-10-17 (mobile not done). Decisions taken: monospace kept only for the audit JSON viewer, runbook box and evidence hash; weight 800 dropped (file deleted); 11px raised to 12px. Guard: `verify-web-wiring.mjs` check 2b.
