/**
 * Menu — an anchored dropdown panel (avatar menu, notification bell).
 *
 * Extracted from the pattern the topbar search results already proved out
 * in AppShell.js: an absolutely-positioned panel, dismissed by Escape or
 * an outside click, with roving arrow-key focus. That was hand-rolled
 * inline for one call site; two more needed it, so it lives here now
 * rather than being copied twice.
 *
 * Deliberately NOT a modal — `ConfirmDialog.js` is the modal, with a
 * backdrop and a focus trap. A menu is dismissible, non-blocking, and
 * must not trap focus, so the two stay separate components.
 *
 * The trigger and panel are wired together with `aria-haspopup`,
 * `aria-expanded` and `aria-controls`, and the panel is `role="menu"` with
 * `role="menuitem"` children, so a screen reader announces it as a menu
 * rather than a list of loose buttons.
 *
 * @param {{
 *   trigger: HTMLElement,
 *   label: string,
 *   align?: 'left'|'right',
 *   onOpen?: () => void,
 * }} props
 * @returns {{el: HTMLElement, panel: HTMLElement, open: () => void, close: () => void, isOpen: () => boolean}}
 *   `el` is the positioned wrapper — put THAT in the DOM, not the trigger.
 */

let menuSeq = 0;

export function Menu({ trigger, label, align = 'right', onOpen }) {
  const id = `menu-${++menuSeq}`;

  const el = document.createElement('div');
  el.className = 'menu';

  const panel = document.createElement('div');
  panel.className = 'menu__panel' + (align === 'left' ? ' menu__panel--left' : '');
  panel.id = id;
  panel.setAttribute('role', 'menu');
  panel.setAttribute('aria-label', label);
  panel.hidden = true;

  trigger.setAttribute('aria-haspopup', 'menu');
  trigger.setAttribute('aria-expanded', 'false');
  trigger.setAttribute('aria-controls', id);

  el.append(trigger, panel);

  function items() {
    return [...panel.querySelectorAll('[role="menuitem"]:not([disabled])')];
  }

  function open() {
    if (!panel.hidden) return;
    // Only one menu open at a time — opening this one closes any other.
    for (const other of document.querySelectorAll('.menu__panel:not([hidden])')) {
      if (other !== panel) other.dispatchEvent(new CustomEvent('menu:close'));
    }
    panel.hidden = false;
    trigger.setAttribute('aria-expanded', 'true');
    onOpen?.();
  }

  function close({ restoreFocus = false } = {}) {
    if (panel.hidden) return;
    panel.hidden = true;
    trigger.setAttribute('aria-expanded', 'false');
    if (restoreFocus) trigger.focus();
  }

  panel.addEventListener('menu:close', () => close());

  trigger.addEventListener('click', (event) => {
    event.stopPropagation();
    if (panel.hidden) open();
    else close();
  });

  // Down-arrow from the trigger moves into the panel, the standard
  // keyboard entry point for a menu button.
  trigger.addEventListener('keydown', (event) => {
    if (event.key === 'ArrowDown') {
      event.preventDefault();
      open();
      items()[0]?.focus();
    }
  });

  panel.addEventListener('keydown', (event) => {
    const list = items();
    const i = list.indexOf(document.activeElement);
    if (event.key === 'Escape') {
      event.preventDefault();
      close({ restoreFocus: true });
    } else if (event.key === 'ArrowDown') {
      event.preventDefault();
      list[(i + 1) % list.length]?.focus();
    } else if (event.key === 'ArrowUp') {
      event.preventDefault();
      list[(i - 1 + list.length) % list.length]?.focus();
    } else if (event.key === 'Tab') {
      // Tabbing out of a menu closes it rather than leaving an orphaned
      // panel open behind the user.
      close();
    }
  });

  // Outside click. Registered per-menu but removed when the wrapper leaves
  // the DOM — main.js rebuilds #app wholesale on every navigation, so a
  // listener that never unregistered would accumulate one per navigation
  // (the same trap AppShell.js's own module-scope search listener
  // documents).
  const onDocumentClick = (event) => {
    if (!el.isConnected) {
      document.removeEventListener('click', onDocumentClick);
      return;
    }
    if (!el.contains(event.target)) close();
  };
  document.addEventListener('click', onDocumentClick);

  return { el, panel, open, close, isOpen: () => !panel.hidden };
}

/**
 * A single row inside a Menu panel. Returns a real <button role="menuitem">
 * so it is focusable and announced correctly.
 *
 * @param {{label: string, icon?: (size:number)=>string, description?: string, onClick: () => void, danger?: boolean}} props
 */
export function MenuItem({ label, icon, description, onClick, danger = false }) {
  const item = document.createElement('button');
  item.type = 'button';
  item.className = 'menu__item' + (danger ? ' menu__item--danger' : '');
  item.setAttribute('role', 'menuitem');
  if (icon) {
    const iconSpan = document.createElement('span');
    iconSpan.className = 'menu__item-icon';
    iconSpan.setAttribute('aria-hidden', 'true');
    iconSpan.innerHTML = icon(16);
    item.appendChild(iconSpan);
  }
  const text = document.createElement('span');
  text.className = 'menu__item-text';
  const labelEl = document.createElement('span');
  labelEl.textContent = label;
  text.appendChild(labelEl);
  if (description) {
    const descEl = document.createElement('span');
    descEl.className = 'menu__item-description';
    descEl.textContent = description;
    text.appendChild(descEl);
  }
  item.appendChild(text);
  item.addEventListener('click', onClick);
  return item;
}
