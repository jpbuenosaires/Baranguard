# Shared UI components

Import from `components/ui` (`import { Button, Banner } from '../components/ui'`). All CSS lives in `theme/ui.css` (class prefix `ui-`), tokens only, no hex.

## When to use which

| Component | Use for |
|---|---|
| `Button` | Every action. `primary` = the one main action on the screen, `secondary` = alternatives, `danger` = destructive or SOS-adjacent, `ghost` = low-emphasis. `size="lg"` for the primary action of a form or a field-use screen. |
| `Card` | A grouped block of content, optional header (title, subtitle, action). |
| `Chip` | Short status or filter. No `onClick` = a read-only span. With `onClick` = a toggle button (`aria-pressed`). |
| `Banner` | Inline message for a screen or section. `error` is `role="alert"`; the rest are `role="status"`. |
| `EmptyState` | A loaded list with nothing in it. |
| `ErrorState` | A failed load. It always has a retry button. |
| `SheetModal` | Forms and pickers in a bottom sheet. Pass `busy` while a request runs. |
| `SyncLabel` | The ONLY wording for sync state. |

## Rules

1. Every interactive part is at least 48x48 CSS px with at least 8px between neighbours. Chips are visually small but keep a 48px hit area.
2. Tone meaning: `info` = neutral news, `success` = confirmed done, `warning` = needs attention soon, `error`/`critical` = failed or unsafe. Do not use `danger` for a merely important action.
3. Never rely on colour alone. Every status has an icon and text.
4. Keep labels. A disabled or loading button keeps its label; explain why in a Banner or helper text, do not swap the label.
5. Never show "Sent" until the server has confirmed. Use `saved_on_phone` for anything only in local SQLite (Rule 7).
6. `SheetModal` with `busy` blocks swipe, backdrop and the close button, so a half-finished request cannot be abandoned mid-flight.
7. Honour reduced motion: do not add animation outside `ui.css`'s guarded rules.

## Migration checklist (later phases, one screen at a time)

- Replace inline-styled banners and `.wf-banner` markup with `Banner` (`critical` becomes `error`).
- Replace one-off button classes (`.xyz-btn`, `IonButton` with custom styles) with `Button`; keep the existing handlers.
- Replace hand-rolled `.status-pill` markup for sync state with `SyncLabel`; map your state to the five states.
- Replace "No items" divs with `EmptyState` and load-failure text with `ErrorState` (supply `onRetry`).
- Replace screen-specific modals with `SheetModal`; pass `busy` from the submit state.
- Delete the old CSS only after the last caller is gone.
