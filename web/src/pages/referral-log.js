/**
 * referral-log.js — Referral Log (contract §5 / §10): which incidents the
 * barangay delegated to which office (PNP, BFP, ambulance, VAW desk, ...)
 * and when.
 *
 * Overhauled with:
 *   - 5-Card Interactive Agency KPI Command Strip with persistent baseline counts
 *   - Full-width search bar, multi-column sort controls & stateful filter reset
 *   - WCAG 2.2 AA semantic agency badges for PNP, BFP, EMS, DOH, DPWH, VAW, LGU, Brgy
 *   - Enriched Incident Case (INC + REF-xxxx) & Reference No. cells
 *   - Direct incident deep links & informative empty state
 */

import { DataTable } from '../components/DataTable.js';
import { icons } from '../components/icons.js';
import { showToast } from '../components/Toast.js';
import { getReferrals, REFERRED_TO_LABELS } from '../services/tanodWorkflowApi.js';
import {
  h, mountPageFrame, showLoading, showError, showEmpty, selectOf, formatManilaDateTime,
  formatIncidentCode,
} from '../services/tanodWorkflowUi.js';

const PAGE_SIZE = 25;
const PRIMARY_AGENCIES = new Set(['pnp', 'bfp', 'ambulance_ems']);

const COLUMNS = [
  { key: 'incident', label: 'Incident Case', sortable: true, width: '20%' },
  { key: 'type', label: 'Incident Type', sortable: true, width: '13%' },
  { key: 'to', label: 'Referred Agency / Office', sortable: true, width: '21%' },
  { key: 'when', label: 'Referred At (Manila Time)', sortable: true, width: '20%' },
  { key: 'ref', label: 'Reference No.', sortable: true, width: '12%' },
  { key: 'action', label: 'Action', align: 'right', width: '14%' },
];

function typeLabel(value) {
  if (!value) return '—';
  const text = String(value).replace(/_/g, ' ');
  return text.charAt(0).toUpperCase() + text.slice(1);
}

function formatReferralCode(referralId) {
  const num = Number(referralId);
  if (!Number.isFinite(num) || num <= 0) return '—';
  return `REF-${String(num).padStart(4, '0')}`;
}

function agencyBadge(referredTo, otherText) {
  const base = REFERRED_TO_LABELS[referredTo] || referredTo || '—';
  const label = otherText ? `${base} — ${otherText}` : base;

  let modifier = 'other';
  if (referredTo === 'pnp') modifier = 'pnp';
  else if (referredTo === 'bfp') modifier = 'bfp';
  else if (referredTo === 'ambulance_ems') modifier = 'ems';
  else if (referredTo === 'doh') modifier = 'doh';
  else if (referredTo === 'dpwh') modifier = 'dpwh';
  else if (referredTo === 'vaw_desk') modifier = 'vaw';
  else if (referredTo === 'higher_lgu' || referredTo === 'social_welfare') modifier = 'lgu';
  else if (referredTo === 'barangay_official') modifier = 'brgy';

  const pill = h('span', `tw-ref-agency-pill tw-ref-agency-pill--${modifier}`);
  const dot = h('span', 'tw-ref-agency-pill__dot');
  dot.setAttribute('aria-hidden', 'true');
  const txt = h('span', 'tw-ref-agency-pill__text', label);
  pill.append(dot, txt);
  return pill;
}

/**
 * @param {HTMLElement} root
 * @param {{userId:number, fullName:string, role:string, barangayId:number}} user
 * @param {() => void} onLoggedOut
 * @param {(page:string, param?:any) => void} navigate
 */
export function renderReferralLogPage(root, user, onLoggedOut, navigate) {
  const { container } = mountPageFrame({
    root, user, onLoggedOut, navigate,
    activeKey: 'referrals',
    title: 'Referral Log',
    subtitle: 'Incidents referred to PNP, BFP, EMS, the Lupon and other offices',
    icon: icons.send,
  });

  const state = {
    from: '',
    to: '',
    referredTo: '',
    otherGroupOnly: false,
    search: '',
    sortBy: 'when',
    sortDir: 'desc',
    page: 1,
  };
  let lastResult = null;
  let baselineCounts = null;

  const kpisHost = h('div', 'ref-kpi-grid');
  kpisHost.setAttribute('role', 'toolbar');
  kpisHost.setAttribute('aria-label', 'Filter referrals by agency');

  // Consolidated Control Bar
  const controlBar = h('div', 'ref-control-bar');

  // Full-width Search input with inline clear button
  const searchWrap = h('div', 'ref-search-box');
  searchWrap.innerHTML = `<span class="ref-search-icon" aria-hidden="true">${icons.search ? icons.search(16) : '🔍'}</span>`;
  const searchInput = document.createElement('input');
  searchInput.type = 'search';
  searchInput.className = 'ref-search-input';
  searchInput.id = 'tw-ref-search';
  searchInput.placeholder = 'Search incident ID (INC-2026-048), referral code (REF-0012), incident type, agency, or reference no.…';
  searchInput.setAttribute('aria-label', 'Search referrals by incident ID, type, agency, or reference number');

  const searchClearBtn = h('button', 'ref-search-clear');
  searchClearBtn.type = 'button';
  searchClearBtn.hidden = true;
  searchClearBtn.setAttribute('aria-label', 'Clear search text');
  searchClearBtn.innerHTML = icons.x ? icons.x(14) : '×';
  searchWrap.append(searchInput, searchClearBtn);

  // Date range picker group
  const dateGroup = h('div', 'ref-date-group');
  const fromInput = document.createElement('input');
  fromInput.type = 'date';
  fromInput.id = 'tw-ref-from';
  fromInput.className = 'ref-date-input';
  fromInput.setAttribute('aria-label', 'From date');

  const toInput = document.createElement('input');
  toInput.type = 'date';
  toInput.id = 'tw-ref-to';
  toInput.className = 'ref-date-input';
  toInput.setAttribute('aria-label', 'To date');

  const fromWrap = h('div', 'ref-date-field');
  const fromLbl = h('label', '', 'From');
  fromLbl.htmlFor = 'tw-ref-from';
  fromWrap.append(fromLbl, fromInput);

  const toWrap = h('div', 'ref-date-field');
  const toLbl = h('label', '', 'To');
  toLbl.htmlFor = 'tw-ref-to';
  toWrap.append(toLbl, toInput);

  dateGroup.append(fromWrap, h('span', 'ref-date-arrow', '→'), toWrap);

  // Destination select
  const destSelect = selectOf(
    Object.entries(REFERRED_TO_LABELS).map(([value, label]) => ({ value, label })),
    { placeholder: 'All destinations' },
  );
  destSelect.id = 'tw-ref-dest';
  destSelect.className = 'ref-select';
  destSelect.setAttribute('aria-label', 'Filter by referred agency destination');

  const destWrap = h('div', 'ref-select-field');
  const destLbl = h('label', '', 'Destination');
  destLbl.htmlFor = 'tw-ref-dest';
  destWrap.append(destLbl, destSelect);

  // Sort controls (Field + Asc/Desc toggle)
  const sortGroup = h('div', 'ref-sort-group');
  const sortSelect = document.createElement('select');
  sortSelect.className = 'ref-select ref-sort-select';
  sortSelect.setAttribute('aria-label', 'Sort referrals by column');
  const sortOptions = [
    ['when', 'Sort: Referred At'],
    ['incident', 'Sort: Incident Case'],
    ['to', 'Sort: Agency / Office'],
    ['type', 'Sort: Incident Type'],
    ['ref', 'Sort: Reference No.'],
  ];
  for (const [val, text] of sortOptions) {
    const opt = document.createElement('option');
    opt.value = val;
    opt.textContent = text;
    sortSelect.appendChild(opt);
  }
  sortSelect.value = state.sortBy;

  const sortDirBtn = h('button', 'ghost ref-sort-dir-btn');
  sortDirBtn.type = 'button';
  const syncSortDirBtn = () => {
    const isDesc = state.sortDir === 'desc';
    sortDirBtn.textContent = isDesc ? '↓ Desc' : '↑ Asc';
    sortDirBtn.setAttribute('aria-label', `Sort direction: ${isDesc ? 'Descending' : 'Ascending'}`);
    sortDirBtn.title = isDesc ? 'Descending order (click for Ascending)' : 'Ascending order (click for Descending)';
  };
  syncSortDirBtn();
  sortGroup.append(sortSelect, sortDirBtn);

  // Clear filters button (stateful)
  const clear = h('button', 'ghost ref-clear-btn', 'Clear filters');
  clear.type = 'button';
  clear.setAttribute('aria-label', 'Clear all active filters');

  const syncClearButtonState = () => {
    const activeCount =
      (state.from ? 1 : 0) +
      (state.to ? 1 : 0) +
      (state.referredTo || state.otherGroupOnly ? 1 : 0) +
      (state.search ? 1 : 0);
    searchClearBtn.hidden = !searchInput.value;
    clear.disabled = activeCount === 0;
    clear.classList.toggle('is-active', activeCount > 0);
    clear.textContent = activeCount > 0 ? `Clear filters (${activeCount})` : 'Clear filters';
  };
  syncClearButtonState();

  controlBar.append(searchWrap, dateGroup, destWrap, sortGroup, clear);

  const body = h('div', 'tw-referrals__body');

  const tableCard = h('div', 'ref-table-card unified-table-card');
  tableCard.append(kpisHost, controlBar, body);

  container.appendChild(tableCard);

  const apply = () => {
    state.from = fromInput.value;
    state.to = toInput.value;
    state.referredTo = destSelect.value;
    if (state.referredTo) state.otherGroupOnly = false;
    state.search = searchInput.value.trim().toLowerCase();
    state.page = 1;
    syncClearButtonState();
    load();
  };

  let searchDebounce = null;
  searchInput.addEventListener('input', () => {
    searchClearBtn.hidden = !searchInput.value;
    clearTimeout(searchDebounce);
    searchDebounce = setTimeout(() => {
      state.search = searchInput.value.trim().toLowerCase();
      syncClearButtonState();
      if (lastResult) render(lastResult);
    }, 180);
  });

  searchClearBtn.addEventListener('click', () => {
    searchInput.value = '';
    state.search = '';
    syncClearButtonState();
    if (lastResult) render(lastResult);
    searchInput.focus();
  });

  fromInput.addEventListener('change', apply);
  toInput.addEventListener('change', apply);
  destSelect.addEventListener('change', () => {
    state.otherGroupOnly = false;
    apply();
  });

  sortSelect.addEventListener('change', () => {
    state.sortBy = sortSelect.value;
    if (lastResult) render(lastResult);
  });

  sortDirBtn.addEventListener('click', () => {
    state.sortDir = state.sortDir === 'desc' ? 'asc' : 'desc';
    syncSortDirBtn();
    if (lastResult) render(lastResult);
  });

  clear.addEventListener('click', () => {
    fromInput.value = '';
    toInput.value = '';
    destSelect.value = '';
    searchInput.value = '';
    state.otherGroupOnly = false;
    apply();
  });

  function computeAgencyBreakdown(total, items) {
    const pnp = items.filter((r) => r.referredTo === 'pnp').length;
    const bfp = items.filter((r) => r.referredTo === 'bfp').length;
    const ems = items.filter((r) => r.referredTo === 'ambulance_ems').length;
    const otherOnPage = items.filter((r) => !PRIMARY_AGENCIES.has(r.referredTo)).length;
    return {
      total: total ?? items.length,
      pnp,
      ems,
      bfp,
      other: otherOnPage,
    };
  }

  function renderKpiStrip(total, items) {
    kpisHost.innerHTML = '';
    if (!state.referredTo) {
      baselineCounts = computeAgencyBreakdown(total, items);
    }
    const counts = baselineCounts || computeAgencyBreakdown(total, items);

    const cards = [
      {
        label: 'Total Referrals',
        sub: 'All delegated cases',
        val: counts.total,
        tone: 'primary',
        icon: icons.send ? icons.send(18) : '📨',
        filter: '',
        isOtherGroup: false,
      },
      {
        label: 'PNP (Police)',
        sub: 'Law enforcement & WCPD',
        val: state.referredTo === 'pnp' ? total : counts.pnp,
        tone: 'info',
        icon: icons.shield ? icons.shield(18) : '🛡️',
        filter: 'pnp',
        isOtherGroup: false,
      },
      {
        label: 'EMS / Ambulance',
        sub: 'Emergency medical transport',
        val: state.referredTo === 'ambulance_ems' ? total : counts.ems,
        tone: 'success',
        icon: icons.activity ? icons.activity(18) : '🚑',
        filter: 'ambulance_ems',
        isOtherGroup: false,
      },
      {
        label: 'BFP (Fire)',
        sub: 'Fire & rescue operations',
        val: state.referredTo === 'bfp' ? total : counts.bfp,
        tone: 'warning',
        icon: icons.alertTriangle ? icons.alertTriangle(18) : '🚒',
        filter: 'bfp',
        isOtherGroup: false,
      },
      {
        label: 'DOH / DPWH / LGU / VAW',
        sub: 'Health, engineering & social desks',
        val: counts.other,
        tone: 'neutral',
        icon: icons.users ? icons.users(18) : '🏛️',
        filter: '',
        isOtherGroup: true,
      },
    ];

    for (const c of cards) {
      const isActive = c.isOtherGroup
        ? state.otherGroupOnly
        : (!state.otherGroupOnly && state.referredTo === c.filter);

      const cardBtn = h('button', `ref-kpi-card ref-kpi-card--${c.tone}${isActive ? ' is-active' : ''}`);
      cardBtn.type = 'button';
      cardBtn.setAttribute('aria-pressed', isActive ? 'true' : 'false');
      cardBtn.setAttribute('aria-label', `Filter by ${c.label} (${c.val})`);

      const iconBox = h('span', `ref-kpi-card__icon ref-kpi-card__icon--${c.tone}`);
      iconBox.setAttribute('aria-hidden', 'true');
      iconBox.innerHTML = c.icon;

      const content = h('div', 'ref-kpi-card__body');
      const topRow = h('div', 'ref-kpi-card__top');
      topRow.append(
        h('span', 'ref-kpi-card__label', c.label),
        h('span', 'ref-kpi-card__value', String(c.val)),
      );
      const subRow = h('span', 'ref-kpi-card__sub', c.sub);
      content.append(topRow, subRow);

      cardBtn.append(iconBox, content);
      cardBtn.addEventListener('click', () => {
        if (c.isOtherGroup) {
          state.otherGroupOnly = !state.otherGroupOnly;
          destSelect.value = '';
          state.referredTo = '';
          syncClearButtonState();
          if (lastResult && !state.referredTo) {
            render(lastResult);
          } else {
            load();
          }
          return;
        }
        state.otherGroupOnly = false;
        if (state.referredTo === c.filter) {
          destSelect.value = '';
        } else {
          destSelect.value = c.filter;
        }
        apply();
      });
      kpisHost.appendChild(cardBtn);
    }
  }

  async function load() {
    if (state.from && state.to && state.from > state.to) {
      showEmpty(body, 'Check the date range', 'The From date is after the To date. Adjust the range to see referrals.');
      return;
    }
    showLoading(body, 'Loading referrals');
    try {
      const res = await getReferrals({
        from: state.from, to: state.to, referredTo: state.referredTo, page: state.page, limit: PAGE_SIZE,
      });
      lastResult = res;
      render(res);
    } catch (err) {
      showError(body, err, load, 'Could not load the referral log.');
    }
  }

  function sortRows(items) {
    const dir = state.sortDir === 'asc' ? 1 : -1;
    return items.slice().sort((a, b) => {
      switch (state.sortBy) {
        case 'incident': {
          const aId = formatIncidentCode(a.incidentId, a.displayId);
          const bId = formatIncidentCode(b.incidentId, b.displayId);
          return aId.localeCompare(bId, undefined, { numeric: true }) * dir;
        }
        case 'type':
          return typeLabel(a.incidentType).localeCompare(typeLabel(b.incidentType)) * dir;
        case 'to': {
          const aTo = REFERRED_TO_LABELS[a.referredTo] || a.referredTo || '';
          const bTo = REFERRED_TO_LABELS[b.referredTo] || b.referredTo || '';
          return aTo.localeCompare(bTo) * dir;
        }
        case 'ref':
          return String(a.referenceNo || '').localeCompare(String(b.referenceNo || ''), undefined, { numeric: true }) * dir;
        case 'when':
        default: {
          const aTime = new Date(a.referredAt || 0).getTime() || 0;
          const bTime = new Date(b.referredAt || 0).getTime() || 0;
          return (aTime - bTime || ((a.referralId || 0) - (b.referralId || 0))) * dir;
        }
      }
    });
  }

  function render(res) {
    body.innerHTML = '';
    renderKpiStrip(res.total, res.items);

    let rows = res.items;
    if (state.otherGroupOnly) {
      rows = rows.filter((r) => !PRIMARY_AGENCIES.has(r.referredTo));
    }
    if (state.search) {
      const q = state.search;
      rows = rows.filter((r) => {
        const id = formatIncidentCode(r.incidentId, r.displayId).toLowerCase();
        const refCode = formatReferralCode(r.referralId).toLowerCase();
        const type = (typeLabel(r.incidentType) || '').toLowerCase();
        const ref = (r.referenceNo || '').toLowerCase();
        const agency = (REFERRED_TO_LABELS[r.referredTo] || r.referredTo || '').toLowerCase();
        return id.includes(q) || String(r.incidentId).includes(q) || refCode.includes(q) || type.includes(q) || ref.includes(q) || agency.includes(q);
      });
    }

    rows = sortRows(rows);

    if (res.items.length === 0 && res.total === 0) {
      const empty = h('div', 'tw-ref-empty');
      const iconSpan = h('div', 'tw-ref-empty__icon');
      iconSpan.innerHTML = icons.send(36);

      const title = h('h3', 'tw-ref-empty__title',
        state.from || state.to || state.referredTo
          ? 'No Referrals Match Filters'
          : 'No Inter-Agency Referrals'
      );

      const desc = h('p', 'tw-ref-empty__desc',
        'When an incident is delegated from the Dispatch Center or Incident Management to external emergency units (such as PNP, BFP, VAW Desk, or Hospital EMS), delegation records will be catalogued here.'
      );

      const actions = h('div', 'tw-ref-empty__actions');
      const incidentsBtn = h('button', 'primary', 'Go to Incident Management');
      incidentsBtn.type = 'button';
      incidentsBtn.addEventListener('click', () => navigate('incident-management'));

      actions.append(incidentsBtn);
      empty.append(iconSpan, title, desc, actions);
      body.appendChild(empty);
      return;
    }

    if (rows.length === 0) {
      showEmpty(body, 'No matching referrals', 'No records match your active filter or search keyword. Clear or adjust your filters.');
      return;
    }

    const filteredCount = state.search || state.otherGroupOnly ? rows.length : res.total;

    body.appendChild(DataTable({
      columns: COLUMNS,
      rows,
      rowKey: (r) => r.referralId,
      caption: 'Referral log',
      emptyMessage: 'No referrals on this page.',
      emptyIcon: icons.send,
      initialSort: { key: state.sortBy, dir: state.sortDir },
      onSortChange: ({ key, dir }) => {
        state.sortBy = key;
        state.sortDir = dir;
        sortSelect.value = key;
        syncSortDirBtn();
        render(res);
      },
      onRowClick: (r) => navigate('incident-detail', r.incidentId),
      page: res.page,
      totalItems: filteredCount,
      pageSize: PAGE_SIZE,
      onPageChange: (next) => { state.page = next; load(); },
      renderCell: (row, key) => {
        switch (key) {
          case 'incident': {
            const cell = h('div', 'ref-incident-cell');
            const idBadge = h('span', 'ref-incident-id', formatIncidentCode(row.incidentId, row.displayId));
            const logSub = h('span', 'ref-log-sub', formatReferralCode(row.referralId));
            cell.append(idBadge, logSub);
            return cell;
          }
          case 'type': return h('span', 'ref-type-text', typeLabel(row.incidentType));
          case 'to': return agencyBadge(row.referredTo, row.otherText);
          case 'when': {
            const cell = h('div', 'ref-when-cell');
            cell.innerHTML = `<span aria-hidden="true">${icons.clock ? icons.clock(14) : ''}</span><span>${formatManilaDateTime(row.referredAt)}</span>`;
            return cell;
          }
          case 'ref': {
            const cell = h('div', 'ref-no-cell');
            if (row.referenceNo) {
              const code = h('code', 'ref-code-badge', row.referenceNo);
              const copyBtn = h('button', 'ref-copy-btn');
              copyBtn.type = 'button';
              copyBtn.title = `Copy reference ${row.referenceNo}`;
              copyBtn.setAttribute('aria-label', `Copy reference number ${row.referenceNo} to clipboard`);
              copyBtn.innerHTML = icons.copy ? icons.copy(13) : '📋';
              copyBtn.addEventListener('click', async (e) => {
                e.stopPropagation();
                try {
                  await navigator.clipboard.writeText(row.referenceNo);
                  showToast(`Copied ${row.referenceNo} to clipboard.`, { variant: 'info' });
                } catch {
                  showToast('Could not copy reference number.', { variant: 'error' });
                }
              });
              cell.append(code, copyBtn);
            } else {
              const emptyPill = h('span', 'ref-no-empty-pill', 'No agency ref');
              emptyPill.title = 'No external agency reference number recorded';
              cell.appendChild(emptyPill);
            }
            return cell;
          }
          case 'action': {
            const viewBtn = h('button', 'ghost ref-view-btn');
            viewBtn.type = 'button';
            viewBtn.setAttribute('aria-label', `View incident details for ${formatIncidentCode(row.incidentId, row.displayId)}`);
            viewBtn.innerHTML = `<span>View case</span><span aria-hidden="true">${icons.arrowRight ? icons.arrowRight(14) : '→'}</span>`;
            viewBtn.addEventListener('click', (e) => {
              e.stopPropagation();
              navigate('incident-detail', row.incidentId);
            });
            return viewBtn;
          }
          default: return '';
        }
      },
    }));
  }

  load();
}

