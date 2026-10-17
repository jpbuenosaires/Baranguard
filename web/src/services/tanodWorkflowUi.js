/**
 * tanodWorkflowUi.js — small shared helpers for the four 2026-10 pages
 * (Approvals, Accomplishment Reports, Referral Log, Safer School Zones):
 * page frame, tab bar, state blocks, Manila-time formatters, the viewer's
 * approval authority (cached), printed-form letterhead.
 *
 * Kept next to tanodWorkflowApi.js rather than in components/ because
 * components/ belongs to the shared design system and is not part of this
 * build's ownership; nothing here is generic enough to promote yet.
 *
 * Every function that puts server data into the DOM uses textContent or
 * escapeHtml (REFERENCE.md §6). Printed-form HTML builders return strings
 * and escape every interpolation.
 */

import { AppShell } from '../components/AppShell.js';
import { PageHeader } from '../components/PageHeader.js';
import { renderLoadingSkeleton, renderErrorState } from '../components/AsyncState.js';
import { logout } from '../api/apiClient.js';
import { escapeHtml } from '../utils/escapeHtml.js';
import { formatManilaDateTime as manilaDateTime, formatManilaDate as manilaDate, formatManilaTime as manilaTime, manilaDateKey } from '../utils/manilaTime.js';
import {
  ApiClientError, getUserById, getBarangayLetterhead,
  REPORT_STATUS_LABELS, TERM_STATUS_LABELS,
} from './tanodWorkflowApi.js';

export { escapeHtml };

/** Tiny element factory: `h('div', 'cls', 'text')`. Text always goes through textContent. */
export function h(tag, className, textContent) {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (textContent !== undefined && textContent !== null) node.textContent = String(textContent);
  return node;
}

/**
 * Mounts AppShell + PageHeader and returns the pieces a page needs.
 * @returns {{shell:object, pageHeader:{el:HTMLElement,actions:HTMLElement}, container:HTMLElement}}
 */
export function mountPageFrame({ root, user, onLoggedOut, navigate, activeKey, title, subtitle, icon }) {
  root.innerHTML = '';
  const shell = AppShell(user, activeKey, navigate, async () => {
    shell.logoutButton.disabled = true;
    await logout();
    onLoggedOut();
  });
  root.appendChild(shell.el);
  const pageHeader = PageHeader({ title, subtitle, icon });
  shell.header.appendChild(pageHeader.el);
  const container = h('div', 'tw-container');
  shell.content.appendChild(container);
  return { shell, pageHeader, container };
}

/**
 * Tab bar in the established `.page-tabs-bar > .page-tabs > .page-tab`
 * markup (analytics.js/personnel.js), appended to the shell header.
 * @returns {{el:HTMLElement, setActive:(id:string)=>void, setBadge:(id:string,n:number|null)=>void}}
 */
export function buildTabBar(tabs, onSelect) {
  const bar = h('div', 'page-tabs-bar');
  const row = h('div', 'page-tabs');
  row.setAttribute('role', 'tablist');
  const buttons = {};
  const badges = {};
  for (const tab of tabs) {
    const btn = h('button', 'page-tab');
    btn.type = 'button';
    btn.setAttribute('role', 'tab');
    btn.id = `tw-tab-${tab.id}`;
    btn.appendChild(document.createTextNode(tab.label));
    const badge = h('span', 'page-tab__badge');
    badge.hidden = true;
    btn.appendChild(badge);
    btn.addEventListener('click', () => onSelect(tab.id));
    buttons[tab.id] = btn;
    badges[tab.id] = badge;
    row.appendChild(btn);
  }
  bar.appendChild(row);
  return {
    el: bar,
    setActive(id) {
      for (const [key, btn] of Object.entries(buttons)) {
        btn.classList.toggle('is-active', key === id);
        btn.setAttribute('aria-selected', key === id ? 'true' : 'false');
      }
    },
    setBadge(id, count) {
      const badge = badges[id];
      if (!badge) return;
      badge.hidden = !count;
      badge.textContent = count ? String(count) : '';
    },
  };
}

// --- The four states (REFERENCE.md §6) --------------------------------------

export function showLoading(container, label) {
  renderLoadingSkeleton({ container, count: 3, ariaLabel: label });
}

export function showError(container, error, onRetry, fallback = 'Something went wrong loading this screen.') {
  renderErrorState({
    container,
    message: error instanceof ApiClientError ? error.message : fallback,
    onRetry,
    retryLabel: 'Retry',
  });
}

export function showEmpty(container, title, message) {
  container.innerHTML = '';
  const block = h('div', 'card state-block');
  block.append(h('h3', '', title), h('p', '', message));
  container.appendChild(block);
}

// --- Dates, durations (Asia/Manila display, REFERENCE.md §2 Rule 11) --------

const MANILA = 'Asia/Manila';

/** `YYYY-MM-DD` literal -> "Mar 5, 2026" with no timezone shift (date-only values are not instants). */
export function formatDateOnly(value) {
  if (!value || !/^\d{4}-\d{2}-\d{2}/.test(String(value))) return '—';
  const [y, m, d] = String(value).slice(0, 10).split('-').map(Number);
  return new Date(Date.UTC(y, m - 1, d)).toLocaleDateString('en-PH', {
    timeZone: 'UTC', year: 'numeric', month: 'short', day: 'numeric',
  });
}

/** UTC instant -> Manila date + time (12-hour). Delegates to utils/manilaTime.js. */
export function formatManilaDateTime(value) {
  return manilaDateTime(value, '—');
}

/** UTC instant -> Manila date only. */
export function formatManilaDate(value) {
  return manilaDate(value, '—');
}

const MANILA_PARTS = new Intl.DateTimeFormat('en-CA', {
  timeZone: MANILA, year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hourCycle: 'h23',
});

/** ISO instant -> `YYYY-MM-DDTHH:mm` on the Manila clock, for <input type="datetime-local">. */
export function toManilaDatetimeLocal(value) {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return '';
  const p = Object.fromEntries(MANILA_PARTS.formatToParts(date).map((x) => [x.type, x.value]));
  return `${p.year}-${p.month}-${p.day}T${p.hour}:${p.minute}`;
}

const MANILA_MONTH_DAY = new Intl.DateTimeFormat('en-PH', { timeZone: MANILA, month: 'short', day: 'numeric' });

/** Shift window as staff read it: "Oct 9 · 6:00 am – 2:00 pm" (Manila time, 12-hour). */
export function formatShiftRange(startAt, endAt) {
  const s = new Date(startAt);
  const e = new Date(endAt);
  if (Number.isNaN(s.getTime()) || Number.isNaN(e.getTime())) return 'Time not recorded';
  const t = (d) => manilaTime(d, '');
  const day = (d) => MANILA_MONTH_DAY.format(d);
  if (manilaDateKey(s) === manilaDateKey(e)) return `${day(s)} · ${t(s)} – ${t(e)}`;
  return `${day(s)} ${t(s)} – ${day(e)} ${t(e)}`;
}

/** `YYYY-MM-DD` of "today" in Manila (a fixed +08:00 offset, never CONVERT_TZ-style tz data). */
export function manilaToday() {
  return new Date(Date.now() + 8 * 3600 * 1000).toISOString().slice(0, 10);
}

/** `YYYY-MM` -> "March 2026". */
export function formatMonthLabel(month) {
  if (!/^\d{4}-\d{2}$/.test(String(month ?? ''))) return month ? String(month) : '—';
  const [y, m] = month.split('-').map(Number);
  return new Date(Date.UTC(y, m - 1, 1)).toLocaleDateString('en-PH', { timeZone: 'UTC', month: 'long', year: 'numeric' });
}

export function daysInMonth(month) {
  const [y, m] = month.split('-').map(Number);
  return new Date(Date.UTC(y, m, 0)).getUTCDate();
}

/** 150 -> "2h 30m". */
export function formatMinutes(minutes) {
  const n = Number(minutes);
  if (!Number.isFinite(n)) return '—';
  const h2 = Math.floor(n / 60);
  const m2 = Math.round(n % 60);
  if (h2 === 0) return `${m2}m`;
  return m2 === 0 ? `${h2}h` : `${h2}h ${m2}m`;
}

/** 150 -> "2.5" (hours, for the printed form's Duration Hours box). */
export function minutesToHours(minutes) {
  const n = Number(minutes);
  if (!Number.isFinite(n)) return '';
  return (Math.round((n / 60) * 100) / 100).toString();
}

/** "08:00:00" -> "08:00". */
export function trimTime(value) {
  return value ? String(value).slice(0, 5) : '';
}

// --- Status pills -----------------------------------------------------------

const REPORT_TONE = { open: 'neutral', prepared: 'pending', returned: 'critical' };
const TERM_TONE = { draft: 'neutral', prepared: 'pending', submitted: 'info' };

export function statusPill(status, kind = 'report') {
  const labels = kind === 'term' ? TERM_STATUS_LABELS : REPORT_STATUS_LABELS;
  const tones = kind === 'term' ? TERM_TONE : REPORT_TONE;
  const pill = h('span', `status-pill status-pill--${tones[status] || 'neutral'}`, labels[status] || status || '—');
  return pill;
}

// --- Errors -----------------------------------------------------------------

/**
 * The same-person rule (contract §4/§7: preparer != approver) arrives as a
 * 409 with the server's own message. Surface it as something an official
 * can act on; any other error keeps the server's real message.
 */
export function actionErrorMessage(err, fallback = 'That action could not be completed.') {
  if (!(err instanceof ApiClientError)) return fallback;
  if (err.status === 409 && /preparer cannot/i.test(err.message)) {
    return 'The person who prepared this record cannot also note or approve it. Ask another official who holds that authority to do this step.';
  }
  if (err.status === 403) return 'Your account does not hold the approval authority this action needs.';
  return err.message || fallback;
}

// --- Viewer approval authority (cached) -------------------------------------

const AUTHORITY_TTL_MS = 60 * 1000;
const authorityCache = new Map();

/** Test hook and post-edit refresh: forget every cached authority lookup. */
export function clearAuthorityCache() {
  authorityCache.clear();
}

/**
 * The signed-in viewer's own authorities + official title, via GET
 * /users/:id (contract §10). Cached for a minute so Approvals and the
 * detail views do not each refetch. A failed lookup resolves to "holds
 * nothing" — action buttons stay hidden rather than showing controls the
 * server may refuse — and `failed` lets the page say so honestly.
 *
 * @returns {Promise<{authority:Set<string>, officialTitle:string|null, failed:boolean}>}
 */
export function getMyAuthority(user) {
  const cached = authorityCache.get(user.userId);
  if (cached && Date.now() - cached.at < AUTHORITY_TTL_MS) return cached.promise;
  const promise = getUserById(user.userId)
    .then((me) => ({ authority: new Set(me.approvalAuthority), officialTitle: me.officialTitle, failed: false }))
    .catch(() => {
      // A failure is never cached, so a Retry really retries.
      authorityCache.delete(user.userId);
      return { authority: new Set(), officialTitle: null, failed: true };
    });
  authorityCache.set(user.userId, { at: Date.now(), promise });
  return promise;
}

// --- Printed-form letterhead ------------------------------------------------

/**
 * Province / municipality / barangay for printed forms, from GET /barangays.
 * On failure the names are left EMPTY (never "#3") and `failed` is true, so the
 * printed form shows a blank line to fill in by hand instead of a fake name.
 */
export async function loadLetterhead(user) {
  try {
    const lh = await getBarangayLetterhead(user.barangayId);
    return { ...lh, failed: !lh.barangayName };
  } catch {
    return { barangayName: '', municipality: '', province: '', failed: true };
  }
}

const PRINT_ROLE_LABELS = {
  admin: 'Chief Tanod (Admin)',
  secretary: 'Barangay Secretary',
  punong_barangay: 'Punong Barangay',
  tanod: 'Barangay Tanod',
};

/** Role label printed in the footer of every official printout ("Printed ... by <role>"). */
export function printedByLabel(user) {
  return PRINT_ROLE_LABELS[user?.role] || 'a signed-in official';
}

const BLANK_LINE = '________________';

/**
 * Letterhead block shared by every printed form (Republic / Province /
 * Municipality / Barangay). No logo circles: the API holds no seal image, and
 * an empty circle on an official form reads as an unfinished draft (Rule 6).
 */
export function letterheadHtml(lh, { office = false } = {}) {
  return `
    <div class="tw-print__letterhead-row">
      <div class="tw-print__letterhead">
      <p class="tw-print__republic">Republic of the Philippines</p>
      <p class="tw-print__line">Province of ${escapeHtml(lh.province || BLANK_LINE)}</p>
      <p class="tw-print__line">Municipality of ${escapeHtml(lh.municipality || BLANK_LINE)}</p>
      <p class="tw-print__brgy">Barangay ${escapeHtml(lh.barangayName || BLANK_LINE)}</p>
      ${office ? '<p class="tw-print__office">Office of the Sangguniang Barangay</p>' : ''}
      </div>
    </div>`;
}

/**
 * Signature block for an official's line on a printed form: blank space for
 * the wet signature, then the printed name, title, and a date line.
 * `name` and `title` may be empty (the signer is not known yet) -> blank lines.
 */
export function signatureBlockHtml(caption, name, title) {
  return `
    <div class="tw-sign__col">
      <div class="tw-sign__cap">${escapeHtml(caption)}</div>
      <div class="tw-sign__space" aria-hidden="true"></div>
      <div class="tw-sign__line"></div>
      <div class="tw-sign__hint">Signature over printed name</div>
      <div class="tw-sign__name">${escapeHtml(name || '')}</div>
      <div class="tw-sign__pos">${escapeHtml(title || '')}</div>
      <div class="tw-sign__date">Date signed: ______________</div>
    </div>`;
}

/** Fixed pursuant-to line printed under the SSZ annex titles (text taken from the user's own forms). */
export const SSZ_PURSUANT_HTML = '<b>[Pursuant to</b> DILG Memorandum Circular No. <u>2026-037</u> dated <u>June 25, 2026</u> - SAFER SCHOOL ZONES (SSZ) UNDER THE SAFER CITIES AND SAFER COMMUNITIES INITIATIVE<b>]</b>';

/** Print-preview opener that also switches the sheet to landscape for wide annexes. */
export function applyPrintOrientation(preview, orientation) {
  if (orientation === 'landscape') {
    preview.sheet?.classList.add('tw-print-sheet--landscape');
    preview.sheet?.classList.add('print-sheet--landscape');
    document.body.classList.add('print-orientation-landscape');
  }
}

/** Section card with a title, used by every page. */
export function card(title, subtitle) {
  const el = h('section', 'card tw-card');
  if (title) {
    const head = h('div', 'tw-card__head');
    head.appendChild(h('h3', 'tw-card__title', title));
    if (subtitle) head.appendChild(h('p', 'tw-card__subtitle', subtitle));
    el.appendChild(head);
  }
  return el;
}

/** Labelled form field: returns `{wrap, input}`. */
export function field(labelText, input, { hint } = {}) {
  const wrap = h('div', 'form-stack tw-field');
  const label = h('label', 'label', labelText);
  if (!input.id) input.id = `tw-f-${Math.random().toString(36).slice(2, 9)}`;
  label.htmlFor = input.id;
  wrap.append(label, input);
  if (hint) wrap.appendChild(h('p', 'tw-field__hint', hint));
  return { wrap, input };
}

export function selectOf(options, { value = '', placeholder, ariaLabel } = {}) {
  const select = document.createElement('select');
  if (ariaLabel) select.setAttribute('aria-label', ariaLabel);
  if (placeholder !== undefined) {
    const opt = document.createElement('option');
    opt.value = '';
    opt.textContent = placeholder;
    select.appendChild(opt);
  }
  for (const o of options) {
    const opt = document.createElement('option');
    opt.value = String(o.value);
    opt.textContent = o.label;
    select.appendChild(opt);
  }
  select.value = value;
  return select;
}

// --- Formal Record Reference Code Formatters (Option A) ---------------------

export function padCode(prefix, id, width = 4) {
  const num = Number(id);
  if (id !== null && id !== undefined && String(id).trim() !== '' && Number.isFinite(num) && num > 0) {
    return `${prefix}-${String(Math.trunc(num)).padStart(width, '0')}`;
  }
  return '—';
}

export function formatShiftCode(id) {
  return padCode('SHF', id, 4);
}

export function formatAccomplishmentCode(id) {
  return padCode('AR', id, 4);
}

export function formatAnnexDCode(id) {
  return padCode('ANX-D', id, 4);
}

export function formatSchoolCode(id) {
  return padCode('SCH', id, 4);
}

export function formatSwapCode(id) {
  return padCode('SWP', id, 4);
}

// The official code is the server's display_id (INC-2026-159). It cannot be
// derived from the numeric id, so without it we show a visibly unofficial
// fallback (INC-#159) and never an invented INC-YYYY-NNN code.
export function formatIncidentCode(incOrId, displayId) {
  const clean = (v) => (v !== null && v !== undefined && String(v).trim() ? String(v).trim() : '');
  if (clean(displayId)) return clean(displayId);
  let rawId = incOrId;
  if (incOrId && typeof incOrId === 'object') {
    const d = clean(incOrId.displayId) || clean(incOrId.incidentDisplayId);
    if (d) return d;
    rawId = incOrId.incidentId ?? incOrId.id;
  }
  const num = Number(rawId);
  if (rawId !== null && rawId !== undefined && String(rawId).trim() !== '' && Number.isFinite(num) && num > 0) {
    return `INC-#${Math.trunc(num)}`;
  }
  return '—';
}

export function formatCitizenReportCode(id) {
  return padCode('CR', id, 4);
}

export function formatDispatchCode(id) {
  return padCode('DSP', id, 4);
}

export function formatSosCode(id) {
  return padCode('SOS', id, 4);
}

export function formatSmsCode(id) {
  return padCode('SMS', id, 4);
}

export function formatAuditCode(id) {
  return padCode('AUD', id, 5);
}

export function formatUserCode(id) {
  return padCode('USR', id, 4);
}

