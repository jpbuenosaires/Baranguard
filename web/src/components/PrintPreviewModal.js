/**
 * PrintPreviewModal.js — Shared A4 print-preview modal and working-copy
 * print controller used across Incident Detail, Statistical Reports,
 * Audit Log, Citizen Report Receipts, and Public Transparency.
 *
 * Ensures consistent official barangay document typography, dark-mode-safe
 * paper contrast, and reliable `window.print()` execution (unlocking the
 * SPA's `height:100%; overflow:hidden` shell via `body.has-print-modal`).
 */
import { icons } from './icons.js';
import { escapeHtml } from '../utils/escapeHtml.js';
import { formatManilaDateTime } from '../utils/manilaTime.js';

/**
 * Opens an interactive A4 Print Preview modal and mounts `#printable-...`
 * directly under `document.body` so `@media print` can isolate it cleanly.
 *
 * @param {object} options
 * @param {string} options.title Modal header title
 * @param {string} options.subtitle Modal header subtitle
 * @param {string} [options.sheetId='printable-sheet'] DOM id for the `.print-sheet` node
 * @param {string} options.sheetHtml Inner HTML of the `.print-sheet` container
 * @param {Array<{label:string, icon?:string, className?:string, onClick:(btn:HTMLButtonElement)=>void}>} [options.extraActions=[]]
 *   Additional footer action buttons placed beside "Print working copy" (e.g. Download Official PDF, Export CSV).
 * @param {string} [options.printedBy] Role or name printed in the page footer ("Printed <Manila time> by <printedBy>").
 * @returns {{ close: () => void, overlay: HTMLElement, sheet: HTMLElement }}
 */
export function openPrintPreviewModal({
  title = 'Printable Official Excerpt',
  subtitle = 'Formatted A4 working sheet',
  sheetId = 'printable-sheet',
  sheetHtml = '',
  extraActions = [],
  printedBy = '',
} = {}) {
  const returnFocusTo = document.activeElement;
  // Remove any existing print modal first so two never stack
  const existing = document.querySelector('.print-modal-backdrop');
  if (existing) existing.remove();

  const overlay = document.createElement('div');
  overlay.className = 'modal-backdrop print-modal-backdrop';

  const modal = document.createElement('div');
  modal.className = 'modal-card print-modal';
  modal.setAttribute('role', 'dialog');
  modal.setAttribute('aria-modal', 'true');
  modal.setAttribute('aria-label', title);

  modal.innerHTML = `
    <div class="print-modal__header">
      <div class="print-modal__title-group">
        <div class="print-modal__icon" aria-hidden="true">${icons.printer(18)}</div>
        <div>
          <h3 class="print-modal__title">${escapeHtml(title)}</h3>
          <p class="print-modal__subtitle">${escapeHtml(subtitle)}</p>
        </div>
      </div>
      <button type="button" class="ghost" id="close-print-modal" aria-label="Close print preview">${icons.x ? icons.x(16) : '&times;'}</button>
    </div>

    <div class="print-modal__viewport">
      <div id="${escapeHtml(sheetId)}" class="print-sheet">
        ${sheetHtml}
        <p class="print-sheet__stamp">Printed ${escapeHtml(formatManilaDateTime(new Date()))} (Philippine time)${printedBy ? ` by ${escapeHtml(printedBy)}` : ''}</p>
      </div>
    </div>

    <div class="print-modal__footer">
      <button type="button" class="ghost" id="cancel-print-btn">Close</button>
      <div class="print-modal__footer-actions">
        <button type="button" class="primary" id="do-print-btn">
          ${icons.printer(16)} <span>Print (A4)</span>
        </button>
      </div>
    </div>
  `;

  const footerActions = modal.querySelector('.print-modal__footer-actions');
  const doPrintBtn = modal.querySelector('#do-print-btn');

  for (const action of extraActions) {
    if (!action || typeof action.onClick !== 'function') continue;
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = action.className || 'ghost';
    btn.innerHTML = `${action.icon || ''} <span>${escapeHtml(action.label)}</span>`.trim();
    btn.addEventListener('click', () => action.onClick(btn));
    footerActions.insertBefore(btn, doPrintBtn);
  }

  overlay.appendChild(modal);
  document.body.appendChild(overlay);
  document.body.classList.add('has-print-modal');
  // The stamp is also fed to the @page bottom-left margin box so it repeats on
  // every A4 page without overlapping table rows (see tanod-workflow.css).
  const stampText = modal.querySelector('.print-sheet__stamp')?.textContent || '';
  document.documentElement.style.setProperty('--print-stamp', JSON.stringify(stampText));

  const onKeyDown = (event) => {
    if (event.key === 'Escape') {
      event.preventDefault();
      close();
      return;
    }
    if (event.key === 'Tab') {
      // Keep keyboard focus inside the dialog while it is open.
      const focusable = [...modal.querySelectorAll('button:not([disabled]), [href], input, select, textarea, [tabindex]:not([tabindex="-1"])')];
      if (!focusable.length) return;
      const first = focusable[0];
      const last = focusable[focusable.length - 1];
      if (event.shiftKey && document.activeElement === first) { event.preventDefault(); last.focus(); }
      else if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first.focus(); }
      else if (!modal.contains(document.activeElement)) { event.preventDefault(); first.focus(); }
    }
  };
  window.addEventListener('keydown', onKeyDown);

  function close() {
    window.removeEventListener('keydown', onKeyDown);
    document.body.classList.remove('has-print-modal');
    document.documentElement.style.removeProperty('--print-stamp');
    overlay.remove();
    if (returnFocusTo && typeof returnFocusTo.focus === 'function' && document.contains(returnFocusTo)) returnFocusTo.focus();
  }

  modal.querySelector('#close-print-modal').addEventListener('click', close);
  modal.querySelector('#cancel-print-btn').addEventListener('click', close);
  doPrintBtn.focus();
  doPrintBtn.addEventListener('click', () => {
    document.body.classList.add('has-print-modal');
    window.print();
  });
  overlay.addEventListener('click', (e) => {
    if (e.target === overlay) close();
  });

  return {
    close,
    overlay,
    sheet: modal.querySelector('.print-sheet'),
  };
}
