/**
 * citizen-reports-inbox.js — W16 Citizen Reports Inbox, list only (§9):
 * "Displays contact/description only as permitted. Conversion is
 * disabled once converted and is idempotent on retries." This cut is
 * explicitly "list only" per Sprint_Prompts.md's own checklist entry —
 * `POST /citizen-reports/:id/convert` is a separate, unbuilt endpoint, so
 * there's no convert action/button here yet. Roles: Secretary, Admin
 * (§7 "View citizen report inbox").
 *
 * Shows the unconverted queue (`?status=unconverted`) — the actionable
 * "inbox" set, not a historical log of every report ever submitted.
 *
 * 2026-09-02: migrated header to PageHeader and the stacked-card list to
 * the shared DataTable component (Figma-alignment pass, same as W6
 * Blotter). Description/contact cells are built as text nodes rather than
 * innerHTML strings — both are raw citizen-submitted text, so this avoids
 * re-introducing the manual escapeHtml() the card version needed.
 *
 * kebab-case filename per §4 (pages/routes convention).
 */

import { getCitizenReports, logout, ApiClientError } from '../api/apiClient.js';
import { AppShell } from '../components/AppShell.js';
import { PageHeader } from '../components/PageHeader.js';
import { DataTable } from '../components/DataTable.js';
import { icons } from '../components/icons.js';

const COLUMNS = [
  { key: 'id', label: 'ID', width: '4.5rem' },
  { key: 'description', label: 'Description' },
  { key: 'contact', label: 'Contact' },
  { key: 'date', label: 'Submitted' },
  { key: 'status', label: 'Status', align: 'right' },
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
      renderList(body, filtered);
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

function renderList(container, items) {
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
        case 'date':
          return new Date(row.submittedAt).toLocaleString();
        case 'status': {
          const span = document.createElement('span');
          span.className = 'status-pill status-pill--pending';
          span.textContent = 'Unconverted';
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
  wrap.setAttribute('aria-label', 'Loading citizen reports');
  for (let i = 0; i < 5; i++) {
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
