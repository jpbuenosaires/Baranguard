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
/**
 * Detects page break markers (such as .tw-print__page-break, .print-page-break,
 * or .acc-batch-sheet-break) and splits a multi-page document into discrete
 * page HTML strings so each page renders as a distinct physical A4 sheet.
 *
 * @param {string} sheetHtml
 * @returns {string[]} Array of page HTML strings
 */
function splitIntoPages(sheetHtml) {
  if (!sheetHtml || typeof sheetHtml !== 'string') return [sheetHtml || ''];

  if (!sheetHtml.includes('tw-print__page-break') &&
      !sheetHtml.includes('acc-batch-sheet-break') &&
      !sheetHtml.includes('print-page-break')) {
    return [sheetHtml];
  }

  const container = document.createElement('div');
  container.innerHTML = sheetHtml.trim();

  // Case 1: Batch accomplishment report sheets (.acc-batch-sheet-break)
  const batchSheets = container.querySelectorAll('.acc-batch-sheet-break');
  if (batchSheets.length > 0) {
    return Array.from(batchSheets).map((el) => el.innerHTML || el.outerHTML);
  }

  // Case 2: Multi-page forms separated by .tw-print__page-break or .print-page-break
  const breakMarkers = container.querySelectorAll('.tw-print__page-break, .print-page-break');
  if (breakMarkers.length > 0) {
    const pages = [];
    if (container.children.length === 1 && (container.firstElementChild.classList.contains('tw-print') || container.firstElementChild.classList.contains('tw-print--wide'))) {
      const wrapper = container.firstElementChild;
      const wrapperClass = wrapper.className;
      let currentPageNodes = [];

      for (const child of Array.from(wrapper.childNodes)) {
        if (child.nodeType === 1 && (child.classList.contains('tw-print__page-break') || child.classList.contains('print-page-break'))) {
          const pageDiv = document.createElement('div');
          pageDiv.className = wrapperClass;
          currentPageNodes.forEach((node) => pageDiv.appendChild(node.cloneNode(true)));
          pages.push(pageDiv.outerHTML);
          currentPageNodes = [];
        } else {
          currentPageNodes.push(child);
        }
      }
      if (currentPageNodes.length > 0) {
        const pageDiv = document.createElement('div');
        pageDiv.className = wrapperClass;
        currentPageNodes.forEach((node) => pageDiv.appendChild(node.cloneNode(true)));
        pages.push(pageDiv.outerHTML);
      }
      return pages.length > 0 ? pages : [sheetHtml];
    } else {
      let currentPageNodes = [];
      for (const child of Array.from(container.childNodes)) {
        if (child.nodeType === 1 && (child.classList.contains('tw-print__page-break') || child.classList.contains('print-page-break'))) {
          const pageDiv = document.createElement('div');
          currentPageNodes.forEach((node) => pageDiv.appendChild(node.cloneNode(true)));
          pages.push(pageDiv.innerHTML);
          currentPageNodes = [];
        } else {
          currentPageNodes.push(child);
        }
      }
      if (currentPageNodes.length > 0) {
        const pageDiv = document.createElement('div');
        currentPageNodes.forEach((node) => pageDiv.appendChild(node.cloneNode(true)));
        pages.push(pageDiv.innerHTML);
      }
      return pages.length > 0 ? pages : [sheetHtml];
    }
  }

  return [sheetHtml];
}

export function openPrintPreviewModal({
  title = 'Printable Official Excerpt',
  subtitle = 'Formatted A4 working sheet',
  sheetId = 'printable-sheet',
  sheetHtml = '',
  extraActions = [],
  printedBy = '',
  orientation = 'portrait',
} = {}) {
  const returnFocusTo = document.activeElement;
  // Remove any existing print modal first so two never stack
  const existing = document.querySelector('.print-modal-backdrop');
  if (existing) existing.remove();

  const overlay = document.createElement('div');
  overlay.className = 'modal-backdrop print-modal-backdrop';

  const isLandscape = orientation === 'landscape';
  const sheetLandscapeClasses = isLandscape ? 'print-sheet--landscape tw-print-sheet--landscape' : '';
  const pages = splitIntoPages(sheetHtml);
  const stampDateStr = formatManilaDateTime(new Date());

  let viewportHtml = '';
  if (pages.length <= 1) {
    const stamp = `Printed ${escapeHtml(stampDateStr)} (Philippine time)${printedBy ? ` by ${escapeHtml(printedBy)}` : ''}`;
    viewportHtml = `
      <div id="${escapeHtml(sheetId)}" class="print-sheet ${sheetLandscapeClasses}">
        ${pages[0] || ''}
        <p class="print-sheet__stamp">${stamp}</p>
      </div>
    `;
  } else {
    const sheets = pages.map((pageHtml, idx) => {
      const pageNum = idx + 1;
      const stamp = `Printed ${escapeHtml(stampDateStr)} (Philippine time)${printedBy ? ` by ${escapeHtml(printedBy)}` : ''}`;
      return `
        <div id="${escapeHtml(sheetId)}-page-${pageNum}" class="print-sheet ${sheetLandscapeClasses}">
          ${pageHtml}
          <p class="print-sheet__stamp">${stamp}</p>
        </div>
      `;
    }).join('');

    viewportHtml = `
      <div id="${escapeHtml(sheetId)}" class="print-sheet-group">
        ${sheets}
      </div>
    `;
  }

  const modal = document.createElement('div');
  modal.className = `modal-card print-modal ${isLandscape ? 'print-modal--landscape' : ''}`.trim();
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
      ${viewportHtml}
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
  if (isLandscape) document.body.classList.add('print-orientation-landscape');

  // Inject explicit A4 @page orientation rule so all browser print engines reliably switch page dimensions
  let orientationStyle = document.getElementById('print-page-orientation-override');
  if (!orientationStyle) {
    orientationStyle = document.createElement('style');
    orientationStyle.id = 'print-page-orientation-override';
    document.head.appendChild(orientationStyle);
  }
  const marginBoxes = '@bottom-left { content: var(--print-stamp, ""); font-size: 8pt; font-family: var(--font-base, -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif); color: #64748b; } @bottom-right { content: "Page " counter(page) " of " counter(pages); font-size: 8pt; font-family: var(--font-base, -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif); color: #64748b; }';
  orientationStyle.textContent = isLandscape
    ? `@page { size: A4 landscape; margin: 12mm 15mm 15mm 15mm; ${marginBoxes} }`
    : `@page { size: A4 portrait; margin: 12mm 15mm 15mm 15mm; ${marginBoxes} }`;

  // The stamp is fed to the @page bottom-left margin box so it repeats on
  // every A4 page as the single, authoritative footer without in-body duplication.
  const baseStampText = modal.querySelector('.print-sheet__stamp')?.textContent || `Printed ${stampDateStr} (Philippine time)${printedBy ? ` by ${printedBy}` : ''}`;
  document.documentElement.style.setProperty('--print-stamp', JSON.stringify(baseStampText));

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
    document.body.classList.remove('print-orientation-landscape');
    document.documentElement.style.removeProperty('--print-stamp');
    const curOrientationStyle = document.getElementById('print-page-orientation-override');
    if (curOrientationStyle) curOrientationStyle.remove();
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

  // Direct printing: let the printer handle the preview without the redundant in-app modal.
  // When the native print dialog closes (printed or cancelled), clean up automatically.
  if (typeof window !== 'undefined' && typeof window.addEventListener === 'function') {
    window.addEventListener('afterprint', close, { once: true });
  }

  // Trigger the native print dialog directly
  if (typeof window !== 'undefined' && typeof window.print === 'function') {
    try {
      window.print();
    } catch (_) {}
  }

  return {
    close,
    overlay,
    sheet: modal.querySelector('.print-sheet'),
  };
}
