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
import { getReferrals, REFERRED_TO_LABELS } from '../services/tanodWorkflowApi.js';
import {
  h, mountPageFrame, showLoading, showError, showEmpty, selectOf, formatManilaDateTime,
} from '../services/tanodWorkflowUi.js';

const PAGE_SIZE = 25;

const COLUMNS = [
  { key: 'incident', label: 'Incident' },
  { key: 'type', label: 'Incident Type' },
  { key: 'to', label: 'Referred Agency / Office' },
  { key: 'when', label: 'Referred At' },
  { key: 'ref', label: 'Reference No.' },
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

  const state = { from: '', to: '', referredTo: '', page: 1 };

  const notice = h('p', 'tw-notice',
    'This log tracks inter-agency delegations, maintaining an audit trail of which cases were referred outside barangay jurisdiction pursuant to DILG BIMSS guidelines.'
  );

  const kpisHost = h('div', 'tw-ref-kpis');
  const filters = h('div', 'tw-filter-bar');

  const fromInput = document.createElement('input');
  fromInput.type = 'date';
  fromInput.id = 'tw-ref-from';

  const toInput = document.createElement('input');
  toInput.type = 'date';
  toInput.id = 'tw-ref-to';

  const destSelect = selectOf(
    Object.entries(REFERRED_TO_LABELS).map(([value, label]) => ({ value, label })),
    { placeholder: 'All destinations' },
  );
  destSelect.id = 'tw-ref-dest';

  const wrapField = (labelText, input) => {
    const wrap = h('div', 'form-stack tw-field');
    const label = h('label', 'label', labelText);
    label.htmlFor = input.id;
    wrap.append(label, input);
    return wrap;
  };

  const clear = h('button', 'ghost', 'Clear filters');
  clear.type = 'button';

  const body = h('div', 'tw-referrals__body');

  filters.append(wrapField('From', fromInput), wrapField('To', toInput), wrapField('Referred to', destSelect), clear);
  container.append(notice, kpisHost, filters, body);

  const apply = () => {
    state.from = fromInput.value;
    state.to = toInput.value;
    state.referredTo = destSelect.value;
    state.page = 1;
    load();
  };
  fromInput.addEventListener('change', apply);
  toInput.addEventListener('change', apply);
  destSelect.addEventListener('change', apply);
  clear.addEventListener('click', () => {
    fromInput.value = ''; toInput.value = ''; destSelect.value = '';
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
      const cardEl = h('button', 'tw-ref-kpi-card');
      cardEl.type = 'button';

      const head = h('div', 'tw-ref-kpi-card__head');
      const iconSpan = h('span', 'tw-ref-kpi-card__icon');
      iconSpan.innerHTML = c.icon(18);
      head.append(iconSpan);

      const val = h('span', 'tw-ref-kpi-card__val', String(c.val));
      const lbl = h('span', 'tw-ref-kpi-card__label', c.label);

      cardEl.append(head, val, lbl);
      cardEl.addEventListener('click', () => {
        destSelect.value = c.filter;
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
      render(res);
    } catch (err) {
      showError(body, err, load, 'Could not load the referral log.');
    }
  }

  function render(res) {
    body.innerHTML = '';
    renderKpiStrip(res.total, res.items);

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

    body.appendChild(DataTable({
      columns: COLUMNS,
      rows: res.items,
      rowKey: (r) => r.referralId,
      caption: 'Referral log',
      emptyMessage: 'No referrals on this page.',
      emptyIcon: icons.send,
      onRowClick: (r) => navigate('incident-detail', r.incidentId),
      page: res.page,
      totalItems: res.total,
      pageSize: PAGE_SIZE,
      onPageChange: (next) => { state.page = next; load(); },
      renderCell: (row, key) => {
        switch (key) {
          case 'incident': return h('span', 'tw-mono', row.displayId || `#${row.incidentId}`);
          case 'type': return h('span', '', typeLabel(row.incidentType));
          case 'to': return agencyBadge(row.referredTo, row.otherText);
          case 'when': return h('span', '', formatManilaDateTime(row.referredAt));
          case 'ref': return h('span', 'tw-mono', row.referenceNo || '—');
          default: return '';
        }
      },
    }));
  }

  load();
}
