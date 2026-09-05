/**
 * Tooltip.js — `InfoTip(text)`, a small hover/focus-revealed info card for
 * annotating a KPI figure or a chart/panel header with what it actually
 * means (2026-09-05, dashboard UX pass — user asked for "hovering to
 * certain data... will show a small card").
 *
 * Deliberately CSS-driven, not JS-positioned: the panel is an absolutely
 * positioned child of an `inline-flex; position:relative` wrapper, shown
 * via `:hover`/`:focus-within` in Tooltip.css — no coordinate math, no
 * viewport-edge collision handling to get wrong, and it never fights
 * `.card`'s own overflow (which is visible, not hidden). `Menu.js`'s
 * anchored-dropdown pattern was considered and rejected here: that one
 * exists because a topbar trigger's panel must escape a `position:sticky`
 * ancestor and reach arbitrary screen positions (avatar menu, notification
 * bell) — a KPI card's tooltip only ever needs to sit right below its own
 * trigger, which plain CSS already does for free.
 *
 * Accessible per the WAI-ARIA tooltip pattern: the trigger is a real
 * `<button>` (keyboard-focusable, gets `:focus-within` for free) with
 * `aria-describedby` pointing at the panel's `id`; the panel carries
 * `role="tooltip"`. Content stays in the accessibility tree at all times
 * (hidden via `opacity`/`visibility`, never `display:none` or the
 * `hidden` attribute), so a screen reader announces it the same way
 * regardless of the CSS hover/focus state.
 *
 * PascalCase per §4 component-file convention. Plain DOM-returning
 * function, no framework, matching every other component in this app.
 */

let tipCounter = 0;

/** @param {string} text @returns {HTMLElement} */
export function InfoTip(text) {
  const id = `info-tip-${++tipCounter}`;

  const wrap = document.createElement('span');
  wrap.className = 'info-tip';

  const trigger = document.createElement('button');
  trigger.type = 'button';
  trigger.className = 'info-tip__trigger';
  trigger.textContent = 'i';
  trigger.setAttribute('aria-describedby', id);
  trigger.setAttribute('aria-label', 'What does this mean?');
  // A tooltip trigger informs, it doesn't act — no click handler, so
  // Enter/Space do nothing surprising; :focus-within is what reveals it.
  trigger.addEventListener('click', (event) => event.preventDefault());

  const panel = document.createElement('span');
  panel.className = 'info-tip__panel';
  panel.id = id;
  panel.setAttribute('role', 'tooltip');
  panel.textContent = text;

  wrap.append(trigger, panel);
  return wrap;
}
