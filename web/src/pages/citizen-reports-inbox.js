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
  { key: 'id', label: 'ID', width: '4.5rem' },
  { key: 'description', label: 'SUMMARY' },
  { key: 'location', label: 'LOCATION', width: '7.5rem' },
  { key: 'contact', label: 'CONTACT', width: '8.5rem' },
  { key: 'status', label: 'STATUS', width: '7rem' },
  { key: 'submitted', label: 'SUBMITTED', width: '7.5rem' },
  { key: 'actions', label: '', width: '4.5rem', align: 'right' },
];

function formatDateTime(isoString) {
  if (!isoString) return '—';
  const d = new Date(isoString);
  if (isNaN(d.getTime())) return isoString;
  return d.toLocaleString(undefined, {
    month: 'short',
    day: 'numeric',
    year: 'numeric',
    hour: 'numeric',
    minute: '2-digit',
  });
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

  // Modern PageHeader with counter pills in actions slot
  const pageHeader = PageHeader({
    title: 'Citizen Reports',
    subtitle: 'Public submissions intake & triage console',
    icon: icons.inbox,
  });

  const pendingPill = document.createElement('span');
  pendingPill.className = 'status-pill status-pill--pending';
  pendingPill.innerHTML = `<strong>Pending:</strong> <span id="inbox-pending-count">—</span>`;

  const totalPill = document.createElement('span');
  totalPill.className = 'status-pill status-pill--info';
  totalPill.innerHTML = `<strong>Total:</strong> <span id="inbox-total-count">—</span>`;

  pageHeader.actions.append(pendingPill, totalPill);
  header.appendChild(pageHeader.el);

  // Main Container & Master-Detail Split Grid
  const container = document.createElement('div');
  container.className = 'citizen-inbox-container';

  const layout = document.createElement('div');
  layout.className = 'citizen-inbox-layout';
  container.appendChild(layout);
  content.appendChild(container);

  // Left Panel (Table & Filters)
  const leftPanel = document.createElement('div');
  leftPanel.className = 'citizen-inbox-left-panel';
  layout.appendChild(leftPanel);

  // Right Panel slot (Detail pane)
  let detailPanel = null;
  let currentMiniMap = null;

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
  searchInput.placeholder = 'Search by ID, description, or contact…';
  searchWrap.append(searchIcon, searchLabel, searchInput);

  // Status Filter Chips
  const filterChips = document.createElement('div');
  filterChips.className = 'citizen-filter-chips';

  const statusChips = [
    { key: 'all', label: 'All', countId: 'chip-count-all' },
    { key: 'unconverted', label: 'Pending Review', countId: 'chip-count-unconverted' },
    { key: 'converted', label: 'Converted', countId: 'chip-count-converted' },
  ];

  let currentStatusFilter = 'all';

  statusChips.forEach(({ key, label, countId }) => {
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = `citizen-filter-chip ${key === currentStatusFilter ? 'is-active' : ''}`;
    btn.dataset.status = key;
    btn.innerHTML = `${label} <span class="citizen-filter-chip__count" id="${countId}">0</span>`;
    btn.addEventListener('click', () => {
      if (currentStatusFilter === key) return;
      currentStatusFilter = key;
      filterChips.querySelectorAll('.citizen-filter-chip').forEach((c) => c.classList.remove('is-active'));
      btn.classList.add('is-active');
      applyFilter();
    });
    filterChips.appendChild(btn);
  });

  filterBar.append(searchWrap, filterChips);
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

    const pendingEl = document.getElementById('inbox-pending-count');
    if (pendingEl) pendingEl.textContent = String(pendingCount);
    const totalEl = document.getElementById('inbox-total-count');
    if (totalEl) totalEl.textContent = String(totalCount);

    const chipAll = document.getElementById('chip-count-all');
    if (chipAll) chipAll.textContent = String(totalCount);
    const chipUnconv = document.getElementById('chip-count-unconverted');
    if (chipUnconv) chipUnconv.textContent = String(pendingCount);
    const chipConv = document.getElementById('chip-count-converted');
    if (chipConv) chipConv.textContent = String(convertedCount);
  }

  function applyFilter() {
    const q = searchInput.value.trim().toLowerCase();
    let filtered = allItems;

    if (currentStatusFilter === 'unconverted') {
      filtered = filtered.filter((r) => !r.incidentId);
    } else if (currentStatusFilter === 'converted') {
      filtered = filtered.filter((r) => !!r.incidentId);
    }

    if (q) {
      filtered = filtered.filter(
        (r) =>
          String(r.reportId).includes(q) ||
          (r.description && r.description.toLowerCase().includes(q)) ||
          (r.contactNumber && r.contactNumber.toLowerCase().includes(q))
      );
    }

    updateCounts();

    if (filtered.length === 0) {
      renderEmpty(tableWrap, q ? 'No reports match your search criteria.' : 'No citizen reports found in this view.');
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
      tr.classList.toggle('is-selected', tr.dataset.reportId === String(report.reportId));
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

    // 1. STICKY HEADER
    const detailHeader = document.createElement('div');
    detailHeader.className = 'citizen-detail-header';

    const headerLeft = document.createElement('div');
    headerLeft.className = 'citizen-detail-header__left';

    const title = document.createElement('h3');
    title.className = 'citizen-detail-header__title';
    title.textContent = `Report #${report.reportId}`;

    const statusPill = document.createElement('span');
    statusPill.className = `status-pill ${isConverted ? 'status-pill--success' : 'status-pill--pending'}`;
    statusPill.textContent = isConverted ? `Converted (INC-${report.incidentId})` : 'Pending Review';

    headerLeft.append(title, statusPill);

    const closeBtn = document.createElement('button');
    closeBtn.type = 'button';
    closeBtn.className = 'citizen-detail-close-btn';
    closeBtn.title = 'Close inspection (Esc)';
    closeBtn.setAttribute('aria-label', 'Close detail pane');
    closeBtn.innerHTML = icons.x(18);
    closeBtn.addEventListener('click', closeDetailPane);

    detailHeader.append(headerLeft, closeBtn);
    pane.appendChild(detailHeader);

    // 2. SCROLLABLE BODY (Only narrative, contact, and map scroll)
    const body = document.createElement('div');
    body.className = 'citizen-detail-body';

    // Metadata Strip
    const metaGrid = document.createElement('div');
    metaGrid.className = 'citizen-detail-meta-grid';

    const hasCoords = report.latitude !== null && report.longitude !== null;

    metaGrid.innerHTML = `
      <div class="citizen-detail-meta-item">
        <span class="citizen-detail-meta-label">Submitted</span>
        <span class="citizen-detail-meta-val" title="${formatDateTime(report.submittedAt)}">${timeAgo(report.submittedAt)}</span>
      </div>
      <div class="citizen-detail-meta-item">
        <span class="citizen-detail-meta-label">Coordinates</span>
        <span class="citizen-detail-meta-val">${hasCoords ? `${report.latitude.toFixed(4)}, ${report.longitude.toFixed(4)}` : 'Not shared'}</span>
      </div>
      <div class="citizen-detail-meta-item">
        <span class="citizen-detail-meta-label">Contact</span>
        <span class="citizen-detail-meta-val">${report.contactNumber || 'Anonymous'}</span>
      </div>
      <div class="citizen-detail-meta-item">
        <span class="citizen-detail-meta-label">Status</span>
        <span class="citizen-detail-meta-val">${isConverted ? `Incident #${report.incidentId}` : 'Awaiting Review'}</span>
      </div>
    `;
    body.appendChild(metaGrid);

    // Full Citizen Narrative Card
    const narrativeCard = document.createElement('div');
    narrativeCard.className = 'citizen-narrative-card';

    const narrativeHeader = document.createElement('div');
    narrativeHeader.style.display = 'flex';
    narrativeHeader.style.alignItems = 'center';
    narrativeHeader.style.justifyContent = 'space-between';

    const narrativeTitle = document.createElement('h4');
    narrativeTitle.className = 'citizen-narrative-card__title';
    narrativeTitle.innerHTML = `${icons.megaphone(16)} Citizen Narrative`;

    const wordCount = (report.description || '').trim().split(/\s+/).filter(Boolean).length;
    const countBadge = document.createElement('span');
    countBadge.className = 'citizen-detail-meta-label';
    countBadge.textContent = `${wordCount} words`;

    narrativeHeader.append(narrativeTitle, countBadge);

    const narrativeText = document.createElement('p');
    narrativeText.className = 'citizen-narrative-card__text';
    narrativeText.textContent = report.description || 'No description provided.';

    narrativeCard.append(narrativeHeader, narrativeText);
    body.appendChild(narrativeCard);

    // Reporter Contact Card
    const contactCard = document.createElement('div');
    contactCard.className = 'citizen-contact-card';

    const contactInfo = document.createElement('div');
    contactInfo.className = 'citizen-contact-card__info';

    const contactIcon = document.createElement('div');
    contactIcon.className = 'citizen-contact-card__icon';
    contactIcon.innerHTML = icons.phone(16);

    const contactText = document.createElement('div');
    contactText.innerHTML = `
      <div class="citizen-detail-meta-label">Reporter Contact Number</div>
      <div class="citizen-contact-card__phone">${report.contactNumber || 'No contact number provided'}</div>
    `;
    contactInfo.append(contactIcon, contactText);
    contactCard.appendChild(contactInfo);

    if (report.contactNumber) {
      const copyBtn = document.createElement('button');
      copyBtn.type = 'button';
      copyBtn.className = 'ghost';
      copyBtn.innerHTML = `${icons.copy(14)} Copy`;
      copyBtn.addEventListener('click', async () => {
        try {
          await navigator.clipboard.writeText(report.contactNumber);
          copyBtn.textContent = 'Copied!';
          setTimeout(() => {
            copyBtn.innerHTML = `${icons.copy(14)} Copy`;
          }, 2000);
        } catch {
          showToast('Failed to copy contact number', { variant: 'error' });
        }
      });
      contactCard.appendChild(copyBtn);
    }
    body.appendChild(contactCard);

    // Geolocation & Mini-Map Card
    const locationCard = document.createElement('div');
    locationCard.className = 'citizen-location-card';

    const locationHeader = document.createElement('div');
    locationHeader.className = 'citizen-location-card__header';

    const locTitle = document.createElement('span');
    locTitle.innerHTML = `${icons.mapPin(15)} Geolocation Context`;

    const locActions = document.createElement('div');
    locActions.style.display = 'flex';
    locActions.style.alignItems = 'center';
    locActions.style.gap = 'var(--spacing-xs)';

    let mapVisible = true;

    if (hasCoords) {
      const toggleMapBtn = document.createElement('button');
      toggleMapBtn.type = 'button';
      toggleMapBtn.className = 'ghost';
      toggleMapBtn.style.padding = '0.2rem 0.5rem';
      toggleMapBtn.style.fontSize = '0.75rem';
      toggleMapBtn.textContent = 'Hide Map';

      const gmapsLink = document.createElement('a');
      gmapsLink.href = `https://www.google.com/maps?q=${report.latitude},${report.longitude}`;
      gmapsLink.target = '_blank';
      gmapsLink.rel = 'noopener noreferrer';
      gmapsLink.className = 'ghost';
      gmapsLink.style.padding = '0.2rem 0.5rem';
      gmapsLink.style.fontSize = '0.75rem';
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
          mapContainer.innerHTML = `<div style="display:flex;align-items:center;justify-content:center;height:100%;font-size:0.8125rem;color:var(--color-text-secondary);padding:1rem;">Map preview requires MapLibre GL library. Coordinates: ${report.latitude.toFixed(6)}, ${report.longitude.toFixed(6)}</div>`;
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
                  tiles: ['https://tile.openstreetmap.org/{z}/{x}/{y}.png'],
                  tileSize: 256,
                  attribution: '© OpenStreetMap contributors',
                },
              },
              layers: [{ id: 'osm-tiles', type: 'raster', source: 'osm-tiles' }],
            },
            center: [report.longitude, report.latitude],
            zoom: 15,
            interactive: true,
          });

          currentMiniMap.addControl(new window.maplibregl.NavigationControl({ showCompass: false }), 'top-right');

          // Branded map pin
          const pinEl = document.createElement('div');
          pinEl.style.display = 'flex';
          pinEl.style.alignItems = 'center';
          pinEl.style.justifyContent = 'center';
          pinEl.style.width = '1.875rem';
          pinEl.style.height = '1.875rem';
          pinEl.style.borderRadius = '50%';
          pinEl.style.background = 'var(--color-critical)';
          pinEl.style.color = '#ffffff';
          pinEl.style.boxShadow = '0 3px 10px rgba(0,0,0,0.35)';
          pinEl.style.border = '2px solid #ffffff';
          pinEl.innerHTML = icons.mapPin(15);

          new window.maplibregl.Marker({ element: pinEl })
            .setLngLat([report.longitude, report.latitude])
            .addTo(currentMiniMap);
        } catch (err) {
          console.warn('Mini-map initialization failed:', err);
          mapContainer.innerHTML = `<div style="display:flex;align-items:center;justify-content:center;height:100%;font-size:0.8125rem;color:var(--color-text-secondary);padding:1rem;">Could not initialize interactive map. Coordinates: ${report.latitude.toFixed(6)}, ${report.longitude.toFixed(6)}</div>`;
        }
      }, 50);
    } else {
      locationHeader.appendChild(locTitle);
      locationCard.appendChild(locationHeader);

      const emptyLoc = document.createElement('div');
      emptyLoc.style.padding = 'var(--spacing-md)';
      emptyLoc.style.color = 'var(--color-text-secondary)';
      emptyLoc.style.fontSize = 'var(--font-size-sm)';
      emptyLoc.textContent = 'Citizen did not share GPS location with this report.';
      locationCard.appendChild(emptyLoc);
      body.appendChild(locationCard);
    }

    // Triage Action Card / Converted Banner
    if (isConverted) {
      const banner = document.createElement('div');
      banner.className = 'citizen-converted-banner';

      const bannerInfo = document.createElement('div');
      bannerInfo.className = 'citizen-converted-banner__info';

      const bannerTitle = document.createElement('div');
      bannerTitle.className = 'citizen-converted-banner__title';
      bannerTitle.innerHTML = `${icons.checkCircle(16)} Official Incident Created`;

      const bannerDesc = document.createElement('div');
      bannerDesc.className = 'citizen-converted-banner__desc';
      bannerDesc.textContent = `This report has been converted to Incident #INC-${report.incidentId}.`;

      bannerInfo.append(bannerTitle, bannerDesc);

      const viewIncidentBtn = document.createElement('button');
      viewIncidentBtn.type = 'button';
      viewIncidentBtn.className = 'primary';
      viewIncidentBtn.style.padding = '0.5rem 1rem';
      viewIncidentBtn.style.fontSize = 'var(--font-size-sm)';
      viewIncidentBtn.style.whiteSpace = 'nowrap';
      viewIncidentBtn.textContent = 'View in Incident Management →';
      viewIncidentBtn.addEventListener('click', () => {
        navigate('incident-management', report.incidentId);
      });

      banner.append(bannerInfo, viewIncidentBtn);
      body.appendChild(banner);
    } else {
      const triageCard = document.createElement('div');
      triageCard.className = 'citizen-triage-card';

      const triageTitle = document.createElement('h4');
      triageTitle.className = 'citizen-triage-card__title';
      triageTitle.innerHTML = `⚡ Triage & Incident Conversion`;

      const triageDesc = document.createElement('p');
      triageDesc.className = 'citizen-triage-card__desc';
      triageDesc.textContent = 'Classify this submission and escalate it to an official dispatch incident.';

      const form = document.createElement('form');
      form.className = 'citizen-triage-form';

      // Responsive controls row grouping Category & Priority
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
      submitBtn.innerHTML = `⚡ Convert to Official Incident`;

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
          showToast(`Converted to Incident #${res.incidentId}.`, { variant: 'success' });
          report.incidentId = res.incidentId;
          updateCounts();
          applyFilter();
          openDetailPane(report);
        } catch (err) {
          submitBtn.disabled = false;
          submitBtn.innerHTML = `⚡ Convert to Official Incident`;
          showToast(err instanceof ApiClientError ? err.message : 'Could not convert report.', { variant: 'error' });
        }
      });

      triageCard.append(triageTitle, triageDesc, form);
      body.appendChild(triageCard);
    }

    pane.appendChild(body);
  }

  function renderTable(container, items) {
    container.innerHTML = '';
    const table = DataTable({
      columns: COLUMNS,
      rows: items,
      rowKey: (row) => row.reportId,
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
            span.className = 'citizen-id-cell';
            span.textContent = `#${row.reportId}`;
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
            const span = document.createElement('span');
            span.className = 'citizen-location-badge';
            span.title = `${row.latitude}, ${row.longitude}`;
            span.innerHTML = `${icons.mapPin(13)} GPS`;
            return span;
          }
          case 'contact': {
            const span = document.createElement('span');
            span.style.fontSize = 'var(--font-size-sm)';
            span.textContent = row.contactNumber || '—';
            return span;
          }
          case 'status': {
            const span = document.createElement('span');
            if (row.incidentId) {
              span.className = 'status-pill status-pill--success';
              span.textContent = `INC-${row.incidentId}`;
            } else {
              span.className = 'status-pill status-pill--pending';
              span.textContent = 'Pending';
            }
            return span;
          }
          case 'submitted': {
            const span = document.createElement('span');
            span.style.fontSize = 'var(--font-size-xs)';
            span.style.color = 'var(--color-text-secondary)';
            span.textContent = timeAgo(row.submittedAt);
            span.title = formatDateTime(row.submittedAt);
            return span;
          }
          case 'actions': {
            const button = document.createElement('button');
            button.type = 'button';
            button.className = 'ghost';
            button.style.padding = '0.25rem 0.5rem';
            button.style.fontSize = 'var(--font-size-xs)';
            button.textContent = row.reportId === selectedReportId ? 'Hide' : 'Inspect';
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

    // Tag table rows with dataset for fast DOM selection
    table.querySelectorAll('tbody tr').forEach((tr, index) => {
      const item = items[index];
      if (item) {
        tr.dataset.reportId = String(item.reportId);
        if (item.reportId === selectedReportId) {
          tr.classList.add('is-selected');
        }
      }
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

function renderEmpty(container, message) {
  container.innerHTML = '';
  const block = document.createElement('div');
  block.className = 'card state-block';
  block.style.margin = 'auto';
  block.innerHTML = `
    <h3>No Reports</h3>
    <p>${message}</p>
  `;
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
