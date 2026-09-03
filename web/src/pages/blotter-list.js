/**
 * blotter-list.js — W6 Electronic Blotter List (§9): "Server-provided
 * redacted excerpt only. New-entry form derives source server-side."
 * Roles: Admin, Secretary (full — list + new-entry form), Punong Barangay
 * (redacted/read-only — list only, no new-entry form per §7 "Web-side
 * incident entry": PB has no access to that action).
 *
 * The list reuses `GET /incidents` (already built for W3's dispatch
 * queue) with no status filter — a blotter ledger shows every incident,
 * not just pending ones. Only the same redacted item shape W3 already
 * gets (no raw_narrative — that's Secretary-only, via a different,
 * unbuilt detail endpoint) — matches "Server-provided redacted excerpt
 * only" exactly, plus `officerName` (2026-09-02 addition — the Tanod off
 * the incident's most recent dispatch, see IncidentsController.php).
 *
 * 2026-09-02: migrated the list from stacked cards to the shared
 * DataTable component (Phase 2 of the Figma-alignment pass) — cards ran
 * ~90px/row against the reference's ~44px, the single biggest density
 * gap on this screen. Header also migrated to PageHeader.
 *
 * kebab-case filename per §4 (pages/routes convention).
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

const COLUMNS = [
  { key: 'id', label: 'ID', width: '4.5rem' },
  { key: 'type', label: 'Type' },
  { key: 'officer', label: 'Officer' },
  { key: 'location', label: 'Location' },
  { key: 'date', label: 'Date' },
  { key: 'status', label: 'Status', align: 'right' },
  // Purely a visual affordance for the row's own click handler — NOT a
  // nested button, which would double-fire inside a clickable row. Added
  // after real use: W7/W8 have no sidebar entry (they need an incident
  // id), so without a visible cue nothing signals that a row opens a
  // detail screen at all.
  { key: 'open', label: '', width: '3rem', align: 'right' },
];

/**
 * @param {HTMLElement} root
 * @param {{fullName:string, role:string}} user
 * @param {() => void} onLoggedOut
 * @param {(page: string) => void} navigate
 */
export function renderBlotterListPage(root, user, onLoggedOut, navigate) {
  root.innerHTML = '';

  const canCreate = user.role === 'admin' || user.role === 'secretary';

  const shell = AppShell(user, 'blotter', navigate, async () => {
    shell.logoutButton.disabled = true;
    await logout();
    onLoggedOut();
  });
  const { header, content } = shell;
  root.appendChild(shell.el);

  const pageHeader = PageHeader({ title: 'Electronic Blotter', subtitle: 'Running ledger of every logged incident — select an entry to open its detail, evidence and blotter record', icon: icons.fileText });
  header.appendChild(pageHeader.el);

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
  searchLabel.textContent = 'Search blotter entries';
  const searchInput = document.createElement('input');
  searchInput.id = 'blotter-search';
  searchInput.type = 'search';
  searchInput.placeholder = 'Search by incident ID, type, officer, or status…';
  searchWrap.append(searchIcon, searchLabel, searchInput);
  filterPanel.appendChild(searchWrap);
  header.appendChild(filterPanel);

  const layout = document.createElement('div');
  layout.className = canCreate ? 'split-panel' : '';
  content.appendChild(layout);

  const listPane = document.createElement('div');
  layout.appendChild(listPane);

  if (canCreate) {
    layout.appendChild(buildNewEntryForm(() => load()));
  }

  let allItems = [];

  // Rows open W7 Electronic Blotter Detail, which every role on this list
  // can read (the finalize/amend controls inside are Secretary-only, and
  // the server enforces that regardless of what the UI shows). W8 AI
  // Redaction Review is reached from W7 rather than directly from here —
  // the real workflow is review the entry, then act on its redaction.
  const onOpenReview = (row) => navigate('blotter-detail', row.incidentId);

  searchInput.addEventListener('input', () => applyFilter());

  function applyFilter() {
    const q = searchInput.value.trim().toLowerCase();
    const filtered = q
      ? allItems.filter((incident) => {
          const typeLabel = (INCIDENT_TYPE_LABELS[incident.incidentType] || incident.incidentType).toLowerCase();
          return (
            String(incident.incidentId).includes(q) ||
            typeLabel.includes(q) ||
            incident.status.toLowerCase().includes(q) ||
            (incident.officerName || '').toLowerCase().includes(q)
          );
        })
      : allItems;
    if (filtered.length === 0) {
      renderEmpty(listPane, q ? 'No entries match your search.' : undefined);
    } else {
      renderList(listPane, filtered, onOpenReview);
    }
  }

  load();

  async function load() {
    renderLoading(listPane);
    try {
      const result = await getIncidents({ limit: 100 });
      allItems = result.items;
      applyFilter();
    } catch (err) {
      const message = err instanceof ApiClientError ? err.message : 'Something went wrong loading the blotter.';
      renderError(listPane, message, load);
    }
  }
}

function buildNewEntryForm(onCreated) {
  const card = document.createElement('div');
  card.className = 'card';

  const heading = document.createElement('h3');
  heading.textContent = 'New Entry';
  heading.style.marginBottom = '16px';

  const form = document.createElement('form');
  form.className = 'form-stack';
  form.noValidate = true;

  const errorBox = document.createElement('div');
  errorBox.className = 'login-form__error';
  errorBox.setAttribute('role', 'alert');
  errorBox.hidden = true;

  const typeLabel = document.createElement('label');
  typeLabel.className = 'label';
  typeLabel.htmlFor = 'blotter-new-type';
  typeLabel.textContent = 'Incident Type';
  const typeSelect = document.createElement('select');
  typeSelect.id = 'blotter-new-type';
  for (const [value, label] of Object.entries(INCIDENT_TYPE_LABELS)) {
    const option = document.createElement('option');
    option.value = value;
    option.textContent = label;
    typeSelect.appendChild(option);
  }

  const narrativeLabel = document.createElement('label');
  narrativeLabel.className = 'label';
  narrativeLabel.htmlFor = 'blotter-new-narrative';
  narrativeLabel.textContent = 'Narrative';
  const narrativeInput = document.createElement('textarea');
  narrativeInput.id = 'blotter-new-narrative';
  narrativeInput.rows = 5;
  narrativeInput.required = true;
  narrativeInput.style.resize = 'vertical';

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
      await createIncident({
        incidentType: typeSelect.value,
        rawNarrative,
        idempotencyKey: crypto.randomUUID(),
      });
      narrativeInput.value = '';
      typeSelect.selectedIndex = 0;
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

function renderList(container, items, onOpenReview) {
  container.innerHTML = '';
  const table = DataTable({
    columns: COLUMNS,
    rows: items,
    rowKey: (row) => row.incidentId,
    onRowClick: onOpenReview ?? undefined,
    caption: 'Electronic blotter entries',
    renderCell: (row, key) => {
      switch (key) {
        case 'id':
          return `#${row.incidentId}`;
        case 'type':
          return INCIDENT_TYPE_LABELS[row.incidentType] || row.incidentType;
        case 'officer':
          return row.officerName || '—';
        case 'location':
          return row.latitude != null && row.longitude != null
            ? `${row.latitude.toFixed(4)}, ${row.longitude.toFixed(4)}`
            : '—';
        case 'date':
          return new Date(row.createdAt).toLocaleString();
        case 'open': {
          const chevron = document.createElement('span');
          chevron.className = 'row-open-hint';
          chevron.setAttribute('aria-hidden', 'true');
          chevron.innerHTML = icons.eye(16);
          return chevron;
        }
        case 'status': {
          const pillClass = STATUS_PILL_CLASS[row.status] || 'status-pill--neutral';
          const span = document.createElement('span');
          span.className = `status-pill ${pillClass}`;
          span.textContent = row.status;
          return span;
        }
        default:
          return '';
      }
    },
  });
  container.appendChild(table);
}

function renderLoading(container) {
  container.innerHTML = '';
  const wrap = document.createElement('div');
  wrap.className = 'stack';
  wrap.setAttribute('role', 'status');
  wrap.setAttribute('aria-label', 'Loading blotter');
  for (let i = 0; i < 6; i++) {
    const skeleton = document.createElement('div');
    skeleton.className = 'skeleton';
    skeleton.style.cssText = 'height:2.75rem; border-radius:0.5rem;';
    wrap.appendChild(skeleton);
  }
  container.appendChild(wrap);
}

function renderEmpty(container, searchMessage) {
  container.innerHTML = '';
  const block = document.createElement('div');
  block.className = 'card state-block';
  block.innerHTML = searchMessage
    ? `<h3>${searchMessage}</h3><p>Try a different search term.</p>`
    : `<h3>No blotter entries yet</h3><p>Once incidents are logged, they'll appear here as a running blotter ledger.</p>`;
  container.appendChild(block);
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
