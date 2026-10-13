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

import { icons } from '../components/icons.js';
import {
  getShiftsByApproval, getAccomplishmentReports, getTermReports, getUserNames,
} from '../services/tanodWorkflowApi.js';
import {
  h, mountPageFrame, showLoading, showError, showEmpty, getMyAuthority,
  formatMonthLabel, formatDateOnly, formatManilaDate, formatShiftRange,
  formatShiftCode, formatAccomplishmentCode, formatAnnexDCode,
} from '../services/tanodWorkflowUi.js';

/** Extract 1–2 uppercase initials from a person/term label. */
function getInitials(label) {
  if (!label) return '•';
  const words = String(label).trim().split(/\s+/).filter(Boolean);
  if (words.length === 0) return '•';
  if (words.length === 1) return words[0].slice(0, 2).toUpperCase();
  return (words[0][0] + words[words.length - 1][0]).toUpperCase();
}

/** Extract time window from formatShiftRange ("Oct 20 · 8:00 am – 4:00 pm" -> "8:00 am – 4:00 pm"). */
function extractShiftHours(startAt, endAt) {
  if (!startAt || !endAt) return '';
  const range = formatShiftRange(startAt, endAt);
  if (!range || range === 'Time not recorded') return '';
  const parts = range.split(' · ');
  return parts.length > 1 ? parts[1] : range;
}

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
      kpiLabel: 'Shifts to Publish',
      workflowStep: '1. Print Schedule → 2. Sign on Paper → 3. Publish Week',
      columns: ['TANOD / SHIFT ID', 'SHIFT DATE & HOURS', 'PATROL ZONE', 'ACTION'],
      title: 'Shifts awaiting publish',
      hint: 'Draft shifts. Tanods only see a shift once it is published. Print the schedule and have it signed on paper, then publish the week.',
      icon: icons.shield || icons.calendar,
      tone: 'primary',
      visible: (a) => isManager || a.has('approve_roster'),
      load: async () => {
        const res = await getShiftsByApproval({ approvalStatus: 'draft', limit: 100 });
        await nameOf.ensure(res.items.filter((r) => r.userId !== null));
        return {
          total: res.total,
          rows: res.items.map((r) => ({
            key: r.shiftId,
            codeLabel: formatShiftCode(r.shiftId),
            title: person(r),
            date: formatManilaDate(r.startAt),
            hours: extractShiftHours(r.startAt, r.endAt),
            sortKey: r.startAt || '',
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
      kpiLabel: 'Reports Prepared',
      workflowStep: '1. Print Report → 2. Sign on Paper',
      columns: ['TANOD / REPORT ID', 'REPORT MONTH', 'INSPECTION STATUS', 'ACTION'],
      title: 'Accomplishment reports prepared',
      hint: 'Ready to print and sign. Printing and signing happen on paper, outside the app.',
      icon: icons.fileText,
      tone: 'info',
      visible: () => isManager,
      load: () => loadReports(['prepared']),
      openAll: () => navigate('accomplishment-reports', { status: 'prepared' }),
      openLabel: 'Open reports',
    },
    {
      id: 'annex-d',
      kpiLabel: 'Annex D to Prepare',
      workflowStep: '1. Prepare → 2. Print & Sign on Paper → 3. Submit',
      columns: ['TERM REPORT', 'COVERAGE PERIOD', 'STAGE & INCIDENTS', 'ACTION'],
      title: 'Annex D to prepare',
      hint: 'Draft and prepared term reports. Prepare the report, print it and have it signed on paper, then submit it.',
      icon: icons.calendar,
      tone: 'success',
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
      rows: items.map((r) => {
        const flaggedCount = Number(r.flaggedEntries) || 0;
        return {
          key: r.reportId,
          codeLabel: formatAccomplishmentCode(r.reportId),
          title: person(r),
          month: formatMonthLabel(r.month),
          sortKey: r.month || '',
          flagged: flaggedCount,
          statusLabel: flaggedCount > 0 ? 'Prepared' : 'Ready to Print & Sign',
          statusTone: flaggedCount > 0 ? 'info' : 'success',
          detail: formatMonthLabel(r.month),
          open: () => navigate('accomplishment-reports', { reportId: r.reportId }),
        };
      }),
    };
  }

  async function loadTerms(statuses) {
    const pages = await Promise.all(statuses.map((status) => getTermReports({ status, limit: 100 })));
    const items = pages.flatMap((res) => res.items);
    return {
      total: pages.reduce((sum, res) => sum + res.total, 0),
      rows: items.map((r) => ({
        key: r.reportId,
        codeLabel: formatAnnexDCode(r.reportId),
        title: r.termLabel,
        dates: `${formatDateOnly(r.termStart)} to ${formatDateOnly(r.termEnd)}`,
        sortKey: r.termStart || '',
        incidents: r.totalIncidents ?? 0,
        status: r.status,
        statusLabel: r.status === 'prepared' ? 'Prepared' : 'Draft',
        statusTone: r.status === 'prepared' ? 'info' : 'pending',
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

  container.classList.add('approvals-page-container');

  const body = h('div', 'tw-approvals appr-command-host');
  container.append(body);

  const counts = new Map();
  let activeQueueFilter = 'all';
  let currentSortField = 'date';
  let currentSortDir = 'desc';
  let currentSearchQuery = '';
  let groupViews = [];

  async function load() {
    showLoading(body, 'Loading approvals');
    counts.clear();
    groupViews = [];

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

    // Build Option D Unified Command Card
    const commandCard = h('div', 'unified-table-card approvals-command-card');

    // 1. Top Interactive KPI Filter Strip (replaces redundant duplicate chip bar)
    const kpiStrip = h('div', 'command-card-kpis approvals-kpi-strip');
    const kpiItemsMap = new Map();
    const kpiCountRefs = new Map();

    if (groups.length > 1) {
      const totalKpi = buildKpiItem({
        id: 'all',
        label: 'Total Waiting',
        tone: 'warning',
        iconFn: icons.clock || icons.checkCircle,
        isActive: true,
        onClick: () => setQueueFilter('all'),
      });
      kpiStrip.appendChild(totalKpi.el);
      kpiItemsMap.set('all', totalKpi.el);
      kpiCountRefs.set('all', totalKpi.valueEl);
    }

    for (const g of groups) {
      const isSingleGroup = groups.length === 1;
      const kpi = buildKpiItem({
        id: g.id,
        label: g.kpiLabel,
        tone: g.tone,
        iconFn: g.icon,
        isActive: isSingleGroup,
        onClick: () => setQueueFilter(isSingleGroup ? 'all' : g.id),
      });
      kpiStrip.appendChild(kpi.el);
      kpiItemsMap.set(g.id, kpi.el);
      kpiCountRefs.set(g.id, kpi.valueEl);
    }
    commandCard.appendChild(kpiStrip);

    // 2. Full-Width Toolbar (Search on left, Sort Field + Desc/Asc on right)
    const filterBar = h('div', 'approvals-filter-bar');

    const searchWrap = h('div', 'approvals-search-wrap');
    const searchIcon = h('span', 'approvals-search-icon');
    searchIcon.setAttribute('aria-hidden', 'true');
    searchIcon.innerHTML = icons.search(16);

    const searchLabel = h('label', 'sr-only', 'Search approvals');
    searchLabel.htmlFor = 'approvals-search-input';

    const searchInput = h('input', 'approvals-search-input');
    searchInput.id = 'approvals-search-input';
    searchInput.type = 'search';
    searchInput.placeholder = 'Search by tanod name, patrol zone, shift hours, month, or term…';
    searchInput.addEventListener('input', () => {
      currentSearchQuery = searchInput.value.trim().toLowerCase();
      applyFiltersAndSort();
    });
    searchWrap.append(searchIcon, searchLabel, searchInput);

    const toolbarRight = h('div', 'approvals-toolbar-right');

    // Sort Controls (Sort Field + Desc / Asc Segmented Toggle)
    const sortControls = h('div', 'citizen-sort-controls approvals-sort-controls');

    const sortSelectLabel = h('label', 'sr-only', 'Sort approvals by');
    sortSelectLabel.htmlFor = 'approvals-sort-field';

    const sortSelect = h('select', 'citizen-sort-select');
    sortSelect.id = 'approvals-sort-field';
    sortSelect.setAttribute('aria-label', 'Sort approvals by');
    [
      { value: 'date', label: 'Sort: Date / Period' },
      { value: 'title', label: 'Sort: Name / Title' },
    ].forEach(({ value, label }) => {
      const opt = h('option', null, label);
      opt.value = value;
      if (value === currentSortField) opt.selected = true;
      sortSelect.appendChild(opt);
    });

    sortSelect.addEventListener('change', () => {
      currentSortField = sortSelect.value;
      applyFiltersAndSort();
    });

    const sortDirGroup = h('div', 'citizen-sort-dir-group');
    sortDirGroup.setAttribute('role', 'group');
    sortDirGroup.setAttribute('aria-label', 'Sort direction');

    const descBtn = h('button', 'citizen-sort-dir-btn is-active', '↓ Desc');
    descBtn.type = 'button';
    descBtn.setAttribute('aria-label', 'Sort descending');
    descBtn.title = 'Descending order';

    const ascBtn = h('button', 'citizen-sort-dir-btn', '↑ Asc');
    ascBtn.type = 'button';
    ascBtn.setAttribute('aria-label', 'Sort ascending');
    ascBtn.title = 'Ascending order';

    descBtn.addEventListener('click', () => {
      if (currentSortDir === 'desc') return;
      currentSortDir = 'desc';
      descBtn.classList.add('is-active');
      ascBtn.classList.remove('is-active');
      applyFiltersAndSort();
    });

    ascBtn.addEventListener('click', () => {
      if (currentSortDir === 'asc') return;
      currentSortDir = 'asc';
      ascBtn.classList.add('is-active');
      descBtn.classList.remove('is-active');
      applyFiltersAndSort();
    });

    sortDirGroup.append(descBtn, ascBtn);
    sortControls.append(sortSelectLabel, sortSelect, sortDirGroup);
    toolbarRight.appendChild(sortControls);

    filterBar.append(searchWrap, toolbarRight);
    commandCard.appendChild(filterBar);

    // 3. Scrollable Queue Body inside Command Card
    const scrollBody = h('div', 'approvals-scroll-body');
    commandCard.appendChild(scrollBody);
    body.appendChild(commandCard);

    function syncAllCounts() {
      let grandTotal = 0;
      for (const g of groups) {
        const c = counts.get(g.id) ?? 0;
        grandTotal += c;
        const kpiEl = kpiCountRefs.get(g.id);
        if (kpiEl) kpiEl.textContent = String(c);
      }
      const totalKpiEl = kpiCountRefs.get('all');
      if (totalKpiEl) totalKpiEl.textContent = String(grandTotal);
    }

    function setQueueFilter(filterId) {
      // Clicking an already-active specific queue tile toggles back to 'all'
      if (filterId !== 'all' && activeQueueFilter === filterId && groups.length > 1) {
        activeQueueFilter = 'all';
      } else {
        activeQueueFilter = filterId;
      }
      for (const [id, el] of kpiItemsMap.entries()) {
        const isCurrent = id === activeQueueFilter;
        el.classList.toggle('is-active', isCurrent);
        el.setAttribute('aria-pressed', isCurrent ? 'true' : 'false');
      }
      applyFiltersAndSort();
    }

    function applyFiltersAndSort() {
      for (const view of groupViews) {
        const matchesTab = activeQueueFilter === 'all' || activeQueueFilter === view.groupId;
        view.el.hidden = !matchesTab;
        view.applyFilterAndSort(currentSearchQuery, currentSortField, currentSortDir);
      }
    }

    groupViews = groups.map((group) => buildGroupSection(group, (total) => {
      counts.set(group.id, total);
      syncAllCounts();
    }));

    for (const view of groupViews) {
      scrollBody.appendChild(view.el);
    }

    const outcomes = await Promise.all(groupViews.map((view) => view.load()));
    if (outcomes.every((o) => o.ok)) return;
    if (outcomes.every((o) => !o.ok)) {
      showError(body, outcomes[0].error, load, 'Could not load the approval queues.');
    }
  }

  load();
}

function buildKpiItem({ id, label, tone, iconFn, isActive, onClick }) {
  const el = h('div', `command-kpi approvals-kpi-item ${isActive ? 'is-active' : ''}`);
  el.dataset.queue = id;
  el.setAttribute('role', 'button');
  el.setAttribute('tabindex', '0');
  el.setAttribute('aria-pressed', isActive ? 'true' : 'false');

  if (onClick) {
    el.addEventListener('click', onClick);
    el.addEventListener('keydown', (e) => {
      if (e.key === 'Enter' || e.key === ' ') {
        e.preventDefault();
        onClick();
      }
    });
  }

  const iconWrap = h('div', `command-kpi__icon command-kpi__icon--${tone}`);
  iconWrap.setAttribute('aria-hidden', 'true');
  if (iconFn) iconWrap.innerHTML = iconFn(18);

  const info = h('div', 'command-kpi__body');
  const labelEl = h('span', 'command-kpi__label', label);
  const valueEl = h('span', 'command-kpi__value', '…');
  info.append(labelEl, valueEl);

  el.append(iconWrap, info);
  return { el, valueEl };
}

function buildGroupSection(group, onCount) {
  const el = h('section', 'tw-approvals__group appr-section');
  el.dataset.group = group.id;

  // Section Header Bar
  const head = h('div', 'tw-card__head tw-approvals__head appr-section__head');

  const headLeft = h('div', 'appr-section__head-left');
  const iconSpan = h('span', `appr-card__icon appr-card__icon--${group.tone}`);
  iconSpan.setAttribute('aria-hidden', 'true');
  if (group.icon) iconSpan.innerHTML = group.icon(16);

  const titleWrap = h('div', 'appr-section__title-stack');
  const titleRow = h('div', 'appr-section__title-row');
  const titleEl = h('h3', 'tw-card__title appr-card__title', group.title);
  const countBadge = h('span', 'tw-count-badge appr-count-badge', '…');
  const workflowPill = h('span', 'appr-workflow-pill', group.workflowStep);
  titleRow.append(titleEl, countBadge, workflowPill);

  const subtitleEl = h('p', 'tw-card__subtitle appr-card__subtitle', group.hint);
  titleWrap.append(titleRow, subtitleEl);
  headLeft.append(iconSpan, titleWrap);

  const headRight = h('div', 'appr-section__head-right');
  const allBtn = h('button', 'appr-open-all-btn');
  allBtn.type = 'button';
  allBtn.innerHTML = `<span>${group.openLabel}</span><span class="appr-open-all-btn__arrow" aria-hidden="true">→</span>`;
  allBtn.addEventListener('click', group.openAll);
  headRight.appendChild(allBtn);

  head.append(headLeft, headRight);

  // Scannable 4-Column Table Header Bar
  const tableHead = h('div', 'appr-table-head');
  tableHead.setAttribute('aria-hidden', 'true');
  const [col1, col2, col3, col4] = group.columns || ['RECORD', 'SCHEDULE / PERIOD', 'DETAILS', 'ACTION'];
  tableHead.append(
    h('span', 'appr-table-head__col', col1),
    h('span', 'appr-table-head__col', col2),
    h('span', 'appr-table-head__col', col3),
    h('span', 'appr-table-head__col appr-table-head__col--right', col4),
  );

  const content = h('div', 'tw-approvals__body appr-section__body');
  el.append(head, tableHead, content);

  let loadedRows = [];
  let hasLoaded = false;

  async function load() {
    showLoading(content, `Loading ${group.title}`);
    countBadge.textContent = '…';
    try {
      const { rows, total } = await group.load();
      loadedRows = rows;
      hasLoaded = true;
      countBadge.textContent = String(total);
      countBadge.classList.toggle('appr-count-badge--active', total > 0);
      onCount(total);
      renderRows(loadedRows);
      return { ok: true };
    } catch (err) {
      countBadge.textContent = '!';
      countBadge.classList.add('appr-count-badge--error');
      showError(content, err, load, `Could not load ${group.title.toLowerCase()}.`);
      return { ok: false, error: err };
    }
  }

  function applyFilterAndSort(query, sortField, sortDir) {
    if (!hasLoaded) return;
    let filtered = [...loadedRows];
    if (query) {
      filtered = filtered.filter((r) => {
        const haystack = `${r.title} ${r.codeLabel || ''} #${r.key} ${r.detail || ''} ${r.zone || ''} ${r.hours || ''} ${r.month || ''} ${r.dates || ''} ${r.statusLabel || ''}`.toLowerCase();
        return haystack.includes(query);
      });
    }
    const dir = sortDir === 'asc' ? 1 : -1;
    filtered.sort((a, b) => {
      const ak = sortField === 'title' ? String(a.title || '').toLowerCase() : String(a.sortKey || a.title || '');
      const bk = sortField === 'title' ? String(b.title || '').toLowerCase() : String(b.sortKey || b.title || '');
      if (ak < bk) return -1 * dir;
      if (ak > bk) return 1 * dir;
      return (Number(a.key) - Number(b.key)) * dir;
    });
    renderRows(filtered, Boolean(query));
  }

  function renderRows(rows, isFiltered = false) {
    content.innerHTML = '';
    tableHead.hidden = rows.length === 0;

    if (rows.length === 0) {
      const emptyWrap = h('div', 'appr-empty-wrap');
      emptyWrap.innerHTML = `
        <span class="appr-empty-icon" aria-hidden="true">${icons.checkCircle ? icons.checkCircle(20) : '✓'}</span>
        <p class="tw-empty-note appr-empty-note">${isFiltered ? 'No matching records in this queue.' : 'All caught up — no records waiting here.'}</p>
      `;
      content.appendChild(emptyWrap);
      return;
    }

    const list = h('ul', 'tw-queue appr-table-list');
    for (const row of rows) {
      const item = h('li', 'tw-queue__item appr-row');
      item.addEventListener('click', (e) => {
        if (e.target.closest('button')) return;
        row.open();
      });

      // Column 1: Avatar + Title + Specific Record ID
      const primaryCol = h('div', 'tw-queue__text appr-row__primary');
      const avatar = h('span', `appr-avatar appr-avatar--${group.tone}`, getInitials(row.title));
      avatar.setAttribute('aria-hidden', 'true');

      const primaryText = h('div', 'appr-row__title-wrap');
      const titleSpan = h('span', 'tw-queue__title appr-row__title', row.title);
      const codeSub = h('span', 'appr-row__code', row.codeLabel || '');
      const detailPill = h('span', 'tw-queue__detail sr-only', row.detail);
      primaryText.append(titleSpan, codeSub, detailPill);
      primaryCol.append(avatar, primaryText);

      // Column 2: Schedule / Date + Shift Hours / Period
      const periodCol = h('div', 'appr-row__period');
      const periodText = row.date || row.month || row.dates || '—';
      const periodBadge = h('span', 'appr-chip appr-chip--date', periodText);
      periodCol.appendChild(periodBadge);
      if (row.hours) {
        const hoursSpan = h('span', 'appr-row__hours', row.hours);
        periodCol.appendChild(hoursSpan);
      }

      // Column 3: Patrol Zone / Inspection Status / Flags
      const metaCol = h('div', 'appr-row__meta');
      if (row.zone) {
        metaCol.appendChild(h('span', 'appr-chip appr-chip--zone', row.zone));
      }
      if (row.statusLabel) {
        metaCol.appendChild(h('span', `appr-chip appr-chip--status-${row.statusTone || 'pending'}`, row.statusLabel));
      }
      if (row.flagged && row.flagged > 0) {
        metaCol.appendChild(h('span', 'appr-chip appr-chip--flag', `• ${row.flagged} to check`));
      }
      if (row.incidents !== undefined) {
        metaCol.appendChild(h('span', 'appr-chip appr-chip--neutral', `${row.incidents} ${row.incidents === 1 ? 'incident' : 'incidents'}`));
      }

      // Column 4: Action Button
      const actionCol = h('div', 'appr-row__action');
      const open = h('button', 'ghost tw-queue__open appr-review-btn');
      open.type = 'button';
      open.setAttribute('aria-label', `Review ${row.title} — ${row.detail}`);
      open.innerHTML = `<span>Review</span><span aria-hidden="true">${icons.arrowRight ? icons.arrowRight(13) : '→'}</span>`;
      open.addEventListener('click', (e) => {
        e.stopPropagation();
        row.open();
      });
      actionCol.appendChild(open);

      item.append(primaryCol, periodCol, metaCol, actionCol);
      list.appendChild(item);
    }
    content.appendChild(list);
  }

  return { groupId: group.id, el, load, applyFilterAndSort };
}
