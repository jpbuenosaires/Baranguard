/**
 * approvals.js — Approvals queue (contract §10): one place where an
 * official sees every record waiting on THEM — availability to review,
 * draft shifts to publish, accomplishment reports to note / approve, and
 * Annex D term reports to prepare / approve — each row deep-linking to the
 * screen where the action is taken.
 *
 * Role/authority gating is UX only (REFERENCE.md §2 Rule 2: the server
 * re-checks every action). A group is shown only when the viewer can act
 * on it:
 *   - availability to review ........ role admin or secretary
 *   - shifts awaiting publish ....... authority approve_roster
 *   - reports to note ............... authority note_report
 *   - reports to approve ............ authority approve_report
 *   - Annex D to prepare ............ authority prepare_annex_d
 *   - Annex D to approve ............ authority approve_annex_d
 * The viewer's authority comes from GET /users/:id (their own record).
 *
 * Each group has its own Loading / Empty / Error-with-retry / Populated
 * states, so one failing endpoint never blanks the whole page.
 */

import { StatStrip } from '../components/StatStrip.js';
import { icons } from '../components/icons.js';
import {
  getAvailability, getShiftsByApproval, getAccomplishmentReports, getTermReports, getUserNames,
} from '../services/tanodWorkflowApi.js';
import {
  h, mountPageFrame, showLoading, showError, showEmpty, getMyAuthority,
  formatMonthLabel, formatDateOnly, formatManilaDate,
} from '../services/tanodWorkflowUi.js';

const ROW_PREVIEW_LIMIT = 6;

/**
 * Group definitions. `visible` decides whether the viewer can act on it,
 * `load` returns `{rows, total}` where each row is `{key, title, detail, open}`.
 */
function buildGroups({ user, navigate, nameOf }) {
  const person = (row) => {
    if (row.userId === null || row.userId === undefined) return 'Unassigned shift';
    return row.fullName || nameOf(row.userId) || `Tanod #${row.userId}`;
  };

  return [
    {
      id: 'availability',
      title: 'Availability to review',
      hint: 'Tanod availability waiting for you to accept or ask them to revise.',
      visible: () => user.role === 'admin' || user.role === 'secretary',
      load: async () => {
        const res = await getAvailability({ status: 'submitted', limit: 100 });
        await nameOf.ensure(res.items);
        return {
          total: res.total,
          rows: res.items.map((r) => ({
            key: r.availId,
            title: person(r),
            detail: `${formatDateOnly(r.periodStart)} to ${formatDateOnly(r.periodEnd)}`,
            open: () => navigate('personnel', { tab: 'scheduler' }),
          })),
        };
      },
      openAll: () => navigate('personnel', { tab: 'scheduler' }),
      openLabel: 'Open Scheduler',
    },
    {
      id: 'shifts',
      title: 'Shifts awaiting publish',
      hint: 'Draft shifts. Tanods only see a shift once it is published.',
      visible: (a) => a.has('approve_roster'),
      load: async () => {
        const res = await getShiftsByApproval({ approvalStatus: 'draft', limit: 100 });
        await nameOf.ensure(res.items.filter((r) => r.userId !== null));
        return {
          total: res.total,
          rows: res.items.map((r) => ({
            key: r.shiftId,
            title: person(r),
            detail: `${formatManilaDate(r.startAt)}${r.patrolZone ? ` · ${r.patrolZone}` : ''}`,
            open: () => navigate('personnel', { tab: 'scheduler' }),
          })),
        };
      },
      openAll: () => navigate('personnel', { tab: 'scheduler' }),
      openLabel: 'Open Scheduler',
    },
    {
      id: 'note',
      title: 'Accomplishment reports to note',
      hint: 'Reports a tanod has submitted and nobody has noted yet.',
      visible: (a) => a.has('note_report'),
      load: () => loadReports('prepared'),
      openAll: () => navigate('accomplishment-reports', { status: 'prepared' }),
      openLabel: 'Open reports',
    },
    {
      id: 'approve',
      title: 'Accomplishment reports to approve',
      hint: 'Noted reports waiting for final approval.',
      visible: (a) => a.has('approve_report'),
      load: () => loadReports('noted'),
      openAll: () => navigate('accomplishment-reports', { status: 'noted' }),
      openLabel: 'Open reports',
    },
    {
      id: 'annex-prepare',
      title: 'Annex D to prepare',
      hint: 'Draft term reports. Preparing recomputes the counts from live data.',
      visible: (a) => a.has('prepare_annex_d'),
      load: () => loadTerms('draft'),
      openAll: () => navigate('school-zones', { tab: 'term' }),
      openLabel: 'Open Term Report',
    },
    {
      id: 'annex-approve',
      title: 'Annex D to approve',
      hint: 'Prepared term reports waiting for approval.',
      visible: (a) => a.has('approve_annex_d'),
      load: () => loadTerms('prepared'),
      openAll: () => navigate('school-zones', { tab: 'term' }),
      openLabel: 'Open Term Report',
    },
  ];

  async function loadReports(status) {
    const res = await getAccomplishmentReports({ status, limit: 100 });
    await nameOf.ensure(res.items);
    return {
      total: res.total,
      rows: res.items.map((r) => ({
        key: r.reportId,
        title: person(r),
        detail: formatMonthLabel(r.month),
        open: () => navigate('accomplishment-reports', { reportId: r.reportId }),
      })),
    };
  }

  async function loadTerms(status) {
    const res = await getTermReports({ status, limit: 100 });
    return {
      total: res.total,
      rows: res.items.map((r) => ({
        key: r.reportId,
        title: r.termLabel,
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
    subtitle: 'Everything waiting on your review, note, approval or publish',
    icon: icons.checkCircle,
  });

  const stripHost = h('div', 'tw-strip-host');
  const body = h('div', 'tw-approvals');
  container.append(stripHost, body);

  const counts = new Map();

  function renderStrip(groups) {
    stripHost.innerHTML = '';
    const items = groups.map((g) => ({
      label: g.title,
      value: counts.has(g.id) ? counts.get(g.id) : '…',
      tone: counts.get(g.id) > 0 ? 'warning' : 'default',
    }));
    stripHost.appendChild(StatStrip({ items }));
  }

  async function load() {
    showLoading(body, 'Loading approvals');
    stripHost.innerHTML = '';
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
        'Nothing for you to approve',
        'Your account holds no approval authority. An Admin can assign one under Personnel > Users.',
      );
      return;
    }

    body.innerHTML = '';
    renderStrip(groups);
    const views = groups.map((group) => buildGroupCard(group, (total) => {
      counts.set(group.id, total);
      renderStrip(groups);
    }));
    for (const view of views) body.appendChild(view.el);
    const outcomes = await Promise.all(views.map((view) => view.load()));
    // One failing queue keeps its own Retry. If EVERY queue failed the
    // problem is the server or the connection, so offer one page-level Retry.
    if (outcomes.every((o) => o.ok)) return;
    if (outcomes.every((o) => !o.ok)) {
      stripHost.innerHTML = '';
      showError(body, outcomes[0].error, load, 'Could not load the approval queues.');
    }
  }

  load();
}

function buildGroupCard(group, onCount) {
  const el = h('section', 'card tw-card tw-approvals__group');
  el.dataset.group = group.id;

  const head = h('div', 'tw-card__head tw-approvals__head');
  const titles = h('div');
  titles.append(h('h3', 'tw-card__title', group.title), h('p', 'tw-card__subtitle', group.hint));
  const countBadge = h('span', 'tw-count-badge', '…');
  head.append(titles, countBadge);

  const content = h('div', 'tw-approvals__body');
  el.append(head, content);

  async function load() {
    showLoading(content, `Loading ${group.title}`);
    countBadge.textContent = '…';
    try {
      const { rows, total } = await group.load();
      countBadge.textContent = String(total);
      onCount(total);
      renderRows(rows, total);
      return { ok: true };
    } catch (err) {
      countBadge.textContent = '!';
      showError(content, err, load, `Could not load ${group.title.toLowerCase()}.`);
      return { ok: false, error: err };
    }
  }

  function renderRows(rows, total) {
    content.innerHTML = '';
    if (rows.length === 0) {
      content.appendChild(h('p', 'tw-empty-note', 'Nothing waiting here.'));
      return;
    }
    const list = h('ul', 'tw-queue');
    for (const row of rows.slice(0, ROW_PREVIEW_LIMIT)) {
      const item = h('li', 'tw-queue__item');
      const text = h('div', 'tw-queue__text');
      text.append(h('span', 'tw-queue__title', row.title), h('span', 'tw-queue__detail', row.detail));
      const open = h('button', 'ghost tw-queue__open', 'Review');
      open.type = 'button';
      open.setAttribute('aria-label', `Review ${row.title} — ${row.detail}`);
      open.addEventListener('click', row.open);
      item.append(text, open);
      list.appendChild(item);
    }
    content.appendChild(list);

    const foot = h('div', 'tw-approvals__foot');
    if (total > ROW_PREVIEW_LIMIT) foot.appendChild(h('span', 'tw-approvals__more', `${total - ROW_PREVIEW_LIMIT} more not shown`));
    const all = h('button', 'link-button', group.openLabel);
    all.type = 'button';
    all.addEventListener('click', group.openAll);
    foot.appendChild(all);
    content.appendChild(foot);
  }

  return { el, load };
}
