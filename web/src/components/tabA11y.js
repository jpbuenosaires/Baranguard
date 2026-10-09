/**
 * tabA11y.js — tab semantics for every `.page-tabs` bar, applied centrally
 * (audit 2026-10-09 X-11/D-18). Analytics, Personnel, SMS Monitor and the
 * tanod-workflow pages each hand-build the shared `.page-tabs > .page-tab`
 * DOM and mark the active tab with the `.is-active` class only, so a screen
 * reader could not tell which tab was selected and there was no arrow-key
 * movement. Rather than edit four page files, this watches the DOM:
 *
 *   - `.page-tabs` gets role="tablist" (unless it already has a role);
 *   - each `.page-tab` gets role="tab" and aria-selected that follows its
 *     `.is-active` class (kept in sync as pages toggle it), plus a roving
 *     tabindex (only the selected tab is in the Tab order);
 *   - Left/Right/Home/End move between tabs and activate the focused tab
 *     (automatic activation, the WAI-ARIA default for cheap tab switches);
 *   - aria-controls is set to the page's <main> (#page-main) when the page
 *     gave none — the panel the tab actually changes.
 */

let started = false;

function syncTab(tab) {
  if (!tab.hasAttribute('role')) tab.setAttribute('role', 'tab');
  if (tab.getAttribute('role') !== 'tab') return;
  const selected = tab.classList.contains('is-active') || tab.getAttribute('aria-current') === 'page';
  if (tab.getAttribute('aria-selected') !== String(selected)) tab.setAttribute('aria-selected', String(selected));
  const wanted = selected ? '0' : '-1';
  if (tab.getAttribute('tabindex') !== wanted) tab.setAttribute('tabindex', wanted);
  if (!tab.hasAttribute('aria-controls') && document.getElementById('page-main')) {
    tab.setAttribute('aria-controls', 'page-main');
  }
}

function syncList(list) {
  if (!list.hasAttribute('role')) list.setAttribute('role', 'tablist');
  const tabs = [...list.querySelectorAll('.page-tab')];
  tabs.forEach(syncTab);
  // No tab marked active yet: keep the first reachable by keyboard.
  if (tabs.length && !tabs.some((t) => t.getAttribute('tabindex') === '0')) tabs[0].setAttribute('tabindex', '0');
  // X-19: the browser tab title names the selected tab too, so switching
  // tabs on Personnel / Analytics / Safer School Zones is reflected there.
  const selected = tabs.find((t) => t.getAttribute('aria-selected') === 'true');
  const heading = document.querySelector('.page-header__title');
  if (selected && heading && heading.isConnected) {
    const label = [...selected.childNodes].filter((n) => n.nodeType === 3 || !n.matches?.('.page-tab__badge')).map((n) => n.textContent).join('').replace(/\s+/g, ' ').trim();
    const page = heading.textContent.replace(/\s+/g, ' ').trim();
    if (label && page) document.title = label.toLowerCase() === page.toLowerCase() ? `${page} — Baranguard` : `${page}: ${label} — Baranguard`;
  }
}

function onKeydown(event) {
  const tab = event.target instanceof Element ? event.target.closest('.page-tab[role="tab"]') : null;
  if (!tab) return;
  const list = tab.closest('.page-tabs');
  if (!list) return;
  const tabs = [...list.querySelectorAll('.page-tab[role="tab"]')].filter((t) => !t.disabled && !t.hidden);
  const i = tabs.indexOf(tab);
  let next = null;
  if (event.key === 'ArrowRight') next = tabs[(i + 1) % tabs.length];
  else if (event.key === 'ArrowLeft') next = tabs[(i - 1 + tabs.length) % tabs.length];
  else if (event.key === 'Home') next = tabs[0];
  else if (event.key === 'End') next = tabs[tabs.length - 1];
  if (!next) return;
  event.preventDefault();
  next.focus();
  next.click();
}

/** Idempotent; also enhances any tab bars already in the document. */
export function startTabA11y() {
  if (started || typeof document === 'undefined' || typeof MutationObserver === 'undefined') return;
  started = true;
  const observer = new MutationObserver((records) => {
    const lists = new Set();
    for (const record of records) {
      const target = record.target;
      if (record.type === 'attributes') {
        if (target.classList?.contains('page-tab')) {
          const list = target.closest('.page-tabs');
          if (list) lists.add(list);
        }
        continue;
      }
      for (const node of record.addedNodes) {
        if (node.nodeType !== 1) continue;
        if (node.matches('.page-tabs')) lists.add(node);
        else if (node.matches('.page-tab')) { const l = node.closest('.page-tabs'); if (l) lists.add(l); }
        else node.querySelectorAll?.('.page-tabs').forEach((l) => lists.add(l));
      }
    }
    lists.forEach(syncList);
  });
  // attributeFilter limits the attribute traffic to class/aria-current flips.
  observer.observe(document.body, { childList: true, subtree: true, attributes: true, attributeFilter: ['class', 'aria-current'] });
  document.addEventListener('keydown', onKeydown);
  document.querySelectorAll('.page-tabs').forEach(syncList);
}
