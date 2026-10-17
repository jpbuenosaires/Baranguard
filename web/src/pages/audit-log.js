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
import { openPrintPreviewModal } from '../components/PrintPreviewModal.js';
import { escapeHtml } from '../utils/escapeHtml.js';
import { formatManilaDate, formatManilaDateTime, formatManilaTimeSeconds, manilaDateKey } from '../utils/manilaTime.js';
import {
  formatAuditCode,
  formatUserCode,
  formatIncidentCode,
  formatDispatchCode,
  formatShiftCode,
  formatCitizenReportCode,
  formatSosCode,
  formatSmsCode,
  formatSchoolCode,
  formatAccomplishmentCode,
  formatAnnexDCode,
  formatSwapCode,
} from '../services/tanodWorkflowUi.js';

function formatAuditEntity(entityType, entityId, displayId = null) {
  if (!entityType) return '—';
  if (entityId === null || entityId === undefined) return entityType;
  switch (String(entityType).toLowerCase()) {
    case 'incident': return formatIncidentCode(entityId, displayId);
    case 'dispatch': return formatDispatchCode(entityId);
    case 'shift': return formatShiftCode(entityId);
    case 'user': return formatUserCode(entityId);
    case 'citizen_report':
    case 'report': return formatCitizenReportCode(entityId);
    case 'sos': return formatSosCode(entityId);
    case 'sms': return formatSmsCode(entityId);
    case 'school': return formatSchoolCode(entityId);
    case 'accomplishment_report': return formatAccomplishmentCode(entityId);
    case 'annex_d': return formatAnnexDCode(entityId);
    case 'swap': return formatSwapCode(entityId);
    default: return `${entityType} #${entityId}`;
  }
}

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
  // Legacy labels: rows written before migration 0029 removed the blotter
  // and AI redaction pipeline still exist in audit_log (write-once).
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
  evidence_accessed: 'Evidence accessed',
  dispatch_status_changed: 'Dispatch status changed',
  dispatch_offer_opened: 'Dispatch offer opened',
  dispatch_offer_accepted: 'Dispatch offer accepted',
  dispatch_offer_cancelled: 'Dispatch offer cancelled',
  dispatch_offer_closed: 'Dispatch offer closed',
  dispatch_offer_expired: 'Dispatch offer expired',
  dispatch_offer_reminder: 'Dispatch offer reminder',
  incident_lifecycle_changed: 'Incident lifecycle changed',
  incident_updated: 'Incident updated',
  incident_related_changed: 'Related incident changed',
  citizen_report_converted: 'Citizen report converted',
  raw_narrative_viewed: 'Raw narrative viewed',
  availability_reviewed: 'Availability reviewed',
  paper_signature_recorded: 'Paper signature recorded',
  approval_recorded_from_paper: 'Approval recorded from paper',
  document_scan_uploaded: 'Document scan uploaded',
  document_scan_downloaded: 'Document scan downloaded',
  school_created: 'School created',
  school_updated: 'School updated',
  ssz_term_report_created: 'Annex D created',
  ssz_term_report_prepared: 'Annex D prepared',
  ssz_term_report_approved: 'Annex D approved',
  ssz_term_report_submitted: 'Annex D submitted',
  sms_broadcast_sent: 'SMS broadcast sent',
  sms_manual_sent: 'SMS manual reply sent',
  sms_subscriber_added: 'SMS subscriber added',
  sms_subscriber_opted_out: 'SMS subscriber opted out',
  system_settings_updated: 'System settings updated',
  user_created: 'User created',
  user_approval_authority_changed: 'Approval authority changed',
  evidence_downloaded: 'Evidence downloaded',
  report_export_downloaded: 'Report export downloaded',
  report_digest_downloaded: 'Report digest downloaded',
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
      'dispatch_status_changed', 'dispatch_offer_opened', 'dispatch_offer_accepted',
      'dispatch_offer_cancelled', 'dispatch_offer_closed', 'dispatch_offer_expired',
      'dispatch_offer_reminder', 'availability_reviewed',
    ],
  },
  incidents: {
    label: 'Incidents',
    actions: [
      'incident_resolved', 'incident_lifecycle_changed', 'incident_updated',
      'incident_related_changed', 'citizen_report_converted',
      'tanod_sos_raised', 'tanod_sos_acknowledged', 'tanod_sos_resolved',
      'evidence_accessed', 'evidence_downloaded', 'raw_narrative_viewed',
    ],
  },
  system: {
    label: 'System',
    actions: [
      'map_package_published', 'report_exported',
      'device_registered', 'device_deactivated',
      'user_created', 'user_updated', 'user_status_changed', 'user_approval_authority_changed',
      'system_settings_updated', 'sms_broadcast_sent', 'sms_manual_sent',
      'sms_subscriber_added', 'sms_subscriber_opted_out',
      'paper_signature_recorded', 'approval_recorded_from_paper',
      'document_scan_uploaded', 'document_scan_downloaded',
      'school_created', 'school_updated',
      'ssz_term_report_created', 'ssz_term_report_prepared',
      'ssz_term_report_approved', 'ssz_term_report_submitted',
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
  // Manila has no daylight saving, so whole-day subtraction is exact.
  return manilaDateKey(Date.now() - (days - 1) * 86400000);
}

function getTodayISO() {
  return manilaDateKey(new Date());
}

/** "2026-10-09" (a Manila calendar day) -> "Oct 9, 2026". */
function dayLabel(iso) {
  return /^\d{4}-\d{2}-\d{2}$/.test(String(iso || '')) ? formatManilaDate(`${iso}T00:00:00+08:00`) : '';
}

/** Plain words for an action code that has no entry in ACTION_LABELS. */
function actionText(action) {
  if (!action) return 'Unknown action';
  if (ACTION_LABELS[action]) return ACTION_LABELS[action];
  const words = String(action).replace(/_/g, ' ').trim();
  return words.charAt(0).toUpperCase() + words.slice(1);
}

/**
 * Formats an instant as Manila date + time parts (Rule 11).
 * @param {string|Date} value
 * @returns {{ date: string, time: string }}
 */
function formatAuditTime(value) {
  if (!value) return { date: '—', time: '' };
  const date = formatManilaDate(value, '');
  if (!date) return { date: 'Not recorded', time: '' };
  return { date, time: formatManilaTimeSeconds(value, '') };
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

  const headers = ['Audit ID', 'When (Manila time)', 'Timestamp (UTC)', 'Actor ID', 'Actor Username', 'Action', 'Entity Type', 'Entity ID', 'Metadata'];
  const rows = items.map((item) => [
    item.auditId,
    `"${formatManilaDateTime(item.createdAt, '')}"`,
    `"${item.createdAt instanceof Date ? item.createdAt.toISOString() : (item.createdAt || '')}"`,
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
  link.setAttribute('download', `baranguard_audit_log_${getTodayISO()}.csv`);
  document.body.appendChild(link);
  link.click();
  document.body.removeChild(link);
  URL.revokeObjectURL(url);
}

/**
 * Opens an A4 Print Preview Modal for the current Audit Log compliance excerpt.
 */
function openAuditPrintModal({ items, totalItems, dateFrom, dateTo, categoryLabel, actionLabel, searchQuery, user }) {
  if (!items || items.length === 0) {
    showToast('No audit log entries available to preview.', { variant: 'info' });
    return;
  }

  const printedAt = formatManilaDateTime(new Date());
  const preparedBy = user?.fullName || 'System Administrator';
  const scopeDesc = [categoryLabel || 'All Categories', actionLabel || 'All Actions'].join(' · ');

  const rowsHtml = items.map((item) => {
    const actor = item.actorUsername
      ? `${item.actorUsername} (${item.actorUserId ? formatUserCode(item.actorUserId) : '—'})`
      : (item.actorUserId ? formatUserCode(item.actorUserId) : 'SYSTEM');
    const actionName = actionText(item.action);
    const entityText = item.entityType
      ? formatAuditEntity(item.entityType, item.entityId, item.entityDisplayId)
      : '—';
    const metaEntries = item.metadataJson && typeof item.metadataJson === 'object'
      ? Object.entries(item.metadataJson).map(([k, v]) => `${k}: ${typeof v === 'object' ? JSON.stringify(v) : v}`).join('; ')
      : '—';

    return `
      <tr>
        <td>${escapeHtml(formatAuditCode(item.auditId))}</td>
        <td>${escapeHtml(formatManilaDateTime(item.createdAt, '—'))}</td>
        <td>${escapeHtml(actor)}</td>
        <td>${escapeHtml(actionName)}</td>
        <td>${escapeHtml(entityText)}</td>
        <td>${escapeHtml(metaEntries || '—')}</td>
      </tr>
    `;
  }).join('');

  const sheetHtml = `
    <div class="print-sheet__header">
      <p class="print-sheet__republic">Republic of the Philippines</p>
      <p class="print-sheet__office">Barangay Administrative Record</p>
      <h3 class="print-sheet__title">System Audit Trail Excerpt</h3>
      <p class="print-sheet__subline">Covering ${escapeHtml(dayLabel(dateFrom))} to ${escapeHtml(dayLabel(dateTo))}${searchQuery ? ` · Filtered by "${escapeHtml(searchQuery)}"` : ''}</p>
      <div>
        <span class="print-sheet__badge print-sheet__badge--finalized">Write-once record: entries cannot be edited or deleted</span>
      </div>
    </div>

    <div class="print-sheet__meta-bar">
      <div class="print-sheet__meta-cell">
        <div class="print-sheet__meta-label">Period Covered</div>
        <div class="print-sheet__meta-val">${escapeHtml(dayLabel(dateFrom))} to ${escapeHtml(dayLabel(dateTo))}</div>
      </div>
      <div class="print-sheet__meta-cell">
        <div class="print-sheet__meta-label">Filter Scope</div>
        <div class="print-sheet__meta-val">${escapeHtml(scopeDesc)}</div>
      </div>
      <div class="print-sheet__meta-cell">
        <div class="print-sheet__meta-label">Entries in Excerpt</div>
        <div class="print-sheet__meta-val">${escapeHtml(String(items.length))} of ${escapeHtml(String(totalItems))} total</div>
      </div>
      <div class="print-sheet__meta-cell">
        <div class="print-sheet__meta-label">Exported By</div>
        <div class="print-sheet__meta-val">${escapeHtml(preparedBy)}</div>
      </div>
    </div>

    <div class="print-sheet__section">
      <h4 class="print-sheet__section-title">Recorded System &amp; Administrative Events</h4>
      <table class="print-sheet__table">
        <thead>
          <tr>
            <th scope="col">Audit ID</th>
            <th scope="col">When (Manila time)</th>
            <th scope="col">Actor</th>
            <th scope="col">Action</th>
            <th scope="col">Target Entity</th>
            <th scope="col">Metadata Summary</th>
          </tr>
        </thead>
        <tbody>
          ${rowsHtml}
        </tbody>
      </table>
    </div>

    <div class="print-sheet__section">
      <h4 class="print-sheet__section-title">Record-keeping Notice</h4>
      <div class="print-sheet__narrative">Audit log entries in Baranguard are write-once. No user or administrator can edit or delete them from the system. Old entries are removed automatically only when the system's retention period for audit records has passed. This printout is not signed until a person signs it below.</div>
    </div>

    <div class="print-sheet__signatures">
      <div class="print-sheet__sig-box">
        <div class="print-sheet__sig-line">${escapeHtml(preparedBy)}</div>
        <div class="print-sheet__sig-role">Prepared &amp; Exported By</div>
      </div>
      <div class="print-sheet__sig-box">
        <div class="print-sheet__sig-line"></div>
        <div class="print-sheet__sig-role">Reviewed by (Punong Barangay) · Date: ____________</div>
      </div>
    </div>

    <div class="print-sheet__footer">
      <span>Baranguard Audit Compliance Console</span>
      <span>Official audit trail excerpt</span>
    </div>
  `;

  openPrintPreviewModal({
    title: 'Printable Audit Trail Excerpt',
    subtitle: `${dayLabel(dateFrom)} to ${dayLabel(dateTo)} · ${items.length} entries`,
    sheetId: 'printable-audit-sheet',
    sheetHtml,
    extraActions: [
      {
        label: 'Export CSV',
        icon: icons.download(15),
        className: 'ghost',
        onClick: () => exportAuditLogsToCsv(items),
      },
    ],
  });
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

  // Page Header with Preview & Print Excerpt + Export CSV actions
  const pageHeader = PageHeader({
    title: 'Audit Log',
    subtitle: 'Permanent record of administrative actions and system events',
    icon: icons.shield,
  });

  const previewPrintBtn = document.createElement('button');
  previewPrintBtn.type = 'button';
  previewPrintBtn.id = 'preview-audit-print-btn';
  previewPrintBtn.className = 'ghost';
  previewPrintBtn.classList.add('audit-header-btn');
  previewPrintBtn.innerHTML = `${icons.printer(16)}<span>Print preview</span>`;
  previewPrintBtn.addEventListener('click', () => {
    const filtered = filterItemsBySearch(currentItems);
    const categoryLabel = activeFilterCategory && CATEGORIES[activeFilterCategory]
      ? CATEGORIES[activeFilterCategory].label
      : 'All Categories';
    const actionLabel = actionSelect.value
      ? actionText(actionSelect.value)
      : 'All Actions';
    openAuditPrintModal({
      items: filtered,
      totalItems: totalAuditItems,
      dateFrom: activeDateFrom,
      dateTo: activeDateTo,
      categoryLabel,
      actionLabel,
      searchQuery,
      user,
    });
  });

  const exportBtn = document.createElement('button');
  exportBtn.type = 'button';
  exportBtn.className = 'ghost';
  exportBtn.classList.add('audit-header-btn');
  exportBtn.innerHTML = `${icons.download(16)}<span>Export CSV</span>`;
  exportBtn.addEventListener('click', () => exportAuditLogsToCsv(filterItemsBySearch(currentItems)));
  pageHeader.actions.append(previewPrintBtn, exportBtn);

  header.appendChild(pageHeader.el);

  // Outer Page Container
  const pageContainer = document.createElement('div');
  pageContainer.className = 'audit-page-container';

  // Embedded Interactive StatStrip Host (Option A: Unified Command Card)
  const statStripHost = document.createElement('div');
  statStripHost.className = 'personnel-card-stat-strip audit-stat-strip';
  statStripHost.setAttribute('role', 'toolbar');
  statStripHost.setAttribute('aria-label', 'Audit category quick filters');

  // 3. Full-Width 4-Column Filter Toolbar
  const filterPanel = document.createElement('div');
  filterPanel.className = 'audit-filter-panel';

  // Col 1: Search Input
  const searchField = document.createElement('div');
  searchField.className = 'audit-search-field';
  const searchIcon = document.createElement('span');
  searchIcon.className = 'audit-search-field__icon';
  searchIcon.innerHTML = icons.search(16);
  searchIcon.setAttribute('aria-hidden', 'true');
  const searchInput = document.createElement('input');
  searchInput.type = 'search';
  searchInput.id = 'audit-search';
  searchInput.placeholder = 'Search the rows loaded on this page…';
  searchInput.setAttribute('aria-label', 'Search the audit log rows loaded on this page (use filters and paging for other records)');
  searchInput.title = 'Searches only the rows shown on this page. Use the action and date filters, or change page, to reach other records.';
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
  categoryChevron.setAttribute('aria-hidden', 'true');
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
      option.textContent = actionText(act);
      actionSelect.appendChild(option);
    }
  }
  populateActionSelect();

  const actionChevron = document.createElement('span');
  actionChevron.className = 'audit-select-chevron';
  actionChevron.innerHTML = icons.chevronDown(14);
  actionChevron.setAttribute('aria-hidden', 'true');
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

  // Announces the result count to screen readers after each filter or page change.
  const resultStatus = document.createElement('p');
  resultStatus.className = 'sr-only';
  resultStatus.setAttribute('role', 'status');

  // 4. Data Table Container
  const tableContainer = document.createElement('div');
  tableContainer.className = 'audit-table-wrap';

  const tableCard = document.createElement('div');
  tableCard.className = 'audit-table-card unified-table-card';
  tableCard.append(statStripHost, filterPanel, resultStatus, tableContainer);
  pageContainer.appendChild(tableCard);

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
    let incidentCount = 0;

    items.forEach((item) => {
      const act = item.action;
      if (CATEGORIES.auth.actions.includes(act)) authCount++;
      else if (CATEGORIES.ops.actions.includes(act)) opsCount++;
      else if (CATEGORIES.incidents.actions.includes(act)) incidentCount++;
    });

    const statCardsData = [
      { id: '', label: 'Total Events', value: totalCount },
      { id: 'auth', label: 'Auth & Access', value: authCount, tone: 'info' },
      { id: 'ops', label: 'Operations & Dispatch', value: opsCount, tone: 'warning' },
      { id: 'incidents', label: 'Incidents', value: incidentCount, tone: 'success' },
    ];

    statCardsData.forEach((stat) => {
      const isActive = activeFilterCategory === stat.id;
      const card = document.createElement('button');
      card.type = 'button';
      card.className = `personnel-stat-chip${isActive ? ' is-active' : ''}`;
      card.setAttribute('aria-pressed', isActive ? 'true' : 'false');
      card.setAttribute('aria-label', `Filter by ${stat.label} (${stat.value})`);

      const lbl = document.createElement('span');
      lbl.className = 'stat-chip__label';
      lbl.textContent = stat.label;

      const val = document.createElement('span');
      val.className = `stat-chip__count${stat.tone ? ' tone-' + stat.tone : ''}`;
      val.textContent = String(stat.value);

      card.append(lbl, val);

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

    const badge = document.createElement('span');
    badge.className = 'audit-write-once-pill';
    badge.innerHTML = `${icons.lock(12)} <span>Write-once · Permanent Audit Trail</span>`;
    statStripHost.appendChild(badge);
  }

  function renderList(items, totalItems) {
    tableContainer.innerHTML = '';
    resultStatus.textContent = `Showing ${items.length} of ${totalItems} audit entries.`;
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
    backdrop.setAttribute('aria-labelledby', 'audit-modal-title');

    const card = document.createElement('div');
    card.className = 'audit-modal-card';

    // Header
    const headerEl = document.createElement('div');
    headerEl.className = 'audit-modal-header';

    const titleEl = document.createElement('h3');
    titleEl.className = 'audit-modal-title';
    titleEl.id = 'audit-modal-title';
    titleEl.innerHTML = `${icons.shield(18)}<span>${escapeHtml(formatAuditCode(row.auditId))}</span>`;

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
    const actionLabel = actionText(row.action);

    grid.innerHTML = `
      <div class="audit-modal-field">
        <span class="audit-modal-label">When</span>
        <span class="audit-modal-value">${escapeHtml(date)} ${escapeHtml(time)} (Manila time)</span>
      </div>
      <div class="audit-modal-field">
        <span class="audit-modal-label">Actor / Initiator</span>
        <span class="audit-modal-value">${row.actorUserId !== null ? `${escapeHtml(row.actorUsername || 'User')} (${escapeHtml(formatUserCode(row.actorUserId))})` : 'System Daemon (Automated)'}</span>
      </div>
      <div class="audit-modal-field">
        <span class="audit-modal-label">Action</span>
        <span class="audit-modal-value">
          <span class="audit-action-pill audit-action-pill--${tone}">${escapeHtml(actionLabel)}</span>
        </span>
      </div>
      <div class="audit-modal-field">
        <span class="audit-modal-label">Target Entity</span>
        <span class="audit-modal-value">${escapeHtml(formatAuditEntity(row.entityType, row.entityId, row.entityDisplayId))}</span>
      </div>
    `;

    // JSON Section
    const jsonSection = document.createElement('div');
    jsonSection.className = 'audit-modal-json-section';

    const jsonLabel = document.createElement('span');
    jsonLabel.className = 'audit-modal-label';
    jsonLabel.textContent = 'Recorded details (technical)';

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
    copyBtn.innerHTML = `${icons.copy(14)}<span>Copy details</span>`;

    copyBtn.addEventListener('click', async () => {
      try {
        await navigator.clipboard.writeText(jsonString);
        copyBtn.innerHTML = `${icons.checkCircle(14)}<span>Copied</span>`;
        copyBtn.classList.add('is-copied');
        setTimeout(() => {
          copyBtn.innerHTML = `${icons.copy(14)}<span>Copy details</span>`;
          copyBtn.classList.remove('is-copied');
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

    // Focus management: remember the opener, move focus into the dialog,
    // keep Tab inside it, and give focus back on close (audit X-10).
    const opener = document.activeElement;
    const closeModal = () => {
      document.removeEventListener('keydown', handleKey);
      backdrop.remove();
      if (opener && typeof opener.focus === 'function' && opener.isConnected) opener.focus();
    };

    const handleKey = (e) => {
      if (e.key === 'Escape') { closeModal(); return; }
      if (e.key !== 'Tab') return;
      const focusable = [...card.querySelectorAll('button, [href], input, select, textarea, [tabindex]:not([tabindex="-1"])')]
        .filter((el) => !el.disabled);
      if (focusable.length === 0) return;
      const first = focusable[0];
      const last = focusable[focusable.length - 1];
      if (e.shiftKey && document.activeElement === first) { e.preventDefault(); last.focus(); }
      else if (!e.shiftKey && document.activeElement === last) { e.preventDefault(); first.focus(); }
    };

    closeBtn.addEventListener('click', closeModal);
    doneBtn.addEventListener('click', closeModal);
    backdrop.addEventListener('click', (e) => {
      if (e.target === backdrop) closeModal();
    });
    document.addEventListener('keydown', handleKey);
    closeBtn.focus();
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
      name.textContent = row.actorUsername || (row.actorUserId ? formatUserCode(row.actorUserId) : 'System');

      const id = document.createElement('span');
      id.className = 'audit-actor-id';
      id.textContent = row.actorUserId ? formatUserCode(row.actorUserId) : 'System';

      info.append(name, id);
      wrap.append(avatarEl, info);
      return wrap;
    }

    case 'action': {
      const span = document.createElement('span');
      const tone = getActionTone(row.action);
      span.className = `audit-action-pill audit-action-pill--${tone}`;
      span.textContent = actionText(row.action);
      return span;
    }

    case 'entity': {
      const chip = document.createElement('span');
      chip.className = 'audit-entity-chip';

      // Provide deep navigation link if entity is a known route
      if (row.entityType === 'user' && row.entityId) {
        const chipBtn = document.createElement('button');
        chipBtn.type = 'button';
        chipBtn.className = 'audit-entity-chip audit-entity-chip--interactive';
        const userCode = formatUserCode(row.entityId);
        chipBtn.title = `View Personnel (${userCode})`;
        chipBtn.setAttribute('aria-label', `View Personnel ${userCode}`);
        chipBtn.textContent = `${userCode} ↗`;
        chipBtn.addEventListener('click', (e) => {
          e.stopPropagation();
          navigate('personnel', { userId: row.entityId });
        });
        return chipBtn;
      }

      const label = formatAuditEntity(row.entityType, row.entityId, row.entityDisplayId);
      chip.textContent = label;
      return chip;
    }

    case 'metadata': {
      if (!row.metadataJson || Object.keys(row.metadataJson).length === 0) {
        const dash = document.createElement('span');
        dash.className = 'audit-meta-empty';
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
        moreTag.className = 'audit-meta-tag audit-meta-tag--more';
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
