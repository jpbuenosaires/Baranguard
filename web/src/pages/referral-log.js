/**
 * referral-log.js — Referral Log (contract §5 / §10): which incidents the
 * barangay delegated to which office (PNP, BFP, ambulance, VAW desk, ...)
 * and when.
 *
 * This is deliberately a DELEGATION log, not a case registry (the DILG
 * BIMSS constraint, REFERENCE.md §1): `GET /referrals` returns only
 * `{referral_id, incident_id, display_id, incident_type, referred_to,
 * other_text, referred_at, reference_no}` — never a narrative, a name, a
 * contact or coordinates — and this page renders exactly those fields.
 * A row opens the incident's own detail screen, where the viewer's normal
 * role rules apply.
 *
 * Roles: admin, secretary, punong_barangay (read-only for all three).
 */

import { DataTable } from '../components/DataTable.js';
import { StatStrip } from '../components/StatStrip.js';
import { icons } from '../components/icons.js';
import { getReferrals, REFERRED_TO_LABELS } from '../services/tanodWorkflowApi.js';
import {
  h, mountPageFrame, showLoading, showError, showEmpty, selectOf, formatManilaDateTime,
} from '../services/tanodWorkflowUi.js';

const PAGE_SIZE = 25;

const COLUMNS = [
  { key: 'incident', label: 'Incident' },
  { key: 'type', label: 'Type' },
  { key: 'to', label: 'Referred to' },
  { key: 'when', label: 'Referred at' },
  { key: 'ref', label: 'Reference no.' },
];

function typeLabel(value) {
  if (!value) return '—';
  const text = String(value).replace(/_/g, ' ');
  return text.charAt(0).toUpperCase() + text.slice(1);
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
    subtitle: 'Who each incident was delegated to — dates and destinations only',
    icon: icons.send,
  });

  const state = { from: '', to: '', referredTo: '', page: 1 };

  const notice = h('p', 'tw-notice', 'This log shows where incidents were referred, not what happened in them. Open an incident to see its own details, subject to your role.');
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
  container.append(notice, filters, body);

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
    if (res.items.length === 0 && res.total === 0) {
      showEmpty(
        body,
        'No referrals',
        state.from || state.to || state.referredTo
          ? 'No referrals match these filters.'
          : 'Referrals appear here when an incident is delegated to another office.',
      );
      return;
    }
    body.appendChild(StatStrip({ items: [{ label: 'Referrals matching filters', value: res.total }] }));
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
          case 'to': {
            const base = REFERRED_TO_LABELS[row.referredTo] || row.referredTo || '—';
            return h('span', '', row.otherText ? `${base} — ${row.otherText}` : base);
          }
          case 'when': return h('span', '', formatManilaDateTime(row.referredAt));
          case 'ref': return h('span', 'tw-mono', row.referenceNo || '—');
          default: return '';
        }
      },
    }));
  }

  load();
}
