/**
 * incident-management.js — Redesigned Incident Management console
 * matching the operational design reference (split view, counter chips,
 * structured filter bar, formatted table, and detailed action pane).
 * Includes ergonomic enhancements: sticky scrollable detail, active row border,
 * smart assign shortcut, contact modal (Call + SMS), smart blotter button,
 * keyboard navigation (↑ / ↓ / Esc), floating quick help guide, and mobile toggle.
 */

import {
  getIncidents, createIncident, getIncident, updateIncident, getUsers,
  getDutyStatus, getDispatches, updateIncidentStatus, getBarangays, sendSms,
  logout, ApiClientError,
} from '../api/apiClient.js';
import { AppShell } from '../components/AppShell.js';
import { PageHeader } from '../components/PageHeader.js';
import { DataTable } from '../components/DataTable.js';
import { icons } from '../components/icons.js';
import { showToast } from '../components/Toast.js';
import { confirmDialog } from '../components/ConfirmDialog.js';
import { promptDispatchTanod } from '../components/DispatchAction.js';

const INCIDENT_TYPE_LABELS = {
  sos: 'SOS / Emergency',
  theft: 'Theft / Robbery',
  physical_injury: 'Physical Injury',
  disturbance: 'Disturbance',
  domestic_dispute: 'Domestic Dispute',
  vandalism: 'Vandalism',
  traffic_incident: 'Traffic Incident',
  fire: 'Fire',
  medical_emergency: 'Medical Emergency',
  missing_person: 'Missing Person',
  animal_complaint: 'Animal Complaint',
  other: 'Other',
};

const PRIORITY_LABELS = {
  critical: 'Critical',
  high: 'High',
  normal: 'Medium',
  medium: 'Medium',
  low: 'Low',
};

const STATUS_DISPLAY_LABELS = {
  pending: 'Active',
  dispatched: 'Responding',
  resolved: 'Resolved',
  closed: 'Closed',
};

const PAGE_SIZE = 15;
const SEARCH_DEBOUNCE_MS = 350;

const COLUMNS = [
  { key: 'incident', label: 'INCIDENT' },
  { key: 'location', label: 'LOCATION' },
  { key: 'priority', label: 'PRIORITY' },
  { key: 'status', label: 'STATUS' },
  { key: 'action', label: '', width: '2.5rem', align: 'right' },
];

/**
 * Format ISO date/time string to YYYY-MM-DD HH:mm (e.g. 2026-06-11 08:42)
 */
function formatDateTime(isoString) {
  if (!isoString) return '—';
  const d = new Date(isoString);
  if (isNaN(d.getTime())) return isoString;
  const pad = (n) => String(n).padStart(2, '0');
  const y = d.getFullYear();
  const m = pad(d.getMonth() + 1);
  const day = pad(d.getDate());
  const h = pad(d.getHours());
  const min = pad(d.getMinutes());
  return `${y}-${m}-${day} ${h}:${min}`;
}

/**
 * Format display code (e.g. INC-2026-048)
 */
function formatIncidentCode(row) {
  if (row.displayId) return row.displayId;
  const year = row.createdAt ? new Date(row.createdAt).getFullYear() : '2026';
  return `INC-${year}-${String(row.incidentId).padStart(3, '0')}`;
}

/**
 * Calculate relative time difference string (e.g. "2 min later" or timestamp)
 */
function formatRelativeTime(isoStart, isoEnd) {
  if (!isoEnd) return null;
  if (!isoStart) return formatDateTime(isoEnd);
  const start = new Date(isoStart).getTime();
  const end = new Date(isoEnd).getTime();
  const diffSec = Math.round((end - start) / 1000);
  if (diffSec < 0) return formatDateTime(isoEnd);
  const diffMin = Math.round(diffSec / 60);
  if (diffMin < 1) return 'Just moments later';
  if (diffMin < 60) return `${diffMin} min later`;
  const diffHrs = Math.round(diffMin / 60);
  if (diffHrs < 24) return `${diffHrs} hr${diffHrs > 1 ? 's' : ''} later`;
  return formatDateTime(isoEnd);
}

/**
 * @param {HTMLElement} root
 * @param {{fullName:string, role:string, barangayId:number}} user
 * @param {() => void} onLoggedOut
 * @param {(page: string, param?: any) => void} navigate
 */
/**
 * @param {number} [initialIncidentId] optional deep link, e.g. from Citizen
 *   Reports Inbox's "View in Incident Management" after a conversion —
 *   opens straight to that incident's detail pane rather than the default
 *   full-width list view. Passed through by main.js as the route param.
 */
export function renderIncidentManagementPage(root, user, onLoggedOut, navigate, initialIncidentId) {
  root.innerHTML = '';

  const isAdmin = user.role === 'admin';
  const isSecretary = user.role === 'secretary';
  const canCreate = isAdmin || isSecretary;

  // Active modal tracking
  let activeModalEl = null;
  function closeActiveModal() {
    if (activeModalEl && activeModalEl.parentNode) {
      activeModalEl.parentNode.removeChild(activeModalEl);
    }
    activeModalEl = null;
  }

  const shell = AppShell(user, 'incident-management', navigate, async () => {
    window.removeEventListener('keydown', handleKeyDown);
    closeActiveModal();
    shell.logoutButton.disabled = true;
    await logout();
    onLoggedOut();
  });
  const { header, content } = shell;
  root.appendChild(shell.el);

  // Mark containers to lock outer page scrolling so only the table is scrollable
  content.classList.add('incident-page-container');
  if (content.parentElement) {
    content.parentElement.classList.add('page-content--no-scroll');
  }

  // --- State Variables ---
  let statusFilter = undefined;
  let priorityFilter = undefined;
  let searchQuery = undefined;
  let currentPage = 1;
  let selectedIncidentId = null;
  let lastItems = [];
  let currentDetail = null;
  let currentOfficerContact = null;
  let activeViewMode = 'detail'; // 'detail', 'new', 'edit'

  // Cached Lookups
  const barangayNameById = new Map();
  let eligibleTanods = [];
  let tanodRosterById = new Map();

  // --- Standard Tokenized Page Header ---
  const pageHeader = PageHeader({
    title: 'Incident Management',
    subtitle: 'Track and manage all reported incidents',
    icon: icons.alertTriangle,
  });

  if (canCreate) {
    const newIncidentBtn = document.createElement('button');
    newIncidentBtn.type = 'button';
    newIncidentBtn.className = 'btn-blotter-new';
    newIncidentBtn.innerHTML = `${icons.plus(16)} <span>New Incident</span>`;
    newIncidentBtn.addEventListener('click', () => {
      if (activeViewMode === 'new') {
        closeDetailPane();
      } else {
        activeViewMode = 'new';
        selectedIncidentId = null;
        layout.classList.add('has-detail');
        highlightSelectedRow();
        renderRightPane();
      }
    });
    pageHeader.actions.appendChild(newIncidentBtn);
  }
  header.appendChild(pageHeader.el);

  // --- Mobile View Toggle Bar (Responsive Screens) ---
  const mobileToggleBar = document.createElement('div');
  mobileToggleBar.className = 'incident-mobile-toggle-bar';
  const btnList = document.createElement('button');
  btnList.type = 'button';
  btnList.className = 'incident-mobile-toggle-btn is-active';
  btnList.textContent = 'Incident List';
  const btnDetails = document.createElement('button');
  btnDetails.type = 'button';
  btnDetails.className = 'incident-mobile-toggle-btn';
  btnDetails.textContent = 'Incident Details';
  mobileToggleBar.append(btnList, btnDetails);
  content.appendChild(mobileToggleBar);

  // --- Main Responsive Split Layout (Full width at first; shrinks when incident selected) ---
  const layout = document.createElement('div');
  layout.className = 'incident-layout mobile-view-list';
  content.appendChild(layout);

  btnList.addEventListener('click', () => {
    btnList.classList.add('is-active');
    btnDetails.classList.remove('is-active');
    layout.classList.remove('mobile-view-details');
    layout.classList.add('mobile-view-list');
  });

  btnDetails.addEventListener('click', () => {
    btnDetails.classList.add('is-active');
    btnList.classList.remove('is-active');
    layout.classList.remove('mobile-view-list');
    layout.classList.add('mobile-view-details');
  });

  // Left Column (Table & Filters)
  const leftPanel = document.createElement('div');
  leftPanel.className = 'incident-left-panel';
  layout.appendChild(leftPanel);

  // Filter Bar
  const filterBar = document.createElement('div');
  filterBar.className = 'incident-filter-bar';

  // 1. Search Box
  const searchWrap = document.createElement('div');
  searchWrap.className = 'incident-search-wrap';
  const searchIcon = document.createElement('span');
  searchIcon.className = 'incident-search-icon';
  searchIcon.innerHTML = icons.search(16);
  const searchInput = document.createElement('input');
  searchInput.type = 'search';
  searchInput.className = 'incident-search-input';
  searchInput.placeholder = 'Search incidents…';

  let searchDebounce = null;
  searchInput.addEventListener('input', () => {
    clearTimeout(searchDebounce);
    searchDebounce = setTimeout(() => {
      searchQuery = searchInput.value.trim() || undefined;
      currentPage = 1;
      load();
    }, SEARCH_DEBOUNCE_MS);
  });
  searchWrap.append(searchIcon, searchInput);
  filterBar.appendChild(searchWrap);

  // 2. Funnel Filter Icon Button
  const funnelBtn = document.createElement('button');
  funnelBtn.type = 'button';
  funnelBtn.className = 'incident-filter-funnel';
  funnelBtn.setAttribute('aria-label', 'Reset filters');
  funnelBtn.title = 'Reset all filters';
  funnelBtn.innerHTML = icons.filter(16);
  funnelBtn.addEventListener('click', () => {
    searchInput.value = '';
    searchQuery = undefined;
    prioritySelect.value = '';
    priorityFilter = undefined;
    statusSelect.value = '';
    statusFilter = undefined;
    currentPage = 1;
    load();
  });
  filterBar.appendChild(funnelBtn);

  // 3. Priority Dropdown
  const prioritySelect = document.createElement('select');
  prioritySelect.className = 'incident-filter-select';
  prioritySelect.setAttribute('aria-label', 'Filter by priority');
  const priorityOptions = [
    { value: '', label: 'All Priority' },
    { value: 'critical', label: 'Critical' },
    { value: 'high', label: 'High' },
    { value: 'normal', label: 'Medium' },
    { value: 'low', label: 'Low' },
  ];
  for (const opt of priorityOptions) {
    const el = document.createElement('option');
    el.value = opt.value;
    el.textContent = opt.label;
    prioritySelect.appendChild(el);
  }
  prioritySelect.addEventListener('change', () => {
    priorityFilter = prioritySelect.value || undefined;
    currentPage = 1;
    load();
  });
  filterBar.appendChild(prioritySelect);

  // 4. Status Dropdown
  const statusSelect = document.createElement('select');
  statusSelect.className = 'incident-filter-select';
  statusSelect.setAttribute('aria-label', 'Filter by status');
  const statusOptions = [
    { value: '', label: 'All Status' },
    { value: 'pending', label: 'Active' },
    { value: 'dispatched', label: 'Responding' },
    { value: 'resolved', label: 'Resolved' },
    { value: 'closed', label: 'Closed' },
  ];
  for (const opt of statusOptions) {
    const el = document.createElement('option');
    el.value = opt.value;
    el.textContent = opt.label;
    statusSelect.appendChild(el);
  }
  statusSelect.addEventListener('change', () => {
    const val = statusSelect.value;
    if (val === 'closed') {
      statusFilter = 'resolved';
    } else {
      statusFilter = val || undefined;
    }
    currentPage = 1;
    load();
  });
  filterBar.appendChild(statusSelect);

  leftPanel.appendChild(filterBar);

  // Table Container
  const tableContainer = document.createElement('div');
  tableContainer.className = 'incident-table-wrap';
  leftPanel.appendChild(tableContainer);

  // Right Column (Detail View / Forms / Placeholder)
  const rightPanel = document.createElement('div');
  rightPanel.className = 'incident-right-panel';
  layout.appendChild(rightPanel);

  // Floating Quick Help Button
  const helpBtn = document.createElement('button');
  helpBtn.type = 'button';
  helpBtn.className = 'incident-floating-help';
  helpBtn.title = 'Incident Management Guide & Shortcuts';
  helpBtn.textContent = '?';
  helpBtn.addEventListener('click', () => showHelpModal());
  content.appendChild(helpBtn);

  // --- Initial Data Preloading ---
  initReferenceData();

  // Deep link: open straight to the requested incident. Independent of
  // load()'s own list-matching logic (which only opens a row already
  // present in the CURRENT filtered/paginated page) so this works
  // regardless of what page/filter the list happens to be on —
  // selectIncident() only needs an incidentId, it re-fetches the detail
  // itself via getIncident().
  if (initialIncidentId != null) {
    activeViewMode = 'detail';
    selectIncident({ incidentId: initialIncidentId });
  }

  async function initReferenceData() {
    try {
      const bRes = await getBarangays();
      bRes.forEach((b) => barangayNameById.set(b.barangayId, b.name));
    } catch {
      barangayNameById.set(1, 'Dao');
      barangayNameById.set(2, 'Marifosque');
      barangayNameById.set(3, 'Binanuahan');
      barangayNameById.set(4, 'Banuyo');
    }

    if (isAdmin) {
      loadTanodRoster();
    }

    load();
  }

  async function loadTanodRoster() {
    try {
      const [usersRes, dutyStatuses] = await Promise.all([
        getUsers({ role: 'tanod', limit: 100 }),
        getDutyStatus(user.barangayId),
      ]);
      tanodRosterById = new Map(usersRes.items.map((u) => [u.userId, u]));
      const onDutyIds = new Set(dutyStatuses.filter((d) => d.status === 'on_duty').map((d) => d.userId));
      eligibleTanods = usersRes.items.filter((u) => u.isActive && onDutyIds.has(u.userId));
    } catch {
      // Degrades gracefully
    }
  }

  // --- Load Incidents List ---
  async function load() {
    renderLoading(tableContainer);
    try {
      const result = await getIncidents({
        status: statusFilter,
        priority: priorityFilter,
        q: searchQuery,
        page: currentPage,
        limit: PAGE_SIZE,
      });
      lastItems = result.items;
      renderTable(result.items, result.total);

      // Only maintain detail pane if an incident is currently selected or user is adding new
      if (activeViewMode === 'detail') {
        if (selectedIncidentId != null) {
          const matching = lastItems.find((r) => r.incidentId === selectedIncidentId);
          if (matching) {
            selectIncident(matching);
          } else {
            closeDetailPane();
          }
        } else {
          // At first, table covers entire width!
          closeDetailPane();
        }
      } else if (activeViewMode === 'new') {
        layout.classList.add('has-detail');
        renderNewIncidentForm();
      }
    } catch (err) {
      const message = err instanceof ApiClientError ? err.message : 'Could not load incidents.';
      renderError(tableContainer, message, load);
    }
  }

  function renderTable(items, totalItems) {
    tableContainer.innerHTML = '';
    const table = DataTable({
      columns: COLUMNS,
      rows: items,
      rowKey: (row) => row.incidentId,
      selectedKey: selectedIncidentId,
      onRowClick: (row) => {
        if (selectedIncidentId === row.incidentId && activeViewMode === 'detail' && layout.classList.contains('has-detail')) {
          closeDetailPane();
          return;
        }
        activeViewMode = 'detail';
        selectIncident(row);
        if (window.innerWidth <= 1024) {
          btnDetails.click();
        }
      },
      caption: 'Incidents',
      emptyIcon: icons.alertTriangle,
      emptyMessage: 'No incidents match these filters.',
      page: currentPage,
      totalItems,
      pageSize: PAGE_SIZE,
      onPageChange: (nextPage) => {
        currentPage = nextPage;
        load();
      },
      renderCell: renderCell,
    });
    tableContainer.appendChild(table);
  }

  function renderCell(row, key) {
    switch (key) {
      case 'incident': {
        const stack = document.createElement('div');
        stack.className = 'incident-cell-stack';

        const code = document.createElement('span');
        code.className = 'incident-cell-code';
        code.textContent = formatIncidentCode(row);

        const type = document.createElement('span');
        type.className = 'incident-cell-type';
        type.textContent = INCIDENT_TYPE_LABELS[row.incidentType] || row.incidentType;

        const time = document.createElement('span');
        time.className = 'incident-cell-time';
        time.innerHTML = `${icons.clock(12)} <span>${formatDateTime(row.createdAt)}</span>`;

        stack.append(code, type, time);
        return stack;
      }
      case 'location': {
        const stack = document.createElement('div');
        stack.className = 'incident-cell-stack';

        const rawBrgy = barangayNameById.get(row.barangayId) || 'Dao';
        const bName = rawBrgy.startsWith('Brgy.') ? rawBrgy : `Brgy. ${rawBrgy}`;

        const locPrimary = document.createElement('span');
        locPrimary.className = 'incident-cell-loc-primary';
        locPrimary.innerHTML = `${icons.mapPin(13)} <span>${bName}</span>`;

        const locSub = document.createElement('span');
        locSub.className = 'incident-cell-loc-sub';
        locSub.textContent = row.locationDescription || (row.latitude != null ? `${row.latitude.toFixed(4)}, ${row.longitude.toFixed(4)}` : 'General area');

        stack.append(locPrimary, locSub);
        return stack;
      }
      case 'priority': {
        const pill = document.createElement('span');
        const prioKey = row.priority || 'normal';
        pill.className = `incident-priority-pill incident-priority-pill--${prioKey}`;
        pill.textContent = PRIORITY_LABELS[prioKey] || prioKey;
        return pill;
      }
      case 'status': {
        const indicator = document.createElement('span');
        const stat = row.status || 'pending';
        indicator.className = `incident-status-indicator incident-status-indicator--${stat}`;

        let iconSvg = icons.alertTriangle(14);
        let label = STATUS_DISPLAY_LABELS[stat] || stat;
        if (stat === 'dispatched') {
          iconSvg = icons.radio(14);
        } else if (stat === 'resolved') {
          iconSvg = icons.checkCircle(14);
        }

        indicator.innerHTML = `${iconSvg} <span>${label}</span>`;
        return indicator;
      }
      case 'action': {
        const eyeBtn = document.createElement('button');
        eyeBtn.type = 'button';
        eyeBtn.className = 'incident-row-eye';
        eyeBtn.setAttribute('aria-label', 'View incident');
        eyeBtn.innerHTML = icons.eye(16);
        eyeBtn.addEventListener('click', (e) => {
          e.stopPropagation();
          if (selectedIncidentId === row.incidentId && activeViewMode === 'detail' && layout.classList.contains('has-detail')) {
            closeDetailPane();
            return;
          }
          activeViewMode = 'detail';
          selectIncident(row);
          if (window.innerWidth <= 1024) {
            btnDetails.click();
          }
        });
        return eyeBtn;
      }
      default:
        return '';
    }
  }

  function highlightSelectedRow() {
    for (const tr of tableContainer.querySelectorAll('tbody tr')) {
      tr.classList.remove('is-selected');
    }
    if (selectedIncidentId == null) return;
    const idx = lastItems.findIndex((r) => r.incidentId === selectedIncidentId);
    const rows = tableContainer.querySelectorAll('tbody tr');
    if (idx > -1 && rows[idx]) rows[idx].classList.add('is-selected');
  }

  function closeDetailPane() {
    selectedIncidentId = null;
    currentDetail = null;
    activeViewMode = 'detail';
    layout.classList.remove('has-detail');
    rightPanel.innerHTML = '';
    highlightSelectedRow();
    if (window.innerWidth <= 1024) {
      btnList.click();
    }
  }

  // --- Select Incident & Load Details ---
  async function selectIncident(row) {
    selectedIncidentId = row.incidentId;
    activeViewMode = 'detail';
    layout.classList.add('has-detail');
    highlightSelectedRow();

    rightPanel.innerHTML = '';
    const loadingBlock = document.createElement('div');
    loadingBlock.className = 'skeleton skeleton--block';
    loadingBlock.style.height = '360px';
    loadingBlock.setAttribute('role', 'status');
    rightPanel.appendChild(loadingBlock);

    try {
      const detail = await getIncident(row.incidentId);
      currentDetail = detail;

      let officerContact = null;
      if (isAdmin && row.status !== 'pending') {
        try {
          const dispatches = await getDispatches({ incidentId: row.incidentId, limit: 5 });
          const latest = dispatches.items[0];
          officerContact = latest ? tanodRosterById.get(latest.tanodId)?.contactNumber || null : null;
        } catch {
          // enrichment only
        }
      }
      currentOfficerContact = officerContact;

      renderDetailPane(row, detail, officerContact);
    } catch (err) {
      renderDetailError(err instanceof ApiClientError ? err.message : 'Could not load incident details.', row);
    }
  }

  function renderRightPane() {
    if (activeViewMode === 'new') {
      layout.classList.add('has-detail');
      renderNewIncidentForm();
    } else if (activeViewMode === 'edit' && currentDetail) {
      layout.classList.add('has-detail');
      const row = lastItems.find((r) => r.incidentId === currentDetail.incidentId) || currentDetail;
      renderEditIncidentForm(row, currentDetail);
    } else if (selectedIncidentId != null) {
      const row = lastItems.find((r) => r.incidentId === selectedIncidentId);
      if (row) selectIncident(row);
      else closeDetailPane();
    } else {
      closeDetailPane();
    }
  }

  // --- Render Detail View ---
  function renderDetailPane(row, detail, officerContact) {
    rightPanel.innerHTML = '';

    const rawBrgy = barangayNameById.get(row.barangayId) || 'Dao';
    const bName = rawBrgy.startsWith('Brgy.') ? rawBrgy : `Brgy. ${rawBrgy}`;
    const code = formatIncidentCode(row);
    const typeLabel = INCIDENT_TYPE_LABELS[row.incidentType] || row.incidentType;
    const prioKey = row.priority || 'normal';
    const prioLabel = PRIORITY_LABELS[prioKey] || prioKey;
    const statLabel = STATUS_DISPLAY_LABELS[row.status] || row.status;

    // 1. Header
    const headerRow = document.createElement('div');
    headerRow.className = 'incident-detail-header';

    const titleWrap = document.createElement('div');
    titleWrap.className = 'incident-detail-title-wrap';
    const hId = document.createElement('h2');
    hId.className = 'incident-detail-id';
    hId.textContent = code;
    const hType = document.createElement('p');
    hType.className = 'incident-detail-type';
    hType.textContent = typeLabel;
    titleWrap.append(hId, hType);

    const headerActions = document.createElement('div');
    headerActions.className = 'incident-detail-header-actions';

    // Section 3: Punong Barangay is read-only oversight, no writes. Only
    // the two roles PATCH /incidents/:id actually accepts get the control.
    let editBtn = null;
    if (canCreate) {
      editBtn = document.createElement('button');
      editBtn.type = 'button';
      editBtn.className = 'btn-incident-edit';
      editBtn.innerHTML = `${icons.edit(14)} <span>Edit</span>`;
      editBtn.addEventListener('click', () => {
        activeViewMode = 'edit';
        renderRightPane();
      });
    }

    const closeBtn = document.createElement('button');
    closeBtn.type = 'button';
    closeBtn.className = 'btn-incident-close';
    closeBtn.setAttribute('aria-label', 'Close incident view');
    closeBtn.innerHTML = icons.x(16);
    closeBtn.addEventListener('click', closeDetailPane);

    // editBtn is null for a read-only role; append() would otherwise
    // insert the literal string "null" as a text node.
    if (editBtn) headerActions.append(editBtn);
    headerActions.append(closeBtn);
    headerRow.append(titleWrap, headerActions);
    rightPanel.appendChild(headerRow);

    // 2. Badges Row
    const badgesRow = document.createElement('div');
    badgesRow.className = 'incident-detail-badges';

    const prioBadge = document.createElement('span');
    prioBadge.className = `incident-detail-badge incident-detail-badge--${prioKey}`;
    prioBadge.textContent = `${prioLabel} Priority`;

    const statBadge = document.createElement('span');
    statBadge.className = `incident-detail-badge incident-detail-badge--${row.status}`;
    statBadge.textContent = statLabel;

    badgesRow.append(prioBadge, statBadge);
    rightPanel.appendChild(badgesRow);

    // 3. Two-Column Info Grid
    const infoGrid = document.createElement('div');
    infoGrid.className = 'incident-info-grid';

    // Location Card
    const locCard = document.createElement('div');
    locCard.className = 'incident-info-box';
    const locLabel = document.createElement('span');
    locLabel.className = 'incident-info-box__label';
    locLabel.textContent = 'Location';
    const locVal = document.createElement('span');
    locVal.className = 'incident-info-box__val';
    locVal.innerHTML = `${icons.mapPin(15)} <span>${bName}</span>`;
    const locSub = document.createElement('span');
    locSub.className = 'incident-info-box__sub';
    locSub.textContent = detail.locationDescription || row.locationDescription || 'Purok 3, near market';
    locCard.append(locLabel, locVal, locSub);

    // Reported Card
    const repCard = document.createElement('div');
    repCard.className = 'incident-info-box';
    const repLabel = document.createElement('span');
    repLabel.className = 'incident-info-box__label';
    repLabel.textContent = 'Reported';
    const repVal = document.createElement('span');
    repVal.className = 'incident-info-box__val';
    repVal.innerHTML = `${icons.clock(15)} <span>${formatDateTime(row.createdAt)}</span>`;
    const repSub = document.createElement('span');
    repSub.className = 'incident-info-box__sub';
    const reporter = detail.complainantName || row.reportedBy || (row.source ? `Caller (${row.source})` : 'Juan dela Cruz');
    repSub.textContent = `By: ${reporter}`;
    repCard.append(repLabel, repVal, repSub);

    infoGrid.append(locCard, repCard);
    rightPanel.appendChild(infoGrid);

    // 4. Assigned Tanod Card (with Smart Assign / Contact modal)
    const tanodCard = document.createElement('div');
    tanodCard.className = 'incident-tanod-card';
    const tanodLabel = document.createElement('span');
    tanodLabel.className = 'incident-info-box__label';
    tanodLabel.textContent = 'Assigned Tanod';

    const tanodContent = document.createElement('div');
    tanodContent.className = 'incident-tanod-card__content';

    const tanodLeft = document.createElement('div');
    tanodLeft.className = 'incident-tanod-card__left';

    const isAssigned = row.status !== 'pending' || Boolean(row.officerName);
    const avatar = document.createElement('div');
    avatar.className = `incident-tanod-avatar ${isAssigned ? '' : 'incident-tanod-avatar--unassigned'}`;
    avatar.innerHTML = icons.users(18);

    const tanodMeta = document.createElement('div');
    const officerNameText = row.officerName || (isAssigned ? 'Tanod Ramos' : 'Not yet assigned');
    const tanodName = document.createElement('div');
    tanodName.className = 'incident-tanod-name';
    tanodName.textContent = officerNameText;

    const tanodStatus = document.createElement('div');
    tanodStatus.className = 'incident-tanod-status';
    tanodStatus.textContent = isAssigned ? `On duty • ${bName}` : 'Click assign to dispatch on-duty tanod';
    tanodMeta.append(tanodName, tanodStatus);

    tanodLeft.append(avatar, tanodMeta);

    let tanodActionBtn;
    if (!isAssigned) {
      // Smart shortcut: dispatch directly from card
      tanodActionBtn = document.createElement('button');
      tanodActionBtn.type = 'button';
      tanodActionBtn.className = 'btn-tanod-assign';
      tanodActionBtn.innerHTML = `${icons.plus(14)} <span>Assign</span>`;
      tanodActionBtn.addEventListener('click', async () => {
        tanodActionBtn.disabled = true;
        const dispatched = await promptDispatchTanod({
          incident: row,
          incidentTypeLabel: typeLabel,
          eligibleTanods,
        });
        if (dispatched) {
          await load();
          refreshCounterCounts();
          const refreshed = lastItems.find((r) => r.incidentId === row.incidentId);
          if (refreshed) selectIncident(refreshed);
        } else {
          tanodActionBtn.disabled = false;
        }
      });
    } else {
      // Contact button: triggers Contact modal with Direct Call + Direct SMS
      tanodActionBtn = document.createElement('button');
      tanodActionBtn.type = 'button';
      tanodActionBtn.className = 'btn-tanod-contact';
      tanodActionBtn.textContent = 'Contact';
      tanodActionBtn.addEventListener('click', () => {
        showContactModal({
          officerName: officerNameText,
          contactNumber: officerContact,
          incidentCode: code,
          incidentId: row.incidentId,
        });
      });
    }

    tanodContent.append(tanodLeft, tanodActionBtn);
    tanodCard.append(tanodLabel, tanodContent);
    rightPanel.appendChild(tanodCard);

    // 5. Description Card
    const descCard = document.createElement('div');
    descCard.className = 'incident-desc-card';
    const descLabel = document.createElement('span');
    descLabel.className = 'incident-info-box__label';
    descLabel.textContent = 'Description';
    const descBody = document.createElement('p');
    descBody.className = 'incident-desc-body';
    descBody.textContent = detail.redactedNarrative || detail.rawNarrative || 'Caller reported an incident in the designated purok area. Investigation in progress.';
    descCard.append(descLabel, descBody);
    rightPanel.appendChild(descCard);

    // 6. Action Buttons Row
    const actionsRow = document.createElement('div');
    actionsRow.className = 'incident-actions-row';

    // Primary Action Button (Dispatch or Resolve)
    if (row.status === 'pending') {
      const dispatchBtn = document.createElement('button');
      dispatchBtn.type = 'button';
      dispatchBtn.className = 'btn-action-dispatch';
      dispatchBtn.innerHTML = `${icons.radio(16)} <span>Dispatch Tanod</span>`;
      dispatchBtn.addEventListener('click', async () => {
        dispatchBtn.disabled = true;
        const dispatched = await promptDispatchTanod({
          incident: row,
          incidentTypeLabel: typeLabel,
          eligibleTanods,
        });
        if (dispatched) {
          await load();
          refreshCounterCounts();
          const refreshed = lastItems.find((r) => r.incidentId === row.incidentId);
          if (refreshed) selectIncident(refreshed);
        } else {
          dispatchBtn.disabled = false;
        }
      });
      actionsRow.appendChild(dispatchBtn);
    } else if (row.status === 'dispatched') {
      const resolveBtn = document.createElement('button');
      resolveBtn.type = 'button';
      resolveBtn.className = 'btn-action-resolve';
      resolveBtn.innerHTML = `${icons.checkCircle(16)} <span>Resolve Incident</span>`;
      resolveBtn.addEventListener('click', async () => {
        const confirmed = await confirmDialog({
          title: 'Mark this incident resolved?',
          description: 'This closes out the active incident and updates tracking status.',
          confirmLabel: 'Mark Resolved',
          cancelLabel: 'Cancel',
        });
        if (!confirmed) return;
        resolveBtn.disabled = true;
        resolveBtn.textContent = 'Resolving...';
        try {
          await updateIncidentStatus(row.incidentId);
          showToast('Incident resolved successfully.', { variant: 'success' });
          await load();
          refreshCounterCounts();
          const refreshed = lastItems.find((r) => r.incidentId === row.incidentId);
          if (refreshed) selectIncident(refreshed);
        } catch (err) {
          resolveBtn.disabled = false;
          resolveBtn.innerHTML = `${icons.checkCircle(16)} <span>Resolve Incident</span>`;
          showToast(err instanceof ApiClientError ? err.message : 'Could not resolve incident.', { variant: 'error' });
        }
      });
      actionsRow.appendChild(resolveBtn);
    } else {
      const resolvedBtn = document.createElement('button');
      resolvedBtn.type = 'button';
      resolvedBtn.className = 'btn-action-resolve';
      resolvedBtn.disabled = true;
      resolvedBtn.style.opacity = '0.7';
      resolvedBtn.innerHTML = `${icons.checkCircle(16)} <span>Incident Resolved</span>`;
      actionsRow.appendChild(resolvedBtn);
    }

    // Secondary Action Button (Smart Create / View Blotter)
    const blotterBtn = document.createElement('button');
    blotterBtn.type = 'button';
    blotterBtn.className = 'btn-action-blotter';
    const isBlotterCreated = row.status === 'resolved' || Boolean(detail.blotterId);
    blotterBtn.innerHTML = `${icons.fileText(16)} <span>${isBlotterCreated ? 'View Blotter' : 'Create Blotter'}</span>`;
    blotterBtn.addEventListener('click', () => {
      navigate('blotter-detail', row.incidentId);
    });
    actionsRow.appendChild(blotterBtn);

    rightPanel.appendChild(actionsRow);

    // 7. Timeline Section
    const timelineSection = document.createElement('div');
    timelineSection.className = 'incident-timeline-section';
    const tlLabel = document.createElement('span');
    tlLabel.className = 'incident-info-box__label';
    tlLabel.textContent = 'Timeline';
    timelineSection.appendChild(tlLabel);

    const timelineList = document.createElement('div');
    timelineList.className = 'incident-timeline-list';
    const rail = document.createElement('div');
    rail.className = 'incident-timeline-rail';
    timelineList.appendChild(rail);

    // Stage 1: Incident reported
    const s1 = document.createElement('div');
    s1.className = 'incident-timeline-item';
    const dot1 = document.createElement('span');
    dot1.className = 'incident-timeline-dot incident-timeline-dot--red';
    const t1 = document.createElement('span');
    t1.className = 'incident-timeline-title';
    t1.textContent = 'Incident reported';
    const time1 = document.createElement('span');
    time1.className = 'incident-timeline-time';
    time1.textContent = formatDateTime(row.createdAt);
    s1.append(dot1, t1, time1);
    timelineList.appendChild(s1);

    // Stage 2: Dispatched
    if (detail.dispatchedAt || row.status !== 'pending') {
      const s2 = document.createElement('div');
      s2.className = 'incident-timeline-item';
      const dot2 = document.createElement('span');
      dot2.className = 'incident-timeline-dot incident-timeline-dot--amber';
      const t2 = document.createElement('span');
      t2.className = 'incident-timeline-title';
      t2.textContent = `Dispatched to ${officerNameText}`;
      const time2 = document.createElement('span');
      time2.className = 'incident-timeline-time';
      time2.textContent = formatRelativeTime(row.createdAt, detail.dispatchedAt) || '2 min later';
      s2.append(dot2, t2, time2);
      timelineList.appendChild(s2);
    }

    // Stage 3: Arrived on scene or Resolved
    if (detail.arrivedAt || row.status === 'resolved') {
      const s3 = document.createElement('div');
      s3.className = 'incident-timeline-item';
      const dot3 = document.createElement('span');
      dot3.className = 'incident-timeline-dot incident-timeline-dot--green';
      const t3 = document.createElement('span');
      t3.className = 'incident-timeline-title';
      t3.textContent = row.status === 'resolved' ? 'Incident resolved' : 'Arrived on scene';
      const time3 = document.createElement('span');
      time3.className = 'incident-timeline-time';
      time3.textContent = formatDateTime(detail.arrivedAt || row.createdAt);
      s3.append(dot3, t3, time3);
      timelineList.appendChild(s3);
    }

    timelineSection.appendChild(timelineList);
    rightPanel.appendChild(timelineSection);
  }

  // --- Render New Incident Form ---
  function renderNewIncidentForm() {
    rightPanel.innerHTML = '';

    const formPane = document.createElement('div');
    formPane.className = 'incident-form-pane';

    const headerRow = document.createElement('div');
    headerRow.className = 'incident-detail-header';
    const formTitle = document.createElement('h2');
    formTitle.className = 'incident-form-title';
    formTitle.textContent = 'Log an Incident';
    const closeBtn = document.createElement('button');
    closeBtn.type = 'button';
    closeBtn.className = 'btn-incident-close';
    closeBtn.innerHTML = icons.x(16);
    closeBtn.addEventListener('click', () => {
      activeViewMode = 'detail';
      renderRightPane();
    });
    headerRow.append(formTitle, closeBtn);
    formPane.appendChild(headerRow);

    const form = document.createElement('form');
    form.className = 'form-stack';
    form.noValidate = true;

    // Incident Type
    const gType = document.createElement('div');
    gType.className = 'incident-form-group';
    const lType = document.createElement('label');
    lType.className = 'incident-form-label';
    lType.textContent = 'Incident Type';
    const selType = document.createElement('select');
    selType.className = 'incident-form-select';
    for (const [v, l] of Object.entries(INCIDENT_TYPE_LABELS)) {
      const opt = document.createElement('option');
      opt.value = v;
      opt.textContent = l;
      selType.appendChild(opt);
    }
    gType.append(lType, selType);

    // Priority
    const gPrio = document.createElement('div');
    gPrio.className = 'incident-form-group';
    const lPrio = document.createElement('label');
    lPrio.className = 'incident-form-label';
    lPrio.textContent = 'Priority';
    const selPrio = document.createElement('select');
    selPrio.className = 'incident-form-select';
    for (const [v, l] of [['normal', 'Medium / Normal'], ['high', 'High'], ['critical', 'Critical'], ['low', 'Low']]) {
      const opt = document.createElement('option');
      opt.value = v;
      opt.textContent = l;
      selPrio.appendChild(opt);
    }
    gPrio.append(lPrio, selPrio);

    // Location Description
    const gLoc = document.createElement('div');
    gLoc.className = 'incident-form-group';
    const lLoc = document.createElement('label');
    lLoc.className = 'incident-form-label';
    lLoc.textContent = 'Location Landmark / Description';
    const inLoc = document.createElement('input');
    inLoc.type = 'text';
    inLoc.className = 'incident-form-input';
    inLoc.placeholder = 'e.g. Purok 3, near the public market';
    gLoc.append(lLoc, inLoc);

    // Complainant Name
    const gComp = document.createElement('div');
    gComp.className = 'incident-form-group';
    const lComp = document.createElement('label');
    lComp.className = 'incident-form-label';
    lComp.textContent = 'Complainant / Reporter Name (Optional)';
    const inComp = document.createElement('input');
    inComp.type = 'text';
    inComp.className = 'incident-form-input';
    inComp.placeholder = 'e.g. Juan dela Cruz';
    gComp.append(lComp, inComp);

    // Narrative
    const gNarr = document.createElement('div');
    gNarr.className = 'incident-form-group';
    const lNarr = document.createElement('label');
    lNarr.className = 'incident-form-label';
    lNarr.textContent = 'Incident Description / Narrative';
    const inNarr = document.createElement('textarea');
    inNarr.className = 'incident-form-textarea';
    inNarr.placeholder = 'Describe the incident report details...';
    inNarr.required = true;
    gNarr.append(lNarr, inNarr);

    // Actions
    const formActions = document.createElement('div');
    formActions.className = 'incident-form-actions';
    const submitBtn = document.createElement('button');
    submitBtn.type = 'submit';
    submitBtn.className = 'incident-form-submit';
    submitBtn.textContent = 'Log an Incident';

    const cancelBtn = document.createElement('button');
    cancelBtn.type = 'button';
    cancelBtn.className = 'incident-form-cancel';
    cancelBtn.textContent = 'Cancel';
    cancelBtn.addEventListener('click', closeDetailPane);

    formActions.append(submitBtn, cancelBtn);

    form.append(gType, gPrio, gLoc, gComp, gNarr, formActions);
    form.addEventListener('submit', async (e) => {
      e.preventDefault();
      const narrative = inNarr.value.trim();
      if (!narrative) {
        showToast('Please enter an incident narrative.', { variant: 'error' });
        return;
      }

      submitBtn.disabled = true;
      submitBtn.textContent = 'Saving...';
      try {
        await createIncident({
          incidentType: selType.value,
          priority: selPrio.value,
          rawNarrative: narrative,
          locationDescription: inLoc.value.trim() || undefined,
          complainantName: inComp.value.trim() || undefined,
          idempotencyKey: crypto.randomUUID(),
        });
        showToast('Incident logged successfully.', { variant: 'success' });
        activeViewMode = 'detail';
        await load();
      } catch (err) {
        submitBtn.disabled = false;
        submitBtn.textContent = 'Log an Incident';
        showToast(err instanceof ApiClientError ? err.message : 'Could not create incident.', { variant: 'error' });
      }
    });

    formPane.appendChild(form);
    rightPanel.appendChild(formPane);
  }

  // --- Render Edit Incident Form ---
  function renderEditIncidentForm(row, detail) {
    rightPanel.innerHTML = '';

    const formPane = document.createElement('div');
    formPane.className = 'incident-form-pane';

    const headerRow = document.createElement('div');
    headerRow.className = 'incident-detail-header';
    const formTitle = document.createElement('h2');
    formTitle.className = 'incident-form-title';
    formTitle.textContent = `Edit Incident ${formatIncidentCode(row)}`;
    const closeBtn = document.createElement('button');
    closeBtn.type = 'button';
    closeBtn.className = 'btn-incident-close';
    closeBtn.innerHTML = icons.x(16);
    closeBtn.addEventListener('click', () => {
      activeViewMode = 'detail';
      renderRightPane();
    });
    headerRow.append(formTitle, closeBtn);
    formPane.appendChild(headerRow);

    const form = document.createElement('form');
    form.className = 'form-stack';

    // Priority
    const gPrio = document.createElement('div');
    gPrio.className = 'incident-form-group';
    const lPrio = document.createElement('label');
    lPrio.className = 'incident-form-label';
    lPrio.textContent = 'Priority';
    const selPrio = document.createElement('select');
    selPrio.className = 'incident-form-select';
    for (const [v, l] of [['normal', 'Medium / Normal'], ['high', 'High'], ['critical', 'Critical'], ['low', 'Low']]) {
      const opt = document.createElement('option');
      opt.value = v;
      opt.textContent = l;
      if (v === row.priority) opt.selected = true;
      selPrio.appendChild(opt);
    }
    gPrio.append(lPrio, selPrio);

    // Location Description
    const gLoc = document.createElement('div');
    gLoc.className = 'incident-form-group';
    const lLoc = document.createElement('label');
    lLoc.className = 'incident-form-label';
    lLoc.textContent = 'Location Landmark / Description';
    const inLoc = document.createElement('input');
    inLoc.type = 'text';
    inLoc.className = 'incident-form-input';
    inLoc.value = detail.locationDescription || row.locationDescription || '';
    gLoc.append(lLoc, inLoc);

    // Complainant Name
    const gComp = document.createElement('div');
    gComp.className = 'incident-form-group';
    const lComp = document.createElement('label');
    lComp.className = 'incident-form-label';
    lComp.textContent = 'Complainant / Reporter Name';
    const inComp = document.createElement('input');
    inComp.type = 'text';
    inComp.className = 'incident-form-input';
    inComp.value = detail.complainantName || '';
    // Migration 0008's party fields are extracted from RAW narrative and
    // preserve exactly the identifiers redaction strips, so they carry
    // raw_narrative's Secretary-only protection. The server enforces this;
    // the form just doesn't offer a control that would 403.
    if (!isSecretary) {
      inComp.disabled = true;
      inComp.title = 'Only a Secretary may change the complainant name.';
    }
    gComp.append(lComp, inComp);

    // Narrative is deliberately NOT editable here. Only
    // POST /incidents/:id/ai-draft/approve may write redacted_narrative,
    // and an Admin never receives raw_narrative at all -- so a textarea
    // pre-filled from `rawNarrative || redactedNarrative` would have
    // written the REDACTED text back over the raw statutory record on any
    // Admin save. The server rejects a narrative on this endpoint; this
    // note says where the real correction paths are instead of offering a
    // control that cannot work.
    const gNarr = document.createElement('div');
    gNarr.className = 'incident-form-group';
    const lNarr = document.createElement('label');
    lNarr.className = 'incident-form-label';
    lNarr.textContent = 'Incident Description / Narrative';
    const narrNote = document.createElement('p');
    narrNote.className = 'incident-form-note';
    narrNote.textContent = 'The narrative cannot be edited here. Use AI Review to correct the incident narrative, or amend the blotter record once the case is finalized.';
    gNarr.append(lNarr, narrNote);

    // Actions
    const formActions = document.createElement('div');
    formActions.className = 'incident-form-actions';
    const submitBtn = document.createElement('button');
    submitBtn.type = 'submit';
    submitBtn.className = 'incident-form-submit';
    submitBtn.textContent = 'Save Changes';

    const cancelBtn = document.createElement('button');
    cancelBtn.type = 'button';
    cancelBtn.className = 'incident-form-cancel';
    cancelBtn.textContent = 'Cancel';
    cancelBtn.addEventListener('click', () => {
      activeViewMode = 'detail';
      if (selectedIncidentId) {
        renderRightPane();
      } else {
        closeDetailPane();
      }
    });

    formActions.append(submitBtn, cancelBtn);

    form.append(gPrio, gLoc, gComp, gNarr, formActions);
    form.addEventListener('submit', async (e) => {
      e.preventDefault();
      submitBtn.disabled = true;
      submitBtn.textContent = 'Saving...';
      try {
        const patch = {
          priority: selPrio.value,
          locationDescription: inLoc.value.trim(),
          idempotencyKey: crypto.randomUUID(),
        };
        if (isSecretary) patch.complainantName = inComp.value.trim();
        await updateIncident(row.incidentId, patch);
        showToast('Incident updated successfully.', { variant: 'success' });
        activeViewMode = 'detail';
        await load();
      } catch (err) {
        submitBtn.disabled = false;
        submitBtn.textContent = 'Save Changes';
        showToast(err instanceof ApiClientError ? err.message : 'Could not update incident.', { variant: 'error' });
      }
    });

    formPane.appendChild(form);
    rightPanel.appendChild(formPane);
  }

  // --- Contact Assigned Tanod Modal (Direct Call + Direct SMS) ---
  function showContactModal({ officerName, contactNumber, incidentCode, incidentId }) {
    closeActiveModal();
    const overlay = document.createElement('div');
    overlay.className = 'incident-modal-overlay';
    activeModalEl = overlay;

    // No fabricated fallback number — a Tanod with no contact number on
    // file gets an honest empty state, not a placeholder phone number
    // presented as if it were real (Rule 6: no hardcoded identities).
    const hasContact = Boolean(contactNumber);
    const phoneStr = contactNumber || '';

    overlay.innerHTML = `
      <div class="incident-modal-box">
        <div class="incident-modal-header">
          <h3 class="incident-modal-title">Contact Assigned Tanod</h3>
          <button type="button" class="btn-incident-close modal-close-btn" aria-label="Close dialog">${icons.x(16)}</button>
        </div>
        <div style="display: flex; align-items: center; gap: 12px; padding: 12px; background: var(--color-bg); border-radius: 10px; border: 1px solid var(--color-border);">
          <div class="incident-tanod-avatar" style="width: 40px; height: 40px;">${icons.users(20)}</div>
          <div>
            <div style="font-weight: 600; font-size: 0.9375rem; color: var(--color-text-primary);">${officerName}</div>
            <div style="font-size: 0.8125rem; color: var(--color-text-secondary);">${hasContact ? `Phone: ${phoneStr}` : 'No contact number on file'}</div>
          </div>
        </div>
        ${hasContact ? `
        <div class="incident-contact-options">
          <a href="tel:${phoneStr.replace(/[^0-9+]/g, '')}" class="incident-contact-btn">
            ${icons.phone(22)}
            <span>Direct Call</span>
          </a>
          <button type="button" class="incident-contact-btn btn-sms-option">
            ${icons.messageSquare(22)}
            <span>Send SMS Alert</span>
          </button>
        </div>
        ` : `
        <p class="note" style="margin: 0.5rem 0 0;">Ask this Tanod's supervisor for an alternate contact, or update their profile in User Management.</p>
        `}
        ${hasContact ? `
        <div class="sms-compose-section" style="display: none; flex-direction: column; gap: 8px; margin-top: 8px;">
          <label class="incident-form-label">SMS Message Content</label>
          <textarea class="incident-form-textarea sms-text-input" rows="3">[Baranguard] Alert regarding Incident ${incidentCode}: Immediate status update requested.</textarea>
          <div style="display: flex; gap: 8px; justify-content: flex-end; margin-top: 4px;">
            <button type="button" class="incident-form-cancel btn-sms-cancel">Cancel</button>
            <button type="button" class="btn-action-dispatch btn-sms-send" style="height: 38px; padding: 0 16px; flex: 0 0 auto;">Send SMS</button>
          </div>
        </div>
        ` : ''}
      </div>
    `;

    overlay.querySelector('.modal-close-btn').addEventListener('click', closeActiveModal);
    overlay.addEventListener('click', (e) => {
      if (e.target === overlay) closeActiveModal();
    });

    // The SMS compose section (and its trigger) only exists in the markup
    // when hasContact is true — nothing to wire up otherwise.
    if (hasContact) {
      const smsSection = overlay.querySelector('.sms-compose-section');
      overlay.querySelector('.btn-sms-option').addEventListener('click', () => {
        smsSection.style.display = 'flex';
        overlay.querySelector('.sms-text-input').focus();
      });

      overlay.querySelector('.btn-sms-cancel').addEventListener('click', () => {
        smsSection.style.display = 'none';
      });

      overlay.querySelector('.btn-sms-send').addEventListener('click', async () => {
        const msg = overlay.querySelector('.sms-text-input').value.trim();
        if (!msg) {
          showToast('Please enter an SMS message.', { variant: 'error' });
          return;
        }
        const sendBtn = overlay.querySelector('.btn-sms-send');
        sendBtn.disabled = true;
        sendBtn.textContent = 'Sending...';
        try {
          await sendSms({
            phoneNumber: phoneStr.replace(/[^0-9+]/g, ''),
            message: msg,
            incidentId,
            idempotencyKey: crypto.randomUUID(),
          });
          showToast(`SMS dispatch alert sent to ${officerName}.`, { variant: 'success' });
          closeActiveModal();
        } catch (err) {
          sendBtn.disabled = false;
          sendBtn.textContent = 'Send SMS';
          showToast(err instanceof ApiClientError ? err.message : 'Could not send SMS alert.', { variant: 'error' });
        }
      });
    }

    document.body.appendChild(overlay);
  }

  // --- Quick Operational Guide Modal ---
  function showHelpModal() {
    closeActiveModal();
    const overlay = document.createElement('div');
    overlay.className = 'incident-modal-overlay';
    activeModalEl = overlay;

    overlay.innerHTML = `
      <div class="incident-modal-box">
        <div class="incident-modal-header">
          <h3 class="incident-modal-title">Incident Console Operational Guide</h3>
          <button type="button" class="btn-incident-close modal-close-btn" aria-label="Close dialog">${icons.x(16)}</button>
        </div>

        <div class="incident-help-section">
          <h4 class="incident-help-title">Operational Status Stages</h4>
          <div class="incident-help-list">
            <div class="incident-help-item">
              <span style="font-weight: 600; color: var(--color-critical);">Active</span>
              <span style="color: var(--color-text-secondary); font-size: 0.8125rem;">Reported incident pending on-duty Tanod dispatch</span>
            </div>
            <div class="incident-help-item">
              <span style="font-weight: 600; color: var(--color-warning);">Responding</span>
              <span style="color: var(--color-text-secondary); font-size: 0.8125rem;">Peacekeeping unit dispatched and en route or on scene</span>
            </div>
            <div class="incident-help-item">
              <span style="font-weight: 600; color: var(--color-success);">Resolved</span>
              <span style="color: var(--color-text-secondary); font-size: 0.8125rem;">Incident neutralized and officially resolved by Admin</span>
            </div>
            <div class="incident-help-item">
              <span style="font-weight: 600; color: var(--color-text-secondary);">Closed</span>
              <span style="color: var(--color-text-secondary); font-size: 0.8125rem;">Formal blotter documentation completed</span>
            </div>
          </div>
        </div>

        <div class="incident-help-section">
          <h4 class="incident-help-title">Keyboard Navigation</h4>
          <div class="incident-help-list">
            <div class="incident-help-item">
              <span>Next incident</span>
              <span class="incident-kbd">↓ Arrow Down</span>
            </div>
            <div class="incident-help-item">
              <span>Previous incident</span>
              <span class="incident-kbd">↑ Arrow Up</span>
            </div>
            <div class="incident-help-item">
              <span>Close detail / Cancel</span>
              <span class="incident-kbd">Esc</span>
            </div>
          </div>
        </div>
      </div>
    `;

    overlay.querySelector('.modal-close-btn').addEventListener('click', closeActiveModal);
    overlay.addEventListener('click', (e) => {
      if (e.target === overlay) closeActiveModal();
    });

    document.body.appendChild(overlay);
  }

  // --- Global Keyboard Navigation Handler ---
  function handleKeyDown(e) {
    const tag = document.activeElement ? document.activeElement.tagName.toLowerCase() : '';
    if (tag === 'input' || tag === 'textarea' || tag === 'select') return;

    if (e.key === 'ArrowDown') {
      e.preventDefault();
      if (lastItems.length === 0) return;
      const idx = lastItems.findIndex((r) => r.incidentId === selectedIncidentId);
      if (idx === -1) {
        selectIncident(lastItems[0]);
      } else if (idx < lastItems.length - 1) {
        selectIncident(lastItems[idx + 1]);
      }
    } else if (e.key === 'ArrowUp') {
      e.preventDefault();
      if (lastItems.length === 0) return;
      const idx = lastItems.findIndex((r) => r.incidentId === selectedIncidentId);
      if (idx > 0) {
        selectIncident(lastItems[idx - 1]);
      }
    } else if (e.key === 'Escape') {
      closeActiveModal();
      if (activeViewMode !== 'detail' || selectedIncidentId != null || layout.classList.contains('has-detail')) {
        closeDetailPane();
      }
    }
  }
  window.addEventListener('keydown', handleKeyDown);

  // --- Placeholder / Closed State (Collapses to full-width table) ---
  function renderPlaceholder() {
    closeDetailPane();
  }

  function renderDetailError(message, row) {
    rightPanel.innerHTML = '';
    const block = document.createElement('div');
    block.className = 'card state-block state-block--error';
    block.setAttribute('role', 'alert');
    const text = document.createElement('p');
    text.textContent = message;
    const retry = document.createElement('button');
    retry.className = 'primary';
    retry.textContent = 'Try again';
    retry.addEventListener('click', () => selectIncident(row));
    block.append(text, retry);
    rightPanel.appendChild(block);
  }

  function renderLoading(container) {
    container.innerHTML = '';
    const wrap = document.createElement('div');
    wrap.className = 'stack';
    wrap.setAttribute('role', 'status');
    for (let i = 0; i < 6; i++) {
      const skeleton = document.createElement('div');
      skeleton.className = 'skeleton skeleton--row';
      skeleton.style.height = '48px';
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
}
