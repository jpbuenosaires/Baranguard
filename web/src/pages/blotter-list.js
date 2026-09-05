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

import { getBlotterList, getIncident, logout, ApiClientError } from '../api/apiClient.js';
import { AppShell } from '../components/AppShell.js';
import { PageHeader } from '../components/PageHeader.js';
import { DataTable, exportRowsToCsv, ExportCsvButton } from '../components/DataTable.js';
import { icons } from '../components/icons.js';

const INCIDENT_TYPE_LABELS = {
  theft: 'Theft', physical_injury: 'Physical Injury', disturbance: 'Disturbance',
  domestic_dispute: 'Domestic Dispute', vandalism: 'Vandalism',
  traffic_incident: 'Traffic Incident', fire: 'Fire',
  medical_emergency: 'Medical Emergency', missing_person: 'Missing Person',
  animal_complaint: 'Animal Complaint', other: 'Other',
};
// case_status (migration 0009, 2026-09-05 UX pass) — replaces the old
// revisionNo>1-derived "Finalized"/"Amended" pill with the real stored
// lifecycle. See BlotterController.php's own comment for the transition
// rules (active on finalize, under_investigation/settled Secretary-
// driven via amend, resolved only ever set when the parent incident is
// resolved).
const CASE_STATUS_LABELS = {
  active: 'Active', under_investigation: 'Under Investigation', settled: 'Settled', resolved: 'Resolved',
};
const CASE_STATUS_PILL_CLASS = {
  active: 'status-pill--info', under_investigation: 'status-pill--pending',
  settled: 'status-pill--success', resolved: 'status-pill--neutral',
};
const PAGE_SIZE = 25;
const SEARCH_DEBOUNCE_MS = 400;

const COLUMNS = [
  { key: 'id', label: 'Blotter ID', width: '8rem', csvValue: (row) => row.displayId || `#${row.blotterId}` },
  { key: 'when', label: 'Date & Time', csvValue: (row) => row.finalizedAt },
  { key: 'type', label: 'Type', csvValue: (row) => INCIDENT_TYPE_LABELS[row.incidentType] || row.incidentType },
  { key: 'location', label: 'Location', csvValue: (row) => row.locationDescription || (row.latitude != null && row.longitude != null ? `${row.latitude}, ${row.longitude}` : '') },
  { key: 'status', label: 'Status', csvValue: (row) => CASE_STATUS_LABELS[row.caseStatus] || row.caseStatus },
  { key: 'officer', label: 'Officer', csvValue: (row) => row.officerName || '' },
  { key: 'actions', label: '', width: '5.5rem', align: 'right' },
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

  // Export CSV (2026-09-05 UX pass) — `exportRowsToCsv`/`ExportCsvButton`
  // already exist as a shared DataTable.js component (already wired into
  // sms-log.js); this is a wire-up, not new component work. Exports only
  // the currently-loaded page, same disclosed limitation every other use
  // of this component already has.
  let currentItems = [];
  let currentTotal = 0;
  let exportButton = ExportCsvButton({
    rows: currentItems,
    totalItems: currentTotal,
    onExport: () => exportRowsToCsv(COLUMNS, currentItems, 'baranguard-blotter'),
  });
  pageHeader.actions.appendChild(exportButton);

  // Search (server-side `q=` — see BlotterController::index()'s own doc
  // for why this isn't a client-side filter over one loaded page).
  let searchQuery = undefined;
  let searchDebounceHandle = null;
  const filterPanel = document.createElement('div');
  filterPanel.className = 'filter-panel';
  const searchWrap = document.createElement('div');
  searchWrap.className = 'filter-panel__search';
  const searchIcon = document.createElement('span');
  searchIcon.className = 'filter-panel__search-icon';
  searchIcon.setAttribute('aria-hidden', 'true');
  searchIcon.innerHTML = icons.search(16);
  const searchLabel = document.createElement('label');
  searchLabel.className = 'sr-only';
  searchLabel.htmlFor = 'blotter-search';
  searchLabel.textContent = 'Search blotter records';
  const searchInput = document.createElement('input');
  searchInput.id = 'blotter-search';
  searchInput.type = 'search';
  searchInput.placeholder = 'Search by case number, type, or complainant/respondent…';
  searchInput.addEventListener('input', () => {
    clearTimeout(searchDebounceHandle);
    searchDebounceHandle = setTimeout(() => {
      searchQuery = searchInput.value.trim() || undefined;
      currentPage = 1;
      load();
    }, SEARCH_DEBOUNCE_MS);
  });
  searchWrap.append(searchIcon, searchLabel, searchInput);
  filterPanel.appendChild(searchWrap);
  header.appendChild(filterPanel);

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
      const result = await getBlotterList({ q: searchQuery, page: currentPage, limit: PAGE_SIZE });
      currentItems = result.items;
      currentTotal = result.total;
      syncExportButton();
      renderList(result.items, result.total, (nextPage) => { currentPage = nextPage; load(); });
    } catch (err) {
      const message = err instanceof ApiClientError ? err.message : 'Something went wrong loading the blotter.';
      renderError(listPane, message, load);
    }
  }

  function syncExportButton() {
    const fresh = ExportCsvButton({
      rows: currentItems,
      totalItems: currentTotal,
      onExport: () => exportRowsToCsv(COLUMNS, currentItems, 'baranguard-blotter'),
    });
    exportButton.replaceWith(fresh);
    // Rebind the outer reference so the NEXT load() call replaces the
    // right node (ExportCsvButton returns a fresh element every call —
    // it has no update-in-place API).
    exportButton = fresh;
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
      renderCell: (row, key) => renderBlotterCell(row, key, navigate),
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
    heading.textContent = `Blotter ${row.displayId || '#' + row.blotterId}`;
    card.appendChild(heading);

    const pill = document.createElement('span');
    pill.className = `status-pill ${CASE_STATUS_PILL_CLASS[row.caseStatus] || 'status-pill--neutral'}`;
    pill.textContent = CASE_STATUS_LABELS[row.caseStatus] || row.caseStatus;
    card.appendChild(pill);
    if (row.revisionNo > 1) {
      const amendedNote = document.createElement('span');
      amendedNote.className = 'status-pill status-pill--pending';
      amendedNote.textContent = `Amended (rev. ${row.revisionNo})`;
      card.appendChild(amendedNote);
    }

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
    addField('Location', row.locationDescription
      || (row.latitude != null && row.longitude != null ? `${row.latitude.toFixed(5)}, ${row.longitude.toFixed(5)}` : 'Not recorded'));
    addField('Officer', row.officerName || 'Not assigned');
    addField('Recorded by', `User #${row.recordedBy}`);
    addField('Finalized', new Date(row.finalizedAt).toLocaleString());
    addField('Revision', String(row.revisionNo));
    if (row.amendedAt) addField('Last amended', new Date(row.amendedAt).toLocaleString());
    addField('Complainant', row.complainantName || 'Not recorded');
    addField('Respondent', row.respondentName || 'Not recorded');
    addField('Contact', row.complainantContactNumber || 'Not recorded');
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
    const narrativeButton = document.createElement('button');
    narrativeButton.type = 'button';
    narrativeButton.className = 'ghost';
    narrativeButton.innerHTML = `<span aria-hidden="true">${icons.eye(16)}</span><span>View full narrative</span>`;
    actions.append(editButton, printButton, narrativeButton);
    card.appendChild(actions);

    // Fetched on demand, not preloaded with the list — GET /incidents/:id
    // already safely returns `redactedNarrative` (approved, PII already
    // stripped) to every role this screen allows; `raw_narrative` stays
    // Secretary-exclusive and this button never touches it.
    const narrativeBlock = document.createElement('pre');
    narrativeBlock.className = 'narrative-block';
    narrativeBlock.hidden = true;
    let narrativeLoaded = false;
    narrativeButton.addEventListener('click', async () => {
      if (narrativeLoaded) {
        narrativeBlock.hidden = !narrativeBlock.hidden;
        return;
      }
      narrativeButton.disabled = true;
      try {
        const incident = await getIncident(row.incidentId);
        narrativeBlock.textContent = incident.redactedNarrative || 'No approved narrative on record.';
        narrativeBlock.hidden = false;
        narrativeLoaded = true;
      } catch (err) {
        narrativeBlock.textContent = err instanceof ApiClientError ? err.message : 'Could not load the narrative.';
        narrativeBlock.hidden = false;
      } finally {
        narrativeButton.disabled = false;
      }
    });
    card.appendChild(narrativeBlock);

    detailPane.appendChild(card);
  }
}

function renderBlotterCell(row, key, navigate) {
  switch (key) {
    case 'id':
      return row.displayId || `#${row.blotterId}`;
    case 'when':
      return new Date(row.finalizedAt).toLocaleString();
    case 'type':
      return INCIDENT_TYPE_LABELS[row.incidentType] || row.incidentType;
    case 'location':
      return row.locationDescription || (row.latitude != null && row.longitude != null
        ? `${row.latitude.toFixed(4)}, ${row.longitude.toFixed(4)}`
        : '—');
    case 'status': {
      const span = document.createElement('span');
      span.className = `status-pill ${CASE_STATUS_PILL_CLASS[row.caseStatus] || 'status-pill--neutral'}`;
      span.textContent = CASE_STATUS_LABELS[row.caseStatus] || row.caseStatus;
      return span;
    }
    case 'officer':
      return row.officerName || '—';
    case 'actions': {
      // Per-row action icons (2026-09-05 UX pass) — View (opens this
      // same row's detail pane, same as clicking anywhere else in the
      // row) and Edit (jumps straight into blotter-detail.js without
      // opening the side panel first). No delete/archive icon: §6 has no
      // delete endpoint for a finalized record by design (this file's
      // own header comment) — shown disabled with the RA 7160 reason
      // rather than omitted, so the row's affordances match the mockup's
      // shape without a control that would 404.
      const wrap = document.createElement('span');
      wrap.className = 'data-table__actions';

      const viewIcon = document.createElement('span');
      viewIcon.className = 'row-open-hint';
      viewIcon.setAttribute('aria-hidden', 'true');
      viewIcon.innerHTML = icons.eye(16);
      viewIcon.title = 'View';
      wrap.appendChild(viewIcon);

      const editButton = document.createElement('button');
      editButton.type = 'button';
      editButton.className = 'ghost row-open-hint';
      editButton.innerHTML = icons.edit(16);
      editButton.title = 'Edit entry';
      editButton.setAttribute('aria-label', `Edit blotter ${row.displayId || '#' + row.blotterId}`);
      editButton.addEventListener('click', (event) => {
        event.stopPropagation();
        navigate('blotter-detail', row.incidentId);
      });
      wrap.appendChild(editButton);

      const archiveButton = document.createElement('button');
      archiveButton.type = 'button';
      archiveButton.className = 'ghost row-open-hint';
      archiveButton.disabled = true;
      archiveButton.innerHTML = icons.x(16);
      archiveButton.title = 'Records cannot be deleted per RA 7160';
      archiveButton.setAttribute('aria-label', 'Delete disabled — records cannot be deleted per RA 7160');
      wrap.appendChild(archiveButton);

      return wrap;
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
