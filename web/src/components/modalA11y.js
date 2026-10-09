/**
 * modalA11y.js — one shared dialog contract for every modal in the app,
 * applied without editing the pages that build them (audit 2026-10-09
 * X-10/D-19: nine of ten modals lacked a focus trap, Escape or focus return;
 * only ConfirmDialog had the full contract).
 *
 * Started once (AppShell calls startModalA11y()). A MutationObserver on
 * <body> notices a modal being added and:
 *   - gives the dialog element role="dialog" and aria-modal="true" if absent;
 *   - names it with aria-labelledby -> its first heading/title, if unnamed;
 *   - moves focus into it (first form control, else first focusable) unless
 *     the page already did;
 *   - traps Tab / Shift+Tab inside it while it is the topmost modal;
 *   - on Escape, clicks the dialog's own close/cancel control — but only if
 *     the page's own Escape handling did not already close it;
 *   - when the modal leaves the DOM, returns focus to the element that was
 *     focused before it opened (if focus was dropped to <body>).
 *
 * ConfirmDialog (`.confirm-backdrop`) already implements all of this and is
 * left alone; while one is open, this module stands aside entirely. Anything
 * carrying `data-modal-a11y="self"` is likewise skipped.
 *
 * Limitation: modals that are hidden with CSS and re-shown (instead of being
 * removed and re-added) get the trap only while visible and no focus return.
 */

/** Overlay roots, by the classes the page stylesheets actually use (D-16/D-19). */
export const MODAL_ROOT_SELECTOR = [
  '.modal-backdrop',
  '.audit-modal-backdrop',
  '.health-modal-backdrop',
  '.incident-modal-overlay',
  '.personnel-modal-overlay',
  '.print-modal-backdrop',
  '.sms-modal-overlay',
  '[role="dialog"][aria-modal="true"]',
  '[role="alertdialog"]',
].join(', ');

const DIALOG_CARD_SELECTOR = [
  '[role="dialog"]', '[role="alertdialog"]',
  '.modal-card', '.audit-modal-card', '.health-modal-card', '.incident-modal-box',
  '.personnel-modal', '.print-modal', '.sms-modal',
].join(', ');

const FOCUSABLE = 'a[href], button:not([disabled]), input:not([disabled]):not([type="hidden"]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])';

const CLOSE_SELECTOR = [
  '[data-modal-close]',
  '[aria-label^="Close" i]',
  '[class*="__close"]', '[class*="-close"]',
].join(', ');

let started = false;
let seq = 0;
let lastOutsideFocus = null;
/** Managed modals, oldest first: { root, dialog, returnTo } */
const stack = [];

function isSelfManaged(el) {
  return Boolean(el.closest('.confirm-backdrop, [data-modal-a11y="self"]'));
}

function isVisible(el) {
  if (!el.isConnected || el.hidden) return false;
  const style = el.ownerDocument.defaultView.getComputedStyle(el);
  return style.display !== 'none' && style.visibility !== 'hidden';
}

function focusablesIn(dialog) {
  return [...dialog.querySelectorAll(FOCUSABLE)].filter((el) => !el.hidden && !el.closest('[hidden]'));
}

function topmost() {
  for (let i = stack.length - 1; i >= 0; i -= 1) {
    if (stack[i].root.isConnected && isVisible(stack[i].root)) return stack[i];
  }
  return null;
}

function findCloseControl(dialog) {
  const explicit = [...dialog.querySelectorAll(CLOSE_SELECTOR)].find((el) => el.matches('button, a, [role="button"]') && !el.disabled);
  if (explicit) return explicit;
  return [...dialog.querySelectorAll('button')].find((b) => !b.disabled && /^(close|cancel|dismiss|keep editing)$/i.test((b.textContent || '').trim())) || null;
}

function enhance(root) {
  if (stack.some((m) => m.root === root)) return;
  if (isSelfManaged(root)) return;
  const dialog = root.matches('[role="dialog"], [role="alertdialog"]')
    ? root
    : (root.querySelector(DIALOG_CARD_SELECTOR) || root);
  if (isSelfManaged(dialog)) return;

  if (!dialog.hasAttribute('role')) dialog.setAttribute('role', 'dialog');
  if (!dialog.hasAttribute('aria-modal')) dialog.setAttribute('aria-modal', 'true');
  if (!dialog.hasAttribute('aria-labelledby') && !dialog.hasAttribute('aria-label')) {
    const heading = dialog.querySelector('h1, h2, h3, h4, h5, h6, [class*="title"]');
    if (heading) {
      if (!heading.id) heading.id = `modal-a11y-title-${++seq}`;
      dialog.setAttribute('aria-labelledby', heading.id);
    }
  }

  // The element focused before the modal opened. The observer runs after
  // insertion, and a page may already have moved focus inside, so the
  // tracked last-outside focus is the reliable source.
  const active = document.activeElement;
  const returnTo = active && active !== document.body && !root.contains(active) ? active : lastOutsideFocus;
  stack.push({ root, dialog, returnTo });

  if (!root.contains(document.activeElement)) {
    const controls = focusablesIn(dialog);
    const target = dialog.querySelector('[autofocus]')
      || controls.find((el) => el.matches('input, select, textarea'))
      || controls[0];
    if (target) target.focus();
    else {
      if (!dialog.hasAttribute('tabindex')) dialog.setAttribute('tabindex', '-1');
      dialog.focus();
    }
  }
}

function handleRemovals() {
  for (let i = stack.length - 1; i >= 0; i -= 1) {
    const modal = stack[i];
    if (modal.root.isConnected) continue;
    stack.splice(i, 1);
    const active = document.activeElement;
    const focusDropped = !active || active === document.body || !active.isConnected;
    if (focusDropped && modal.returnTo && modal.returnTo.isConnected) modal.returnTo.focus();
  }
}

function scan(node) {
  if (node.nodeType !== 1) return;
  if (node.matches(MODAL_ROOT_SELECTOR)) enhance(node);
  else for (const found of node.querySelectorAll(MODAL_ROOT_SELECTOR)) enhance(found);
}

// Snapshot at the very start of a keydown (window capture runs before any
// document-level handler): was a ConfirmDialog open, and which modal is on top.
let keydownSnapshot = null;
function onKeydownCapture(event) {
  keydownSnapshot = {
    event,
    confirmOpen: Boolean(document.querySelector('.confirm-backdrop')),
    modal: topmost(),
  };
}

function onKeydownBubble(event) {
  const snap = keydownSnapshot?.event === event ? keydownSnapshot : null;
  keydownSnapshot = null;
  if (!snap || snap.confirmOpen || !snap.modal) return;
  const { root, dialog } = snap.modal;
  if (event.key === 'Tab') {
    if (event.defaultPrevented) return; // the page traps focus itself
    const controls = focusablesIn(dialog);
    if (controls.length === 0) { event.preventDefault(); return; }
    const first = controls[0];
    const last = controls[controls.length - 1];
    const active = document.activeElement;
    if (!dialog.contains(active)) { event.preventDefault(); first.focus(); return; }
    if (event.shiftKey && active === first) { event.preventDefault(); last.focus(); }
    else if (!event.shiftKey && active === last) { event.preventDefault(); first.focus(); }
  } else if (event.key === 'Escape') {
    if (event.defaultPrevented) return;
    // Let the page's own Escape handling (if any) run to completion first;
    // only a modal still on screen afterwards needs closing here.
    setTimeout(() => {
      if (!root.isConnected || !isVisible(root)) return;
      findCloseControl(dialog)?.click();
    }, 0);
  }
}

function onFocusIn(event) {
  const target = event.target;
  if (!(target instanceof Element)) return;
  if (target.closest(MODAL_ROOT_SELECTOR) || target.closest('.confirm-backdrop')) return;
  lastOutsideFocus = target;
}

/** Idempotent: the first call installs the observer and key handling. */
export function startModalA11y() {
  if (started || typeof document === 'undefined' || typeof MutationObserver === 'undefined') return;
  started = true;
  const observer = new MutationObserver((records) => {
    let removed = false;
    for (const record of records) {
      for (const node of record.addedNodes) scan(node);
      if (record.removedNodes.length) removed = true;
    }
    if (removed) handleRemovals();
  });
  observer.observe(document.body, { childList: true, subtree: true });
  window.addEventListener('keydown', onKeydownCapture, true);
  window.addEventListener('keydown', onKeydownBubble, false);
  document.addEventListener('focusin', onFocusIn, true);
  // Anything already open when started.
  for (const found of document.querySelectorAll(MODAL_ROOT_SELECTOR)) enhance(found);
}

/** Test-only: how many modals are currently tracked. */
export function __managedModalCount() {
  return stack.filter((m) => m.root.isConnected).length;
}
