/**
 * approvals.js — Approvals queue (contract §10): one place where an
 * official sees every record waiting on THEM — draft shifts to publish,
 * accomplishment reports prepared and ready to print and sign, and Annex D
 * term reports still to prepare or submit — each row deep-linking to the
 * screen where the action is taken.
 *
 * Signing happens on paper, outside the app: the app only prints. Nothing
 * here tracks signatures or approval of a printed copy.
 *
 * Availability is not here (2026-10-12): it is the tanod's own fixed
 * statement and is not reviewed; it is shown read-only in the Scheduler.
 *
 * Role/authority gating is UX only (REFERENCE.md §2 Rule 2: the server
 * re-checks every action). A group is shown only when the viewer can act
 * on it:
 *   - shifts awaiting publish ....... role admin or secretary, or
 *                                     authority approve_roster
 *   - reports prepared .............. role admin or secretary
 *   - Annex D to prepare ............ role admin or secretary (draft and
 *                                     prepared term reports)
 * The viewer's authority comes from GET /users/:id (their own record).
 *
 * Each group has its own Loading / Empty / Error-with-retry / Populated
 * states, so one failing endpoint never blanks the whole page.
 */

import { StatStrip } from '../components/StatStrip.js';
import { icons } from '../components/icons.js';
import {
  getShiftsByApproval, getAccomplishmentReports, getTermReports, getUserNames,
} from '../services/tanodWorkflowApi.js';
import {
  h, mountPageFrame, showLoading, showError, showEmpty, getMyAuthority,
  formatMonthLabel, formatDateOnly, formatManilaDate,
} from '../services/tanodWorkflowUi.js';

const ROW_PREVIEW_LIMIT = 5;

/**
 * Group definitions. `visible` decides whether the viewer can act on it,
 * `load` returns `{rows, total}` where each row is `{key, title, detail, open}`.
 */
function buildGroups({ user, navigate, nameOf }) {
  const isManager = user.role === 'admin' || user.role === 'secretary';
  const person = (row) => {
    if (row.userId === null || row.userId === undefined) return 'Unassigned shift';
    return row.fullName || nameOf(row.userId) || `Tanod #${row.userId}`;
  };

  return [
    {
      id: 'shifts',
      title: 'Shifts awaiting publish',
      hint: 'Draft shifts. Tanods only see a shift once it is published. Print the schedule and have it signed on paper, then publish the week.',
      icon: icons.shield || icons.calendar,
      badgeTone: 'shifts',
      visible: (a) => isManager || a.has('approve_roster'),
      load: async () => {
        const res = await getShiftsByApproval({ approvalStatus: 'draft', limit: 100 });
        await nameOf.ensure(res.items.filter((r) => r.userId !== null));
        return {
          total: res.total,
          rows: res.items.map((r) => ({
            key: r.shiftId,
            title: person(r),
            date: formatManilaDate(r.startAt),
            zone: r.patrolZone || 'General patrol',
            detail: `${formatManilaDate(r.startAt)}${r.patrolZone ? ` · ${r.patrolZone}` : ''}`,
            open: () => navigate('personnel', { tab: 'scheduler' }),
          })),
        };
      },
      openAll: () => navigate('personnel', { tab: 'scheduler' }),
      openLabel: 'Open Scheduler',
    },
    {
      id: 'reports-prepared',
      title: 'Accomplishment reports prepared',
      hint: 'Ready to print and sign. Printing and signing happen on paper, outside the app.',
      icon: icons.fileText,
      badgeTone: 'reports',
      visible: () => isManager,
      load: () => loadReports(['prepared']),
      openAll: () => navigate('accomplishment-reports', { status: 'prepared' }),
      openLabel: 'Open reports',
    },
    {
      id: 'annex-d',
      title: 'Annex D to prepare',
      hint: 'Draft and prepared term reports. Prepare the report, print it and have it signed on paper, then submit it.',
      icon: icons.calendar,
      badgeTone: 'annex',
      visible: () => isManager,
      load: () => loadTerms(['draft', 'prepared']),
      openAll: () => navigate('school-zones', { tab: 'term' }),
      openLabel: 'Open Term Report',
    },
  ];

  async function loadReports(statuses) {
    const pages = await Promise.all(statuses.map((status) => getAccomplishmentReports({ status, limit: 100 })));
    const items = pages.flatMap((res) => res.items);
    await nameOf.ensure(items);
    return {
      total: pages.reduce((sum, res) => sum + res.total, 0),
      rows: items.map((r) => ({
        key: r.reportId,
        title: person(r),
        month: formatMonthLabel(r.month),
        flagged: Number(r.flaggedEntries) || 0,
        detail: formatMonthLabel(r.month),
        open: () => navigate('accomplishment-reports', { reportId: r.reportId }),
      })),
    };
  }

  async function loadTerms(statuses) {
    const pages = await Promise.all(statuses.map((status) => getTermReports({ status, limit: 100 })));
    const items = pages.flatMap((res) => res.items);
    return {
      total: pages.reduce((sum, res) => sum + res.total, 0),
      rows: items.map((r) => ({
        key: r.reportId,
        title: r.termLabel,
        dates: `${formatDateOnly(r.termStart)} to ${formatDateOnly(r.termEnd)}`,
        incidents: r.totalIncidents ?? 0,
        status: r.status,
        detail: `${formatDateOnly(r.termStart)} to ${formatDateOnly(r.termEnd)}`,
        open: () => navigate('school-zones', { tab: 'term', reportId: r.reportId }),
      })),
    };
  }
}

/** Lazily-loaded user-name lookup; only fetched when a row has no name of its own. */
function createNameLookup() {
  let names = null;
  let attempted = false;
  const lookup = (userId) => (names ? names.get(userId) : undefined);
  lookup.ensure = async (rows) => {
    if (attempted || rows.every((r) => r.fullName)) return;
    attempted = true;
    try { names = await getUserNames(); } catch { names = new Map(); }
  };
  return lookup;
}

/**
 * @param {HTMLElement} root
 * @param {{userId:number, fullName:string, role:string, barangayId:number}} user
 * @param {() => void} onLoggedOut
 * @param {(page:string, param?:any) => void} navigate
 */
export function renderApprovalsPage(root, user, onLoggedOut, navigate) {
  const { container } = mountPageFrame({
    root, user, onLoggedOut, navigate,
    activeKey: 'approvals',
    title: 'Approvals',
    subtitle: 'Everything waiting on you. Printing and signing are done on paper',
    icon: icons.checkCircle,
  });

  const body = h('div', 'tw-approvals appr-grid');
  container.append(body);

  const counts = new Map();

  async function load() {
    showLoading(body, 'Loading approvals');
    counts.clear();

    const mine = await getMyAuthority(user);
    if (mine.failed) {
      showError(body, null, load, 'Could not check your approval authority, so no queues can be shown.');
      return;
    }

    const nameOf = createNameLookup();
    const groups = buildGroups({ user, navigate, nameOf }).filter((g) => g.visible(mine.authority));

    if (groups.length === 0) {
      showEmpty(
        body,
        'Nothing waiting for you',
        'Your account holds no approval authority. An Admin can assign one under Personnel > Users.',
      );
      return;
    }

    body.innerHTML = '';
    const views = groups.map((group) => buildGroupCard(group, (total) => {
      counts.set(group.id, total);
    }));
    for (const view of views) body.appendChild(view.el);
    const outcomes = await Promise.all(views.map((view) => view.load()));
    if (outcomes.every((o) => o.ok)) return;
    if (outcomes.every((o) => !o.ok)) {
      showError(body, outcomes[0].error, load, 'Could not load the approval queues.');
    }
  }

  load();
}

function buildGroupCard(group, onCount) {
  const el = h('section', 'card tw-card tw-approvals__group appr-card');
  el.dataset.group = group.id;

  const head = h('div', 'tw-card__head tw-approvals__head appr-card__head');
  const titles = h('div', 'appr-card__titles');

  const titleWrap = h('div', 'appr-card__title-row');
  const iconSpan = h('span', 'appr-card__icon');
  if (group.icon) iconSpan.innerHTML = group.icon(18);
  const titleEl = h('h3', 'tw-card__title appr-card__title', group.title);
  titleWrap.append(iconSpan, titleEl);

  const subtitleEl = h('p', 'tw-card__subtitle appr-card__subtitle', group.hint);
  titles.append(titleWrap, subtitleEl);

  const countBadge = h('span', 'tw-count-badge appr-count-badge', '…');
  head.append(titles, countBadge);

  const content = h('div', 'tw-approvals__body appr-card__body');
  el.append(head, content);

  async function load() {
    showLoading(content, `Loading ${group.title}`);
    countBadge.textContent = '…';
    try {
      const { rows, total } = await group.load();
      countBadge.textContent = String(total);
      if (total > 0) countBadge.classList.add('appr-count-badge--active');
      onCount(total);
      renderRows(rows, total);
      return { ok: true };
    } catch (err) {
      countBadge.textContent = '!';
      countBadge.classList.add('appr-count-badge--error');
      showError(content, err, load, `Could not load ${group.title.toLowerCase()}.`);
      return { ok: false, error: err };
    }
  }

  function renderRows(rows, total) {
    content.innerHTML = '';
    if (rows.length === 0) {
      const emptyWrap = h('div', 'appr-empty-wrap');
      emptyWrap.innerHTML = `
        <span class="appr-empty-icon" aria-hidden="true">${icons.checkCircle ? icons.checkCircle(24) : '✓'}</span>
        <p class="tw-empty-note appr-empty-note">All caught up — no records waiting here.</p>
      `;
      content.appendChild(emptyWrap);
      return;
    }
    const list = h('ul', 'tw-queue appr-queue');
    for (const row of rows.slice(0, ROW_PREVIEW_LIMIT)) {
      const item = h('li', 'tw-queue__item appr-queue__item');
      
      const text = h('div', 'tw-queue__text appr-queue__text');
      const titleSpan = h('span', 'tw-queue__title appr-queue__title', row.title);
      
      // Structured metadata chips
      const chipsRow = h('div', 'appr-chips-row');
      if (row.date) {
        chipsRow.appendChild(h('span', 'appr-chip appr-chip--date', row.date));
      }
      if (row.zone) {
        chipsRow.appendChild(h('span', 'appr-chip appr-chip--zone', row.zone));
      }
      if (row.month) {
        chipsRow.appendChild(h('span', 'appr-chip appr-chip--month', row.month));
      }
      if (row.flagged && row.flagged > 0) {
        chipsRow.appendChild(h('span', 'appr-chip appr-chip--flag', `• ${row.flagged} to check`));
      }
      if (row.dates) {
        chipsRow.appendChild(h('span', 'appr-chip appr-chip--date', row.dates));
      }

      // Preserve tw-queue__detail for test contract compatibility
      const detailPill = h('span', 'tw-queue__detail sr-only', row.detail);
      text.append(titleSpan, chipsRow, detailPill);

      const open = h('button', 'ghost tw-queue__open appr-review-btn');
      open.type = 'button';
      open.setAttribute('aria-label', `Review ${row.title} — ${row.detail}`);
      open.innerHTML = `<span>Review</span><span aria-hidden="true">${icons.arrowRight ? icons.arrowRight(13) : '→'}</span>`;
      open.addEventListener('click', row.open);

      item.append(text, open);
      list.appendChild(item);
    }
    content.appendChild(list);

    // If queue is Annex D and has only 1-2 items, fill the lower dead space with a useful compliance checklist
    if (group.id === 'annex-d' && total <= 2) {
      const first = rows[0];
      const summaryCard = h('div', 'appr-annex-summary-card');
      summaryCard.innerHTML = `
        <div class="appr-annex-summary-head">
          <span class="appr-summary-pip" aria-hidden="true">📋</span>
          <strong>Annex D Steps</strong>
        </div>
        <ul class="appr-summary-list">
          <li><strong>Step 1:</strong> Click <em>Review</em> to preview the DILG Annex D sheet.</li>
          <li><strong>Step 2:</strong> Print on official Barangay Dao letterhead.</li>
          <li><strong>Step 3:</strong> Prepare the report here, then print it; the Punong Barangay signs on paper.</li>
          <li><strong>Step 4:</strong> Mark it submitted once it has been delivered.</li>
        </ul>
      `;
      content.appendChild(summaryCard);
    }

    const foot = h('div', 'tw-approvals__foot appr-card__foot');
    if (total > ROW_PREVIEW_LIMIT) {
      foot.appendChild(h('span', 'tw-approvals__more appr-more-pill', `+${total - ROW_PREVIEW_LIMIT} more in queue`));
    } else {
      foot.appendChild(h('span', 'appr-all-shown-note', `All ${total} displayed`));
    }
    const all = h('button', 'link-button appr-open-all-btn', group.openLabel);
    all.type = 'button';
    all.innerHTML = `<span>${group.openLabel}</span><span aria-hidden="true">→</span>`;
    all.addEventListener('click', group.openAll);
    foot.appendChild(all);
    content.appendChild(foot);
  }

  return { el, load };
}
