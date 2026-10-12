/**
 * referral-log.js — Referral Log (contract §5 / §10): which incidents the
 * barangay delegated to which office (PNP, BFP, ambulance, VAW desk, ...)
 * and when.
 *
 * Overhauled with:
 *   - Agency KPI Summary Strip
 *   - Color-coded agency badges
 *   - Direct incident deep links
 *   - Informative empty state explaining the delegation boundary
 */

import { DataTable } from '../components/DataTable.js';
import { icons } from '../components/icons.js';
import { showToast } from '../components/Toast.js';
import { getReferrals, REFERRED_TO_LABELS } from '../services/tanodWorkflowApi.js';
import {
  h, escapeHtml, mountPageFrame, showLoading, showError, showEmpty, selectOf, formatManilaDateTime,
} from '../services/tanodWorkflowUi.js';

const PAGE_SIZE = 25;

const COLUMNS = [
  { key: 'incident', label: 'Incident Case' },
  { key: 'type', label: 'Incident Type' },
  { key: 'to', label: 'Referred Agency / Office' },
  { key: 'when', label: 'Referred At (Manila Time)' },
  { key: 'ref', label: 'Reference No.' },
  { key: 'action', label: 'Action', align: 'right' },
];

function typeLabel(value) {
  if (!value) return '—';
  const text = String(value).replace(/_/g, ' ');
  return text.charAt(0).toUpperCase() + text.slice(1);
}

function agencyBadge(referredTo, otherText) {
  const base = REFERRED_TO_LABELS[referredTo] || referredTo || '—';
  const label = otherText ? `${base} — ${otherText}` : base;

  let modifier = 'other';
  if (referredTo === 'pnp') modifier = 'pnp';
  else if (referredTo === 'bfp') modifier = 'bfp';
  else if (referredTo === 'ambulance_ems') modifier = 'ems';
  else if (referredTo === 'vaw_desk') modifier = 'vaw';
  else if (referredTo === 'higher_lgu' || referredTo === 'social_welfare') modifier = 'lgu';

  const pill = h('span', `tw-ref-agency-pill tw-ref-agency-pill--${modifier}`);
  pill.textContent = label;
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
    subtitle: 'Inter-agency delegations — incidents referred to PNP, BFP, EMS, and government offices',
    icon: icons.send,
  });

  const state = { from: '', to: '', referredTo: '', search: '', page: 1 };
  let lastResult = null;

  // Dismissible notice banner
  const NOTICE_STORAGE_KEY = 'baranguard_ref_notice_dismissed';
  const isNoticeDismissed = localStorage.getItem(NOTICE_STORAGE_KEY) === 'true';

  const notice = h('div', 'ref-notice-card');
  if (isNoticeDismissed) notice.hidden = true;
  notice.innerHTML = `
    <div class="ref-notice-content">
      <span class="ref-notice-icon" aria-hidden="true">${icons.info ? icons.info(18) : 'ℹ️'}</span>
      <span>This log tracks inter-agency delegations, maintaining an audit trail of which cases were referred outside barangay jurisdiction pursuant to DILG BIMSS guidelines.</span>
    </div>
  `;
  const dismissBtn = h('button', 'ref-notice-dismiss');
  dismissBtn.type = 'button';
  dismissBtn.setAttribute('aria-label', 'Dismiss guidance note');
  dismissBtn.innerHTML = icons.x ? icons.x(14) : '✕';
  dismissBtn.addEventListener('click', () => {
    notice.hidden = true;
    localStorage.setItem(NOTICE_STORAGE_KEY, 'true');
  });
  notice.appendChild(dismissBtn);

  const kpisHost = h('div', 'tw-ref-kpis ref-kpis-bar');

  // Consolidated 44px Control Bar
  const controlBar = h('div', 'ref-control-bar');

  // Search input
  const searchWrap = h('div', 'ref-search-box');
  searchWrap.innerHTML = `<span class="ref-search-icon" aria-hidden="true">${icons.search ? icons.search(16) : '🔍'}</span>`;
  const searchInput = document.createElement('input');
  searchInput.type = 'search';
  searchInput.className = 'ref-search-input';
  searchInput.id = 'tw-ref-search';
  searchInput.placeholder = 'Search incident ID, type, reference...';
  searchInput.setAttribute('aria-label', 'Search referrals by incident ID, type, or reference number');
  searchWrap.appendChild(searchInput);

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

  // Clear filters
  const clear = h('button', 'ghost ref-clear-btn', 'Clear filters');
  clear.type = 'button';
  clear.setAttribute('aria-label', 'Clear all active filters');

  controlBar.append(searchWrap, dateGroup, destWrap, clear);

  const body = h('div', 'tw-referrals__body');

  container.append(notice, kpisHost, controlBar, body);

  const apply = () => {
    state.from = fromInput.value;
    state.to = toInput.value;
    state.referredTo = destSelect.value;
    state.search = searchInput.value.trim().toLowerCase();
    state.page = 1;
    load();
  };

  let searchDebounce = null;
  searchInput.addEventListener('input', () => {
    clearTimeout(searchDebounce);
    searchDebounce = setTimeout(() => {
      state.search = searchInput.value.trim().toLowerCase();
      if (lastResult) render(lastResult);
    }, 200);
  });

  fromInput.addEventListener('change', apply);
  toInput.addEventListener('change', apply);
  destSelect.addEventListener('change', apply);
  clear.addEventListener('click', () => {
    fromInput.value = ''; 
    toInput.value = ''; 
    destSelect.value = '';
    searchInput.value = '';
    apply();
  });

  function renderKpiStrip(total, items) {
    kpisHost.innerHTML = '';
    const pnpCount = items.filter((r) => r.referredTo === 'pnp').length;
    const bfpCount = items.filter((r) => r.referredTo === 'bfp').length;
    const emsCount = items.filter((r) => r.referredTo === 'ambulance_ems').length;
    const vawCount = items.filter((r) => r.referredTo === 'vaw_desk').length;

    const cards = [
      { label: 'Total Referrals', val: total, icon: icons.send, filter: '' },
      { label: 'PNP (Police)', val: pnpCount, icon: icons.shield, filter: 'pnp' },
      { label: 'BFP (Fire)', val: bfpCount, icon: icons.flame, filter: 'bfp' },
      { label: 'EMS / Ambulance', val: emsCount, icon: icons.activity, filter: 'ambulance_ems' },
      { label: 'VAW Desk', val: vawCount, icon: icons.users, filter: 'vaw_desk' },
    ];

    for (const c of cards) {
      const isActive = state.referredTo === c.filter;
      const cardEl = h('button', `tw-ref-kpi-card ref-kpi-card${isActive ? ' is-active' : ''}`);
      cardEl.type = 'button';
      cardEl.setAttribute('aria-pressed', isActive ? 'true' : 'false');
      cardEl.setAttribute('aria-label', `Filter by ${c.label} (${c.val})`);

      const head = h('div', 'tw-ref-kpi-card__head');
      const iconSpan = h('span', 'tw-ref-kpi-card__icon');
      iconSpan.innerHTML = c.icon(18);
      head.append(iconSpan);

      const val = h('span', 'tw-ref-kpi-card__val', String(c.val));
      const lbl = h('span', 'tw-ref-kpi-card__label', c.label);

      cardEl.append(head, val, lbl);
      cardEl.addEventListener('click', () => {
        if (state.referredTo === c.filter) {
          destSelect.value = '';
        } else {
          destSelect.value = c.filter;
        }
        apply();
      });
      kpisHost.appendChild(cardEl);
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

  function render(res) {
    body.innerHTML = '';
    renderKpiStrip(res.total, res.items);

    let rows = res.items;
    if (state.search) {
      const q = state.search;
      rows = rows.filter((r) => {
        const id = (r.displayId || `#${r.incidentId}`).toLowerCase();
        const type = (typeLabel(r.incidentType) || '').toLowerCase();
        const ref = (r.referenceNo || '').toLowerCase();
        const agency = (REFERRED_TO_LABELS[r.referredTo] || r.referredTo || '').toLowerCase();
        return id.includes(q) || type.includes(q) || ref.includes(q) || agency.includes(q);
      });
    }

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
      showEmpty(body, 'No matching referrals', 'No records match your search keyword. Clear or adjust your search query.');
      return;
    }

    body.appendChild(DataTable({
      columns: COLUMNS,
      rows: rows,
      rowKey: (r) => r.referralId,
      caption: 'Referral log',
      emptyMessage: 'No referrals on this page.',
      emptyIcon: icons.send,
      onRowClick: (r) => navigate('incident-detail', r.incidentId),
      page: res.page,
      totalItems: state.search ? rows.length : res.total,
      pageSize: PAGE_SIZE,
      onPageChange: (next) => { state.page = next; load(); },
      renderCell: (row, key) => {
        switch (key) {
          case 'incident': {
            const cell = h('div', 'ref-incident-cell');
            const idBadge = h('span', 'ref-incident-id', row.displayId || `#${row.incidentId}`);
            cell.appendChild(idBadge);
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
              cell.innerHTML = `<span class="ref-empty-dash" title="No reference recorded">—</span>`;
            }
            return cell;
          }
          case 'action': {
            const viewBtn = h('button', 'ghost ref-view-btn');
            viewBtn.type = 'button';
            viewBtn.setAttribute('aria-label', `View incident details for ${row.displayId || `#${row.incidentId}`}`);
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

