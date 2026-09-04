/**
 * incident-management.js — Phase 5 of the mockup-driven UI round 2
 * (see .claude/plans/clever-wishing-hummingbird.md). The operational
 * incident list from the second supplied mockup: every incident, any
 * status, filterable — distinct from W6 Electronic Blotter (Phase 6),
 * which is the finalized-record view over `blotter_record`, not
 * `incident`.
 *
 * Backed entirely by the already-built `GET /incidents` (status/priority/
 * page/limit, tenant + role scoped server-side) — no new endpoint. Status
 * chips double as filters, with live counts fetched via three scoped
 * `limit=1` requests (reading each response's own `total`) rather than a
 * new counts endpoint — the same real-current-total the list itself uses,
 * not a date-scoped figure from GET /reports/summary that would disagree
 * with what's on screen.
 *
 * Full-text search was deliberately left out of this cut (logged in the
 * plan): `GET /incidents` has no `q=` param, and `GET /search` caps at 10
 * results with no location/officer fields — reusing it here would mean a
 * second, thinner list shape sitting inside the same table. Chips +
 * priority + pagination cover the mockup's real filtering intent.
 *
 * Roles: Admin and Secretary — the two roles that actually work incidents
 * end-to-end. Punong Barangay's incident-facing screen is the finalized
 * Blotter record view; Tanod is mobile-only.
 *
 * Also carries the "New Entry" incident-creation form W6 used to host —
 * moved here in Phase 6, since logging a brand-new incident is
 * operational work on `incident`, not the finalized `blotter_record` W6
 * became a view over.
 *
 * kebab-case filename per §4.
 */

import { getIncidents, createIncident, logout, ApiClientError } from '../api/apiClient.js';
import { AppShell } from '../components/AppShell.js';
import { PageHeader } from '../components/PageHeader.js';
import { DataTable } from '../components/DataTable.js';
import { icons } from '../components/icons.js';

const INCIDENT_TYPE_LABELS = {
  theft: 'Theft', physical_injury: 'Physical Injury', disturbance: 'Disturbance',
  domestic_dispute: 'Domestic Dispute', vandalism: 'Vandalism',
  traffic_incident: 'Traffic Incident', fire: 'Fire',
  medical_emergency: 'Medical Emergency', missing_person: 'Missing Person',
  animal_complaint: 'Animal Complaint', other: 'Other',
};
const STATUS_PILL_CLASS = { pending: 'status-pill--pending', dispatched: 'status-pill--info', resolved: 'status-pill--success' };
const PRIORITY_PILL_CLASS = { normal: 'status-pill--neutral', high: 'status-pill--pending', critical: 'status-pill--critical' };
const STATUSES = ['pending', 'dispatched', 'resolved'];
const PAGE_SIZE = 25;

const COLUMNS = [
  { key: 'incident', label: 'Incident' },
  { key: 'location', label: 'Location' },
  { key: 'tanod', label: 'Tanod Assigned' },
  { key: 'priority', label: 'Priority' },
  { key: 'status', label: 'Status', align: 'right' },
  { key: 'open', label: '', width: '3rem', align: 'right' },
];

/**
 * @param {HTMLElement} root
 * @param {{fullName:string, role:string}} user
 * @param {() => void} onLoggedOut
 * @param {(page: string, param?: any) => void} navigate
 */
export function renderIncidentManagementPage(root, user, onLoggedOut, navigate) {
  root.innerHTML = '';

  const canCreate = user.role === 'admin' || user.role === 'secretary';

  const shell = AppShell(user, 'incident-management', navigate, async () => {
    shell.logoutButton.disabled = true;
    await logout();
    onLoggedOut();
  });
  const { header, content } = shell;
  root.appendChild(shell.el);

  const pageHeader = PageHeader({
    title: 'Incident Management',
    subtitle: 'Every logged incident, any status — filter by stage or priority',
    icon: icons.alertTriangle,
  });
  header.appendChild(pageHeader.el);

  let showForm = false;
  if (canCreate) {
    const newButton = document.createElement('button');
    newButton.type = 'button';
    newButton.className = 'primary';
    newButton.innerHTML = `<span aria-hidden="true">${icons.plus(16)}</span><span>Log Incident</span>`;
    newButton.addEventListener('click', () => { showForm = !showForm; renderFormPane(); });
    pageHeader.actions.appendChild(newButton);
  }

  const chipRow = document.createElement('div');
  chipRow.className = 'filter-chip-row';
  const chips = {};
  for (const key of ['all', ...STATUSES]) {
    const chip = document.createElement('button');
    chip.type = 'button';
    chip.className = 'filter-chip';
    chip.textContent = key === 'all' ? 'All' : key.charAt(0).toUpperCase() + key.slice(1);
    chip.addEventListener('click', () => { statusFilter = key === 'all' ? undefined : key; currentPage = 1; syncChips(); load(); });
    chips[key] = chip;
    chipRow.appendChild(chip);
  }
  header.appendChild(chipRow);

  const filterPanel = document.createElement('div');
  filterPanel.className = 'filter-panel';
  const prioritySelect = document.createElement('select');
  prioritySelect.setAttribute('aria-label', 'Filter by priority');
  for (const [value, label] of [['', 'All priorities'], ['normal', 'Normal'], ['high', 'High'], ['critical', 'Critical']]) {
    const option = document.createElement('option');
    option.value = value;
    option.textContent = label;
    prioritySelect.appendChild(option);
  }
  prioritySelect.addEventListener('change', () => { currentPage = 1; load(); });
  filterPanel.appendChild(prioritySelect);
  header.appendChild(filterPanel);

  const layout = document.createElement('div');
  layout.className = 'split-panel';
  content.appendChild(layout);

  const body = document.createElement('div');
  layout.appendChild(body);

  function renderFormPane() {
    layout.classList.toggle('split-panel--full', !showForm);
    const existing = layout.querySelector('.incident-form-pane');
    if (existing) existing.remove();
    if (showForm) {
      const formPane = document.createElement('div');
      formPane.className = 'incident-form-pane';
      formPane.appendChild(buildNewEntryForm(() => { showForm = false; renderFormPane(); load(); refreshChipCounts(); }));
      layout.appendChild(formPane);
    }
  }
  renderFormPane();

  let statusFilter = undefined;
  let currentPage = 1;

  function syncChips() {
    for (const [key, chip] of Object.entries(chips)) {
      const active = (key === 'all' && statusFilter === undefined) || key === statusFilter;
      chip.classList.toggle('is-active', active);
    }
  }
  syncChips();
  refreshChipCounts();

  async function refreshChipCounts() {
    try {
      const [all, pending, dispatched, resolved] = await Promise.all([
        getIncidents({ limit: 1 }),
        getIncidents({ status: 'pending', limit: 1 }),
        getIncidents({ status: 'dispatched', limit: 1 }),
        getIncidents({ status: 'resolved', limit: 1 }),
      ]);
      chips.all.textContent = `All (${all.total})`;
      chips.pending.textContent = `Pending (${pending.total})`;
      chips.dispatched.textContent = `Dispatched (${dispatched.total})`;
      chips.resolved.textContent = `Resolved (${resolved.total})`;
    } catch {
      // Chips are a filter convenience; a failed count fetch just leaves
      // the plain labels, the filters themselves still work.
    }
  }

  load();

  async function load() {
    renderLoading(body);
    try {
      const result = await getIncidents({
        status: statusFilter,
        priority: prioritySelect.value || undefined,
        page: currentPage,
        limit: PAGE_SIZE,
      });
      renderList(body, result.items, result.total, (nextPage) => { currentPage = nextPage; load(); });
    } catch (err) {
      const message = err instanceof ApiClientError ? err.message : 'Something went wrong loading incidents.';
      renderError(body, message, load);
    }
  }

  function renderList(container, items, totalItems, onPageChange) {
    container.innerHTML = '';
    const table = DataTable({
      columns: COLUMNS,
      rows: items,
      rowKey: (row) => row.incidentId,
      onRowClick: (row) => navigate('blotter-detail', row.incidentId),
      caption: 'Incidents',
      emptyIcon: icons.alertTriangle,
      emptyMessage: 'No incidents match these filters.',
      page: currentPage,
      totalItems,
      pageSize: PAGE_SIZE,
      onPageChange,
      renderCell: renderIncidentCell,
    });
    container.appendChild(table);
  }
}

/** Moved from the old W6 blotter-list.js — see this file's own header. */
function buildNewEntryForm(onCreated) {
  const card = document.createElement('div');
  card.className = 'card';

  const heading = document.createElement('h3');
  heading.textContent = 'Log Incident';

  const form = document.createElement('form');
  form.className = 'form-stack';
  form.noValidate = true;

  const errorBox = document.createElement('div');
  errorBox.className = 'login-form__error';
  errorBox.setAttribute('role', 'alert');
  errorBox.hidden = true;

  const typeLabel = document.createElement('label');
  typeLabel.className = 'label';
  typeLabel.htmlFor = 'incident-new-type';
  typeLabel.textContent = 'Incident Type';
  const typeSelect = document.createElement('select');
  typeSelect.id = 'incident-new-type';
  for (const [value, label] of Object.entries(INCIDENT_TYPE_LABELS)) {
    const option = document.createElement('option');
    option.value = value;
    option.textContent = label;
    typeSelect.appendChild(option);
  }

  const narrativeLabel = document.createElement('label');
  narrativeLabel.className = 'label';
  narrativeLabel.htmlFor = 'incident-new-narrative';
  narrativeLabel.textContent = 'Narrative';
  const narrativeInput = document.createElement('textarea');
  narrativeInput.id = 'incident-new-narrative';
  narrativeInput.rows = 5;
  narrativeInput.required = true;
  narrativeInput.classList.add('textarea--resizable');

  const submitButton = document.createElement('button');
  submitButton.type = 'submit';
  submitButton.className = 'primary';
  submitButton.textContent = 'Log Entry';

  form.append(errorBox, typeLabel, typeSelect, narrativeLabel, narrativeInput, submitButton);
  card.append(heading, form);

  form.addEventListener('submit', async (event) => {
    event.preventDefault();
    errorBox.hidden = true;

    const rawNarrative = narrativeInput.value.trim();
    if (!rawNarrative) {
      errorBox.textContent = 'Enter a narrative for this entry.';
      errorBox.hidden = false;
      return;
    }

    submitButton.disabled = true;
    submitButton.textContent = 'Logging…';
    try {
      await createIncident({ incidentType: typeSelect.value, rawNarrative, idempotencyKey: crypto.randomUUID() });
      onCreated();
    } catch (err) {
      const message = err instanceof ApiClientError ? err.message : 'Could not log this entry.';
      errorBox.textContent = message;
      errorBox.hidden = false;
    } finally {
      submitButton.disabled = false;
      submitButton.textContent = 'Log Entry';
    }
  });

  return card;
}

function renderIncidentCell(row, key) {
  switch (key) {
    case 'incident': {
      const wrap = document.createElement('span');
      wrap.className = 'data-table__stacked';
      const top = document.createElement('span');
      top.className = 'data-table__stacked-primary';
      top.textContent = `#${row.incidentId} — ${INCIDENT_TYPE_LABELS[row.incidentType] || row.incidentType}`;
      const bottom = document.createElement('span');
      bottom.className = 'data-table__sub';
      bottom.textContent = new Date(row.createdAt).toLocaleString();
      wrap.append(top, bottom);
      return wrap;
    }
    case 'location':
      return row.latitude != null && row.longitude != null
        ? `${row.latitude.toFixed(4)}, ${row.longitude.toFixed(4)}`
        : '—';
    case 'tanod':
      return row.officerName || '—';
    case 'priority': {
      const span = document.createElement('span');
      span.className = `status-pill ${PRIORITY_PILL_CLASS[row.priority] || 'status-pill--neutral'}`;
      span.textContent = row.priority;
      return span;
    }
    case 'status': {
      const span = document.createElement('span');
      span.className = `status-pill ${STATUS_PILL_CLASS[row.status] || 'status-pill--neutral'}`;
      span.textContent = row.status;
      return span;
    }
    case 'open': {
      const chevron = document.createElement('span');
      chevron.className = 'row-open-hint';
      chevron.setAttribute('aria-hidden', 'true');
      chevron.innerHTML = icons.eye(16);
      return chevron;
    }
    default:
      return '';
  }
}

function renderLoading(container) {
  container.innerHTML = '';
  const wrap = document.createElement('div');
  wrap.className = 'stack';
  wrap.setAttribute('role', 'status');
  wrap.setAttribute('aria-label', 'Loading incidents');
  for (let i = 0; i < 6; i++) {
    const skeleton = document.createElement('div');
    skeleton.className = 'skeleton skeleton--row';
    wrap.appendChild(skeleton);
  }
  container.appendChild(wrap);
}

function renderError(container, message, onRetry) {
  container.innerHTML = '';
  const block = document.createElement('div');
  block.className = 'card state-block state-block--error';
  block.setAttribute('role', 'alert');
  const text = document.createElement('p');
  text.textContent = message;
  const retryButton = document.createElement('button');
  retryButton.className = 'primary';
  retryButton.textContent = 'Retry';
  retryButton.addEventListener('click', onRetry);
  block.append(text, retryButton);
  container.appendChild(block);
}
