/**
 * blotter-list.js — W6 Electronic Blotter, REBUILT in Phase 6 of the
 * mockup-driven UI round 2 (see .claude/plans/clever-wishing-hummingbird.md).
 *
 * Previously this screen listed every INCIDENT (any status, via
 * `GET /incidents`) plus a "new entry" incident-creation form. The
 * supplied mockup shows something different: a ledger of finalized
 * blotter RECORDS — the legal record a Secretary produces by finalizing
 * an incident's approved redaction, not the operational incident itself.
 * Both views are real and both are wanted, so they split:
 *   - This screen (`GET /blotter`, BlotterController::index) — the
 *     finalized-record ledger, read-only, with a details side panel.
 *   - Incident Management (Phase 5, `GET /incidents`) — every incident
 *     any status, plus the incident-creation form this screen used to
 *     host.
 *
 * Roles: Admin/Secretary/Punong Barangay — same as the endpoint's own
 * role gate. No delete action anywhere (§6: no delete endpoint exists,
 * and a finalized record is amend-only by design).
 *
 * kebab-case filename per §4.
 */

import { getBlotterList, logout, ApiClientError } from '../api/apiClient.js';
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
const PAGE_SIZE = 25;

const COLUMNS = [
  { key: 'id', label: 'Blotter ID', width: '6.5rem' },
  { key: 'when', label: 'Date & Time' },
  { key: 'type', label: 'Type' },
  { key: 'location', label: 'Location' },
  { key: 'status', label: 'Status' },
  { key: 'officer', label: 'Officer' },
  { key: 'open', label: '', width: '3rem', align: 'right' },
];

/**
 * @param {HTMLElement} root
 * @param {{fullName:string, role:string}} user
 * @param {() => void} onLoggedOut
 * @param {(page: string, param?: any) => void} navigate
 */
export function renderBlotterListPage(root, user, onLoggedOut, navigate) {
  root.innerHTML = '';

  const shell = AppShell(user, 'blotter', navigate, async () => {
    shell.logoutButton.disabled = true;
    await logout();
    onLoggedOut();
  });
  const { header, content } = shell;
  root.appendChild(shell.el);

  const pageHeader = PageHeader({
    title: 'Electronic Blotter',
    subtitle: 'Finalized blotter records — select an entry for its full detail',
    icon: icons.fileText,
  });
  header.appendChild(pageHeader.el);

  const layout = document.createElement('div');
  layout.className = 'split-panel';
  content.appendChild(layout);

  const listPane = document.createElement('div');
  layout.appendChild(listPane);

  const detailPane = document.createElement('div');
  detailPane.className = 'blotter-detail-pane';
  layout.appendChild(detailPane);
  renderDetailPlaceholder();

  let currentPage = 1;
  let selectedBlotterId = null;

  load();

  async function load() {
    renderLoading(listPane);
    try {
      const result = await getBlotterList({ page: currentPage, limit: PAGE_SIZE });
      renderList(result.items, result.total, (nextPage) => { currentPage = nextPage; load(); });
    } catch (err) {
      const message = err instanceof ApiClientError ? err.message : 'Something went wrong loading the blotter.';
      renderError(listPane, message, load);
    }
  }

  function renderList(items, totalItems, onPageChange) {
    listPane.innerHTML = '';
    const table = DataTable({
      columns: COLUMNS,
      rows: items,
      rowKey: (row) => row.blotterId,
      selectedKey: selectedBlotterId,
      onRowClick: (row) => { selectedBlotterId = row.blotterId; renderDetail(row); highlightSelected(items); },
      caption: 'Finalized blotter records',
      emptyIcon: icons.fileText,
      emptyMessage: 'No blotter records have been finalized yet.',
      page: currentPage,
      totalItems,
      pageSize: PAGE_SIZE,
      onPageChange,
      renderCell: renderBlotterCell,
    });
    listPane.appendChild(table);
  }

  function highlightSelected(items) {
    // DataTable itself already re-renders selection styling via
    // `selectedKey` on the next renderList() call; this just keeps the
    // CURRENT table's row highlighted without a full reload.
    for (const tr of listPane.querySelectorAll('tbody tr')) {
      tr.classList.remove('is-selected');
    }
    const idx = items.findIndex((r) => r.blotterId === selectedBlotterId);
    const rows = listPane.querySelectorAll('tbody tr');
    if (idx > -1 && rows[idx]) rows[idx].classList.add('is-selected');
  }

  function renderDetailPlaceholder() {
    detailPane.innerHTML = '';
    const card = document.createElement('div');
    card.className = 'card state-block';
    card.innerHTML = '<h3>Select an entry</h3><p>Choose a row on the left to see its full record here.</p>';
    detailPane.appendChild(card);
  }

  function renderDetail(row) {
    detailPane.innerHTML = '';
    const card = document.createElement('div');
    card.className = 'card blotter-print-area';

    const heading = document.createElement('h3');
    heading.textContent = `Blotter #${row.blotterId}`;
    card.appendChild(heading);

    const statusLabel = row.revisionNo > 1 ? 'Amended' : 'Finalized';
    const pill = document.createElement('span');
    pill.className = `status-pill ${row.revisionNo > 1 ? 'status-pill--pending' : 'status-pill--success'}`;
    pill.textContent = statusLabel;
    card.appendChild(pill);

    const fields = document.createElement('dl');
    fields.className = 'detail-fields';
    const addField = (label, value) => {
      const dt = document.createElement('dt');
      dt.textContent = label;
      const dd = document.createElement('dd');
      dd.textContent = value;
      fields.append(dt, dd);
    };
    addField('Incident', `#${row.incidentId} — ${INCIDENT_TYPE_LABELS[row.incidentType] || row.incidentType}`);
    addField('Location', row.latitude != null && row.longitude != null ? `${row.latitude.toFixed(5)}, ${row.longitude.toFixed(5)}` : 'Not recorded');
    addField('Officer', row.officerName || 'Not assigned');
    addField('Recorded by', `User #${row.recordedBy}`);
    addField('Finalized', new Date(row.finalizedAt).toLocaleString());
    addField('Revision', String(row.revisionNo));
    if (row.amendedAt) addField('Last amended', new Date(row.amendedAt).toLocaleString());
    card.appendChild(fields);

    const actions = document.createElement('div');
    actions.className = 'blotter-detail-pane__actions';
    const editButton = document.createElement('button');
    editButton.type = 'button';
    editButton.className = 'primary';
    editButton.textContent = 'Edit entry';
    editButton.addEventListener('click', () => navigate('blotter-detail', row.incidentId));
    const printButton = document.createElement('button');
    printButton.type = 'button';
    printButton.className = 'ghost';
    printButton.innerHTML = `<span aria-hidden="true">${icons.fileText(16)}</span><span>Print</span>`;
    printButton.addEventListener('click', () => window.print());
    actions.append(editButton, printButton);
    card.appendChild(actions);

    detailPane.appendChild(card);
  }
}

function renderBlotterCell(row, key) {
  switch (key) {
    case 'id':
      return `#${row.blotterId}`;
    case 'when':
      return new Date(row.finalizedAt).toLocaleString();
    case 'type':
      return INCIDENT_TYPE_LABELS[row.incidentType] || row.incidentType;
    case 'location':
      return row.latitude != null && row.longitude != null
        ? `${row.latitude.toFixed(4)}, ${row.longitude.toFixed(4)}`
        : '—';
    case 'status': {
      const amended = row.revisionNo > 1;
      const span = document.createElement('span');
      span.className = `status-pill ${amended ? 'status-pill--pending' : 'status-pill--success'}`;
      span.textContent = amended ? 'Amended' : 'Finalized';
      return span;
    }
    case 'officer':
      return row.officerName || '—';
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
  wrap.setAttribute('aria-label', 'Loading blotter');
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
