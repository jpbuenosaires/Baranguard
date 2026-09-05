/**
 * citizen-reports-inbox.js — W16 Citizen Reports Inbox (§9): "Displays
 * contact/description only as permitted. Conversion is disabled once
 * converted and is idempotent on retries." Roles: Secretary, Admin
 * (§7 "View citizen report inbox").
 *
 * Shows the unconverted queue (`?status=unconverted`) — the actionable
 * "inbox" set, not a historical log of every report ever submitted.
 *
 * 2026-09-05: added the Convert action (`POST /citizen-reports/:id/
 * convert`, built this same pass — see CitizenReportsController.php's
 * class doc). This screen used to be genuinely list-only, a real
 * workflow dead end: a report had no way to become an incident short of
 * an Admin/Secretary manually re-typing everything into "Log Incident."
 * Convert prompts for `incident_type` (no citizen-report equivalent to
 * infer it from — the reviewer picks the closest category) via the
 * shared `promptSelect()` dialog, then reloads the list; the row
 * disappears because it no longer matches `status=unconverted`, same
 * "load() after a successful action" pattern every other screen here
 * uses. Also added a Location column — captured at intake
 * (citizen-report.js's optional "Share my current location") but never
 * surfaced here even though the API already returned it.
 *
 * 2026-09-02: migrated header to PageHeader and the stacked-card list to
 * the shared DataTable component (Figma-alignment pass, same as W6
 * Blotter). Description/contact cells are built as text nodes rather than
 * innerHTML strings — both are raw citizen-submitted text, so this avoids
 * re-introducing the manual escapeHtml() the card version needed.
 *
 * kebab-case filename per §4 (pages/routes convention).
 */

import { getCitizenReports, convertCitizenReport, logout, ApiClientError } from '../api/apiClient.js';
import { AppShell } from '../components/AppShell.js';
import { PageHeader } from '../components/PageHeader.js';
import { DataTable } from '../components/DataTable.js';
import { icons } from '../components/icons.js';
import { promptSelect } from '../components/ConfirmDialog.js';
import { showToast } from '../components/Toast.js';

// Same 11-member enum as `incident.incident_type` (§5) — duplicated here
// the same way every other JS consumer of this enum already does
// (DonutChart, statistical-reports.js, incident-management.js).
const INCIDENT_TYPE_OPTIONS = [
  ['theft', 'Theft'], ['physical_injury', 'Physical Injury'], ['disturbance', 'Disturbance'],
  ['domestic_dispute', 'Domestic Dispute'], ['vandalism', 'Vandalism'],
  ['traffic_incident', 'Traffic Incident'], ['fire', 'Fire'],
  ['medical_emergency', 'Medical Emergency'], ['missing_person', 'Missing Person'],
  ['animal_complaint', 'Animal Complaint'], ['other', 'Other'],
];

const COLUMNS = [
  { key: 'id', label: 'ID', width: '4.5rem' },
  { key: 'description', label: 'Description' },
  { key: 'contact', label: 'Contact' },
  // Location was captured at intake (citizen-report.js's optional "Share
  // my current location") but never surfaced here, even though it's
  // already in the API response (`getCitizenReports()` already returns
  // latitude/longitude) — this column just renders data that already
  // existed.
  { key: 'location', label: 'Location', width: '6rem' },
  { key: 'date', label: 'Submitted' },
  { key: 'actions', label: 'Actions', align: 'right' },
];

/**
 * @param {HTMLElement} root
 * @param {{fullName:string, role:string}} user
 * @param {() => void} onLoggedOut
 * @param {(page: string) => void} navigate
 */
export function renderCitizenReportsInboxPage(root, user, onLoggedOut, navigate) {
  root.innerHTML = '';

  const shell = AppShell(user, 'citizen-inbox', navigate, async () => {
    shell.logoutButton.disabled = true;
    await logout();
    onLoggedOut();
  });
  const { header, content } = shell;
  root.appendChild(shell.el);

  const pageHeader = PageHeader({ title: 'Citizen Reports', subtitle: 'Unconverted public submissions awaiting review', icon: icons.inbox });
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
  searchLabel.htmlFor = 'citizen-inbox-search';
  searchLabel.textContent = 'Search citizen reports';
  const searchInput = document.createElement('input');
  searchInput.id = 'citizen-inbox-search';
  searchInput.type = 'search';
  searchInput.placeholder = 'Search by description or reference number…';
  searchWrap.append(searchIcon, searchLabel, searchInput);
  filterPanel.appendChild(searchWrap);
  header.appendChild(filterPanel);

  const body = document.createElement('div');
  content.appendChild(body);

  let allItems = [];
  searchInput.addEventListener('input', () => applyFilter());

  function applyFilter() {
    const q = searchInput.value.trim().toLowerCase();
    const filtered = q
      ? allItems.filter((r) => String(r.reportId).includes(q) || r.description.toLowerCase().includes(q))
      : allItems;
    if (filtered.length === 0) {
      renderEmpty(body, q ? 'No reports match your search.' : undefined);
    } else {
      renderList(body, filtered, load);
    }
  }

  load();

  async function load() {
    renderLoading(body);
    try {
      const result = await getCitizenReports({ status: 'unconverted', limit: 100 });
      allItems = result.items;
      applyFilter();
    } catch (err) {
      const message = err instanceof ApiClientError ? err.message : 'Something went wrong loading citizen reports.';
      renderError(body, message, load);
    }
  }
}

function renderList(container, items, onConverted) {
  container.innerHTML = '';
  const table = DataTable({
    columns: COLUMNS,
    rows: items,
    rowKey: (row) => row.reportId,
    caption: 'Citizen report inbox',
    renderCell: (row, key) => {
      switch (key) {
        case 'id':
          return `#${row.reportId}`;
        case 'description': {
          const span = document.createElement('span');
          span.className = 'data-table__sub';
          span.textContent = row.description;
          return span;
        }
        case 'contact': {
          const span = document.createElement('span');
          span.textContent = row.contactNumber || '—';
          return span;
        }
        case 'location': {
          if (row.latitude === null || row.longitude === null) {
            const span = document.createElement('span');
            span.className = 'note';
            span.textContent = 'Not shared';
            return span;
          }
          const span = document.createElement('span');
          span.className = 'avatar-row';
          span.title = `${row.latitude}, ${row.longitude}`;
          span.innerHTML = `${icons.mapPin(16)}<span>Included</span>`;
          return span;
        }
        case 'date':
          return new Date(row.submittedAt).toLocaleString();
        case 'actions': {
          const button = document.createElement('button');
          button.type = 'button';
          button.className = 'primary';
          button.textContent = 'Convert to Incident';
          button.addEventListener('click', (event) => {
            event.stopPropagation();
            convertRow(row, button, onConverted);
          });
          return button;
        }
        default:
          return '';
      }
    },
  });
  container.appendChild(table);
}

async function convertRow(row, button, onConverted) {
  const incidentType = await promptSelect({
    title: 'Convert to Incident',
    description: `Report #${row.reportId}: "${row.description}"`,
    label: 'Incident type',
    options: INCIDENT_TYPE_OPTIONS.map(([value, label]) => ({ value, label })),
    confirmLabel: 'Convert',
  });
  if (!incidentType) return;

  button.disabled = true;
  button.textContent = 'Converting…';
  try {
    const result = await convertCitizenReport(row.reportId, { incidentType });
    showToast(`Converted to Incident #${result.incidentId}.`, { variant: 'success' });
    onConverted();
  } catch (err) {
    button.disabled = false;
    button.textContent = 'Convert to Incident';
    showToast(err instanceof ApiClientError ? err.message : 'Could not convert this report.', { variant: 'error' });
  }
}

function renderLoading(container) {
  container.innerHTML = '';
  const wrap = document.createElement('div');
  wrap.className = 'stack';
  wrap.setAttribute('role', 'status');
  wrap.setAttribute('aria-label', 'Loading citizen reports');
  for (let i = 0; i < 5; i++) {
    const skeleton = document.createElement('div');
    skeleton.className = 'skeleton skeleton--row';
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
    : `
    <h3>Inbox is empty</h3>
    <p>No unconverted citizen reports right now. New public submissions will appear here.</p>
  `;
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
