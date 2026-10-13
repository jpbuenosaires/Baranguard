/**
 * citizen-reports-inbox.js — Citizen Reports Inbox (§9 W16)
 * Redesigned operational console with viewport-locked master-detail split layout,
 * live status filtering, full narrative inspection pane, MapLibre mini-map pin preview,
 * and pinned triage action footer (Category + Priority selection).
 *
 * Roles: Secretary, Admin (§7 "View citizen report inbox").
 */

import { getCitizenReports, convertCitizenReport, logout, ApiClientError } from '../api/apiClient.js';
import { AppShell } from '../components/AppShell.js';
import { PageHeader } from '../components/PageHeader.js';
import { DataTable } from '../components/DataTable.js';
import { icons } from '../components/icons.js';
import { showToast } from '../components/Toast.js';
import { escapeHtml } from '../utils/escapeHtml.js';
import { formatManilaDate, formatManilaDateTime } from '../utils/manilaTime.js';
import { attachBasemapFallback, OSM_TILE_URL } from '../utils/mapFallback.js';
import { formatIncidentCode, formatCitizenReportCode } from '../services/tanodWorkflowUi.js';

// Same 11-member enum as `incident.incident_type` (§5)
const INCIDENT_TYPE_OPTIONS = [
  ['theft', 'Theft / Robbery'],
  ['physical_injury', 'Physical Injury'],
  ['disturbance', 'Disturbance / Noise'],
  ['domestic_dispute', 'Domestic Dispute'],
  ['vandalism', 'Vandalism / Property Damage'],
  ['traffic_incident', 'Traffic Incident'],
  ['fire', 'Fire / Smoke Hazard'],
  ['medical_emergency', 'Medical Emergency'],
  ['missing_person', 'Missing Person'],
  ['animal_complaint', 'Animal Complaint'],
  ['other', 'Other'],
];

const PRIORITY_OPTIONS = [
  { value: 'normal', label: 'Normal' },
  { value: 'high', label: 'High' },
  { value: 'critical', label: 'Critical' },
];

const COLUMNS = [
  { key: 'id', label: 'REFERENCE', width: '7rem', sortable: true, sortValue: (row) => Number(row.reportId) || 0 },
  { key: 'description', label: 'SUMMARY' },
  { key: 'location', label: 'LOCATION', width: '9.5rem' },
  { key: 'contact', label: 'CONTACT', width: '9rem' },
  { key: 'status', label: 'STATUS', width: '10.5rem', sortable: true, sortValue: (row) => (row.incidentId ? 1 : 0) },
  { key: 'submitted', label: 'SUBMITTED', width: '8.5rem', sortable: true, sortValue: (row) => (row.submittedAt ? new Date(row.submittedAt).getTime() : 0) },
  { key: 'actions', label: 'ACTION', width: '6.5rem', align: 'right' },
];

function formatReportCode(id) {
  return `CR-${String(id).padStart(4, '0')}`;
}

function formatContactNumber(raw) {
  if (!raw) return '';
  const digits = String(raw).replace(/\D/g, '');
  if (digits.length === 11 && digits.startsWith('09')) {
    return `${digits.slice(0, 4)} ${digits.slice(4, 7)} ${digits.slice(7)}`;
  }
  return String(raw);
}

function formatDateTime(isoString) {
  if (!isoString) return '—';
  return formatManilaDateTime(isoString, String(isoString));
}

function formatShortDate(isoString) {
  if (!isoString) return '';
  return formatManilaDate(isoString, '');
}

function timeAgo(isoString) {
  if (!isoString) return '—';
  const diffMs = Date.now() - new Date(isoString).getTime();
  const diffSec = Math.max(0, Math.round(diffMs / 1000));
  if (diffSec < 60) return 'Just now';
  const diffMin = Math.round(diffSec / 60);
  if (diffMin < 60) return `${diffMin}m ago`;
  const diffHr = Math.round(diffMin / 60);
  if (diffHr < 24) return `${diffHr}h ago`;
  const diffDay = Math.round(diffHr / 24);
  return `${diffDay}d ago`;
}

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
  content.classList.add('citizen-inbox-content');
  const pageContentEl = shell.el.querySelector('.page-content');
  if (pageContentEl) {
    pageContentEl.classList.add('citizen-inbox-content');
  }
  root.appendChild(shell.el);

  const pageHeader = PageHeader({
    title: 'Citizen Reports',
    subtitle: 'Earlier citizen submissions on file (the public form is no longer open) — triage & convert to incidents',
    icon: icons.inbox,
  });
  header.appendChild(pageHeader.el);

  // Main Container & Master-Detail Split Grid
  content.classList.add('citizen-inbox-page-container');
  if (content.parentElement) {
    content.parentElement.classList.add('page-content--no-scroll');
  }

  const container = document.createElement('div');
  container.className = 'citizen-inbox-container';

  const layout = document.createElement('div');
  layout.className = 'citizen-inbox-layout';
  container.appendChild(layout);
  content.appendChild(container);

  // Left Panel (Option A Unified Command Card: KPI Strip + Toolbar + Flush Table)
  const leftPanel = document.createElement('div');
  leftPanel.className = 'citizen-inbox-left-panel unified-table-card';
  layout.appendChild(leftPanel);

  // Embedded 4-KPI Summary Strip
  const kpiStrip = document.createElement('div');
  kpiStrip.className = 'command-card-kpis';
  kpiStrip.innerHTML = `
    <div class="command-kpi">
      <div class="command-kpi__icon command-kpi__icon--info" aria-hidden="true">${icons.inbox(18)}</div>
      <div class="command-kpi__body">
        <span class="command-kpi__label">Total Reports</span>
        <strong class="command-kpi__value" id="inbox-total-count">—</strong>
      </div>
    </div>
    <div class="command-kpi">
      <div class="command-kpi__icon command-kpi__icon--warning" aria-hidden="true">${icons.clock(18)}</div>
      <div class="command-kpi__body">
        <span class="command-kpi__label">Pending Review</span>
        <strong class="command-kpi__value" id="inbox-pending-count">—</strong>
      </div>
    </div>
    <div class="command-kpi">
      <div class="command-kpi__icon command-kpi__icon--success" aria-hidden="true">${icons.checkCircle(18)}</div>
      <div class="command-kpi__body">
        <span class="command-kpi__label">Converted</span>
        <strong class="command-kpi__value" id="inbox-converted-count">—</strong>
      </div>
    </div>
    <div class="command-kpi">
      <div class="command-kpi__icon command-kpi__icon--info" aria-hidden="true">${icons.mapPin(18)}</div>
      <div class="command-kpi__body">
        <span class="command-kpi__label">GPS Shared</span>
        <strong class="command-kpi__value" id="inbox-gps-count">—</strong>
      </div>
    </div>
  `;
  leftPanel.appendChild(kpiStrip);

  // Right Panel slot (Detail pane)
  let detailPanel = null;
  let currentMiniMap = null;
  let detachMiniMapFallback = null;

  // Filter Bar
  const filterBar = document.createElement('div');
  filterBar.className = 'citizen-filter-bar';

  const searchWrap = document.createElement('div');
  searchWrap.className = 'citizen-search-wrap';
  const searchIcon = document.createElement('span');
  searchIcon.className = 'citizen-search-icon';
  searchIcon.setAttribute('aria-hidden', 'true');
  searchIcon.innerHTML = icons.search(16);

  const searchLabel = document.createElement('label');
  searchLabel.className = 'sr-only';
  searchLabel.htmlFor = 'citizen-inbox-search';
  searchLabel.textContent = 'Search reports';

  const searchInput = document.createElement('input');
  searchInput.id = 'citizen-inbox-search';
  searchInput.type = 'search';
  searchInput.className = 'citizen-search-input';
  searchInput.placeholder = 'Search by reference (CR-0001), summary, or contact…';
  searchWrap.append(searchIcon, searchLabel, searchInput);

  // Status Filter Chips + Sort (Desc / Asc) Controls
  const toolbarRight = document.createElement('div');
  toolbarRight.className = 'citizen-toolbar-right';

  const filterChips = document.createElement('div');
  filterChips.className = 'filter-chips citizen-filter-chips';

  const statusChips = [
    { key: 'all', label: 'All', countId: 'chip-count-all' },
    { key: 'unconverted', label: 'Pending Review', countId: 'chip-count-unconverted' },
    { key: 'converted', label: 'Converted', countId: 'chip-count-converted' },
  ];

  let currentStatusFilter = 'all';
  // Default order matches the database query (ORDER BY submitted_at DESC)
  let currentSortField = 'submitted';
  let currentSortDir = 'desc';

  statusChips.forEach(({ key, label, countId }) => {
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = `filter-chip ${key === currentStatusFilter ? 'is-active' : ''}`;
    btn.dataset.status = key;
    btn.innerHTML = `${label} <span class="filter-chip__count" id="${countId}">0</span>`;
    btn.addEventListener('click', () => {
      if (currentStatusFilter === key) return;
      currentStatusFilter = key;
      filterChips.querySelectorAll('.filter-chip').forEach((c) => c.classList.remove('is-active'));
      btn.classList.add('is-active');
      applyFilter();
    });
    filterChips.appendChild(btn);
  });

  // Sort Controls (Field + DESC / ASC toggle)
  const sortControls = document.createElement('div');
  sortControls.className = 'citizen-sort-controls';

  const sortSelectLabel = document.createElement('label');
  sortSelectLabel.className = 'sr-only';
  sortSelectLabel.htmlFor = 'citizen-inbox-sort-field';
  sortSelectLabel.textContent = 'Sort reports by';

  const sortSelect = document.createElement('select');
  sortSelect.id = 'citizen-inbox-sort-field';
  sortSelect.className = 'citizen-sort-select';
  sortSelect.setAttribute('aria-label', 'Sort reports by');
  [
    { value: 'submitted', label: 'Sort: Submitted' },
    { value: 'id', label: 'Sort: Reference (CR)' },
    { value: 'status', label: 'Sort: Status' },
  ].forEach(({ value, label }) => {
    const opt = document.createElement('option');
    opt.value = value;
    opt.textContent = label;
    if (value === currentSortField) opt.selected = true;
    sortSelect.appendChild(opt);
  });

  const sortDirGroup = document.createElement('div');
  sortDirGroup.className = 'citizen-sort-dir-group';
  sortDirGroup.setAttribute('role', 'group');
  sortDirGroup.setAttribute('aria-label', 'Sort direction');

  const descBtn = document.createElement('button');
  descBtn.type = 'button';
  descBtn.className = 'citizen-sort-dir-btn is-active';
  descBtn.dataset.dir = 'desc';
  descBtn.setAttribute('aria-label', 'Sort descending');
  descBtn.title = 'Descending (Newest / Highest ID first)';
  descBtn.textContent = '↓ Desc';

  const ascBtn = document.createElement('button');
  ascBtn.type = 'button';
  ascBtn.className = 'citizen-sort-dir-btn';
  ascBtn.dataset.dir = 'asc';
  ascBtn.setAttribute('aria-label', 'Sort ascending');
  ascBtn.title = 'Ascending (Oldest / Lowest ID first)';
  ascBtn.textContent = '↑ Asc';

  function syncToolbarSortUI() {
    sortSelect.value = currentSortField;
    descBtn.classList.toggle('is-active', currentSortDir === 'desc');
    ascBtn.classList.toggle('is-active', currentSortDir === 'asc');
  }

  sortSelect.addEventListener('change', () => {
    currentSortField = sortSelect.value;
    applyFilter();
  });

  descBtn.addEventListener('click', () => {
    if (currentSortDir === 'desc') return;
    currentSortDir = 'desc';
    syncToolbarSortUI();
    applyFilter();
  });

  ascBtn.addEventListener('click', () => {
    if (currentSortDir === 'asc') return;
    currentSortDir = 'asc';
    syncToolbarSortUI();
    applyFilter();
  });

  sortDirGroup.append(descBtn, ascBtn);
  sortControls.append(sortSelectLabel, sortSelect, sortDirGroup);

  toolbarRight.append(filterChips, sortControls);
  filterBar.append(searchWrap, toolbarRight);
  leftPanel.appendChild(filterBar);

  // Table wrapper
  const tableWrap = document.createElement('div');
  tableWrap.className = 'citizen-table-wrap';
  leftPanel.appendChild(tableWrap);

  let allItems = [];
  let selectedReportId = null;

  searchInput.addEventListener('input', () => applyFilter());

  // Keyboard shortcut: Escape closes detail pane
  const onKeyDown = (e) => {
    if (e.key === 'Escape' && selectedReportId !== null) {
      closeDetailPane();
    }
  };
  window.addEventListener('keydown', onKeyDown);

  // Clean up listener when navigating away
  const observer = new MutationObserver(() => {
    if (!root.contains(container)) {
      window.removeEventListener('keydown', onKeyDown);
      destroyMiniMap();
      observer.disconnect();
    }
  });
  observer.observe(root, { childList: true });

  function destroyMiniMap() {
    if (detachMiniMapFallback) {
      detachMiniMapFallback();
      detachMiniMapFallback = null;
    }
    if (currentMiniMap) {
      try {
        currentMiniMap.remove();
      } catch {
        /* ignore */
      }
      currentMiniMap = null;
    }
  }

  function updateCounts() {
    const totalCount = allItems.length;
    const pendingCount = allItems.filter((r) => !r.incidentId).length;
    const convertedCount = allItems.filter((r) => !!r.incidentId).length;
    const gpsCount = allItems.filter((r) => r.latitude !== null && r.longitude !== null).length;

    const pendingEl = document.getElementById('inbox-pending-count');
    if (pendingEl) pendingEl.textContent = String(pendingCount);
    const totalEl = document.getElementById('inbox-total-count');
    if (totalEl) totalEl.textContent = String(totalCount);
    const convertedEl = document.getElementById('inbox-converted-count');
    if (convertedEl) convertedEl.textContent = String(convertedCount);
    const gpsEl = document.getElementById('inbox-gps-count');
    if (gpsEl) gpsEl.textContent = String(gpsCount);

    const chipAll = document.getElementById('chip-count-all');
    if (chipAll) chipAll.textContent = String(totalCount);
    const chipUnconv = document.getElementById('chip-count-unconverted');
    if (chipUnconv) chipUnconv.textContent = String(pendingCount);
    const chipConv = document.getElementById('chip-count-converted');
    if (chipConv) chipConv.textContent = String(convertedCount);
  }

  function applyFilter() {
    const q = searchInput.value.trim().toLowerCase();
    let filtered = [...allItems];

    if (currentStatusFilter === 'unconverted') {
      filtered = filtered.filter((r) => !r.incidentId);
    } else if (currentStatusFilter === 'converted') {
      filtered = filtered.filter((r) => !!r.incidentId);
    }

    if (q) {
      filtered = filtered.filter(
        (r) =>
          String(r.reportId).includes(q) ||
          formatReportCode(r.reportId).toLowerCase().includes(q) ||
          (r.description && r.description.toLowerCase().includes(q)) ||
          (r.contactNumber && r.contactNumber.toLowerCase().includes(q))
      );
    }

    updateCounts();

    if (filtered.length === 0) {
      renderEmpty(
        tableWrap,
        q ? 'No reports match your search criteria.' : 'No citizen reports found in this view.',
        q ? null : 'Walk-ins are logged from Incident Management.'
      );
      if (selectedReportId !== null) {
        closeDetailPane();
      }
    } else {
      renderTable(tableWrap, filtered);
      // If currently selected report is still in filtered list, keep it open
      if (selectedReportId !== null) {
        const item = allItems.find((r) => r.reportId === selectedReportId);
        if (item) {
          openDetailPane(item);
        } else {
          closeDetailPane();
        }
      }
    }
  }

  function openDetailPane(report) {
    selectedReportId = report.reportId;
    layout.classList.add('has-detail');

    if (!detailPanel) {
      detailPanel = document.createElement('div');
      detailPanel.className = 'citizen-detail-panel';
      layout.appendChild(detailPanel);
    }

    renderDetailContent(detailPanel, report);

    // Re-render table row highlight
    tableWrap.querySelectorAll('.data-table tbody tr').forEach((tr) => {
      const rowId = tr.dataset.reportId || tr.dataset.rowKey;
      tr.classList.toggle('is-selected', rowId === String(report.reportId));
    });

    if (window.innerWidth <= 1024) {
      detailPanel.scrollIntoView({ behavior: 'smooth', block: 'start' });
    }
  }

  function closeDetailPane() {
    selectedReportId = null;
    destroyMiniMap();
    if (detailPanel) {
      detailPanel.remove();
      detailPanel = null;
    }
    layout.classList.remove('has-detail');
    tableWrap.querySelectorAll('.data-table tbody tr').forEach((tr) => {
      tr.classList.remove('is-selected');
    });
  }

  function renderDetailContent(pane, report) {
    destroyMiniMap();
    pane.innerHTML = '';

    const isConverted = Boolean(report.incidentId);
    const hasCoords = report.latitude !== null && report.longitude !== null;
    const reportCode = formatReportCode(report.reportId);

    // 1. STICKY HEADER
    const detailHeader = document.createElement('div');
    detailHeader.className = 'citizen-detail-header';

    const headerLeft = document.createElement('div');
    headerLeft.className = 'citizen-detail-header__left';

    const codeBadge = document.createElement('span');
    codeBadge.className = 'incident-id-badge citizen-id-badge';
    codeBadge.textContent = reportCode;

    const title = document.createElement('h3');
    title.className = 'citizen-detail-header__title';
    title.textContent = reportCode;

    const statusPill = document.createElement('span');
    statusPill.className = `status-pill ${isConverted ? 'status-pill--success' : 'status-pill--pending'}`;
    statusPill.textContent = isConverted ? 'Converted to an incident' : 'Pending Review';

    headerLeft.append(codeBadge, title, statusPill);

    const closeBtn = document.createElement('button');
    closeBtn.type = 'button';
    closeBtn.className = 'citizen-detail-close-btn';
    closeBtn.title = 'Close inspection (Esc)';
    closeBtn.setAttribute('aria-label', 'Close detail pane');
    closeBtn.innerHTML = icons.x(18);
    closeBtn.addEventListener('click', closeDetailPane);

    detailHeader.append(headerLeft, closeBtn);
    pane.appendChild(detailHeader);

    // 2. SCROLLABLE BODY (Unified Narrative + Metadata Card, and Geolocation Map Card)
    const body = document.createElement('div');
    body.className = 'citizen-detail-body';

    // Unified Narrative & Reporter Overview Card (no left color stripe)
    const overviewCard = document.createElement('div');
    overviewCard.className = 'citizen-overview-card';

    const narrativeHeader = document.createElement('div');
    narrativeHeader.className = 'citizen-overview-card__header';

    const narrativeTitle = document.createElement('h4');
    narrativeTitle.className = 'citizen-narrative-card__title';
    narrativeTitle.innerHTML = `${icons.megaphone(15)} Citizen Narrative`;

    const wordCount = (report.description || '').trim().split(/\s+/).filter(Boolean).length;
    const countBadge = document.createElement('span');
    countBadge.className = 'citizen-word-count-chip';
    countBadge.textContent = `${wordCount} ${wordCount === 1 ? 'word' : 'words'}`;

    narrativeHeader.append(narrativeTitle, countBadge);

    const narrativeText = document.createElement('p');
    narrativeText.className = 'citizen-narrative-card__text';
    narrativeText.textContent = report.description || 'No description provided.';

    // Combined 3-Column Metadata & Contact Footer inside Overview Card
    const metaGrid = document.createElement('div');
    metaGrid.className = 'citizen-overview-meta';

    const submittedItem = document.createElement('div');
    submittedItem.className = 'citizen-detail-meta-item';
    submittedItem.innerHTML = `
      <span class="citizen-detail-meta-label">Submitted</span>
      <span class="citizen-detail-meta-val">${escapeHtml(timeAgo(report.submittedAt))}</span>
      <span class="citizen-detail-meta-sub">${escapeHtml(formatDateTime(report.submittedAt))}</span>
    `;

    const contactItem = document.createElement('div');
    contactItem.className = 'citizen-detail-meta-item';
    const contactLabel = document.createElement('span');
    contactLabel.className = 'citizen-detail-meta-label';
    contactLabel.textContent = 'Reporter Contact';

    const contactRow = document.createElement('div');
    contactRow.className = 'citizen-detail-contact-inline';
    const contactVal = document.createElement('span');
    contactVal.className = 'citizen-detail-meta-val';
    contactVal.textContent = report.contactNumber ? formatContactNumber(report.contactNumber) : 'Anonymous';
    contactRow.appendChild(contactVal);

    if (report.contactNumber) {
      const copyBtn = document.createElement('button');
      copyBtn.type = 'button';
      copyBtn.className = 'citizen-copy-inline-btn';
      copyBtn.title = 'Copy contact number';
      copyBtn.setAttribute('aria-label', 'Copy contact number');
      copyBtn.innerHTML = `${icons.copy(12)} <span>Copy</span>`;
      copyBtn.addEventListener('click', async () => {
        try {
          await navigator.clipboard.writeText(report.contactNumber);
          copyBtn.innerHTML = `${icons.checkCircle(12)} <span>Copied</span>`;
          setTimeout(() => {
            copyBtn.innerHTML = `${icons.copy(12)} <span>Copy</span>`;
          }, 2000);
        } catch {
          showToast('Failed to copy contact number', { variant: 'error' });
        }
      });
      contactRow.appendChild(copyBtn);
    }
    contactItem.append(contactLabel, contactRow);

    const coordsItem = document.createElement('div');
    coordsItem.className = 'citizen-detail-meta-item';
    coordsItem.innerHTML = `
      <span class="citizen-detail-meta-label">Coordinates</span>
      <span class="citizen-detail-meta-val">${hasCoords ? `${report.latitude.toFixed(4)}, ${report.longitude.toFixed(4)}` : 'Not shared'}</span>
      <span class="citizen-detail-meta-sub">${hasCoords ? 'GPS pin attached' : 'No GPS telemetry'}</span>
    `;

    metaGrid.append(submittedItem, contactItem, coordsItem);
    overviewCard.append(narrativeHeader, narrativeText, metaGrid);
    body.appendChild(overviewCard);

    // Geolocation & Mini-Map Card
    const locationCard = document.createElement('div');
    locationCard.className = 'citizen-location-card';

    const locationHeader = document.createElement('div');
    locationHeader.className = 'citizen-location-card__header';

    const locTitle = document.createElement('span');
    locTitle.className = 'citizen-location-card__title';
    locTitle.innerHTML = `${icons.mapPin(15)} Geolocation Context`;

    const locActions = document.createElement('div');
    locActions.className = 'citizen-location-card__actions';

    let mapVisible = true;

    if (hasCoords) {
      const toggleMapBtn = document.createElement('button');
      toggleMapBtn.type = 'button';
      toggleMapBtn.className = 'ghost citizen-loc-btn';
      toggleMapBtn.textContent = 'Hide Map';

      const gmapsLink = document.createElement('a');
      gmapsLink.href = `https://www.google.com/maps?q=${report.latitude},${report.longitude}`;
      gmapsLink.target = '_blank';
      gmapsLink.rel = 'noopener noreferrer';
      gmapsLink.className = 'ghost citizen-loc-btn';
      gmapsLink.innerHTML = `${icons.externalLink(12)} Google Maps`;

      locActions.append(toggleMapBtn, gmapsLink);
      locationHeader.append(locTitle, locActions);
      locationCard.appendChild(locationHeader);

      const mapContainer = document.createElement('div');
      mapContainer.className = 'citizen-mini-map';
      locationCard.appendChild(mapContainer);
      body.appendChild(locationCard);

      toggleMapBtn.addEventListener('click', () => {
        mapVisible = !mapVisible;
        mapContainer.style.display = mapVisible ? 'block' : 'none';
        toggleMapBtn.textContent = mapVisible ? 'Hide Map' : 'Show Map';
        if (mapVisible && currentMiniMap) {
          currentMiniMap.resize();
        }
      });

      // Initialize MapLibre Mini Map asynchronously
      setTimeout(() => {
        if (!window.maplibregl) {
          mapContainer.innerHTML = `<div class="citizen-map-fallback">Map preview requires MapLibre GL library. Coordinates: ${report.latitude.toFixed(6)}, ${report.longitude.toFixed(6)}</div>`;
          return;
        }

        try {
          currentMiniMap = new window.maplibregl.Map({
            container: mapContainer,
            style: {
              version: 8,
              sources: {
                'osm-tiles': {
                  type: 'raster',
                  tiles: [OSM_TILE_URL],
                  tileSize: 256,
                  attribution: '© OpenStreetMap contributors',
                },
              },
              layers: [
                { id: 'background', type: 'background', paint: { 'background-color': '#E0F2FE' } },
                { id: 'osm-tiles', type: 'raster', source: 'osm-tiles' },
              ],
            },
            center: [report.longitude, report.latitude],
            zoom: 15,
            interactive: true,
          });

          currentMiniMap.addControl(new window.maplibregl.NavigationControl({ showCompass: false }), 'top-right');
          detachMiniMapFallback = attachBasemapFallback(currentMiniMap, 'osm-tiles');

          const pinEl = document.createElement('div');
          pinEl.className = 'citizen-mini-map-pin';
          pinEl.innerHTML = icons.mapPin(15);

          new window.maplibregl.Marker({ element: pinEl })
            .setLngLat([report.longitude, report.latitude])
            .addTo(currentMiniMap);
        } catch (err) {
          console.warn('Mini-map initialization failed:', err);
          mapContainer.innerHTML = `<div class="citizen-map-fallback">Could not initialize interactive map. Coordinates: ${report.latitude.toFixed(6)}, ${report.longitude.toFixed(6)}</div>`;
        }
      }, 50);
    } else {
      locationHeader.appendChild(locTitle);
      locationCard.appendChild(locationHeader);

      const emptyLoc = document.createElement('div');
      emptyLoc.className = 'citizen-location-empty';
      emptyLoc.textContent = 'Citizen did not share GPS location with this report.';
      locationCard.appendChild(emptyLoc);
      body.appendChild(locationCard);
    }

    pane.appendChild(body);

    // 3. PINNED BOTTOM ACTION FOOTER (Always visible without scrolling)
    const footer = document.createElement('div');
    footer.className = 'citizen-detail-footer';

    if (isConverted) {
      const banner = document.createElement('div');
      banner.className = 'citizen-converted-banner';

      const bannerInfo = document.createElement('div');
      bannerInfo.className = 'citizen-converted-banner__info';

      const bannerTitle = document.createElement('div');
      bannerTitle.className = 'citizen-converted-banner__title';
      bannerTitle.innerHTML = `${icons.checkCircle(16)} Official Incident Created (${escapeHtml(formatIncidentCode(report.incidentId))})`;

      const bannerDesc = document.createElement('div');
      bannerDesc.className = 'citizen-converted-banner__desc';
      bannerDesc.textContent = 'This report has been converted to an incident. Open it in Incident Management to see its incident number.';

      bannerInfo.append(bannerTitle, bannerDesc);

      const viewIncidentBtn = document.createElement('button');
      viewIncidentBtn.type = 'button';
      viewIncidentBtn.className = 'primary citizen-view-inc-btn';
      viewIncidentBtn.textContent = 'View Incident →';
      viewIncidentBtn.addEventListener('click', () => {
        navigate('incident-management', report.incidentId);
      });

      banner.append(bannerInfo, viewIncidentBtn);
      footer.appendChild(banner);
    } else {
      const triageCard = document.createElement('div');
      triageCard.className = 'citizen-triage-card';

      const triageHeader = document.createElement('div');
      triageHeader.className = 'citizen-triage-card__header';

      const triageTitle = document.createElement('h4');
      triageTitle.className = 'citizen-triage-card__title';
      triageTitle.innerHTML = `${icons.shield(15)} Triage & Incident Conversion`;

      const triageDesc = document.createElement('p');
      triageDesc.className = 'citizen-triage-card__desc';
      triageDesc.textContent = 'Classify this submission and escalate it to an official dispatch incident.';

      triageHeader.append(triageTitle, triageDesc);

      const form = document.createElement('form');
      form.className = 'citizen-triage-form';

      const controlsRow = document.createElement('div');
      controlsRow.className = 'citizen-triage-controls-row';

      // Incident Type Selector
      const typeField = document.createElement('div');
      typeField.className = 'citizen-triage-field citizen-triage-field--select';

      const typeLabel = document.createElement('label');
      typeLabel.htmlFor = 'triage-incident-type';
      typeLabel.className = 'citizen-detail-meta-label';
      typeLabel.textContent = 'Incident Category';

      const typeSelect = document.createElement('select');
      typeSelect.id = 'triage-incident-type';
      typeSelect.className = 'citizen-triage-select';
      INCIDENT_TYPE_OPTIONS.forEach(([val, label]) => {
        const opt = document.createElement('option');
        opt.value = val;
        opt.textContent = label;
        if (val === 'disturbance') opt.selected = true;
        typeSelect.appendChild(opt);
      });
      typeField.append(typeLabel, typeSelect);

      // Priority Selector Pills
      let selectedPriority = 'normal';
      const priorityField = document.createElement('div');
      priorityField.className = 'citizen-triage-field citizen-triage-field--priority';

      const priorityLabel = document.createElement('span');
      priorityLabel.className = 'citizen-detail-meta-label';
      priorityLabel.textContent = 'Priority';

      const priorityPills = document.createElement('div');
      priorityPills.className = 'citizen-priority-pills';

      PRIORITY_OPTIONS.forEach(({ value, label }) => {
        const pill = document.createElement('button');
        pill.type = 'button';
        pill.className = `citizen-priority-pill ${value === selectedPriority ? 'is-active' : ''}`;
        pill.dataset.priority = value;
        pill.textContent = label;
        pill.addEventListener('click', () => {
          selectedPriority = value;
          priorityPills.querySelectorAll('.citizen-priority-pill').forEach((p) => p.classList.remove('is-active'));
          pill.classList.add('is-active');
        });
        priorityPills.appendChild(pill);
      });
      priorityField.append(priorityLabel, priorityPills);

      controlsRow.append(typeField, priorityField);

      // Convert Button
      const submitBtn = document.createElement('button');
      submitBtn.type = 'submit';
      submitBtn.className = 'btn-convert-incident';
      submitBtn.innerHTML = `${icons.checkCircle(16)} <span>Convert to Official Incident</span>`;

      form.append(controlsRow, submitBtn);

      form.addEventListener('submit', async (e) => {
        e.preventDefault();
        submitBtn.disabled = true;
        submitBtn.textContent = 'Converting…';

        try {
          const res = await convertCitizenReport(report.reportId, {
            incidentType: typeSelect.value,
            priority: selectedPriority,
          });
          showToast('Converted to an incident.', { variant: 'success' });
          report.incidentId = res.incidentId;
          updateCounts();
          applyFilter();
          openDetailPane(report);
        } catch (err) {
          submitBtn.disabled = false;
          submitBtn.innerHTML = `${icons.checkCircle(16)} <span>Convert to Official Incident</span>`;
          showToast(err instanceof ApiClientError ? err.message : 'Could not convert report.', { variant: 'error' });
        }
      });

      triageCard.append(triageHeader, form);
      footer.appendChild(triageCard);
    }

    pane.appendChild(footer);
  }

  function renderTable(container, items) {
    container.innerHTML = '';
    const table = DataTable({
      columns: COLUMNS,
      rows: items,
      rowKey: (row) => row.reportId,
      selectedKey: selectedReportId,
      rowAriaLabel: (row) => `#${row.reportId}`,
      initialSort: { key: currentSortField, direction: currentSortDir },
      onSortChange: ({ key, direction }) => {
        if (key) {
          currentSortField = key;
          currentSortDir = direction;
          syncToolbarSortUI();
        }
      },
      caption: 'Citizen reports inbox',
      rowClass: (row) => (row.reportId === selectedReportId ? 'is-selected' : undefined),
      onRowClick: (row) => {
        if (selectedReportId === row.reportId) {
          closeDetailPane();
        } else {
          openDetailPane(row);
        }
      },
      renderCell: (row, key) => {
        switch (key) {
          case 'id': {
            const span = document.createElement('span');
            span.className = 'incident-id-badge citizen-id-badge';
            span.textContent = formatReportCode(row.reportId);
            span.title = formatCitizenReportCode(row.reportId);
            return span;
          }
          case 'description': {
            const span = document.createElement('span');
            span.className = 'citizen-summary-cell';
            span.textContent = row.description;
            span.title = row.description;
            return span;
          }
          case 'location': {
            if (row.latitude === null || row.longitude === null) {
              const span = document.createElement('span');
              span.className = 'citizen-location-badge citizen-location-badge--none';
              span.textContent = 'Not shared';
              return span;
            }
            const wrap = document.createElement('div');
            wrap.className = 'citizen-location-cell';
            wrap.title = `${row.latitude}, ${row.longitude}`;

            const badge = document.createElement('span');
            badge.className = 'citizen-location-badge';
            badge.innerHTML = `${icons.mapPin(12)} GPS`;

            const coords = document.createElement('span');
            coords.className = 'citizen-location-coords';
            coords.textContent = `${row.latitude.toFixed(4)}, ${row.longitude.toFixed(4)}`;

            wrap.append(badge, coords);
            return wrap;
          }
          case 'contact': {
            const span = document.createElement('span');
            if (!row.contactNumber) {
              span.className = 'citizen-contact-cell citizen-contact-cell--anon';
              span.textContent = 'Anonymous';
            } else {
              span.className = 'citizen-contact-cell';
              span.textContent = formatContactNumber(row.contactNumber);
            }
            return span;
          }
          case 'status': {
            if (row.incidentId) {
              const wrap = document.createElement('div');
              wrap.className = 'citizen-status-stack';

              const pill = document.createElement('span');
              pill.className = 'status-pill status-pill--success';
              pill.textContent = 'Converted';

              const incBadge = document.createElement('span');
              incBadge.className = 'citizen-linked-inc-badge';
              incBadge.textContent = formatIncidentCode(row.incidentId, row.incidentDisplayId);

              wrap.append(pill, incBadge);
              return wrap;
            }
            const span = document.createElement('span');
            span.className = 'status-pill status-pill--pending';
            span.textContent = 'Pending Review';
            return span;
          }
          case 'submitted': {
            const wrap = document.createElement('div');
            wrap.className = 'citizen-submitted-cell';
            wrap.title = formatDateTime(row.submittedAt);

            const rel = document.createElement('span');
            rel.className = 'citizen-submitted-cell__rel';
            rel.textContent = timeAgo(row.submittedAt);

            const dateStr = formatShortDate(row.submittedAt);
            if (dateStr) {
              const sub = document.createElement('span');
              sub.className = 'citizen-submitted-cell__date';
              sub.textContent = dateStr;
              wrap.append(rel, sub);
            } else {
              wrap.appendChild(rel);
            }
            return wrap;
          }
          case 'actions': {
            const isSelected = row.reportId === selectedReportId;
            const isPending = !row.incidentId;
            const button = document.createElement('button');
            button.type = 'button';
            button.className = `citizen-action-btn ${
              isSelected
                ? 'citizen-action-btn--active'
                : isPending
                  ? 'citizen-action-btn--review'
                  : 'citizen-action-btn--view'
            }`;
            button.textContent = isSelected ? 'Close' : isPending ? 'Review →' : 'View';
            button.addEventListener('click', (event) => {
              event.stopPropagation();
              if (selectedReportId === row.reportId) {
                closeDetailPane();
              } else {
                openDetailPane(row);
              }
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

  load();

  async function load() {
    renderLoading(tableWrap);
    try {
      // Fetch all reports (limit 100) so we can filter and switch tabs instantly
      const result = await getCitizenReports({ limit: 100 });
      allItems = result.items;
      applyFilter();
    } catch (err) {
      const message = err instanceof ApiClientError ? err.message : 'Something went wrong loading citizen reports.';
      renderError(tableWrap, message, load);
    }
  }
}

function renderLoading(container) {
  container.innerHTML = '';
  const wrap = document.createElement('div');
  wrap.className = 'stack';
  wrap.setAttribute('role', 'status');
  wrap.setAttribute('aria-label', 'Loading citizen reports');
  for (let i = 0; i < 6; i++) {
    const skeleton = document.createElement('div');
    skeleton.className = 'skeleton skeleton--row';
    wrap.appendChild(skeleton);
  }
  container.appendChild(wrap);
}

function renderEmpty(container, message, hint = null) {
  container.innerHTML = '';
  const block = document.createElement('div');
  block.className = 'card state-block';
  block.style.margin = 'auto';
  const heading = document.createElement('h3');
  heading.textContent = 'No Reports';
  const body = document.createElement('p');
  body.textContent = message;
  block.append(heading, body);
  if (hint) {
    // Citizens can no longer file reports directly (the public form was
    // removed 2026-10-07), so an empty inbox is the normal state: say where
    // walk-ins go instead of leaving staff wondering why it is empty.
    const hintLine = document.createElement('p');
    hintLine.textContent = hint;
    block.appendChild(hintLine);
  }
  container.appendChild(block);
}

function renderError(container, message, onRetry) {
  container.innerHTML = '';
  const block = document.createElement('div');
  block.className = 'card state-block state-block--error';
  block.style.margin = 'auto';
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
