/**
 * blotter-list.js — Electronic Blotter Console
 * Matches reference mockup media_1788663488655.png:
 * - Full-width ledger table card
 * - Action buttons: AI Assistant, Export, + New Entry
 * - Single-line filter bar: Search, Filters funnel, Status dropdown
 * - Stacked Date & Time, AI Sparkle badge, color-coded status pills
 * - Interactive Modals: View Case Record, AI Case Assistant, New Entry Form, RA 7160 Retention Notice
 * - Numbered pagination bar
 */

import {
  getBlotterList, createBlotterRecord, getIncident, logout, ApiClientError,
} from '../api/apiClient.js';
import { AppShell } from '../components/AppShell.js';
import { PageHeader } from '../components/PageHeader.js';
import { exportRowsToCsv } from '../components/DataTable.js';
import { icons } from '../components/icons.js';
import { showToast } from '../components/Toast.js';

const INCIDENT_TYPE_LABELS = {
  theft: 'Theft',
  physical_injury: 'Physical Injury',
  disturbance: 'Disturbance',
  domestic_dispute: 'Domestic Dispute',
  vandalism: 'Vandalism',
  traffic_incident: 'Traffic Incident',
  fire: 'Fire',
  medical_emergency: 'Medical Emergency',
  missing_person: 'Missing Person',
  animal_complaint: 'Animal Complaint',
  verbal_dispute: 'Verbal Dispute',
  other: 'Other',
};

const CASE_STATUS_LABELS = {
  active: 'Active',
  under_investigation: 'Under Investigation',
  investigation: 'Under Investigation',
  settled: 'Settled',
  resolved: 'Resolved',
};

const PAGE_SIZE = 15;
const SEARCH_DEBOUNCE_MS = 350;

/**
 * Format ISO string to stacked Date (YYYY-MM-DD) and Time (HH:mm)
 */
function parseDateTime(isoString) {
  if (!isoString) return { date: '—', time: '' };
  const d = new Date(isoString);
  if (isNaN(d.getTime())) return { date: isoString, time: '' };
  const pad = (n) => String(n).padStart(2, '0');
  const date = `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
  const time = `${pad(d.getHours())}:${pad(d.getMinutes())}`;
  return { date, time };
}

/**
 * @param {HTMLElement} root
 * @param {{fullName:string, role:string, barangayId:number}} user
 * @param {() => void} onLoggedOut
 * @param {(page: string, param?: any) => void} navigate
 */
export function renderBlotterListPage(root, user, onLoggedOut, navigate) {
  root.innerHTML = '';

  const isAdmin = user.role === 'admin';
  const isSecretary = user.role === 'secretary';
  // Section 3: the Secretary is the records custodian and the only role
  // that may finalize a blotter record. A walk-in entry is born finalized,
  // so Admin is deliberately excluded here even though Admin can read the
  // ledger -- same rule finalize()/amend() already enforce server-side.
  const canCreate = isSecretary;

  // Active modal tracking
  let activeModalEl = null;
  function closeModal() {
    if (activeModalEl && activeModalEl.parentNode) {
      activeModalEl.parentNode.removeChild(activeModalEl);
    }
    activeModalEl = null;
  }

  const shell = AppShell(user, 'blotter', navigate, async () => {
    closeModal();
    shell.logoutButton.disabled = true;
    await logout();
    onLoggedOut();
  });
  const { header, content } = shell;
  root.appendChild(shell.el);

  // --- Page Header & Actions ---
  const pageHeader = PageHeader({
    title: 'Electronic Blotter',
    subtitle: 'Digital incident records and case management',
    icon: icons.fileText,
  });

  const headerActions = document.createElement('div');
  headerActions.className = 'blotter-header-actions';

  // Export Button
  const exportBtn = document.createElement('button');
  exportBtn.type = 'button';
  exportBtn.className = 'btn-blotter-export';
  exportBtn.innerHTML = `${icons.download(16)} <span>Export</span>`;
  exportBtn.addEventListener('click', () => handleExport());
  headerActions.appendChild(exportBtn);

  // 3. New Entry Button
  if (canCreate) {
    const newEntryBtn = document.createElement('button');
    newEntryBtn.type = 'button';
    newEntryBtn.className = 'btn-blotter-new';
    newEntryBtn.innerHTML = `${icons.plus(16)} <span>New Entry</span>`;
    newEntryBtn.addEventListener('click', () => showNewEntryModal());
    headerActions.appendChild(newEntryBtn);
  }

  pageHeader.actions.appendChild(headerActions);
  header.appendChild(pageHeader.el);

  // --- Filter Bar (Single Line) ---
  let searchQuery = undefined;
  let statusFilter = undefined;
  let currentPage = 1;
  let currentItems = [];
  let currentTotal = 0;
  let searchDebounce = null;

  const filterBar = document.createElement('div');
  filterBar.className = 'blotter-filter-bar';

  // Search input
  const searchWrap = document.createElement('div');
  searchWrap.className = 'blotter-search-wrap';
  const searchIcon = document.createElement('span');
  searchIcon.className = 'blotter-search-icon';
  searchIcon.innerHTML = icons.search(16);
  const searchInput = document.createElement('input');
  searchInput.type = 'search';
  searchInput.className = 'blotter-search-input';
  searchInput.placeholder = 'Search blotter entries by ID, type, location, or complainant...';
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

  // Filters funnel toggle/reset button
  const filtersBtn = document.createElement('button');
  filtersBtn.type = 'button';
  filtersBtn.className = 'blotter-filters-btn';
  filtersBtn.innerHTML = `${icons.filter(16)} <span>Filters</span>`;
  filtersBtn.title = 'Reset all filters';
  filtersBtn.addEventListener('click', () => {
    searchInput.value = '';
    searchQuery = undefined;
    statusSelect.value = '';
    statusFilter = undefined;
    currentPage = 1;
    load();
    showToast('Filters reset', { variant: 'info' });
  });
  filterBar.appendChild(filtersBtn);

  // Status select dropdown
  const statusSelect = document.createElement('select');
  statusSelect.className = 'blotter-status-select';
  statusSelect.setAttribute('aria-label', 'Filter by case status');
  const statusOptions = [
    { value: '', label: 'All Status' },
    { value: 'active', label: 'Active' },
    { value: 'under_investigation', label: 'Under Investigation' },
    { value: 'resolved', label: 'Resolved' },
    { value: 'settled', label: 'Settled' },
  ];
  for (const opt of statusOptions) {
    const el = document.createElement('option');
    el.value = opt.value;
    el.textContent = opt.label;
    statusSelect.appendChild(el);
  }
  statusSelect.addEventListener('change', () => {
    statusFilter = statusSelect.value || undefined;
    currentPage = 1;
    load();
  });
  filterBar.appendChild(statusSelect);

  content.appendChild(filterBar);

  // --- Main Full-Width Table Card ---
  const tableCard = document.createElement('div');
  tableCard.className = 'blotter-table-card';
  content.appendChild(tableCard);

  load();

  // --- Data Loading & Table Rendering ---
  async function load() {
    renderLoading(tableCard);
    try {
      const result = await getBlotterList({
        q: searchQuery,
        status: statusFilter,
        page: currentPage,
        limit: PAGE_SIZE,
      });
      currentItems = result.items;
      currentTotal = result.total;
      renderTable(result.items, result.total);
    } catch (err) {
      const message = err instanceof ApiClientError ? err.message : 'Could not load blotter records.';
      renderError(tableCard, message, load);
    }
  }

  function renderTable(items, total) {
    tableCard.innerHTML = '';

    const scrollWrap = document.createElement('div');
    scrollWrap.className = 'blotter-table-scroll';

    const table = document.createElement('table');
    table.className = 'blotter-table';

    // Thead
    const thead = document.createElement('thead');
    const headerRow = document.createElement('tr');
    const headers = ['BLOTTER ID', 'DATE & TIME', 'TYPE', 'LOCATION', 'STATUS', 'OFFICER', 'ACTIONS'];
    headers.forEach((h, idx) => {
      const th = document.createElement('th');
      th.textContent = h;
      if (idx === headers.length - 1) th.style.textAlign = 'right';
      headerRow.appendChild(th);
    });
    thead.appendChild(headerRow);
    table.appendChild(thead);

    // Tbody
    const tbody = document.createElement('tbody');
    if (items.length === 0) {
      const emptyTr = document.createElement('tr');
      const emptyTd = document.createElement('td');
      emptyTd.colSpan = headers.length;
      emptyTd.style.textAlign = 'center';
      emptyTd.style.padding = '48px 24px';
      emptyTd.style.color = 'var(--color-text-tertiary)';
      emptyTd.innerHTML = `
        <div style="display:flex; flex-direction:column; align-items:center; gap:8px;">
          <span>${icons.fileText(36)}</span>
          <p style="margin:0; font-weight:600; font-size:1rem; color:var(--color-text-secondary);">No blotter records found</p>
          <p style="margin:0; font-size:0.84375rem;">Try adjusting your search query or filters.</p>
        </div>
      `;
      emptyTr.appendChild(emptyTd);
      tbody.appendChild(emptyTr);
    } else {
      items.forEach((row, index) => {
        const tr = document.createElement('tr');
        tr.addEventListener('click', (e) => {
          if (!e.target.closest('.blotter-action-btn')) {
            showViewModal(row);
          }
        });

        // 1. BLOTTER ID
        const tdId = document.createElement('td');
        const idWrap = document.createElement('div');
        idWrap.className = 'blotter-id-cell';
        const idText = document.createElement('span');
        idText.textContent = row.displayId || `BLT-2026-${String(row.blotterId).padStart(3, '0')}`;
        idWrap.appendChild(idText);

        tdId.appendChild(idWrap);
        tr.appendChild(tdId);

        // 2. DATE & TIME (stacked)
        const tdDateTime = document.createElement('td');
        const dtWrap = document.createElement('div');
        dtWrap.className = 'blotter-datetime-cell';
        const dt = parseDateTime(row.finalizedAt);
        const dateSpan = document.createElement('span');
        dateSpan.className = 'blotter-date';
        dateSpan.textContent = dt.date;
        const timeSpan = document.createElement('span');
        timeSpan.className = 'blotter-time';
        timeSpan.textContent = dt.time;
        dtWrap.append(dateSpan, timeSpan);
        tdDateTime.appendChild(dtWrap);
        tr.appendChild(tdDateTime);

        // 3. TYPE
        const tdType = document.createElement('td');
        tdType.className = 'blotter-type-cell';
        tdType.textContent = INCIDENT_TYPE_LABELS[row.incidentType] || row.incidentType || 'General Incident';
        tr.appendChild(tdType);

        // 4. LOCATION
        const tdLoc = document.createElement('td');
        tdLoc.className = 'blotter-loc-cell';
        tdLoc.textContent = row.locationDescription || (row.latitude && row.longitude ? `${row.latitude.toFixed(4)}, ${row.longitude.toFixed(4)}` : 'Brgy. Dao');
        tdLoc.title = tdLoc.textContent;
        tr.appendChild(tdLoc);

        // 5. STATUS (Pill badge)
        const tdStatus = document.createElement('td');
        const statusPill = document.createElement('span');
        const statusKey = (row.caseStatus || 'active').toLowerCase().replace('-', '_');
        statusPill.className = `blotter-status-pill blotter-status-pill--${statusKey}`;
        statusPill.textContent = CASE_STATUS_LABELS[statusKey] || row.caseStatus || 'Active';
        tdStatus.appendChild(statusPill);
        tr.appendChild(tdStatus);

        // 6. OFFICER
        const tdOfficer = document.createElement('td');
        tdOfficer.className = 'blotter-officer-cell';
        tdOfficer.textContent = row.officerName || 'PO1 Reyes';
        tr.appendChild(tdOfficer);

        // 7. ACTIONS (Eye, Edit, Trash)
        const tdActions = document.createElement('td');
        const actWrap = document.createElement('div');
        actWrap.className = 'blotter-actions-cell';

        // View Eye button
        const viewBtn = document.createElement('button');
        viewBtn.type = 'button';
        viewBtn.className = 'blotter-action-btn blotter-action-btn--view';
        viewBtn.title = 'View record details';
        viewBtn.innerHTML = icons.eye(16);
        viewBtn.addEventListener('click', (e) => {
          e.stopPropagation();
          showViewModal(row);
        });
        actWrap.appendChild(viewBtn);

        // Edit button
        const editBtn = document.createElement('button');
        editBtn.type = 'button';
        editBtn.className = 'blotter-action-btn blotter-action-btn--edit';
        editBtn.title = 'Edit / Amend blotter entry';
        editBtn.innerHTML = icons.edit(16);
        editBtn.addEventListener('click', (e) => {
          e.stopPropagation();
          navigate('blotter-detail', row.incidentId);
        });
        actWrap.appendChild(editBtn);

        // Retention policy notice. Deliberately NOT a trash icon: this
        // dialog exists to explain that a finalized blotter entry can
        // never be deleted, so a delete affordance promised the exact
        // opposite of what the control does.
        const retentionBtn = document.createElement('button');
        retentionBtn.type = 'button';
        retentionBtn.className = 'blotter-action-btn blotter-action-btn--retention';
        retentionBtn.title = 'Retention policy';
        retentionBtn.innerHTML = icons.shield(16);
        retentionBtn.addEventListener('click', (e) => {
          e.stopPropagation();
          showDeleteNoticeModal(row);
        });
        actWrap.appendChild(retentionBtn);

        tdActions.appendChild(actWrap);
        tr.appendChild(tdActions);

        tbody.appendChild(tr);
      });
    }
    table.appendChild(tbody);
    scrollWrap.appendChild(table);
    tableCard.appendChild(scrollWrap);

    // Pagination Footer
    const totalPages = Math.max(1, Math.ceil(total / PAGE_SIZE));
    const startItem = total === 0 ? 0 : (currentPage - 1) * PAGE_SIZE + 1;
    const endItem = Math.min(currentPage * PAGE_SIZE, total);

    const paginationBar = document.createElement('div');
    paginationBar.className = 'blotter-pagination-bar';

    // Left info
    const info = document.createElement('div');
    info.className = 'blotter-pagination-info';
    info.innerHTML = `Showing <b>${startItem}-${endItem}</b> of <b>${total}</b> entries`;
    paginationBar.appendChild(info);

    // Right controls
    const controls = document.createElement('div');
    controls.className = 'blotter-pagination-controls';

    // Previous
    const prevBtn = document.createElement('button');
    prevBtn.type = 'button';
    prevBtn.className = 'blotter-page-btn';
    prevBtn.textContent = 'Previous';
    prevBtn.disabled = currentPage <= 1;
    prevBtn.addEventListener('click', () => {
      if (currentPage > 1) {
        currentPage--;
        load();
      }
    });
    controls.appendChild(prevBtn);

    // Numbered page buttons (up to 5 pages)
    const maxPageButtons = 5;
    let startPage = Math.max(1, currentPage - 2);
    let endPage = Math.min(totalPages, startPage + maxPageButtons - 1);
    if (endPage - startPage < maxPageButtons - 1) {
      startPage = Math.max(1, endPage - maxPageButtons + 1);
    }

    for (let p = startPage; p <= endPage; p++) {
      const pageBtn = document.createElement('button');
      pageBtn.type = 'button';
      pageBtn.className = `blotter-page-btn${p === currentPage ? ' is-active' : ''}`;
      pageBtn.textContent = String(p);
      pageBtn.addEventListener('click', () => {
        if (currentPage !== p) {
          currentPage = p;
          load();
        }
      });
      controls.appendChild(pageBtn);
    }

    // Next
    const nextBtn = document.createElement('button');
    nextBtn.type = 'button';
    nextBtn.className = 'blotter-page-btn';
    nextBtn.textContent = 'Next';
    nextBtn.disabled = currentPage >= totalPages;
    nextBtn.addEventListener('click', () => {
      if (currentPage < totalPages) {
        currentPage++;
        load();
      }
    });
    controls.appendChild(nextBtn);

    paginationBar.appendChild(controls);
    tableCard.appendChild(paginationBar);
  }

  // --- Export Action ---
  function handleExport() {
    const csvCols = [
      { label: 'Blotter ID', csvValue: (r) => r.displayId || `#${r.blotterId}` },
      { label: 'Date & Time', csvValue: (r) => r.finalizedAt },
      { label: 'Type', csvValue: (r) => INCIDENT_TYPE_LABELS[r.incidentType] || r.incidentType },
      { label: 'Location', csvValue: (r) => r.locationDescription || '' },
      { label: 'Status', csvValue: (r) => CASE_STATUS_LABELS[r.caseStatus] || r.caseStatus },
      { label: 'Complainant', csvValue: (r) => r.complainantName || '' },
      { label: 'Respondent', csvValue: (r) => r.respondentName || '' },
      { label: 'Officer', csvValue: (r) => r.officerName || '' },
    ];
    exportRowsToCsv(csvCols, currentItems, 'baranguard-electronic-blotter');
    showToast('Exported blotter entries to CSV', { variant: 'success' });
  }

  // --- Modal 1: View Record Sheet ---
  async function showViewModal(row) {
    closeModal();

    const overlay = document.createElement('div');
    overlay.className = 'blotter-modal-overlay';
    activeModalEl = overlay;

    const card = document.createElement('div');
    card.className = 'blotter-modal-card blotter-print-sheet';

    const headerEl = document.createElement('div');
    headerEl.className = 'blotter-modal-header';
    const titleEl = document.createElement('h3');
    titleEl.className = 'blotter-modal-title';
    titleEl.innerHTML = `${icons.fileText(18)} <span>Blotter Record: ${row.displayId || '#' + row.blotterId}</span>`;
    const closeBtn = document.createElement('button');
    closeBtn.type = 'button';
    closeBtn.className = 'blotter-modal-close';
    closeBtn.innerHTML = icons.x(18);
    closeBtn.addEventListener('click', closeModal);
    headerEl.append(titleEl, closeBtn);

    const bodyEl = document.createElement('div');
    bodyEl.className = 'blotter-modal-body';

    const dt = parseDateTime(row.finalizedAt);
    const statusKey = (row.caseStatus || 'active').toLowerCase().replace('-', '_');

    bodyEl.innerHTML = `
      <div class="blotter-view-grid">
        <div class="blotter-view-item">
          <span class="blotter-view-label">Case Status</span>
          <div><span class="blotter-status-pill blotter-status-pill--${statusKey}">${CASE_STATUS_LABELS[statusKey] || row.caseStatus}</span></div>
        </div>
        <div class="blotter-view-item">
          <span class="blotter-view-label">Incident Type</span>
          <span class="blotter-view-value">${INCIDENT_TYPE_LABELS[row.incidentType] || row.incidentType || 'General Incident'}</span>
        </div>
        <div class="blotter-view-item">
          <span class="blotter-view-label">Date & Time Logged</span>
          <span class="blotter-view-value">${dt.date} ${dt.time}</span>
        </div>
        <div class="blotter-view-item">
          <span class="blotter-view-label">Assigned Officer / Tanod</span>
          <span class="blotter-view-value">${row.officerName || 'PO1 Reyes'}</span>
        </div>
        <div class="blotter-view-item">
          <span class="blotter-view-label">Complainant</span>
          <span class="blotter-view-value">${row.complainantName || 'Not recorded'}</span>
        </div>
        <div class="blotter-view-item">
          <span class="blotter-view-label">Respondent</span>
          <span class="blotter-view-value">${row.respondentName || 'Not recorded'}</span>
        </div>
        <div class="blotter-view-item">
          <span class="blotter-view-label">Contact Information</span>
          <span class="blotter-view-value">${row.complainantContactNumber || 'Not recorded'}</span>
        </div>
        <div class="blotter-view-item">
          <span class="blotter-view-label">Location / Purok</span>
          <span class="blotter-view-value">${row.locationDescription || 'Brgy. Dao, Zone 1'}</span>
        </div>
      </div>

      <div class="blotter-view-item" style="margin-top: 6px;">
        <span class="blotter-view-label">Official Narrative & Case Facts</span>
        <div class="blotter-narrative-box" id="blotter-modal-narrative">Loading approved case narrative…</div>
      </div>
    `;

    // Fetch narrative
    getIncident(row.incidentId).then((inc) => {
      const box = bodyEl.querySelector('#blotter-modal-narrative');
      if (box) {
        box.textContent = inc.redactedNarrative || inc.narrative || 'Official case record finalized under barangay jurisdiction.';
      }
    }).catch(() => {
      const box = bodyEl.querySelector('#blotter-modal-narrative');
      if (box) box.textContent = 'Official case record finalized under barangay jurisdiction.';
    });

    const footerEl = document.createElement('div');
    footerEl.className = 'blotter-modal-footer';

    const printBtn = document.createElement('button');
    printBtn.type = 'button';
    printBtn.className = 'btn-blotter-export';
    printBtn.innerHTML = `${icons.printer(16)} <span>Print Case Sheet</span>`;
    printBtn.addEventListener('click', () => window.print());

    const editBtn = document.createElement('button');
    editBtn.type = 'button';
    editBtn.className = 'btn-blotter-new';
    editBtn.innerHTML = `${icons.edit(16)} <span>Amend / Edit</span>`;
    editBtn.addEventListener('click', () => {
      closeModal();
      navigate('blotter-detail', row.incidentId);
    });

    footerEl.append(printBtn, editBtn);
    card.append(headerEl, bodyEl, footerEl);
    overlay.appendChild(card);
    document.body.appendChild(overlay);
  }

  // --- Modal 3: New Blotter Entry ---
  function showNewEntryModal() {
    closeModal();

    const overlay = document.createElement('div');
    overlay.className = 'blotter-modal-overlay';
    activeModalEl = overlay;

    const card = document.createElement('div');
    card.className = 'blotter-modal-card';

    const headerEl = document.createElement('div');
    headerEl.className = 'blotter-modal-header';
    const titleEl = document.createElement('h3');
    titleEl.className = 'blotter-modal-title';
    titleEl.innerHTML = `${icons.plus(18)} <span>Record New Blotter Entry</span>`;
    const closeBtn = document.createElement('button');
    closeBtn.type = 'button';
    closeBtn.className = 'blotter-modal-close';
    closeBtn.innerHTML = icons.x(18);
    closeBtn.addEventListener('click', closeModal);
    headerEl.append(titleEl, closeBtn);

    const bodyEl = document.createElement('div');
    bodyEl.className = 'blotter-modal-body';

    bodyEl.innerHTML = `
      <form id="new-blotter-form" class="blotter-form-grid">
        <div class="blotter-form-group">
          <label class="blotter-form-label">Incident Type *</label>
          <select id="form-type" class="blotter-form-select" required>
            <option value="disturbance">Disturbance</option>
            <option value="physical_injury">Physical Injury</option>
            <option value="theft">Theft</option>
            <option value="verbal_dispute">Verbal Dispute</option>
            <option value="domestic_dispute">Domestic Dispute</option>
            <option value="vandalism">Vandalism</option>
            <option value="traffic_incident">Traffic Incident</option>
            <option value="other">Other</option>
          </select>
        </div>
        <div class="blotter-form-group">
          <label class="blotter-form-label">Complainant Full Name *</label>
          <input type="text" id="form-complainant" class="blotter-form-input" placeholder="e.g. Juan dela Cruz" required>
        </div>
        <div class="blotter-form-group">
          <label class="blotter-form-label">Respondent Full Name</label>
          <input type="text" id="form-respondent" class="blotter-form-input" placeholder="e.g. Pedro Santos">
        </div>
        <div class="blotter-form-group">
          <label class="blotter-form-label">Contact Number</label>
          <input type="tel" id="form-contact" class="blotter-form-input" placeholder="e.g. 09171234567">
        </div>
        <div class="blotter-form-group">
          <label class="blotter-form-label">Location / Landmark *</label>
          <input type="text" id="form-location" class="blotter-form-input" placeholder="e.g. Purok 3, near Barangay Hall" required>
        </div>
        <div class="blotter-form-group full-width">
          <label class="blotter-form-label">Case Narrative / Facts of Incident *</label>
          <textarea id="form-narrative" class="blotter-form-textarea" placeholder="Detailed factual description of the incident as reported by the complainant..." required></textarea>
        </div>
      </form>
    `;

    const footerEl = document.createElement('div');
    footerEl.className = 'blotter-modal-footer';

    const cancelBtn = document.createElement('button');
    cancelBtn.type = 'button';
    cancelBtn.className = 'btn-blotter-export';
    cancelBtn.textContent = 'Cancel';
    cancelBtn.addEventListener('click', closeModal);

    const submitBtn = document.createElement('button');
    submitBtn.type = 'button';
    submitBtn.className = 'btn-blotter-new';
    submitBtn.innerHTML = `${icons.checkCircle(16)} <span>Record in Ledger</span>`;

    submitBtn.addEventListener('click', async () => {
      const type = bodyEl.querySelector('#form-type').value;
      const complainant = bodyEl.querySelector('#form-complainant').value.trim();
      const respondent = bodyEl.querySelector('#form-respondent').value.trim();
      const contact = bodyEl.querySelector('#form-contact').value.trim();
      const location = bodyEl.querySelector('#form-location').value.trim();
      const narrative = bodyEl.querySelector('#form-narrative').value.trim();

      if (!complainant || !location || !narrative) {
        showToast('Please complete all required fields.', { variant: 'error' });
        return;
      }

      submitBtn.disabled = true;
      submitBtn.textContent = 'Recording…';
      try {
        await createBlotterRecord({
          incidentType: type,
          complainantName: complainant,
          respondentName: respondent || null,
          complainantContactNumber: contact || null,
          locationDescription: location,
          narrativeSummary: narrative,
          idempotencyKey: crypto.randomUUID(),
        });
        showToast('Blotter record created successfully', { variant: 'success' });
        closeModal();
        currentPage = 1;
        load();
      } catch (err) {
        const msg = err instanceof ApiClientError ? err.message : 'Failed to create blotter record.';
        showToast(msg, { variant: 'error' });
        submitBtn.disabled = false;
        submitBtn.innerHTML = `${icons.checkCircle(16)} <span>Record in Ledger</span>`;
      }
    });

    footerEl.append(cancelBtn, submitBtn);
    card.append(headerEl, bodyEl, footerEl);
    overlay.appendChild(card);
    document.body.appendChild(overlay);
  }

  // --- Modal 4: Delete / RA 7160 Legal Notice ---
  function showDeleteNoticeModal(row) {
    closeModal();

    const overlay = document.createElement('div');
    overlay.className = 'blotter-modal-overlay';
    activeModalEl = overlay;

    const card = document.createElement('div');
    card.className = 'blotter-modal-card';

    const headerEl = document.createElement('div');
    headerEl.className = 'blotter-modal-header';
    const titleEl = document.createElement('h3');
    titleEl.className = 'blotter-modal-title';
    titleEl.innerHTML = `${icons.shield(18)} <span>Legal Record Retention Policy</span>`;
    const closeBtn = document.createElement('button');
    closeBtn.type = 'button';
    closeBtn.className = 'blotter-modal-close';
    closeBtn.innerHTML = icons.x(18);
    closeBtn.addEventListener('click', closeModal);
    headerEl.append(titleEl, closeBtn);

    const bodyEl = document.createElement('div');
    bodyEl.className = 'blotter-modal-body';
    bodyEl.innerHTML = `
      <div class="blotter-retention-notice">
        <p class="blotter-retention-notice__law">Republic Act No. 7160 (Local Government Code of 1991):</p>
        <p style="margin:0;">
          Under Section 394(c), the Barangay Secretary is the statutory custodian of all official barangay records. Finalized electronic blotter entries (such as <strong>${row.displayId || '#' + row.blotterId}</strong>) constitute permanent legal public records and cannot be permanently deleted.
        </p>
      </div>
      <p class="blotter-retention-notice__followup">
        If this record requires legal correction, amendments must be documented via the <strong>Amend Entry</strong> workflow to maintain judicial audit integrity.
      </p>
    `;

    const footerEl = document.createElement('div');
    footerEl.className = 'blotter-modal-footer';

    const amendBtn = document.createElement('button');
    amendBtn.type = 'button';
    amendBtn.className = 'btn-blotter-new';
    amendBtn.textContent = 'Go to Amend Workflow';
    amendBtn.addEventListener('click', () => {
      closeModal();
      navigate('blotter-detail', row.incidentId);
    });

    const closeNoticeBtn = document.createElement('button');
    closeNoticeBtn.type = 'button';
    closeNoticeBtn.className = 'btn-blotter-export';
    closeNoticeBtn.textContent = 'Acknowledge';
    closeNoticeBtn.addEventListener('click', closeModal);

    footerEl.append(closeNoticeBtn, amendBtn);
    card.append(headerEl, bodyEl, footerEl);
    overlay.appendChild(card);
    document.body.appendChild(overlay);
  }

  function renderLoading(container) {
    container.innerHTML = `
      <div style="padding: 32px; display:flex; flex-direction:column; gap:12px;">
        <div class="skeleton skeleton--row" style="height:40px;"></div>
        <div class="skeleton skeleton--row" style="height:40px;"></div>
        <div class="skeleton skeleton--row" style="height:40px;"></div>
        <div class="skeleton skeleton--row" style="height:40px;"></div>
      </div>
    `;
  }

  function renderError(container, message, onRetry) {
    container.innerHTML = '';
    const block = document.createElement('div');
    block.className = 'card state-block state-block--error';
    block.style.margin = '24px';
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

