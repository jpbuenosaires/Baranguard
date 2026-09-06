/**
 * audit-log.js — W17 Audit Log Viewer (§9): "Roles: Admin only ·
 * API: GET /audit-log · Last 7 days default, paginated, no edit/delete
 * controls."
 *
 * "No edit/delete controls" is the defining constraint of this screen,
 * not a detail: §5 makes `audit_log` write-once except controlled
 * retention deletion, and the whole value of an audit trail is that the
 * people it records cannot curate it. So this screen renders rows and
 * nothing else — no row actions, no bulk selection, no delete, and the
 * server offers no endpoint that would let one exist.
 *
 * The 7-day default is applied SERVER-SIDE (see AuditLogController), so
 * an empty date range here means "the documented default view", not
 * "everything ever".
 *
 * Fully overhauled with:
 * - Design token compliance and light/dark theme support
 * - Branded statutory compliance notice banner (§5/§9 W17)
 * - Interactive StatStrip with category quick-filters
 * - Full-width 4-column filter toolbar with chevron dropdown indicators
 * - Standardized Date Range picker with anchored popover dialog
 * - High-density cell renderers (Avatar initials, status pills, entity chips, metadata tags)
 * - Click-to-inspect Audit Event Modal with formatted JSON payload & Copy JSON utility
 * - Admin CSV Export tool in header actions
 *
 * kebab-case filename per §4.
 */

import { getAuditLog, logout, ApiClientError } from '../api/apiClient.js';
import { AppShell } from '../components/AppShell.js';
import { PageHeader } from '../components/PageHeader.js';
import { DataTable } from '../components/DataTable.js';
import { avatarInitials } from '../components/Avatar.js';
import { showToast } from '../components/Toast.js';
import { icons } from '../components/icons.js';
import { DateRangePicker } from '../components/DateRangePicker.js';

const PAGE_SIZE = 25;

// Rule 17's action list, grouped for the filter dropdown.
const ACTION_LABELS = {
  login_success: 'Login — success',
  login_failure: 'Login — failure',
  logout: 'Logout',
  password_changed: 'Password changed',
  user_updated: 'User updated',
  user_status_changed: 'User status changed',
  dispatch_created: 'Dispatch created',
  dispatch_cancelled: 'Dispatch cancelled',
  dispatch_status_override: 'Dispatch status override',
  incident_resolved: 'Incident resolved',
  shift_created: 'Shift created',
  shift_updated: 'Shift updated',
  swap_request_resolved: 'Swap decision',
  fatigue_flag_acknowledged: 'Fatigue flag acknowledged',
  ai_redaction_queued: 'AI redaction queued',
  ai_redaction_approved: 'AI redaction approved',
  ai_summary_regeneration_queued: 'AI summary rerun',
  ai_translation_queued: 'AI translation queued',
  blotter_finalized: 'Blotter finalized',
  blotter_amended: 'Blotter amended',
  lupon_packet_generated: 'Lupon packet generated',
  tanod_sos_raised: 'SOS raised',
  tanod_sos_acknowledged: 'SOS acknowledged',
  tanod_sos_resolved: 'SOS resolved',
  device_registered: 'Device registered',
  device_deactivated: 'Device deactivated',
  duty_status_changed: 'Duty status changed',
  map_package_published: 'Map package published',
  citizen_report_submitted: 'Citizen report submitted',
  report_exported: 'Report exported',
};

const CATEGORIES = {
  auth: {
    label: 'Auth & Access',
    actions: ['login_success', 'login_failure', 'logout', 'password_changed'],
  },
  ops: {
    label: 'Operations & Dispatch',
    actions: [
      'dispatch_created', 'dispatch_cancelled', 'dispatch_status_override',
      'duty_status_changed', 'shift_created', 'shift_updated',
      'swap_request_resolved', 'fatigue_flag_acknowledged',
    ],
  },
  blotter: {
    label: 'Blotter & Incidents',
    actions: [
      'incident_resolved', 'blotter_finalized', 'blotter_amended',
      'lupon_packet_generated', 'citizen_report_submitted',
      'tanod_sos_raised', 'tanod_sos_acknowledged', 'tanod_sos_resolved',
    ],
  },
  system: {
    label: 'AI & System',
    actions: [
      'ai_redaction_queued', 'ai_redaction_approved',
      'ai_summary_regeneration_queued', 'ai_translation_queued',
      'map_package_published', 'report_exported',
      'device_registered', 'device_deactivated',
      'user_updated', 'user_status_changed',
    ],
  },
};

const COLUMNS = [
  { key: 'when', label: 'When', width: '13rem' },
  { key: 'actor', label: 'Actor', width: '14rem' },
  { key: 'action', label: 'Action', width: '13rem' },
  { key: 'entity', label: 'Entity', width: '12rem' },
  { key: 'metadata', label: 'Details' },
];

/**
 * Maps an action string to a semantic status pill tone
 * @param {string} action
 * @returns {'success'|'critical'|'info'|'warning'|'neutral'}
 */
function getActionTone(action) {
  if (['login_failure', 'tanod_sos_raised', 'dispatch_cancelled'].includes(action)) {
    return 'critical';
  }
  if (['login_success', 'incident_resolved', 'blotter_finalized', 'ai_redaction_approved', 'tanod_sos_resolved'].includes(action)) {
    return 'success';
  }
  if (['dispatch_created', 'shift_created', 'shift_updated', 'user_updated', 'report_exported', 'map_package_published'].includes(action)) {
    return 'info';
  }
  if (['tanod_sos_acknowledged', 'blotter_amended', 'fatigue_flag_acknowledged', 'swap_request_resolved'].includes(action)) {
    return 'warning';
  }
  return 'neutral';
}

/**
 * Calculates start date ISO string for given relative days
 * @param {number} days
 * @returns {string} YYYY-MM-DD
 */
function getPastDateISO(days) {
  const d = new Date();
  d.setDate(d.getDate() - (days - 1));
  return d.toISOString().slice(0, 10);
}

function getTodayISO() {
  return new Date().toISOString().slice(0, 10);
}

/**
 * Formats a date string to friendly readable parts
 * @param {string} dateStr
 * @returns {{ date: string, time: string }}
 */
function formatAuditTime(dateStr) {
  if (!dateStr) return { date: '—', time: '' };
  const d = new Date(dateStr);
  if (isNaN(d.getTime())) return { date: dateStr, time: '' };

  const date = d.toLocaleDateString(undefined, {
    month: 'short',
    day: 'numeric',
    year: 'numeric',
  });
  const time = d.toLocaleTimeString(undefined, {
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
  });
  return { date, time };
}

/**
 * Converts items to CSV and triggers browser download
 * @param {Array<object>} items
 */
function exportAuditLogsToCsv(items) {
  if (!items || items.length === 0) {
    showToast('No audit log entries available to export.', { variant: 'info' });
    return;
  }

  const headers = ['Audit ID', 'Timestamp (UTC)', 'Actor ID', 'Actor Username', 'Action', 'Entity Type', 'Entity ID', 'Metadata'];
  const rows = items.map((item) => [
    item.auditId,
    `"${item.createdAt || ''}"`,
    item.actorUserId ?? 'SYSTEM',
    `"${(item.actorUsername || '').replace(/"/g, '""')}"`,
    `"${(item.action || '').replace(/"/g, '""')}"`,
    `"${(item.entityType || '').replace(/"/g, '""')}"`,
    item.entityId ?? '',
    `"${(JSON.stringify(item.metadataJson || {})).replace(/"/g, '""')}"`,
  ]);

  const csvContent = [headers.join(','), ...rows.map((r) => r.join(','))].join('\r\n');
  const blob = new Blob([csvContent], { type: 'text/csv;charset=utf-8;' });
  const url = URL.createObjectURL(blob);
  const link = document.createElement('a');
  link.setAttribute('href', url);
  link.setAttribute('download', `baranguard_audit_log_${new Date().toISOString().slice(0, 10)}.csv`);
  document.body.appendChild(link);
  link.click();
  document.body.removeChild(link);
  URL.revokeObjectURL(url);
}

/**
 * @param {HTMLElement} root
 * @param {{fullName:string, role:string}} user
 * @param {() => void} onLoggedOut
 * @param {(page: string, param?: any) => void} navigate
 */
export function renderAuditLogPage(root, user, onLoggedOut, navigate) {
  root.innerHTML = '';

  const shell = AppShell(user, 'audit-log', navigate, async () => {
    shell.logoutButton.disabled = true;
    await logout();
    onLoggedOut();
  });
  const { header, content } = shell;
  root.appendChild(shell.el);

  // Page Header with Export CSV action
  const pageHeader = PageHeader({
    title: 'Audit Log',
    subtitle: 'Immutable record of administrative actions & system events',
    icon: icons.shield,
  });

  const exportBtn = document.createElement('button');
  exportBtn.type = 'button';
  exportBtn.className = 'ghost';
  exportBtn.style.cssText = 'display: inline-flex; align-items: center; gap: 0.5rem;';
  exportBtn.innerHTML = `${icons.download(16)}<span>Export CSV</span>`;
  exportBtn.addEventListener('click', () => exportAuditLogsToCsv(currentItems));
  pageHeader.actions.appendChild(exportBtn);

  header.appendChild(pageHeader.el);

  // Outer Page Container
  const pageContainer = document.createElement('div');
  pageContainer.className = 'audit-page-container';

  // 1. Statutory Security & Compliance Notice Banner
  const securityBanner = document.createElement('div');
  securityBanner.className = 'audit-security-banner';
  securityBanner.innerHTML = `
    <div class="audit-security-banner__icon">
      ${icons.shield(22)}
    </div>
    <div class="audit-security-banner__content">
      <div class="audit-security-banner__title">
        <span>Immutable Compliance Audit Trail</span>
        <span class="audit-security-banner__badge">7-Year Statutory Retention (§5/§9 W17)</span>
      </div>
      <p class="audit-security-banner__text">
        Audit entries are write-once and tamper-evident. They cannot be edited or deleted from this console or any API endpoint.
        The only authorized purge is performed by the automated retention subsystem after the 7-year statutory period expires.
      </p>
    </div>
  `;
  pageContainer.appendChild(securityBanner);

  // 2. Interactive StatStrip Host
  const statStripHost = document.createElement('div');
  statStripHost.className = 'stat-card-grid';
  pageContainer.appendChild(statStripHost);

  // 3. Full-Width 4-Column Filter Toolbar
  const filterPanel = document.createElement('div');
  filterPanel.className = 'audit-filter-panel';

  // Col 1: Search Input
  const searchField = document.createElement('div');
  searchField.className = 'audit-search-field';
  const searchIcon = document.createElement('span');
  searchIcon.className = 'audit-search-field__icon';
  searchIcon.innerHTML = icons.search(16);
  const searchInput = document.createElement('input');
  searchInput.type = 'search';
  searchInput.id = 'audit-search';
  searchInput.placeholder = 'Search actor, action, or metadata…';
  searchInput.setAttribute('aria-label', 'Search audit logs');
  searchField.append(searchIcon, searchInput);

  // Col 2: Category Dropdown
  const categoryWrapper = document.createElement('div');
  categoryWrapper.className = 'audit-select-wrapper';
  const categorySelect = document.createElement('select');
  categorySelect.id = 'audit-category';
  categorySelect.setAttribute('aria-label', 'Filter by category');

  const catAll = document.createElement('option');
  catAll.value = '';
  catAll.textContent = 'All Categories';
  categorySelect.appendChild(catAll);

  for (const [catKey, catObj] of Object.entries(CATEGORIES)) {
    const opt = document.createElement('option');
    opt.value = catKey;
    opt.textContent = catObj.label;
    categorySelect.appendChild(opt);
  }

  const categoryChevron = document.createElement('span');
  categoryChevron.className = 'audit-select-chevron';
  categoryChevron.innerHTML = icons.chevronDown(14);
  categoryWrapper.append(categorySelect, categoryChevron);

  // Col 3: Action Dropdown
  const actionWrapper = document.createElement('div');
  actionWrapper.className = 'audit-select-wrapper';
  const actionSelect = document.createElement('select');
  actionSelect.id = 'audit-action';
  actionSelect.setAttribute('aria-label', 'Filter by specific action');

  function populateActionSelect(selectedCategory = '') {
    actionSelect.innerHTML = '';
    const allOption = document.createElement('option');
    allOption.value = '';
    allOption.textContent = 'All Actions';
    actionSelect.appendChild(allOption);

    let eligibleActions = Object.keys(ACTION_LABELS);
    if (selectedCategory && CATEGORIES[selectedCategory]) {
      eligibleActions = CATEGORIES[selectedCategory].actions;
    }

    for (const act of eligibleActions) {
      const option = document.createElement('option');
      option.value = act;
      option.textContent = ACTION_LABELS[act] || act.replace(/_/g, ' ');
      actionSelect.appendChild(option);
    }
  }
  populateActionSelect();

  const actionChevron = document.createElement('span');
  actionChevron.className = 'audit-select-chevron';
  actionChevron.innerHTML = icons.chevronDown(14);
  actionWrapper.append(actionSelect, actionChevron);

  // Col 4: Date range. 2026-09-06 UI/UX audit — this screen used to build
  // its own picker, the most divergent of the five copies in the app: it
  // labelled its default option "Last 7 days (Default)", used "From Date"/
  // "To Date" where the others used "From"/"To", titled the popover
  // "Select Custom Date Range", used a typographic ellipsis where the
  // others used three dots, and swapped the shared select styling for a
  // bespoke wrapper plus a JS-injected chevron. All of that is now the
  // shared component.
  //
  // "All time" is kept (SMS Monitor is the only other screen with it) and
  // still resolves to a REAL bound, because GET /audit-log has no
  // unbounded mode — omitting date_from makes the controller default to
  // its own short window, not "everything". The bound is the audit
  // retention horizon (RetentionService::AUDIT_LOG_DAYS, 7 years), so
  // nothing older can exist and the label is honest rather than
  // decorative.
  const ALL_TIME_DAYS = 365 * 7;

  let activeDateFrom = getPastDateISO(7);
  let activeDateTo = getTodayISO();

  const rangePicker = DateRangePicker({
    value: '7',
    allowAllTime: true,
    ariaLabel: 'Filter by date range',
    onChange: ({ mode, from, to }) => {
      if (mode === 'all') {
        activeDateFrom = getPastDateISO(ALL_TIME_DAYS);
        activeDateTo = getTodayISO();
      } else {
        activeDateFrom = from;
        activeDateTo = to;
      }
      currentPage = 1;
      load();
    },
  });

  filterPanel.append(searchField, categoryWrapper, actionWrapper, rangePicker.el);
  pageContainer.appendChild(filterPanel);

  // 4. Data Table Container
  const tableContainer = document.createElement('div');
  tableContainer.className = 'audit-table-wrap';
  pageContainer.appendChild(tableContainer);

  content.appendChild(pageContainer);

  // State
  let currentPage = 1;
  let currentItems = [];
  let totalAuditItems = 0;
  let activeFilterCategory = '';
  let searchQuery = '';

  // Category & Action change handlers
  categorySelect.addEventListener('change', () => {
    activeFilterCategory = categorySelect.value;
    populateActionSelect(activeFilterCategory);
    actionSelect.value = '';
    currentPage = 1;
    load();
  });

  actionSelect.addEventListener('change', () => {
    currentPage = 1;
    load();
  });

  // Search input with debounce
  let searchDebounce = null;
  searchInput.addEventListener('input', () => {
    clearTimeout(searchDebounce);
    searchDebounce = setTimeout(() => {
      searchQuery = searchInput.value.trim().toLowerCase();
      renderList(filterItemsBySearch(currentItems), totalAuditItems);
    }, 200);
  });

  function filterItemsBySearch(items) {
    if (!searchQuery) return items;
    return items.filter((row) => {
      const matchAction = (row.action || '').toLowerCase().includes(searchQuery);
      const matchActor = (row.actorUsername || '').toLowerCase().includes(searchQuery)
        || String(row.actorUserId || '').includes(searchQuery);
      const matchEntity = (row.entityType || '').toLowerCase().includes(searchQuery)
        || String(row.entityId || '').includes(searchQuery);
      const matchMeta = row.metadataJson ? JSON.stringify(row.metadataJson).toLowerCase().includes(searchQuery) : false;
      return matchAction || matchActor || matchEntity || matchMeta;
    });
  }

  // Initial load
  load();

  async function load() {
    renderLoading(tableContainer);
    try {
      const result = await getAuditLog({
        action: actionSelect.value || undefined,
        dateFrom: activeDateFrom,
        dateTo: activeDateTo,
        page: currentPage,
        limit: PAGE_SIZE,
      });

      currentItems = result.items;
      totalAuditItems = result.total;

      renderStatStrip(currentItems, totalAuditItems);
      renderList(filterItemsBySearch(currentItems), totalAuditItems);
    } catch (err) {
      const message = err instanceof ApiClientError ? err.message : 'Something went wrong loading the audit log.';
      renderError(tableContainer, message, load);
    }
  }

  function renderStatStrip(items, totalCount) {
    statStripHost.innerHTML = '';

    // Calculate breakdown from current result page
    let authCount = 0;
    let opsCount = 0;
    let blotterCount = 0;

    items.forEach((item) => {
      const act = item.action;
      if (CATEGORIES.auth.actions.includes(act)) authCount++;
      else if (CATEGORIES.ops.actions.includes(act)) opsCount++;
      else if (CATEGORIES.blotter.actions.includes(act)) blotterCount++;
    });

    const statCardsData = [
      { id: '', label: 'Total Events Recorded', value: totalCount, tone: 'primary' },
      { id: 'auth', label: 'Auth & Access Events', value: authCount, tone: 'info' },
      { id: 'ops', label: 'Operations & Dispatch', value: opsCount, tone: 'warning' },
      { id: 'blotter', label: 'Blotter & Incidents', value: blotterCount, tone: 'success' },
    ];

    statCardsData.forEach((stat) => {
      const card = document.createElement('button');
      card.type = 'button';
      card.className = `stat-card ${activeFilterCategory === stat.id ? 'is-active' : ''}`;
      card.setAttribute('aria-label', `Filter by ${stat.label}`);

      const val = document.createElement('span');
      val.className = `stat-card__value stat-card__value--${stat.tone}`;
      val.textContent = String(stat.value);

      const lbl = document.createElement('span');
      lbl.className = 'stat-card__label';
      lbl.textContent = stat.label;

      card.append(val, lbl);

      card.addEventListener('click', () => {
        if (activeFilterCategory === stat.id) {
          activeFilterCategory = '';
        } else {
          activeFilterCategory = stat.id;
        }
        categorySelect.value = activeFilterCategory;
        populateActionSelect(activeFilterCategory);
        actionSelect.value = '';
        currentPage = 1;
        load();
      });

      statStripHost.appendChild(card);
    });
  }

  function renderList(items, totalItems) {
    tableContainer.innerHTML = '';
    tableContainer.appendChild(DataTable({
      columns: COLUMNS,
      rows: items,
      rowKey: (row) => row.auditId,
      caption: 'Baranguard system audit log entries',
      emptyIcon: icons.fileText,
      emptyMessage: searchQuery ? `No audit entries match "${searchQuery}".` : 'No audit entries found in this period.',
      page: currentPage,
      totalItems,
      pageSize: PAGE_SIZE,
      onPageChange: (nextPage) => { currentPage = nextPage; load(); },
      onRowClick: (row) => openEventModal(row),
      renderCell: (row, key) => renderAuditCell(row, key, navigate),
    }));
  }

  /**
   * Opens the Audit Event Inspection Modal with JSON Viewer
   * @param {object} row
   */
  function openEventModal(row) {
    const existing = document.querySelector('.audit-modal-backdrop');
    if (existing) existing.remove();

    const backdrop = document.createElement('div');
    backdrop.className = 'audit-modal-backdrop';
    backdrop.setAttribute('role', 'dialog');
    backdrop.setAttribute('aria-modal', 'true');
    backdrop.setAttribute('aria-label', `Audit Event #${row.auditId}`);

    const card = document.createElement('div');
    card.className = 'audit-modal-card';

    // Header
    const headerEl = document.createElement('div');
    headerEl.className = 'audit-modal-header';

    const titleEl = document.createElement('h3');
    titleEl.className = 'audit-modal-title';
    titleEl.innerHTML = `${icons.shield(18)}<span>Audit Event #${row.auditId}</span>`;

    const closeBtn = document.createElement('button');
    closeBtn.type = 'button';
    closeBtn.className = 'audit-modal-close';
    closeBtn.setAttribute('aria-label', 'Close dialog');
    closeBtn.innerHTML = icons.x(16);

    headerEl.append(titleEl, closeBtn);

    // Body
    const bodyEl = document.createElement('div');
    bodyEl.className = 'audit-modal-body';

    const grid = document.createElement('div');
    grid.className = 'audit-modal-grid';

    const { date, time } = formatAuditTime(row.createdAt);
    const tone = getActionTone(row.action);
    const actionLabel = ACTION_LABELS[row.action] || row.action.replace(/_/g, ' ');

    grid.innerHTML = `
      <div class="audit-modal-field">
        <span class="audit-modal-label">Event Timestamp</span>
        <span class="audit-modal-value">${date} ${time} (UTC: ${row.createdAt || 'N/A'})</span>
      </div>
      <div class="audit-modal-field">
        <span class="audit-modal-label">Actor / Initiator</span>
        <span class="audit-modal-value">${row.actorUserId !== null ? `${row.actorUsername || 'User'} (#${row.actorUserId})` : 'System Daemon (Automated)'}</span>
      </div>
      <div class="audit-modal-field">
        <span class="audit-modal-label">Action</span>
        <span class="audit-modal-value">
          <span class="audit-action-pill audit-action-pill--${tone}">${actionLabel}</span>
        </span>
      </div>
      <div class="audit-modal-field">
        <span class="audit-modal-label">Target Entity</span>
        <span class="audit-modal-value">${row.entityType || 'General'}${row.entityId !== null ? ` #${row.entityId}` : ''}</span>
      </div>
    `;

    // JSON Section
    const jsonSection = document.createElement('div');
    jsonSection.className = 'audit-modal-json-section';

    const jsonLabel = document.createElement('span');
    jsonLabel.className = 'audit-modal-label';
    jsonLabel.textContent = 'Event Metadata Payload';

    const jsonViewer = document.createElement('pre');
    jsonViewer.className = 'audit-json-viewer';
    const jsonString = JSON.stringify(row.metadataJson || {}, null, 2);
    jsonViewer.textContent = jsonString;

    jsonSection.append(jsonLabel, jsonViewer);
    bodyEl.append(grid, jsonSection);

    // Footer
    const footerEl = document.createElement('div');
    footerEl.className = 'audit-modal-footer';

    const copyBtn = document.createElement('button');
    copyBtn.type = 'button';
    copyBtn.className = 'audit-btn-copy';
    copyBtn.innerHTML = `${icons.copy(14)}<span>Copy Raw JSON</span>`;

    copyBtn.addEventListener('click', async () => {
      try {
        await navigator.clipboard.writeText(jsonString);
        copyBtn.innerHTML = `${icons.checkCircle(14)}<span>Copied!</span>`;
        copyBtn.style.borderColor = 'var(--color-success)';
        setTimeout(() => {
          copyBtn.innerHTML = `${icons.copy(14)}<span>Copy Raw JSON</span>`;
          copyBtn.style.borderColor = '';
        }, 2000);
      } catch (err) {
        showToast('Could not copy to clipboard.', { variant: 'error' });
      }
    });

    const doneBtn = document.createElement('button');
    doneBtn.type = 'button';
    doneBtn.className = 'ghost';
    doneBtn.textContent = 'Close';

    footerEl.append(copyBtn, doneBtn);

    card.append(headerEl, bodyEl, footerEl);
    backdrop.appendChild(card);
    document.body.appendChild(backdrop);

    const closeModal = () => {
      document.removeEventListener('keydown', handleKey);
      backdrop.remove();
    };

    const handleKey = (e) => {
      if (e.key === 'Escape') closeModal();
    };

    closeBtn.addEventListener('click', closeModal);
    doneBtn.addEventListener('click', closeModal);
    backdrop.addEventListener('click', (e) => {
      if (e.target === backdrop) closeModal();
    });
    document.addEventListener('keydown', handleKey);
  }
}

/**
 * Cell renderer for DataTable
 * @param {object} row
 * @param {string} key
 * @param {(page: string, param?: any) => void} navigate
 * @returns {HTMLElement|string}
 */
function renderAuditCell(row, key, navigate) {
  switch (key) {
    case 'when': {
      const wrap = document.createElement('div');
      wrap.className = 'audit-when-cell';
      const { date, time } = formatAuditTime(row.createdAt);

      const dateEl = document.createElement('span');
      dateEl.className = 'audit-when-date';
      dateEl.textContent = date;

      const timeEl = document.createElement('span');
      timeEl.className = 'audit-when-time';
      timeEl.textContent = time;

      wrap.append(dateEl, timeEl);
      return wrap;
    }

    case 'actor': {
      const wrap = document.createElement('div');
      wrap.className = 'audit-actor-cell';

      // System action (retention jobs, background automation) has no actor
      if (row.actorUserId === null) {
        const badge = document.createElement('span');
        badge.className = 'audit-system-badge';
        badge.innerHTML = `${icons.settings(12)}<span>System</span>`;
        wrap.appendChild(badge);
        return wrap;
      }

      const avatarHtml = avatarInitials(row.actorUsername || 'User', 28);
      const temp = document.createElement('div');
      temp.innerHTML = avatarHtml;
      const avatarEl = temp.firstElementChild;

      const info = document.createElement('div');
      info.className = 'audit-actor-info';

      const name = document.createElement('span');
      name.className = 'audit-actor-name';
      name.textContent = row.actorUsername || `User #${row.actorUserId}`;

      const id = document.createElement('span');
      id.className = 'audit-actor-id';
      id.textContent = `#${row.actorUserId}`;

      info.append(name, id);
      wrap.append(avatarEl, info);
      return wrap;
    }

    case 'action': {
      const span = document.createElement('span');
      const tone = getActionTone(row.action);
      span.className = `audit-action-pill audit-action-pill--${tone}`;
      span.textContent = ACTION_LABELS[row.action] || row.action.replace(/_/g, ' ');
      return span;
    }

    case 'entity': {
      const chip = document.createElement('span');
      chip.className = 'audit-entity-chip';

      // Provide deep navigation link if entity is a known route
      if (row.entityType === 'blotter_record' && row.entityId) {
        chip.className += ' audit-entity-chip--interactive';
        chip.title = `View Blotter Record #${row.entityId}`;
        chip.textContent = `Blotter #${row.entityId} ↗`;
        chip.addEventListener('click', (e) => {
          e.stopPropagation(); // Avoid triggering row modal
          navigate('blotter-detail', { id: row.entityId });
        });
        return chip;
      }

      if (row.entityType === 'user' && row.entityId) {
        chip.className += ' audit-entity-chip--interactive';
        chip.title = `View Personnel #${row.entityId}`;
        chip.textContent = `User #${row.entityId} ↗`;
        chip.addEventListener('click', (e) => {
          e.stopPropagation();
          navigate('personnel', { userId: row.entityId });
        });
        return chip;
      }

      const label = row.entityId !== null ? `${row.entityType} #${row.entityId}` : (row.entityType || '—');
      chip.textContent = label;
      return chip;
    }

    case 'metadata': {
      if (!row.metadataJson || Object.keys(row.metadataJson).length === 0) {
        const dash = document.createElement('span');
        dash.style.color = 'var(--color-text-tertiary)';
        dash.textContent = '—';
        return dash;
      }

      const wrap = document.createElement('div');
      wrap.className = 'audit-meta-preview';

      const entries = Object.entries(row.metadataJson);
      const visibleEntries = entries.slice(0, 3);

      visibleEntries.forEach(([k, v]) => {
        const tag = document.createElement('span');
        tag.className = 'audit-meta-tag';
        tag.title = `${k}: ${v}`;

        const keySpan = document.createElement('span');
        keySpan.className = 'audit-meta-tag__key';
        keySpan.textContent = `${k}:`;

        tag.append(keySpan, document.createTextNode(` ${v}`));
        wrap.appendChild(tag);
      });

      if (entries.length > 3) {
        const moreTag = document.createElement('span');
        moreTag.className = 'audit-meta-tag';
        moreTag.style.color = 'var(--color-primary)';
        moreTag.textContent = `+${entries.length - 3} more`;
        wrap.appendChild(moreTag);
      }

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
  wrap.setAttribute('aria-label', 'Loading audit log');
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
