/**
 * school-zones.js — Safer School Zones (DILG MC 2026-037), contract §7 /
 * §10. Three tabs, each with a printable form that mirrors the barangay's
 * own file:
 *
 *   Schools      Annex B inventory. Admin/Secretary add, edit, deactivate
 *                (no delete — contract §7); Punong Barangay reads.
 *   Incidents    Annex C-1 view: incidents linked to a school, with the
 *                short NON-identifying C-1 summary / action / status notes
 *                and the offices each was referred to (from
 *                GET /incidents/:id/referrals). The C-1 columns are kept
 *                separate from `raw_narrative` on purpose — no student or
 *                victim names appear anywhere here.
 *   Term Report  Annex D: live counts for a term range, then draft ->
 *                prepared -> submitted. The report is printed and signed on
 *                paper outside the app; the app only prints it (blank
 *                signature lines) and records receipt on submission. No
 *                deadline is hardcoded anywhere; the form text defers to
 *                the circular exactly as the user's file does.
 *
 * Authority gating is UX only (REFERENCE.md §2 Rule 2); the server
 * re-checks. The preparer-must-differ rule surfaces as a plain message on
 * a 409. `param`: `{tab?: 'schools'|'incidents'|'term', reportId?}`.
 *
 * Data limits stated honestly in the UI: the Incidents tab filters school-
 * linked incidents client-side (the contract defines no server filter) and
 * says so when its page cap is hit.
 */

import { DataTable } from '../components/DataTable.js';
import { StatStrip } from '../components/StatStrip.js';
import { Menu } from '../components/Menu.js';
import { showToast } from '../components/Toast.js';
import { confirmDialog } from '../components/ConfirmDialog.js';
import { manilaDateKey } from '../utils/manilaTime.js';
import { openPrintPreviewModal } from '../components/PrintPreviewModal.js';
import { icons } from '../components/icons.js';
import {
  getSchools, createSchool, updateSchool, getSchoolIncidents, getIncidentReferrals,
  getSchoolTermLive, getTermReports, getTermReport, createTermReport, updateTermReport,
  prepareTermReport, markTermReportSubmitted,
  REFERRED_TO_LABELS, SCHOOL_LEVEL_LABELS, SCHOOL_TYPE_LABELS, TERM_STATUS_LABELS,
} from '../services/tanodWorkflowApi.js';
import {
  h, escapeHtml, mountPageFrame, buildTabBar, showLoading, showError, showEmpty, card, field,
  selectOf, statusPill, formatDateOnly, formatManilaDateTime, actionErrorMessage,
  loadLetterhead, letterheadHtml, applyPrintOrientation, SSZ_PURSUANT_HTML,
  signatureBlockHtml, printedByLabel,
  formatSchoolCode, formatAnnexDCode, formatIncidentCode,
} from '../services/tanodWorkflowUi.js';

const TABS = [
  { id: 'schools', label: 'Schools (Annex B)' },
  { id: 'incidents', label: 'Incidents (Annex C-1)' },
  { id: 'term', label: 'Term Report (Annex D)' },
];
const INCIDENT_PAGE_SIZE = 25;
const PRINT_INCIDENT_CAP = 200;
const REFERRAL_UNAVAILABLE = 'Referral data could not be loaded - do not file this copy';
const BARANGAY_LEVEL_DESTINATIONS = new Set(['barangay_official', 'vaw_desk']);

const COUNT_TILES = [
  ['totalTanods', 'Tanods'],
  ['totalSchools', 'Schools covered'],
  ['totalDeploymentDays', 'Days with tanod deployment'],
  ['totalIncidents', 'Incidents logged'],
  ['incidentsBarangayOnly', 'Acted on by Barangay, no referral'],
  ['incidentsPnp', 'Referred to PNP'],
  ['incidentsBfp', 'Referred to BFP'],
  ['incidentsHigherLgu', 'Referred to Higher LGU'],
  ['incidentsDoh', 'Referred to DOH'],
  ['incidentsDpwh', 'Referred to DPWH'],
  ['incidentsOtherAgencies', 'Referred to other agencies'],
];

function normalizeParam(param) {
  if (param && typeof param === 'object') return param;
  return {};
}

function manilaDateOf(value) {
  return manilaDateKey(value) || '';
}

/**
 * loadLetterhead() falls back to "#<id>" with a blank municipality and
 * province when GET /barangays fails. A printed form must never go out that
 * way, so the sheet carries a loud warning instead of a half-filled header.
 */
function letterheadUsable(lh) {
  return Boolean(lh && lh.barangayName && !String(lh.barangayName).startsWith('#') && lh.municipality && lh.province);
}

const LETTERHEAD_WARNING_HTML = `
  <div class="tw-print__warning" role="alert">
    <b>LETTERHEAD NOT LOADED.</b> The barangay, municipality and province could not be loaded from the system.
    Do not file this copy. Reload the page and print again.
  </div>`;

function safeLetterheadHtml(lh, opts) {
  return letterheadUsable(lh) ? letterheadHtml(lh, opts) : LETTERHEAD_WARNING_HTML;
}

function warnIfLetterheadMissing(lh) {
  if (!letterheadUsable(lh)) {
    showToast('The barangay letterhead could not be loaded. The preview carries a warning; do not file this copy.', { variant: 'warning' });
  }
}

/**
 * @param {HTMLElement} root
 * @param {{userId:number, fullName:string, role:string, barangayId:number}} user
 * @param {() => void} onLoggedOut
 * @param {(page:string, param?:any) => void} navigate
 * @param {{tab?:string, reportId?:number}} [param]
 */
export function renderSchoolZonesPage(root, user, onLoggedOut, navigate, param) {
  const initial = normalizeParam(param);
  const canEdit = user.role === 'admin' || user.role === 'secretary';
  const canViewGis = user.role === 'admin' || user.role === 'punong_barangay';

  const { shell, pageHeader, container } = mountPageFrame({
    root, user, onLoggedOut, navigate,
    activeKey: 'school-zones',
    title: 'Safer School Zones',
    subtitle: 'School inventory, incident reports and the term report (DILG MC 2026-037)',
    icon: icons.shield,
  });

  const body = h('div', 'tw-ssz');
  container.appendChild(body);

  let activeTab = TABS.some((t) => t.id === initial.tab) ? initial.tab : 'schools';
  let pendingReportId = initial.reportId ?? null;

  const tabBar = buildTabBar(TABS, (id) => { pendingReportId = null; setTab(id); });
  shell.header.appendChild(tabBar.el);

  // Shared school list (used by all three tabs); reloaded after any edit.
  let schoolsPromise = null;
  const loadSchools = (force = false) => {
    if (force || !schoolsPromise) {
      const pending = getSchools();
      schoolsPromise = pending;
      // A failed lookup must not stay cached, or Retry would replay the failure.
      pending.catch(() => { if (schoolsPromise === pending) schoolsPromise = null; });
    }
    return schoolsPromise;
  };

  function setTab(id) {
    activeTab = id;
    tabBar.setActive(id);
    pageHeader.actions.innerHTML = '';
    body.innerHTML = '';
    if (id === 'schools') renderSchoolsTab(body);
    else if (id === 'incidents') renderIncidentsTab(body);
    else renderTermTab(body);
  }

  // =========================================================================
  // Schools tab (Annex B)
  // =========================================================================

  function renderSchoolsTab(host) {
    let schools = [];
    let filterStatus = 'active'; // 'active' | 'deactivated' | 'all'
    let searchQuery = '';

    // Consolidated Top Control Bar: Segmented Status Tabs + Search Box
    const controlBar = h('div', 'ssz-control-bar');

    const tabsWrap = h('div', 'ssz-segmented-tabs filter-chips');
    tabsWrap.setAttribute('role', 'tablist');
    tabsWrap.setAttribute('aria-label', 'Filter schools by status');

    const chipActive = h('button', 'filter-chip ssz-tab-btn is-active');
    chipActive.type = 'button';
    chipActive.setAttribute('role', 'tab');
    chipActive.setAttribute('aria-selected', 'true');
    chipActive.innerHTML = `<span>Active</span><span class="ssz-tab-count">0</span>`;

    const chipDeactivated = h('button', 'filter-chip ssz-tab-btn');
    chipDeactivated.type = 'button';
    chipDeactivated.setAttribute('role', 'tab');
    chipDeactivated.setAttribute('aria-selected', 'false');
    chipDeactivated.innerHTML = `<span>Deactivated</span><span class="ssz-tab-count">0</span>`;

    const chipAll = h('button', 'filter-chip ssz-tab-btn');
    chipAll.type = 'button';
    chipAll.setAttribute('role', 'tab');
    chipAll.setAttribute('aria-selected', 'false');
    chipAll.innerHTML = `<span>All</span><span class="ssz-tab-count">0</span>`;

    const setFilterStatus = (status) => {
      filterStatus = status;
      chipActive.classList.toggle('is-active', status === 'active');
      chipActive.setAttribute('aria-selected', String(status === 'active'));
      chipDeactivated.classList.toggle('is-active', status === 'deactivated');
      chipDeactivated.setAttribute('aria-selected', String(status === 'deactivated'));
      chipAll.classList.toggle('is-active', status === 'all');
      chipAll.setAttribute('aria-selected', String(status === 'all'));
      renderFilteredView();
    };

    chipActive.addEventListener('click', () => setFilterStatus('active'));
    chipDeactivated.addEventListener('click', () => setFilterStatus('deactivated'));
    chipAll.addEventListener('click', () => setFilterStatus('all'));
    tabsWrap.append(chipActive, chipDeactivated, chipAll);

    // Search Box
    const searchBox = h('div', 'ssz-search-box');
    const searchIcon = h('span', 'ssz-search-icon');
    searchIcon.setAttribute('aria-hidden', 'true');
    searchIcon.innerHTML = icons.search(16);

    const searchInput = document.createElement('input');
    searchInput.type = 'search';
    searchInput.className = 'ssz-search-input';
    searchInput.placeholder = 'Search school name, address, focal person...';
    searchInput.setAttribute('aria-label', 'Search schools inventory');

    const clearSearchBtn = h('button', 'ssz-search-clear');
    clearSearchBtn.type = 'button';
    clearSearchBtn.setAttribute('aria-label', 'Clear search query');
    clearSearchBtn.innerHTML = icons.x(14);
    clearSearchBtn.hidden = true;

    clearSearchBtn.addEventListener('click', () => {
      searchInput.value = '';
      searchQuery = '';
      clearSearchBtn.hidden = true;
      searchInput.focus();
      renderFilteredView();
    });

    let searchTimer = null;
    searchInput.addEventListener('input', () => {
      searchQuery = searchInput.value.trim();
      clearSearchBtn.hidden = !searchQuery;
      if (searchTimer) clearTimeout(searchTimer);
      searchTimer = setTimeout(() => {
        renderFilteredView();
      }, 120);
    });

    searchBox.append(searchIcon, searchInput, clearSearchBtn);
    controlBar.append(tabsWrap, searchBox);

    // Print & Add School in pageHeader.actions
    const printBtn = h('button', 'ghost');
    printBtn.type = 'button';
    printBtn.innerHTML = `${icons.printer(16)}<span>Preview &amp; print Annex B</span>`;
    printBtn.addEventListener('click', async () => {
      const active = schools.filter((s) => s.isActive !== false && s.isActive !== 0);
      if (active.length === 0) { showToast('There are no active schools to print.', { variant: 'info' }); return; }
      const lh = await loadLetterhead(user);
      warnIfLetterheadMissing(lh);
      const preview = openPrintPreviewModal({
        title: 'Annex B — Safer School Zones Inventory',
        subtitle: `${active.length} active school${active.length === 1 ? '' : 's'}`,
        sheetId: 'printable-annex-b',
        sheetHtml: buildAnnexBHtml(active, lh),
        printedBy: printedByLabel(user),
        orientation: 'landscape',
      });
      applyPrintOrientation(preview, 'landscape');
    });
    pageHeader.actions.appendChild(printBtn);

    if (canEdit) {
      const addBtn = h('button', 'primary');
      addBtn.type = 'button';
      addBtn.innerHTML = `${icons.plus(16)}<span>Add school</span>`;
      addBtn.addEventListener('click', () => openForm(null));
      pageHeader.actions.appendChild(addBtn);
    }

    const formHost = h('div');
    formHost.hidden = true;
    const tableHost = h('div', 'ssz-table-body');
    const tableCard = h('div', 'unified-table-card ssz-table-card');
    tableCard.append(controlBar, tableHost);
    host.append(formHost, tableCard);

    function updateCounts() {
      const activeCount = schools.filter((s) => s.isActive !== false && s.isActive !== 0).length;
      const inactiveCount = schools.length - activeCount;
      const activeSlot = chipActive.querySelector('.ssz-tab-count');
      if (activeSlot) activeSlot.textContent = String(activeCount);
      const inactiveSlot = chipDeactivated.querySelector('.ssz-tab-count');
      if (inactiveSlot) inactiveSlot.textContent = String(inactiveCount);
      const allSlot = chipAll.querySelector('.ssz-tab-count');
      if (allSlot) allSlot.textContent = String(schools.length);
    }

    function openForm(school) {
      formHost.innerHTML = '';
      formHost.hidden = false;
      formHost.appendChild(buildSchoolForm(school, async () => {
        formHost.innerHTML = '';
        formHost.hidden = true;
        await load(true);
      }, () => {
        formHost.innerHTML = '';
        formHost.hidden = true;
      }));
      formHost.scrollIntoView?.({ block: 'nearest' });
    }

    async function load(force = false) {
      showLoading(tableHost, 'Loading schools');
      try {
        const res = await loadSchools(force);
        schools = res.items;
        updateCounts();
        renderFilteredView();
      } catch (err) {
        showError(tableHost, err, () => load(true), 'Could not load the school list.');
      }
    }

    function getFilteredRows() {
      return schools.filter((s) => {
        const isActive = s.isActive !== false && s.isActive !== 0;
        if (filterStatus === 'active' && !isActive) return false;
        if (filterStatus === 'deactivated' && isActive) return false;

        if (searchQuery) {
          const q = searchQuery.toLowerCase();
          const matchCode = formatSchoolCode(s.schoolId).toLowerCase().includes(q);
          const matchName = (s.name || '').toLowerCase().includes(q);
          const matchAddress = (s.address || '').toLowerCase().includes(q);
          const matchFocal = (s.focalPerson || '').toLowerCase().includes(q);
          const matchContact = (s.focalContact || '').toLowerCase().includes(q);
          const matchRemarks = (s.remarks || '').toLowerCase().includes(q);
          if (!matchCode && !matchName && !matchAddress && !matchFocal && !matchContact && !matchRemarks) {
            return false;
          }
        }
        return true;
      });
    }

    function renderFilteredView() {
      tableHost.innerHTML = '';
      updateCounts();

      if (schools.length === 0) {
        showEmpty(
          tableHost,
          'No schools yet',
          canEdit ? 'Add the schools in this barangay to build the Annex B inventory.' : 'No schools have been added to the inventory yet.',
        );
        return;
      }

      const rows = getFilteredRows();

      if (rows.length === 0) {
        const emptyWrap = h('div', 'tw-notice');
        emptyWrap.style.margin = 'var(--spacing-md)';
        emptyWrap.innerHTML = `
          <p class="tw-strong">No schools match your search.</p>
          <p class="tw-muted">Try adjusting your keywords or switching status tabs.</p>
        `;
        const resetBtn = h('button', 'primary', 'Clear search');
        resetBtn.type = 'button';
        resetBtn.style.marginTop = 'var(--spacing-sm)';
        resetBtn.addEventListener('click', () => {
          searchInput.value = '';
          searchQuery = '';
          clearSearchBtn.hidden = true;
          setFilterStatus('active');
        });
        emptyWrap.appendChild(resetBtn);
        tableHost.appendChild(emptyWrap);
        return;
      }

      const columns = [
        { key: 'name', label: 'School & Classification' },
        { key: 'address', label: 'Location & Remarks' },
        { key: 'focal', label: 'SSZ Focal Person & Contact' },
      ];
      if (filterStatus === 'all') {
        columns.push({ key: 'status', label: 'Status' });
      }
      if (canEdit || canViewGis) {
        columns.push({ key: 'actions', label: 'Actions', align: 'right' });
      }

      tableHost.appendChild(DataTable({
        columns,
        rows,
        rowKey: (s) => s.schoolId,
        caption: 'Schools Inventory (Annex B)',
        emptyMessage: 'No matching schools found.',
        emptyIcon: icons.shield,
        renderCell: (s, key) => {
          switch (key) {
            case 'name': {
              const cell = h('div', 'ssz-school-cell');
              const nameEl = h('div', 'ssz-school-name', s.name);
              const metaEl = h('div', 'ssz-school-meta');
              const codeBadge = h('span', 'c1-inc-code-pill', formatSchoolCode(s.schoolId));
              const isPriv = s.schoolType === 'private';
              const typeBadge = h('span', `tw-school-badge tw-school-badge--${isPriv ? 'private' : 'public'}`, SCHOOL_TYPE_LABELS[s.schoolType] || s.schoolType || 'Public');
              const levelBadge = h('span', 'ssz-level-tag', SCHOOL_LEVEL_LABELS[s.level] || s.level || '—');
              metaEl.append(codeBadge, typeBadge, levelBadge);
              cell.append(nameEl, metaEl);
              return cell;
            }
            case 'address': {
              const cell = h('div', 'ssz-address-cell');
              const addrLine = h('div', 'ssz-address-line');
              addrLine.innerHTML = `<span class="ssz-cell-icon" aria-hidden="true">${icons.mapPin(14)}</span><span>${escapeHtml(s.address || '—')}</span>`;
              cell.appendChild(addrLine);
              if (s.remarks) {
                const remarksEl = h('div', 'ssz-remarks-note');
                remarksEl.innerHTML = `<span class="ssz-cell-icon" aria-hidden="true">${icons.info(12)}</span><span class="tw-muted">${escapeHtml(s.remarks)}</span>`;
                cell.appendChild(remarksEl);
              }
              return cell;
            }
            case 'focal': {
              const cell = h('div', 'ssz-contact-cell');
              const personName = h('div', 'ssz-focal-name', s.focalPerson || '—');
              cell.appendChild(personName);
              if (s.focalContact) {
                const contactRow = h('div', 'ssz-contact-row');
                const telLink = h('a', 'ssz-tel-link', s.focalContact);
                telLink.href = `tel:${s.focalContact.replace(/[^0-9+]/g, '')}`;
                telLink.setAttribute('aria-label', `Call ${s.focalContact}`);
                const copyBtn = h('button', 'ssz-copy-btn');
                copyBtn.type = 'button';
                copyBtn.setAttribute('aria-label', `Copy phone number for ${s.focalPerson || s.name}`);
                copyBtn.title = 'Copy phone number';
                copyBtn.innerHTML = icons.copy(12);
                copyBtn.addEventListener('click', (e) => {
                  e.stopPropagation();
                  try {
                    navigator.clipboard?.writeText(s.focalContact);
                    showToast('Phone number copied to clipboard.', { variant: 'success' });
                  } catch {
                    showToast(s.focalContact, { variant: 'info' });
                  }
                });
                contactRow.append(telLink, copyBtn);
                cell.appendChild(contactRow);
              }
              return cell;
            }
            case 'status': {
              const isActive = s.isActive !== false && s.isActive !== 0;
              return isActive
                ? h('span', 'status-pill status-pill--success', 'Active')
                : h('span', 'status-pill status-pill--neutral', 'Deactivated');
            }
            case 'actions': return schoolActions(s);
            default: return '';
          }
        },
      }));
    }

    function schoolActions(s) {
      const wrap = h('div', 'ssz-actions-group');

      // Primary 1-click Edit button (Admin & Secretary only)
      if (canEdit) {
        const edit = h('button', 'ghost ssz-action-edit-btn', 'Edit');
        edit.type = 'button';
        edit.setAttribute('aria-label', `Edit ${s.name}`);
        edit.addEventListener('click', (e) => {
          e.stopPropagation();
          openForm(s);
        });
        wrap.appendChild(edit);
      }

      // Secondary Overflow Menu for Map, Contact copy, and Deactivate/Reactivate
      const menuTrigger = h('button', 'ghost ssz-more-btn');
      menuTrigger.type = 'button';
      menuTrigger.setAttribute('aria-label', `More options for ${s.name}`);
      menuTrigger.innerHTML = `<span aria-hidden="true">${icons.menu ? icons.menu(16) : '•••'}</span>`;

      const menu = Menu({
        trigger: menuTrigger,
        label: `Actions for ${s.name}`,
        align: 'right',
        panelClass: 'ssz-action-menu-panel',
      });

      // 1. View on Live Map (if user has GIS capability)
      if (canViewGis) {
        const mapItem = h('button', 'menu__item ssz-menu__item');
        mapItem.type = 'button';
        mapItem.setAttribute('role', 'menuitem');
        mapItem.innerHTML = `<span class="menu__item-icon" aria-hidden="true">${icons.mapPin(16)}</span><span>View on Live Map</span>`;
        mapItem.addEventListener('click', (e) => {
          e.stopPropagation();
          menu.close();
          showToast(`Opening Live Map centered on ${s.name}...`, { variant: 'info' });
          navigate('gis', { focusAddress: s.address, schoolName: s.name });
        });
        menu.panel.appendChild(mapItem);
      }

      // 2. Copy full focal person info
      if (s.focalPerson || s.focalContact) {
        const copyItem = h('button', 'menu__item ssz-menu__item');
        copyItem.type = 'button';
        copyItem.setAttribute('role', 'menuitem');
        copyItem.innerHTML = `<span class="menu__item-icon" aria-hidden="true">${icons.copy(16)}</span><span>Copy focal details</span>`;
        copyItem.addEventListener('click', (e) => {
          e.stopPropagation();
          menu.close();
          const clipText = `${s.name} - Focal: ${s.focalPerson || 'N/A'} (${s.focalContact || 'N/A'})`;
          try {
            navigator.clipboard?.writeText(clipText);
            showToast('Focal details copied to clipboard.', { variant: 'success' });
          } catch {
            showToast(clipText, { variant: 'info' });
          }
        });
        menu.panel.appendChild(copyItem);
      }

      // 3. Deactivate / Reactivate (Admin & Secretary only)
      if (canEdit) {
        const isActive = !(s.isActive === false || s.isActive === 0);
        const toggleItem = h('button', `menu__item ssz-menu__item ${isActive ? 'ssz-menu__item--danger' : ''}`);
        toggleItem.type = 'button';
        toggleItem.setAttribute('role', 'menuitem');
        toggleItem.innerHTML = `<span class="menu__item-icon" aria-hidden="true">${isActive ? icons.alertTriangle(16) : icons.rotateCcw(16)}</span><span>${isActive ? 'Deactivate school' : 'Reactivate school'}</span>`;
        toggleItem.addEventListener('click', async (e) => {
          e.stopPropagation();
          menu.close();
          const ok = await confirmDialog({
            title: isActive ? 'Deactivate this school?' : 'Reactivate this school?',
            description: isActive
              ? 'It stays on record and in past reports but leaves the active inventory and the Annex B printout.'
              : 'It returns to the active inventory and the Annex B printout.',
            confirmLabel: isActive ? 'Deactivate' : 'Reactivate',
            danger: isActive,
            onConfirmAsync: async () => {
              try { await updateSchool(s.schoolId, { isActive: !isActive }); } catch (err) { throw new Error(actionErrorMessage(err)); }
            },
          });
          if (ok) {
            showToast(isActive ? 'School deactivated.' : 'School reactivated.', { variant: 'success' });
            load(true);
          }
        });
        menu.panel.appendChild(toggleItem);
      }

      wrap.appendChild(menu.el);
      return wrap;
    }

    load();
  }

  function buildSchoolForm(school, onSaved, onCancel) {
    const editing = school !== null;
    const el = card(editing ? 'Edit school' : 'Add school', 'Annex B inventory entry. Do not record any student information here.');
    el.classList.add('tw-form-card');

    const name = document.createElement('input');
    name.maxLength = 160;
    name.value = school?.name ?? '';
    const type = selectOf(Object.entries(SCHOOL_TYPE_LABELS).map(([value, label]) => ({ value, label })), { value: school?.schoolType ?? '', placeholder: 'Select…' });
    const level = selectOf(Object.entries(SCHOOL_LEVEL_LABELS).map(([value, label]) => ({ value, label })), { value: school?.level ?? '', placeholder: 'Select…' });
    const address = document.createElement('input');
    address.maxLength = 255;
    address.value = school?.address ?? '';
    const focalPerson = document.createElement('input');
    focalPerson.maxLength = 120;
    focalPerson.value = school?.focalPerson ?? '';
    const focalContact = document.createElement('input');
    focalContact.maxLength = 32;
    focalContact.inputMode = 'tel';
    focalContact.value = school?.focalContact ?? '';
    const remarks = document.createElement('textarea');
    remarks.maxLength = 500;
    remarks.rows = 3;
    remarks.value = school?.remarks ?? '';

    const grid = h('div', 'tw-form-grid');
    grid.append(
      field('Name of school', name).wrap,
      field('Public or private', type).wrap,
      field('Level', level).wrap,
      field('Complete address', address).wrap,
      field('SSZ focal person', focalPerson).wrap,
      field('Focal contact number', focalContact).wrap,
    );
    const remarksField = field('Remarks (include possible hotspots)', remarks);
    remarksField.wrap.classList.add('tw-form-grid__wide');
    grid.appendChild(remarksField.wrap);

    const error = h('p', 'tw-form-error');
    error.setAttribute('role', 'alert');
    error.hidden = true;

    const actions = h('div', 'tw-action-bar');
    const save = h('button', 'primary', editing ? 'Save changes' : 'Add school');
    save.type = 'button';
    const cancel = h('button', 'ghost', 'Cancel');
    cancel.type = 'button';
    cancel.addEventListener('click', onCancel);
    actions.append(save, cancel);

    save.addEventListener('click', async () => {
      error.hidden = true;
      const fields = {
        name: name.value.trim(),
        schoolType: type.value,
        level: level.value,
        address: address.value.trim(),
        focalPerson: focalPerson.value.trim() || null,
        focalContact: focalContact.value.trim() || null,
        remarks: remarks.value.trim() || null,
      };
      if (!fields.name || !fields.schoolType || !fields.level || !fields.address) {
        error.textContent = 'Name, public/private, level and complete address are required.';
        error.hidden = false;
        return;
      }
      save.disabled = true;
      try {
        if (editing) await updateSchool(school.schoolId, fields);
        else await createSchool(fields);
        showToast(editing ? 'School updated.' : 'School added.', { variant: 'success' });
        await onSaved();
      } catch (err) {
        error.textContent = actionErrorMessage(err, 'Could not save this school.');
        error.hidden = false;
        save.disabled = false;
      }
    });

    el.append(grid, error, actions);
    return el;
  }

  // =========================================================================
  // Incidents tab (Annex C-1)
  // =========================================================================

  function renderIncidentsTab(host) {
    const referralCache = new Map(); // incidentId -> {kinds, labels} | null (fetch failed)
    const state = { from: '', to: '', schoolId: '', sortBy: 'when_who', sortDir: 'desc', page: 1 };
    let searchQuery = '';
    let selectedReferralKind = 'all';
    let all = [];
    let schoolNames = new Map();
    let truncated = false;

    function isEmsKind(k) {
      return k === 'ambulance_ems' || k === 'doh' || k === 'ambulance' || k === 'hospital';
    }

    function matchesReferralFacet(incidentId, kind) {
      if (kind === 'all') return true;
      const entry = referralCache.get(incidentId);
      if (!entry || !entry.kinds) return false;
      if (kind === 'barangay') {
        return !entry.kinds.some((k) => !BARANGAY_LEVEL_DESTINATIONS.has(k));
      }
      if (kind === 'pnp') return entry.kinds.includes('pnp');
      if (kind === 'ems') return entry.kinds.some(isEmsKind);
      if (kind === 'bfp') return entry.kinds.includes('bfp');
      if (kind === 'other') {
        return entry.kinds.some(
          (k) => !BARANGAY_LEVEL_DESTINATIONS.has(k) && k !== 'pnp' && k !== 'bfp' && !isEmsKind(k),
        );
      }
      return true;
    }

    // Dismissible Privacy & Regulatory Callout Card
    const note = h('div', 'c1-notice-card tw-notice');
    const noteContent = h('div', 'c1-notice-content');
    const noteIcon = h('span', 'c1-notice-icon');
    noteIcon.setAttribute('aria-hidden', 'true');
    noteIcon.innerHTML = icons.shield(18);
    const noteText = h('div', '', 'Annex C-1 is factual and short. The summary, action taken and status notes are separate from the confidential incident narrative and must not name students or victims. Secretary or Admin add them on the incident.');
    noteContent.append(noteIcon, noteText);

    const dismissBtn = h('button', 'c1-notice-dismiss');
    dismissBtn.type = 'button';
    dismissBtn.setAttribute('aria-label', 'Dismiss confidentiality note');
    dismissBtn.innerHTML = icons.x(14);
    dismissBtn.addEventListener('click', () => {
      note.hidden = true;
      try { sessionStorage.setItem('ssz_c1_notice_dismissed', '1'); } catch {}
    });
    try {
      if (sessionStorage.getItem('ssz_c1_notice_dismissed') === '1') note.hidden = true;
    } catch {}
    note.append(noteContent, dismissBtn);

    // Consolidated Single-Row Control Bar (Search First, Dates, School, Sort, Clear)
    const filters = h('div', 'c1-control-bar c1-filters tw-filter-bar');

    // Primary Search Input Box (Leading Control)
    const searchBox = h('div', 'c1-search-box');
    const searchIcon = h('span', 'c1-search-icon');
    searchIcon.setAttribute('aria-hidden', 'true');
    searchIcon.innerHTML = icons.search(16);

    const searchInput = document.createElement('input');
    searchInput.type = 'search';
    searchInput.id = 'tw-c1-search';
    searchInput.className = 'c1-search-input';
    searchInput.placeholder = 'Search case ID, school, summary, location, officer...';
    searchInput.setAttribute('aria-label', 'Search school incident reports');

    const clearSearchBtn = h('button', 'c1-search-clear');
    clearSearchBtn.type = 'button';
    clearSearchBtn.setAttribute('aria-label', 'Clear search query');
    clearSearchBtn.innerHTML = icons.x(14);
    clearSearchBtn.hidden = true;

    // Date Pickers Group
    const dateGroup = h('div', 'c1-date-group');
    const fromInput = document.createElement('input'); fromInput.type = 'date'; fromInput.id = 'tw-c1-from'; fromInput.className = 'c1-date-input';
    const toInput = document.createElement('input'); toInput.type = 'date'; toInput.id = 'tw-c1-to'; toInput.className = 'c1-date-input';
    const fromField = h('div', 'c1-date-field');
    const fromLabel = h('label', 'label', 'From'); fromLabel.htmlFor = fromInput.id;
    fromField.append(fromLabel, fromInput);

    const toField = h('div', 'c1-date-field');
    const toLabel = h('label', 'label', 'To'); toLabel.htmlFor = toInput.id;
    toField.append(toLabel, toInput);

    const arrowSpan = h('span', 'c1-date-arrow', '➔');
    dateGroup.append(fromField, arrowSpan, toField);

    // School Dropdown Group (Inline label + select, aligned with date & sort controls)
    const schoolField = h('div', 'c1-select-field');
    const schoolSelect = selectOf([], { placeholder: 'All schools' });
    schoolSelect.id = 'tw-c1-school';
    schoolSelect.className = 'c1-select';
    const schoolLabel = h('label', 'label', 'School');
    schoolLabel.htmlFor = schoolSelect.id;
    schoolField.append(schoolLabel, schoolSelect);

    // Sort Controls Group
    const sortGroup = h('div', 'c1-sort-group');
    const sortSelect = document.createElement('select');
    sortSelect.id = 'tw-c1-sort';
    sortSelect.className = 'c1-select c1-sort-select';
    sortSelect.setAttribute('aria-label', 'Sort school incidents by');
    const sortOptions = [
      { value: 'when_who', label: 'Sort: Reported Date' },
      { value: 'incident', label: 'Sort: School' },
      { value: 'action_referral', label: 'Sort: Escalation' },
    ];
    for (const so of sortOptions) {
      const opt = document.createElement('option');
      opt.value = so.value;
      opt.textContent = so.label;
      sortSelect.appendChild(opt);
    }
    sortSelect.value = state.sortBy;

    const sortDirBtn = h('button', 'ghost c1-sort-dir-btn');
    sortDirBtn.type = 'button';
    const syncSortControls = () => {
      sortSelect.value = state.sortBy;
      const isDesc = state.sortDir === 'desc';
      sortDirBtn.textContent = isDesc ? '↓ Desc' : '↑ Asc';
      sortDirBtn.setAttribute('aria-label', isDesc ? 'Sort descending (newest first)' : 'Sort ascending (oldest first)');
      sortDirBtn.title = isDesc ? 'Descending order (click to toggle ascending)' : 'Ascending order (click to toggle descending)';
    };
    syncSortControls();

    sortSelect.addEventListener('change', () => {
      state.sortBy = sortSelect.value;
      state.page = 1;
      renderTable();
    });
    sortDirBtn.addEventListener('click', () => {
      state.sortDir = state.sortDir === 'desc' ? 'asc' : 'desc';
      syncSortControls();
      state.page = 1;
      renderTable();
    });
    sortGroup.append(sortSelect, sortDirBtn);

    const clear = h('button', 'ghost c1-clear-btn', 'Clear filters');
    clear.type = 'button';
    clear.disabled = true;
    clear.setAttribute('aria-label', 'Clear all incident filters');

    function updateClearButtonState() {
      let activeCount = 0;
      if (state.from) activeCount += 1;
      if (state.to) activeCount += 1;
      if (state.schoolId) activeCount += 1;
      if (selectedReferralKind !== 'all') activeCount += 1;
      if (searchQuery) activeCount += 1;
      clear.disabled = activeCount === 0;
      clear.textContent = activeCount > 0 ? `Clear filters (${activeCount})` : 'Clear filters';
    }

    clearSearchBtn.addEventListener('click', () => {
      searchInput.value = '';
      searchQuery = '';
      clearSearchBtn.hidden = true;
      searchInput.focus();
      state.page = 1;
      updateClearButtonState();
      renderTable();
    });

    let searchTimer = null;
    searchInput.addEventListener('input', () => {
      searchQuery = searchInput.value.trim();
      clearSearchBtn.hidden = !searchQuery;
      updateClearButtonState();
      if (searchTimer) clearTimeout(searchTimer);
      searchTimer = setTimeout(() => {
        state.page = 1;
        renderTable();
      }, 120);
    });
    searchBox.append(searchIcon, searchInput, clearSearchBtn);

    filters.append(searchBox, dateGroup, schoolField, sortGroup, clear);

    // Unified Escalation Summary & Interactive Filter Bar (Replaces redundant StatStrip row)
    const facetsBar = h('div', 'c1-facets-bar');
    facetsBar.setAttribute('role', 'group');
    facetsBar.setAttribute('aria-label', 'Filter by escalation agency');
    const facetsLabel = h('span', 'c1-facets-label');
    facetsLabel.innerHTML = `<span aria-hidden="true">${icons.filter(14)}</span><span>Escalation:</span>`;
    facetsBar.appendChild(facetsLabel);

    const facetItems = [
      { id: 'all', label: 'All School Incidents' },
      { id: 'barangay', label: 'Barangay Only' },
      { id: 'pnp', label: 'Police / PNP' },
      { id: 'ems', label: 'Medical / EMS' },
      { id: 'bfp', label: 'Fire / BFP' },
      { id: 'other', label: 'Other Agencies' },
    ];
    const facetButtons = new Map();
    for (const fi of facetItems) {
      const btn = h('button', `c1-facet-chip ${fi.id === 'all' ? 'is-active' : ''}`);
      btn.type = 'button';
      btn.dataset.facet = fi.id;
      btn.setAttribute('aria-pressed', String(fi.id === 'all'));
      const lblSpan = h('span', 'c1-facet-chip__label', fi.label);
      const countSpan = h('span', 'c1-facet-chip__count', '0');
      btn.append(lblSpan, countSpan);
      btn.addEventListener('click', () => {
        selectedReferralKind = fi.id;
        for (const [id, entry] of facetButtons.entries()) {
          const active = id === fi.id;
          entry.btn.classList.toggle('is-active', active);
          entry.btn.setAttribute('aria-pressed', String(active));
        }
        state.page = 1;
        updateClearButtonState();
        renderTable();
      });
      facetButtons.set(fi.id, { btn, countSpan });
      facetsBar.appendChild(btn);
    }

    const tableHost = h('div', 'c1-table-body');
    const tableCard = h('div', 'unified-table-card c1-table-card');
    tableCard.append(note, filters, facetsBar, tableHost);
    host.appendChild(tableCard);

    const printBtn = h('button', 'ghost');
    printBtn.type = 'button';
    printBtn.innerHTML = `${icons.printer(16)}<span>Preview &amp; print Annex C-1</span>`;
    pageHeader.actions.appendChild(printBtn);
    printBtn.addEventListener('click', async () => {
      const rows = filtered();
      if (rows.length === 0) { showToast('There are no school incidents to print for these filters.', { variant: 'info' }); return; }
      printBtn.disabled = true;
      try {
        const toPrint = rows.slice(0, PRINT_INCIDENT_CAP);
        if (rows.length > PRINT_INCIDENT_CAP) showToast(`Printing the first ${PRINT_INCIDENT_CAP} of ${rows.length} incidents. Narrow the dates to print the rest.`, { variant: 'warning' });
        await ensureReferrals(toPrint);
        // A blank "referred to" cell reads as "not referred" on a form that
        // goes to the Mayor and DILG, so a failed lookup blocks the print.
        const unchecked = toPrint.filter((r) => !referralCache.get(r.incidentId));
        if (unchecked.length > 0) {
          showToast(`Referral data could not be loaded for ${unchecked.length} incident${unchecked.length === 1 ? '' : 's'} - do not file a copy until it loads. Try again.`, { variant: 'error' });
          renderTable();
          return;
        }
        const lh = await loadLetterhead(user);
        warnIfLetterheadMissing(lh);
        const preview = openPrintPreviewModal({
          title: 'Annex C-1 — Incident Report, Safer School Zones',
          subtitle: `${toPrint.length} incident${toPrint.length === 1 ? '' : 's'}`,
          sheetId: 'printable-annex-c1',
          sheetHtml: buildAnnexC1Html(toPrint.map(toC1Row), lh, {
            count: toPrint.length,
            total: rows.length,
            from: state.from,
            to: state.to,
            truncatedScan: truncated,
          }),
          printedBy: printedByLabel(user),
          orientation: 'landscape',
        });
        applyPrintOrientation(preview, 'landscape');
      } finally {
        printBtn.disabled = false;
      }
    });

    const apply = () => {
      state.from = fromInput.value;
      state.to = toInput.value;
      state.schoolId = schoolSelect.value;
      state.page = 1;
      updateClearButtonState();
      renderTable();
    };
    fromInput.addEventListener('change', apply);
    toInput.addEventListener('change', apply);
    schoolSelect.addEventListener('change', apply);
    clear.addEventListener('click', () => {
      fromInput.value = '';
      toInput.value = '';
      schoolSelect.value = '';
      searchInput.value = '';
      searchQuery = '';
      clearSearchBtn.hidden = true;
      selectedReferralKind = 'all';
      for (const [id, entry] of facetButtons.entries()) {
        const active = id === 'all';
        entry.btn.classList.toggle('is-active', active);
        entry.btn.setAttribute('aria-pressed', String(active));
      }
      apply();
    });

    function baseFiltered() {
      return all.filter((i) => {
        const day = manilaDateOf(i.createdAt);
        if (state.from && day < state.from) return false;
        if (state.to && day > state.to) return false;
        if (state.schoolId && String(i.schoolId) !== state.schoolId) return false;

        if (searchQuery) {
          const q = searchQuery.toLowerCase();
          const code = formatIncidentCode(i).toLowerCase();
          const sName = (schoolNames.get(i.schoolId) || i.schoolName || '').toLowerCase();
          const narrative = (i.c1Summary || '').toLowerCase();
          const location = (i.locationDescription || '').toLowerCase();
          const action = (i.c1ActionTaken || '').toLowerCase();
          const officer = (i.officerName || '').toLowerCase();
          if (
            !code.includes(q)
            && !sName.includes(q)
            && !narrative.includes(q)
            && !location.includes(q)
            && !action.includes(q)
            && !officer.includes(q)
          ) {
            return false;
          }
        }
        return true;
      });
    }

    function updateFacetCounts(baseRows) {
      for (const fi of facetItems) {
        const entry = facetButtons.get(fi.id);
        if (!entry) continue;
        const count = fi.id === 'all'
          ? baseRows.length
          : baseRows.filter((i) => matchesReferralFacet(i.incidentId, fi.id)).length;
        entry.countSpan.textContent = String(count);
      }
    }

    function sortIncidentRows(rows) {
      const dir = state.sortDir === 'asc' ? 1 : -1;
      return [...rows].sort((a, b) => {
        if (state.sortBy === 'incident') {
          const sA = (schoolNames.get(a.schoolId) || a.schoolName || '').toLowerCase();
          const sB = (schoolNames.get(b.schoolId) || b.schoolName || '').toLowerCase();
          if (sA !== sB) return sA.localeCompare(sB) * dir;
        } else if (state.sortBy === 'action_referral') {
          const rA = (referredText(a.incidentId) || '').toLowerCase();
          const rB = (referredText(b.incidentId) || '').toLowerCase();
          if (rA !== rB) return rA.localeCompare(rB) * dir;
        }
        const tA = String(a.createdAt || '');
        const tB = String(b.createdAt || '');
        if (tA !== tB) return tA.localeCompare(tB) * dir;
        return (Number(a.incidentId) - Number(b.incidentId)) * dir;
      });
    }

    function filtered() {
      const base = baseFiltered();
      const facetFiltered = selectedReferralKind === 'all'
        ? base
        : base.filter((i) => matchesReferralFacet(i.incidentId, selectedReferralKind));
      return sortIncidentRows(facetFiltered);
    }

    async function ensureReferrals(rows) {
      // A failed lookup is cached as null; retry those rather than trusting them.
      const missing = rows.filter((r) => !referralCache.get(r.incidentId));
      if (missing.length === 0) return;
      const results = await Promise.allSettled(missing.map((r) => getIncidentReferrals(r.incidentId)));
      results.forEach((res, idx) => {
        const id = missing[idx].incidentId;
        if (res.status === 'fulfilled') {
          const refs = res.value.items;
          referralCache.set(id, {
            kinds: refs.map((ref) => ref.referredTo),
            labels: refs.map((ref) => (ref.referredTo === 'other' && ref.otherText ? ref.otherText : (REFERRED_TO_LABELS[ref.referredTo] || ref.referredTo))),
          });
        } else {
          referralCache.set(id, null);
        }
      });
    }

    /** C-1 "referred to" text: actual recipients, with "Barangay" when nothing left the barangay. */
    function referredText(incidentId) {
      const entry = referralCache.get(incidentId);
      if (!entry) return null;
      const external = entry.kinds.some((k) => !BARANGAY_LEVEL_DESTINATIONS.has(k));
      const unique = [...new Set(entry.labels)];
      return external ? unique.join('; ') : ['Barangay', ...unique].join('; ');
    }

    function toC1Row(i) {
      return {
        schoolName: schoolNames.get(i.schoolId) || i.schoolName || formatSchoolCode(i.schoolId),
        // The API has no incident-occurrence time, only when the record was
        // logged, so the cell says so rather than passing it off as "when it happened".
        when: `Reported: ${formatManilaDateTime(i.createdAt)}`,
        location: i.locationDescription || '',
        narrative: i.c1Summary || '',
        action: i.c1ActionTaken || '',
        referredTo: referredText(i.incidentId) ?? REFERRAL_UNAVAILABLE,
        personnel: i.officerName || '',
        // Internal system status ("Pending", "Dispatched") is not a C-1 status note.
        status: i.c1StatusNotes || '',
      };
    }

    async function load() {
      showLoading(tableHost, 'Loading school incidents');
      try {
        const [schoolsRes, incidents] = await Promise.all([loadSchools(), getSchoolIncidents()]);
        schoolNames = new Map(schoolsRes.items.map((s) => [s.schoolId, s.name]));
        for (const s of schoolsRes.items) {
          const opt = document.createElement('option');
          opt.value = String(s.schoolId);
          opt.textContent = s.name;
          schoolSelect.appendChild(opt);
        }
        all = incidents.items;
        truncated = incidents.truncated;
        await ensureReferrals(all);
        await renderTable();
      } catch (err) {
        showError(tableHost, err, load, 'Could not load school incidents.');
      }
    }

    async function renderTable() {
      const base = baseFiltered();
      updateFacetCounts(base);
      const rows = filtered();
      tableHost.innerHTML = '';
      if (all.length === 0) {
        showEmpty(tableHost, 'No school incidents', 'Incidents appear here once they are linked to a school. Link a school from the incident, or when it is reported.');
        return;
      }
      if (rows.length === 0) {
        showEmpty(tableHost, 'No incidents match', 'Adjust the dates, search keywords, escalation filter, or school filter.');
        return;
      }
      const start = (state.page - 1) * INCIDENT_PAGE_SIZE;
      const slice = rows.slice(start, start + INCIDENT_PAGE_SIZE);
      await ensureReferrals(slice);
      updateFacetCounts(base);
      tableHost.innerHTML = '';

      if (truncated) {
        tableHost.appendChild(h('p', 'tw-notice tw-notice--warning', 'Only the most recent incidents were scanned for school links. Older school incidents may be missing here.'));
      }
      tableHost.appendChild(DataTable({
        columns: [
          { key: 'incident', label: 'School & Incident Summary', sortable: true },
          { key: 'when_who', label: 'Reported & Personnel', sortable: true },
          { key: 'action_referral', label: 'Action Taken & Escalation', sortable: true },
          { key: 'action', label: 'Action', align: 'right' },
        ],
        rows: slice,
        rowKey: (i) => i.incidentId,
        caption: 'School incidents (Annex C-1)',
        emptyMessage: 'No incidents on this page.',
        emptyIcon: icons.shield,
        sortKey: state.sortBy,
        sortDir: state.sortDir,
        onSort: (key, dir) => {
          state.sortBy = key;
          state.sortDir = dir;
          syncSortControls();
          state.page = 1;
          renderTable();
        },
        onRowClick: (i) => navigate('incident-detail', i.incidentId),
        page: state.page,
        totalItems: rows.length,
        pageSize: INCIDENT_PAGE_SIZE,
        onPageChange: (next) => { state.page = next; renderTable(); },
        renderCell: (i, key) => {
          const c1 = toC1Row(i);
          switch (key) {
            case 'incident': {
              const cell = h('div', 'c1-incident-cell');
              const metaRow = h('div', 'c1-incident-meta');
              const incCodePill = h('span', 'c1-inc-code-pill', formatIncidentCode(i));
              const schoolPill = h('span', 'c1-school-pill');
              schoolPill.innerHTML = `<span aria-hidden="true">${icons.shield(12)}</span><span>${escapeHtml(c1.schoolName)}</span>`;
              metaRow.append(incCodePill, schoolPill);

              if (c1.location) {
                if (canViewGis) {
                  const mapBtn = h('button', 'c1-location-link');
                  mapBtn.type = 'button';
                  mapBtn.setAttribute('aria-label', `View ${c1.location} near ${c1.schoolName} on Live GIS Map`);
                  mapBtn.title = 'View on Live GIS Map';
                  mapBtn.innerHTML = `<span aria-hidden="true">${icons.mapPin(13)}</span><span>${escapeHtml(c1.location)}</span>`;
                  mapBtn.addEventListener('click', (e) => {
                    e.stopPropagation();
                    showToast(`Opening Live Map centered on ${c1.schoolName} (${c1.location})...`, { variant: 'info' });
                    navigate('gis', { focusAddress: c1.location, schoolName: c1.schoolName });
                  });
                  metaRow.appendChild(mapBtn);
                } else {
                  const locSpan = h('span', 'c1-location-line');
                  locSpan.innerHTML = `<span aria-hidden="true">${icons.mapPin(13)}</span><span>${escapeHtml(c1.location)}</span>`;
                  metaRow.appendChild(locSpan);
                }
              }

              const narrativeText = c1.narrative || 'No C-1 summary recorded';
              const narrative = h('div', `c1-narrative-title${c1.narrative ? '' : ' is-muted'}`, narrativeText);
              if (c1.narrative) narrative.title = c1.narrative;
              cell.append(metaRow, narrative);
              return cell;
            }
            case 'when_who': {
              const cell = h('div', 'c1-when-who-cell');
              const timeRow = h('div', 'c1-time-row');
              timeRow.innerHTML = `<span aria-hidden="true">${icons.clock(14)}</span><span>${escapeHtml(c1.when)}</span>`;
              const officerRow = h('div', 'c1-officer-row');
              officerRow.innerHTML = `<span aria-hidden="true">${icons.users(14)}</span><span>${escapeHtml(c1.personnel || 'Unassigned tanod')}</span>`;
              cell.append(timeRow, officerRow);
              return cell;
            }
            case 'action_referral': {
              const cell = h('div', 'c1-action-referral-cell');
              const actionText = h('div', `c1-action-text${c1.action ? '' : ' is-muted'}`, c1.action || 'No C-1 action recorded');
              if (c1.action) actionText.title = c1.action;
              const badgesWrap = h('div', 'c1-badges-wrap');

              const entry = referralCache.get(i.incidentId);
              const refText = referredText(i.incidentId);
              if (refText) {
                let badgeTone = 'brgy';
                if (entry?.kinds) {
                  if (entry.kinds.some(isEmsKind)) badgeTone = 'ems';
                  else if (entry.kinds.includes('pnp')) badgeTone = 'pnp';
                  else if (entry.kinds.includes('bfp')) badgeTone = 'bfp';
                  else if (entry.kinds.some((k) => !BARANGAY_LEVEL_DESTINATIONS.has(k))) badgeTone = 'other';
                }
                const refBadge = h('span', `c1-referral-badge c1-referral-badge--${badgeTone}`);
                const dot = h('span', 'c1-referral-badge__dot');
                dot.setAttribute('aria-hidden', 'true');
                const txt = h('span', 'c1-referral-badge__text', refText);
                refBadge.append(dot, txt);
                badgesWrap.appendChild(refBadge);
              } else if (referralCache.has(i.incidentId) && entry === null) {
                // The lookup FAILED (null), as opposed to still loading (no entry yet).
                // A blank "referred to" would look like "nothing was referred".
                badgesWrap.appendChild(h('span', 'c1-referral-badge c1-referral-badge--other', REFERRAL_UNAVAILABLE));
              }
              if (c1.status && c1.status !== '—') {
                badgesWrap.appendChild(h('span', 'c1-status-note-badge', `Status: ${c1.status}`));
              }
              cell.append(actionText, badgesWrap);
              return cell;
            }
            case 'action': {
              const viewBtn = h('button', 'ghost c1-view-case-btn');
              viewBtn.type = 'button';
              viewBtn.setAttribute('aria-label', `View case details for ${c1.schoolName} incident`);
              viewBtn.innerHTML = `<span>View case</span><span aria-hidden="true">${icons.arrowRight ? icons.arrowRight(14) : '→'}</span>`;
              viewBtn.addEventListener('click', (e) => {
                e.stopPropagation();
                navigate('incident-detail', i.incidentId);
              });
              return viewBtn;
            }
            default: return '';
          }
        },
      }));
    }

    load();
  }

  // =========================================================================
  // Term report tab (Annex D)
  // =========================================================================

  function renderTermTab(host) {
    const livePanel = h('div', 'd-term-live-host');
    const listHost = h('div', 'd-term-list-host');
    const detailHost = h('div', 'tw-reports-detail d-term-detail-host');
    detailHost.hidden = true;
    host.append(livePanel, listHost, detailHost);

    function showList() {
      detailHost.hidden = true;
      detailHost.innerHTML = '';
      livePanel.hidden = false;
      listHost.hidden = false;
      loadList();
    }

    async function openDetail(reportId) {
      livePanel.hidden = true;
      listHost.hidden = true;
      detailHost.hidden = false;
      await loadDetail(reportId);
    }

    // ----- live counts + create draft ---------------------------------------

    function buildLivePanel() {
      livePanel.innerHTML = '';
      const el = h('div', 'card d-calculator-panel');

      const label = document.createElement('input');
      label.className = 'd-input-text';
      label.maxLength = 40;
      label.placeholder = 'e.g. Term 1 S.Y. 2026-2027';

      const start = document.createElement('input');
      start.type = 'date';
      start.id = 'term-start-input';
      start.className = 'd-input-date';
      start.setAttribute('aria-label', 'Term starts');

      const end = document.createElement('input');
      end.type = 'date';
      end.id = 'term-end-input';
      end.className = 'd-input-date';
      end.setAttribute('aria-label', 'Term ends');

      const remarks = document.createElement('input');
      remarks.type = 'text';
      remarks.className = 'd-input-text';
      remarks.maxLength = 1000;
      remarks.placeholder = 'Observations, TA needs, or good practices (optional)…';

      // Top header row with quick Academic Term Presets (3 Philippine school year terms)
      const head = h('div', 'd-panel-header d-panel-header--row');
      const titles = h('div', 'd-panel-header__titles');
      titles.innerHTML = `
        <div class="d-panel-title-line">
          <h3 class="tw-card__title">Live Term Metrics &amp; Draft Generator</h3>
          <span class="d-panel-badge"><span aria-hidden="true">${icons.calendar ? icons.calendar(13) : ''}</span> Annex D Statutory Aggregator</span>
        </div>
        <p class="tw-card__subtitle">Select a term date window (or use a quick term preset) to compute real-time Annex D counts and lock in a formal draft snapshot.</p>
      `;

      const presetsBar = h('div', 'd-term-presets');
      presetsBar.appendChild(h('span', 'd-term-presets__label', 'Quick Fill:'));
      const presets = [
        { text: 'Term 1 S.Y. 26–27', termLabel: 'Term 1 S.Y. 2026-2027', start: '2026-08-01', end: '2026-11-30' },
        { text: 'Term 2 S.Y. 26–27', termLabel: 'Term 2 S.Y. 2026-2027', start: '2026-12-01', end: '2027-02-28' },
        { text: 'Term 3 S.Y. 26–27', termLabel: 'Term 3 S.Y. 2026-2027', start: '2027-03-01', end: '2027-05-31' },
      ];
      for (const p of presets) {
        const pBtn = h('button', 'ghost d-preset-chip', p.text);
        pBtn.type = 'button';
        pBtn.addEventListener('click', () => {
          if (!label.value.trim() || presets.some((pr) => pr.termLabel === label.value.trim())) {
            label.value = p.termLabel;
          }
          start.value = p.start;
          end.value = p.end;
          refreshCounts();
        });
        presetsBar.appendChild(pBtn);
      }

      const resetBtn = h('button', 'ghost d-preset-chip d-preset-chip--reset', 'Reset');
      resetBtn.type = 'button';
      resetBtn.hidden = true;
      resetBtn.addEventListener('click', () => {
        label.value = '';
        start.value = '';
        end.value = '';
        remarks.value = '';
        refreshCounts();
      });
      presetsBar.appendChild(resetBtn);

      head.append(titles, presetsBar);
      el.appendChild(head);

      // Compact single-row composer control bar
      const controlBar = h('div', 'd-term-control-bar');
      const labelField = h('div', 'd-term-field d-term-field--label');
      labelField.innerHTML = `<label for="term-label-input">Term Label <span class="d-required">*</span></label>`;
      label.id = 'term-label-input';
      labelField.appendChild(label);

      const dateField = h('div', 'd-term-field d-term-field--dates');
      dateField.innerHTML = `<label>Term Window (Start &amp; End) <span class="d-required">*</span></label>`;
      const dateInputsWrap = h('div', 'd-date-inputs-group');

      const startWrap = h('div', 'd-date-subfield');
      const startLbl = h('label', 'sr-only', 'Term starts');
      startLbl.htmlFor = 'term-start-input';
      startWrap.append(startLbl, start);

      const endWrap = h('div', 'd-date-subfield');
      const endLbl = h('label', 'sr-only', 'Term ends');
      endLbl.htmlFor = 'term-end-input';
      endWrap.append(endLbl, end);

      dateInputsWrap.append(startWrap, h('span', 'd-date-separator', '→'), endWrap);
      dateField.appendChild(dateInputsWrap);

      controlBar.append(labelField, dateField);

      let createBtn = null;
      if (canEdit) {
        const remarksField = h('div', 'd-term-field d-term-field--remarks');
        remarksField.innerHTML = `<label for="term-remarks-input">Term Remarks &amp; Observations <span class="d-optional-tag">(Optional)</span></label>`;
        remarks.id = 'term-remarks-input';
        remarksField.appendChild(remarks);

        const actionField = h('div', 'd-term-field d-term-field--cta');
        createBtn = h('button', 'primary d-create-draft-btn');
        createBtn.type = 'button';
        createBtn.innerHTML = `<span aria-hidden="true">${icons.plus ? icons.plus(15) : '+'}</span><span>Create draft term report</span>`;
        actionField.appendChild(createBtn);

        controlBar.append(remarksField, actionField);
      }

      el.appendChild(controlBar);

      const countsHost = h('div', 'tw-counts-host d-counts-host');
      const error = h('p', 'tw-form-error');
      error.setAttribute('role', 'alert');
      error.hidden = true;

      el.append(countsHost, error);
      livePanel.appendChild(el);

      let seq = 0;
      async function refreshCounts() {
        error.hidden = true;
        resetBtn.hidden = !(start.value || end.value || label.value.trim());
        if (!start.value || !end.value) {
          countsHost.innerHTML = `
            <div class="d-empty-prompt d-empty-prompt--compact">
              <span class="d-empty-prompt__icon" aria-hidden="true">${icons.calendar ? icons.calendar(16) : '📅'}</span>
              <span class="d-empty-prompt__inline-text"><strong>Select term start and end dates above</strong> — BaranGuard will compute real-time tanod deployments, covered schools, and incident referrals across the period.</span>
            </div>
          `;
          return;
        }
        if (start.value > end.value) {
          countsHost.innerHTML = `
            <div class="d-empty-prompt d-empty-prompt--compact d-empty-prompt--error">
              <span class="d-empty-prompt__icon" aria-hidden="true">${icons.alertTriangle ? icons.alertTriangle(16) : '⚠️'}</span>
              <span class="d-empty-prompt__inline-text"><strong>Invalid date window</strong> — The term start date cannot be after the term end date. Please adjust the range.</span>
            </div>
          `;
          return;
        }
        const mySeq = ++seq;
        showLoading(countsHost, 'Computing real-time term metrics across schools & patrols');
        try {
          const live = await getSchoolTermLive({ termStart: start.value, termEnd: end.value });
          if (mySeq !== seq) return;
          countsHost.innerHTML = '';
          countsHost.appendChild(countsGrid(live));
          if (live.otherInstitutions) countsHost.appendChild(h('p', 'tw-other-inst', `Other institutions: ${live.otherInstitutions}`));
        } catch (err) {
          if (mySeq !== seq) return;
          showError(countsHost, err, refreshCounts, 'Could not compute live counts.');
        }
      }
      start.addEventListener('change', refreshCounts);
      end.addEventListener('change', refreshCounts);
      refreshCounts();

      createBtn?.addEventListener('click', async () => {
        error.hidden = true;
        if (!label.value.trim() || !start.value || !end.value) {
          error.textContent = 'Enter a term label and both term dates.';
          error.hidden = false;
          return;
        }
        if (start.value > end.value) {
          error.textContent = 'The term start must be on or before the term end.';
          error.hidden = false;
          return;
        }
        createBtn.disabled = true;
        try {
          const created = await createTermReport({
            termLabel: label.value.trim(), termStart: start.value, termEnd: end.value, remarks: remarks.value.trim(),
          });
          showToast('Draft term report created.', { variant: 'success' });
          openDetail(created.reportId);
        } catch (err) {
          error.textContent = actionErrorMessage(err, 'Could not create the draft.');
          error.hidden = false;
          createBtn.disabled = false;
        }
      });
    }

    // ----- saved reports list -------------------------------------------------

    let termStatusFilter = 'all';
    let termSearchQuery = '';
    let termSortDesc = true;

    async function loadList() {
      showLoading(listHost, 'Loading term reports');
      try {
        const res = await getTermReports();
        const allItems = res.items || [];
        listHost.innerHTML = '';
        const el = card('Saved term reports', 'Term records by status: draft, prepared or submitted. Click any row to view the detail, print it or move it along.');
        el.className += ' unified-table-card d-table-card';

        if (allItems.length === 0) {
          el.appendChild(h('p', 'tw-empty-note', canEdit ? 'No term reports yet. Create a draft above once a term range is chosen.' : 'No term reports have been created yet.'));
          listHost.appendChild(el);
          return;
        }

        // Toolbar with Status Filter Tabs, Full-Width Search & Sort Order Toggle
        const toolbar = h('div', 'ssz-control-bar d-list-toolbar');
        const statusTabs = h('div', 'ssz-segmented-tabs');
        statusTabs.setAttribute('role', 'group');
        statusTabs.setAttribute('aria-label', 'Filter term reports by workflow status');

        const countsByStatus = {
          all: allItems.length,
          draft: allItems.filter((r) => r.status === 'draft').length,
          prepared: allItems.filter((r) => r.status === 'prepared').length,
          submitted: allItems.filter((r) => r.status === 'submitted').length,
        };

        const searchWrap = h('div', 'ssz-search-box');
        const searchIcon = h('span', 'ssz-search-icon');
        searchIcon.setAttribute('aria-hidden', 'true');
        searchIcon.innerHTML = icons.search ? icons.search(15) : '🔍';
        const searchInput = document.createElement('input');
        searchInput.type = 'search';
        searchInput.className = 'ssz-search-input';
        searchInput.placeholder = 'Search saved term reports by label, reference code (ANX-D-0007), or dates…';
        searchInput.setAttribute('aria-label', 'Search saved term reports');
        searchInput.value = termSearchQuery;
        searchWrap.append(searchIcon, searchInput);

        const sortBtn = h('button', 'ghost d-sort-btn');
        sortBtn.type = 'button';
        const updateSortBtnLabel = () => {
          sortBtn.innerHTML = `<span>Sort: ${termSortDesc ? '↓ Newest' : '↑ Oldest'}</span>`;
          sortBtn.setAttribute('aria-label', `Sort term reports (${termSortDesc ? 'Newest first' : 'Oldest first'})`);
        };
        updateSortBtnLabel();

        const tableMount = h('div', 'd-table-mount');

        function renderFilteredTable() {
          statusTabs.innerHTML = '';
          const tabDefs = [
            ['all', 'All'],
            ['draft', 'Draft'],
            ['prepared', 'Prepared'],
            ['submitted', 'Submitted'],
          ];
          for (const [key, lbl] of tabDefs) {
            const btn = h('button', `ssz-tab-btn${termStatusFilter === key ? ' is-active' : ''}`);
            btn.type = 'button';
            btn.setAttribute('aria-pressed', termStatusFilter === key ? 'true' : 'false');
            btn.append(
              h('span', '', lbl),
              h('span', 'ssz-tab-count', String(countsByStatus[key] ?? 0)),
            );
            btn.addEventListener('click', () => {
              termStatusFilter = key;
              renderFilteredTable();
            });
            statusTabs.appendChild(btn);
          }

          const q = termSearchQuery.trim().toLowerCase();
          const filtered = allItems
            .filter((r) => (termStatusFilter === 'all' ? true : r.status === termStatusFilter))
            .filter((r) => {
              if (!q) return true;
              const hay = `${r.termLabel || ''} ${formatAnnexDCode(r.reportId)} #${r.reportId} ${r.termStart || ''} ${r.termEnd || ''} ${r.status || ''}`.toLowerCase();
              return hay.includes(q);
            })
            .slice()
            .sort((a, b) => {
              const cmp = String(a.termStart || '').localeCompare(String(b.termStart || '')) || ((a.reportId || 0) - (b.reportId || 0));
              return termSortDesc ? -cmp : cmp;
            });

          tableMount.innerHTML = '';
          tableMount.appendChild(DataTable({
            columns: [
              { key: 'label', label: 'Term & Coverage' },
              { key: 'range', label: 'Term Window' },
              { key: 'status', label: 'Workflow Status' },
              { key: 'incidents', label: 'Coverage & Incidents' },
              { key: 'actions', label: 'Actions', align: 'right' },
            ],
            rows: filtered,
            rowKey: (r) => r.reportId,
            caption: 'Saved term reports',
            emptyMessage: 'No matching term reports.',
            emptyIcon: icons.fileText,
            onRowClick: (r) => openDetail(r.reportId),
            renderCell: (r, key) => {
              switch (key) {
                case 'label': {
                  const cell = h('div', 'd-term-title-cell');
                  const title = h('span', 'd-term-title-text', r.termLabel);
                  const sub = h('span', 'd-term-sub-text', `${formatAnnexDCode(r.reportId)} · Annex D Term Report`);
                  cell.append(title, sub);
                  return cell;
                }
                case 'range': {
                  const cell = h('div', 'd-term-range-cell');
                  cell.innerHTML = `<span aria-hidden="true">${icons.calendar ? icons.calendar(14) : ''}</span><span>${formatDateOnly(r.termStart)} to ${formatDateOnly(r.termEnd)}</span>`;
                  return cell;
                }
                case 'status': return statusPill(r.status, 'term');
                case 'incidents': {
                  const wrap = h('div', 'd-row-metrics');
                  if (r.totalSchools != null) {
                    wrap.appendChild(h('span', 'd-metric-pill', `${r.totalSchools} school${r.totalSchools === 1 ? '' : 's'}`));
                  }
                  const incBadge = h('span', 'd-incidents-badge', `${r.totalIncidents ?? 0} incident${(r.totalIncidents ?? 0) === 1 ? '' : 's'}`);
                  wrap.appendChild(incBadge);
                  return wrap;
                }
                case 'actions': {
                  const wrap = h('div', 'd-row-actions');

                  // Quick Print preview shortcut
                  const printBtn = h('button', 'ghost d-row-action-btn');
                  printBtn.type = 'button';
                  printBtn.title = 'Preview & print Annex D';
                  printBtn.setAttribute('aria-label', `Preview and print Annex D for ${r.termLabel}`);
                  printBtn.innerHTML = `<span aria-hidden="true">${icons.printer ? icons.printer(14) : '🖨️'}</span><span>Print</span>`;
                  printBtn.addEventListener('click', async (e) => {
                    e.stopPropagation();
                    printBtn.disabled = true;
                    try {
                      const fullReport = await getTermReport(r.reportId);
                      const lh = await loadLetterhead(user);
                      warnIfLetterheadMissing(lh);
                      openPrintPreviewModal({
                        title: 'Annex D — Safer School Zones Term-Based Report',
                        subtitle: `${fullReport.termLabel} · ${TERM_STATUS_LABELS[fullReport.status] || fullReport.status}`,
                        sheetId: 'printable-annex-d',
                        sheetHtml: buildAnnexDHtml(fullReport, lh),
                        printedBy: printedByLabel(user),
                        orientation: 'landscape',
                      });
                    } catch (err) {
                      showToast(actionErrorMessage(err, 'Could not open print preview.'), { variant: 'error' });
                    } finally {
                      printBtn.disabled = false;
                    }
                  });

                  // View details button
                  const viewBtn = h('button', 'ghost d-row-action-btn d-row-action-btn--primary');
                  viewBtn.type = 'button';
                  viewBtn.title = 'View report details';
                  viewBtn.setAttribute('aria-label', `View details for ${r.termLabel}`);
                  viewBtn.innerHTML = `<span>View</span><span aria-hidden="true">${icons.arrowRight ? icons.arrowRight(14) : '→'}</span>`;
                  viewBtn.addEventListener('click', (e) => {
                    e.stopPropagation();
                    openDetail(r.reportId);
                  });

                  wrap.append(printBtn, viewBtn);
                  return wrap;
                }
                default: return '';
              }
            },
          }));
        }

        searchInput.addEventListener('input', () => {
          termSearchQuery = searchInput.value;
          renderFilteredTable();
        });

        sortBtn.addEventListener('click', () => {
          termSortDesc = !termSortDesc;
          updateSortBtnLabel();
          renderFilteredTable();
        });

        toolbar.append(statusTabs, searchWrap, sortBtn);
        el.append(toolbar, tableMount);
        renderFilteredTable();
        listHost.appendChild(el);
      } catch (err) {
        showError(listHost, err, loadList, 'Could not load saved term reports.');
      }
    }

    // ----- detail -------------------------------------------------------------

    async function loadDetail(reportId) {
      showLoading(detailHost, 'Loading term report');
      try {
        const report = await getTermReport(reportId);
        renderDetail(report);
      } catch (err) {
        showError(detailHost, err, () => loadDetail(reportId), 'Could not load this term report.');
      }
    }

    function renderDetail(report) {
      detailHost.innerHTML = '';
      pageHeader.actions.innerHTML = '';

      const back = h('button', 'ghost d-back-btn');
      back.type = 'button';
      back.innerHTML = `<span aria-hidden="true">←</span><span>Back to term reports</span>`;
      back.addEventListener('click', () => { pageHeader.actions.innerHTML = ''; showList(); });

      const printBtn = h('button', 'ghost');
      printBtn.type = 'button';
      printBtn.innerHTML = `${icons.printer(16)}<span>Preview &amp; print Annex D</span>`;
      printBtn.addEventListener('click', async () => {
        printBtn.disabled = true;
        try {
          const lh = await loadLetterhead(user);
          warnIfLetterheadMissing(lh);
          openPrintPreviewModal({
            title: 'Annex D — Safer School Zones Term-Based Report',
            subtitle: `${report.termLabel} · ${TERM_STATUS_LABELS[report.status] || report.status}`,
            sheetId: 'printable-annex-d',
            sheetHtml: buildAnnexDHtml(report, lh),
            printedBy: printedByLabel(user),
            orientation: 'landscape',
          });
        } finally {
          printBtn.disabled = false;
        }
      });
      pageHeader.actions.appendChild(printBtn);

      const head = card();
      head.classList.add('d-detail-card');

      // Unified top header bar integrating Back button, Term title, ID badge, Date range, and Status pill
      const topBar = h('div', 'd-detail-top-bar');
      const leftNav = h('div', 'd-detail-top-bar__left');
      const titles = h('div', 'd-detail-titles');
      const titleRow = h('div', 'd-detail-title-row');
      titleRow.append(
        h('h3', 'tw-card__title d-detail-title', report.termLabel),
        h('span', 'd-report-id-pill', formatAnnexDCode(report.reportId)),
      );
      const subRow = h('p', 'tw-card__subtitle d-detail-subtitle');
      subRow.innerHTML = `<span aria-hidden="true">${icons.calendar ? icons.calendar(14) : ''}</span><span>${escapeHtml(formatDateOnly(report.termStart))} to ${escapeHtml(formatDateOnly(report.termEnd))}</span>`;
      titles.append(titleRow, subRow);
      leftNav.append(back, h('span', 'd-detail-divider', ''), titles);

      const rightStatus = h('div', 'd-detail-top-bar__right');
      rightStatus.appendChild(statusPill(report.status, 'term'));
      topBar.append(leftNav, rightStatus);
      head.appendChild(topBar);

      // 3-Step Statutory Workflow Stepper
      head.appendChild(buildWorkflowStepper(report.status));

      // Balanced 2-Row Metric Clusters
      head.appendChild(countsGrid(report));

      if (report.status === 'draft') {
        const notice = h('div', 'tw-notice d-snapshot-notice');
        notice.innerHTML = `<span class="d-snapshot-notice__icon" aria-hidden="true">${icons.info ? icons.info(16) : 'ℹ️'}</span><span>These counts are a snapshot from when the draft was created. Marking it prepared recomputes them from live data.</span>`;
        head.appendChild(notice);
      }

      // Structured Metadata, Remarks & Statutory Audit Trail strip
      const metaStrip = h('div', 'd-meta-callout-grid');
      if (report.otherInstitutions) {
        const instBox = h('div', 'd-meta-callout');
        instBox.append(
          h('span', 'd-meta-callout__label', 'Other Institutions Referred To'),
          h('p', 'd-meta-callout__value tw-other-inst', `Other institutions: ${report.otherInstitutions}`),
        );
        metaStrip.appendChild(instBox);
      }
      if (report.remarks && !(report.status === 'draft' && canEdit)) {
        const remBox = h('div', 'd-meta-callout');
        remBox.append(
          h('span', 'd-meta-callout__label', 'Term Remarks & Observations'),
          h('p', 'd-meta-callout__value tw-remarks', `Remarks: ${report.remarks}`),
        );
        metaStrip.appendChild(remBox);
      }

      const trail = h('ul', 'tw-trail d-audit-trail');
      const addTrail = (label, value) => {
        const li = h('li', 'tw-trail__item d-audit-trail__item');
        li.append(h('span', 'tw-trail__label d-audit-trail__label', label), h('span', 'tw-trail__value d-audit-trail__value', value));
        trail.appendChild(li);
      };
      if (report.preparedAt) addTrail('Prepared', formatManilaDateTime(report.preparedAt));
      if (report.mayorOfficeReceivedBy) addTrail('Received by Office of the Mayor', `${report.mayorOfficeReceivedBy}${report.mayorOfficeReceivedAt ? ` · ${formatDateOnly(report.mayorOfficeReceivedAt)}` : ''}`);
      if (report.dilgReceivedBy || report.dilgDateReceived) addTrail('DILG copy received', `${report.dilgReceivedBy || '—'}${report.dilgDateReceived ? ` · ${formatDateOnly(report.dilgDateReceived)}` : ''}`);
      if (trail.children.length) {
        const trailBox = h('div', 'd-meta-callout d-meta-callout--trail');
        trailBox.append(h('span', 'd-meta-callout__label', 'Statutory Sign-Off & Submission Trail'), trail);
        metaStrip.appendChild(trailBox);
      }

      if (metaStrip.children.length) head.appendChild(metaStrip);

      detailHost.appendChild(head);

      if (report.status === 'draft' && canEdit) detailHost.appendChild(buildDraftEditor(report));
      detailHost.appendChild(buildTermActions(report));
    }

    function buildWorkflowStepper(status) {
      const steps = [
        { key: 'draft', num: '1', title: 'Draft & Remarks', desc: 'Snapshot counts & narrative' },
        { key: 'prepared', num: '2', title: 'Prepared (Print & Sign)', desc: 'Recomputed & signed on paper' },
        { key: 'submitted', num: '3', title: 'Submitted to Mayor / DILG', desc: 'Official receipt logged' },
      ];
      const order = { draft: 0, prepared: 1, submitted: 2 };
      const currentIdx = order[status] ?? 0;

      const nav = h('div', 'd-workflow-stepper');
      nav.setAttribute('aria-label', 'Annex D statutory workflow progress');

      steps.forEach((step, idx) => {
        const item = h('div', 'd-stepper-item');
        if (idx < currentIdx || status === 'submitted') item.classList.add('is-done');
        else if (idx === currentIdx) {
          item.classList.add('is-current');
          item.setAttribute('aria-current', 'step');
        }

        const badge = h('span', 'd-stepper-badge', idx < currentIdx || status === 'submitted' ? '✓' : step.num);
        const textWrap = h('div', 'd-stepper-text');
        textWrap.append(
          h('span', 'd-stepper-title', step.title),
          h('span', 'd-stepper-desc', step.desc),
        );
        item.append(badge, textWrap);
        nav.appendChild(item);
      });

      return nav;
    }

    function buildDraftEditor(report) {
      const el = card('Remarks and other institutions', 'Editable while the report is a draft.');
      el.classList.add('d-workflow-card');
      const remarks = document.createElement('textarea'); remarks.rows = 3; remarks.maxLength = 1000; remarks.value = report.remarks ?? '';
      const other = document.createElement('input'); other.maxLength = 500; other.value = report.otherInstitutions ?? '';

      const editorGrid = h('div', 'd-draft-editor-grid');
      editorGrid.append(
        field('Remarks (technical assistance needed, key issues, good practices)', remarks).wrap,
        field('Other institutions referred to (separate with semicolons)', other).wrap,
      );
      el.appendChild(editorGrid);

      const error = h('p', 'tw-form-error'); error.setAttribute('role', 'alert'); error.hidden = true;
      const save = h('button', 'primary', 'Save remarks');
      save.type = 'button';
      save.addEventListener('click', async () => {
        error.hidden = true;
        save.disabled = true;
        try {
          await updateTermReport(report.reportId, { remarks: remarks.value.trim(), otherInstitutions: other.value.trim() });
          showToast('Draft updated.', { variant: 'success' });
          loadDetail(report.reportId);
        } catch (err) {
          error.textContent = actionErrorMessage(err, 'Could not save the draft.');
          error.hidden = false;
          save.disabled = false;
        }
      });

      const footer = h('div', 'd-submit-actions-bar');
      footer.append(
        h('span', 'd-submit-actions-bar__hint', 'Changes are included on the printed Annex D sheet.'),
        save,
      );
      el.append(error, footer);
      return el;
    }

    function buildTermActions(report) {
      const canPrepare = report.status === 'draft' && canEdit;
      const canSubmit = report.status === 'prepared' && canEdit;

      const title = canPrepare
        ? 'Finalize & Mark as Prepared'
        : canSubmit
          ? 'Record Statutory Submission'
          : 'Workflow Status & Next Step';

      const subtitle = canPrepare
        ? 'Fixes the counts from live data. Then print the report and have it signed on paper.'
        : canSubmit
          ? 'Record who at the Office of the Mayor received the signed (on paper) report, and the DILG copy if known.'
          : undefined;

      const el = card(title, subtitle);
      el.classList.add('d-workflow-card');

      if (canPrepare) el.appendChild(buildPrepareForm(report));
      if (canSubmit) el.appendChild(buildSubmitForm(report));

      if (!canPrepare && !canSubmit) {
        el.appendChild(h('p', 'tw-empty-note d-workflow-status-note', termNoActionText(report)));
      }
      return el;
    }

    function termNoActionText(report) {
      if (report.status === 'draft') return 'Waiting for the Secretary or Admin to mark this draft prepared.';
      if (report.status === 'prepared') return 'Prepared. Print it and have it signed on paper; the Secretary or Admin marks it submitted once the Office of the Mayor has received it.';
      return 'This report has been submitted. Nothing further to do.';
    }

    function buildPrepareForm(report) {
      const wrap = h('div', 'tw-submit-form d-action-form');
      const error = h('p', 'tw-form-error'); error.setAttribute('role', 'alert'); error.hidden = true;
      const btn = h('button', 'primary', 'Mark as prepared');
      btn.type = 'button';
      btn.addEventListener('click', async () => {
        error.hidden = true;
        btn.disabled = true;
        try {
          await prepareTermReport(report.reportId);
          showToast('Report marked as prepared. Print it and have it signed on paper.', { variant: 'success' });
          loadDetail(report.reportId);
        } catch (err) {
          error.textContent = actionErrorMessage(err, 'Could not mark this report as prepared.');
          error.hidden = false;
          btn.disabled = false;
        }
      });
      const footer = h('div', 'd-submit-actions-bar');
      footer.append(
        h('span', 'd-submit-actions-bar__hint', 'Recomputes all 11 Annex D indicators from live patrol and incident records.'),
        btn,
      );
      wrap.append(error, footer);
      return wrap;
    }

    function buildSubmitForm(report) {
      const wrap = h('div', 'tw-submit-form d-action-form');
      const mayorBy = document.createElement('input'); mayorBy.maxLength = 120; mayorBy.placeholder = 'e.g. Maria Santos, Records Officer';
      const mayorAt = document.createElement('input'); mayorAt.type = 'date';
      const dilgBy = document.createElement('input'); dilgBy.maxLength = 120; dilgBy.placeholder = 'e.g. LGOO V Juan Dela Cruz';
      const dilgAt = document.createElement('input'); dilgAt.type = 'date';

      const groupsGrid = h('div', 'd-submit-groups-grid');

      const mayorGroup = h('div', 'd-submit-group d-submit-group--required');
      const mayorHead = h('div', 'd-submit-group__head');
      mayorHead.append(
        h('span', 'd-submit-group__title', 'Office of the Mayor Receipt'),
        h('span', 'd-submit-group__badge d-submit-group__badge--req', 'Required'),
      );
      const mayorFields = h('div', 'd-submit-group__fields');
      mayorFields.append(
        field('Received by (Office of the Mayor)', mayorBy).wrap,
        field('Date received', mayorAt).wrap,
      );
      mayorGroup.append(mayorHead, mayorFields);

      const dilgGroup = h('div', 'd-submit-group');
      const dilgHead = h('div', 'd-submit-group__head');
      dilgHead.append(
        h('span', 'd-submit-group__title', 'DILG Field Office Copy'),
        h('span', 'd-submit-group__badge', 'Optional'),
      );
      const dilgFields = h('div', 'd-submit-group__fields');
      dilgFields.append(
        field('DILG copy received by (optional)', dilgBy).wrap,
        field('DILG date received (optional)', dilgAt).wrap,
      );
      dilgGroup.append(dilgHead, dilgFields);

      groupsGrid.append(mayorGroup, dilgGroup);

      const error = h('p', 'tw-form-error'); error.setAttribute('role', 'alert'); error.hidden = true;
      const btn = h('button', 'primary', 'Mark as submitted');
      btn.type = 'button';
      btn.addEventListener('click', async () => {
        error.hidden = true;
        if (!mayorBy.value.trim() || !mayorAt.value) {
          error.textContent = 'Enter who at the Office of the Mayor received it, and the date.';
          error.hidden = false;
          return;
        }
        const ok = await confirmDialog({
          title: 'Mark this report as submitted?',
          description: 'This records receipt and closes the report. It cannot be undone.',
          confirmLabel: 'Mark submitted',
          onConfirmAsync: async () => {
            try {
              await markTermReportSubmitted(report.reportId, {
                mayorOfficeReceivedBy: mayorBy.value.trim(),
                mayorOfficeReceivedAt: mayorAt.value,
                dilgReceivedBy: dilgBy.value.trim(),
                dilgDateReceived: dilgAt.value,
              });
            } catch (err) { throw new Error(actionErrorMessage(err)); }
          },
        });
        if (ok) { showToast('Marked as submitted.', { variant: 'success' }); loadDetail(report.reportId); }
      });

      const footer = h('div', 'd-submit-actions-bar');
      footer.append(
        h('span', 'd-submit-actions-bar__hint', 'Ensure wet-ink signatures from the Punong Barangay are completed before logging submission.'),
        btn,
      );
      wrap.append(groupsGrid, error, footer);
      return wrap;
    }

    // ----- boot ---------------------------------------------------------------

    (async () => {
      buildLivePanel();
      if (pendingReportId !== null) {
        const id = pendingReportId;
        pendingReportId = null;
        openDetail(id);
      } else {
        loadList();
      }
    })();
  }

  setTab(activeTab);
}

/** Tiles for the Annex D counts, arranged in a balanced 2-row bento grid. */
function countsGrid(counts) {
  const container = h('div', 'd-counts-clusters-wrap');

  const buildCluster = (group) => {
    const cluster = h('div', `d-counts-cluster ${group.modClass || ''}`.trim());
    const header = h('div', 'd-cluster-header');
    const titleWrap = h('div', 'd-cluster-header__left');
    titleWrap.innerHTML = `<span class="d-cluster-icon" aria-hidden="true">${group.icon}</span><h4 class="d-cluster-title">${escapeHtml(group.title)}</h4>`;
    header.appendChild(titleWrap);
    if (group.badgeText) {
      header.appendChild(h('span', 'd-cluster-badge', group.badgeText));
    }
    cluster.appendChild(header);

    const grid = h('div', `tw-counts d-counts-grid ${group.gridClass || ''}`.trim());
    for (const [key, label] of group.keys) {
      const tile = h('div', 'tw-count-tile d-count-tile');
      const val = counts[key] ?? 0;
      tile.append(
        h('span', 'tw-count-tile__value d-count-tile__value', String(val)),
        h('span', 'tw-count-tile__label d-count-tile__label', label),
      );
      grid.appendChild(tile);
    }
    cluster.appendChild(grid);
    return cluster;
  };

  const totalReferrals =
    (Number(counts.incidentsPnp) || 0) +
    (Number(counts.incidentsBfp) || 0) +
    (Number(counts.incidentsHigherLgu) || 0) +
    (Number(counts.incidentsDoh) || 0) +
    (Number(counts.incidentsDpwh) || 0) +
    (Number(counts.incidentsOtherAgencies) || 0);

  const topRow = h('div', 'd-counts-top-row');
  topRow.append(
    buildCluster({
      title: 'Coverage & Patrol Deployments',
      icon: icons.shield ? icons.shield(16) : '🛡️',
      modClass: 'd-counts-cluster--coverage',
      gridClass: 'd-counts-grid--3col',
      badgeText: 'Annex D · Part I',
      keys: [
        ['totalTanods', 'Tanods Deployed'],
        ['totalSchools', 'Schools Covered'],
        ['totalDeploymentDays', 'Days with Patrol Deployment'],
      ],
    }),
    buildCluster({
      title: 'Incident Volume & Local Resolution',
      icon: icons.alertCircle ? icons.alertCircle(16) : '⚠️',
      modClass: 'd-counts-cluster--incidents',
      gridClass: 'd-counts-grid--2col',
      badgeText: 'Annex D · Part II',
      keys: [
        ['totalIncidents', 'Total Incidents Logged'],
        ['incidentsBarangayOnly', 'Barangay Handled (No Escalation)'],
      ],
    }),
  );

  const bottomCluster = buildCluster({
    title: 'Multi-Agency External Referrals',
    icon: icons.users ? icons.users(16) : '👥',
    modClass: 'd-counts-cluster--referrals',
    gridClass: 'd-counts-grid--6col',
    badgeText: `${totalReferrals} External Referral${totalReferrals === 1 ? '' : 's'}`,
    keys: [
      ['incidentsPnp', 'Referred to PNP'],
      ['incidentsBfp', 'Referred to BFP'],
      ['incidentsHigherLgu', 'Referred to Higher LGU'],
      ['incidentsDoh', 'Referred to DOH / EMS'],
      ['incidentsDpwh', 'Referred to DPWH'],
      ['incidentsOtherAgencies', 'Referred to Other Agencies'],
    ],
  });

  container.append(topRow, bottomCluster);
  return container;
}

// ===========================================================================
// Print layouts (text mirrors the barangay's own Annex B / C-1 / D files)
// ===========================================================================

function buildAnnexBHtml(schools, lh) {
  const rows = schools.map((s) => `
    <tr>
      <td>${escapeHtml(s.name)}</td>
      <td>${escapeHtml(SCHOOL_TYPE_LABELS[s.schoolType] || s.schoolType || '')}</td>
      <td>${escapeHtml(SCHOOL_LEVEL_LABELS[s.level] || s.level || '')}</td>
      <td class="tw-print__left">${escapeHtml(s.address || '')}</td>
      <td>${escapeHtml(s.focalPerson || '')}</td>
      <td>${escapeHtml(s.focalContact || '')}</td>
      <td class="tw-print__left">${escapeHtml(s.remarks || '')}</td>
    </tr>`).join('');
  const titleBlock = `
    <p class="tw-print__title">ANNEX &ldquo;B&rdquo; &ndash; SAFER SCHOOL ZONES INVENTORY</p>
    <p class="tw-print__subtitle">${SSZ_PURSUANT_HTML}</p>`;
  return `
    <div class="tw-print tw-print--wide">
      ${safeLetterheadHtml(lh, { office: true })}
      ${titleBlock}
      <table class="tw-print__table tw-print__table--inv">
        <thead><tr>
          <th scope="col">Name of School</th><th scope="col">Public/<br>Private</th><th scope="col">Level</th><th scope="col">Complete Address</th>
          <th scope="col">SSZ Focal Person</th><th scope="col">SSZ Focal Contact<br>Number</th><th scope="col">Remarks<br>(include possible hotspots)</th>
        </tr></thead>
        <tbody>${rows}</tbody>
      </table>
      <div class="tw-sign">
        ${signatureBlockHtml('Prepared by:', '', 'Name and position')}
        ${signatureBlockHtml('Noted by:', '', 'Punong Barangay')}
      </div>
      <div class="tw-print__page-break"></div>
      ${safeLetterheadHtml(lh, { office: true })}
      ${titleBlock}
      <div class="tw-print__howto">
        <p class="tw-print__lead">How To Use:</p>
        <p>1. Indicate the Name of School.</p>
        <p>2. Indicate if <u>Public</u> or <u>Private</u> School.</p>
        <p>3. Indicate the Level of Institution:</p>
        <p class="tw-print__indent"><b>a. Preschool / Daycare / ECCD</b> &ndash; covers toddler, nursery, daycare, and kindergarten-level learners prior to formal elementary education. <b>Primary</b> or <b>Elementary</b> &ndash; school offering elementary/basic education.</p>
        <p class="tw-print__indent"><b>b. Secondary</b> or <b>High-School</b> &ndash; school offering junior high school and/or senior high school education.</p>
        <p class="tw-print__indent"><b>c. Integrated</b> &ndash; school offering both elementary and secondary education in one site.</p>
        <p class="tw-print__indent"><b>d. Higher Education Institution (HEI)</b> or <b>Tertiary</b> &ndash; college or university under CHED supervision.</p>
        <p class="tw-print__indent"><b>e. All-through School</b> &ndash; school offering primary, secondary, and, where applicable, tertiary or other continuous levels under one institution.</p>
        <p class="tw-print__indent"><b>f. TVET</b> &ndash; vocational or technical-vocational schools regulated by TESDA.</p>
        <p class="tw-print__indent"><b>g. SNED</b> = Special Needs Education.</p>
        <p>4. Indicate the <b>complete address</b> where the school is located.</p>
        <p>5. Indicate the name of the <b>SAFER School Zone Focal Person</b> duly designated by the School Head as supplied in <b>Annex &ldquo;A&rdquo; &ndash; SAFER School Zone Coordination Form.</b></p>
        <p>6. Indicate the SAFER School Zone Focal Person&rsquo;s <b>active contact number.</b></p>
        <p>7. Put necessary remarks, if any.</p>
      </div>
    </div>`;
}

function buildAnnexC1Html(rows, lh, meta = {}) {
  const range = (meta.from || meta.to)
    ? `Incidents logged ${meta.from ? 'from ' + meta.from : ''}${meta.from && meta.to ? ' ' : ''}${meta.to ? 'to ' + meta.to : ''}`
    : 'Incidents logged: all dates on file';
  const truncationNote = (meta.total > meta.count)
    ? ` PARTIAL LIST: ${meta.count} of ${meta.total} matching incidents are shown. Narrow the dates and print the rest.`
    : (meta.truncatedScan ? ' Only the most recent incidents were scanned for school links; older school incidents may be missing.' : '');
  const metaLine = meta.count === undefined ? '' : `<p class="tw-print__meta">${escapeHtml(range)}. ${meta.count} incident${meta.count === 1 ? '' : 's'} listed.${escapeHtml(truncationNote)}</p>`;
  const body = rows.map((r) => `
    <tr>
      <td>${escapeHtml(r.schoolName)}</td>
      <td>${escapeHtml(r.when)}</td>
      <td>${escapeHtml(r.location)}</td>
      <td>${escapeHtml(r.narrative)}</td>
      <td>${escapeHtml(r.action)}</td>
      <td>${escapeHtml(r.referredTo)}</td>
      <td>${escapeHtml(r.personnel)}</td>
      <td>${escapeHtml(r.status)}</td>
    </tr>`).join('');
  return `
    <div class="tw-print tw-print--wide">
      ${safeLetterheadHtml(lh, { office: true })}
      <p class="tw-print__title">ANNEX C-1 &ndash; PORMULARYO NG ULAT SA INSIDENTE SA SAFER SCHOOL ZONES</p>
      <p class="tw-print__subtitle">${SSZ_PURSUANT_HTML}</p>
      ${metaLine}
      <p class="tw-print__intro">Itala ang mga insidente o panganib na nangyari sa, o may direktang epekto sa, <i>school zone</i>. Panatilihing batay sa katotohanan, maikli, at hindi para sa imbestigasyon o pagtukoy ng pananagutan.</p>
      <table class="tw-print__table tw-print__table--c1">
        <thead><tr>
          <th scope="col">Pangalan ng Paaralan na malapit sa pinangyarihan ng insidente</th>
          <th scope="col">Oras / Petsa ng Insidente (Kailan)</th>
          <th scope="col">Eksaktong Lugar (Saan)</th>
          <th scope="col">Maikling Salaysay ng Insidente (Ano ang Nangyari at Paano)</th>
          <th scope="col">Ginawang Aksyon</th>
          <th scope="col">ISINANGGUNI O INIULAT SA<div class="tw-print__th-sub">(PNP / BFP / Higher LGU / DPWH / DOH / Iba pa, gaya ng 911)</div></th>
          <th scope="col">Tumugong Tauhan ng Barangay</th>
          <th scope="col">Kalagayan / Mga Tala</th>
        </tr></thead>
        <tbody>${body}</tbody>
      </table>
      <div class="tw-sign">
        ${signatureBlockHtml('Prepared by:', '', 'Name and position')}
        ${signatureBlockHtml('Noted by:', '', 'Punong Barangay')}
      </div>
      <div class="tw-print__howto">
        <p class="tw-print__lead">Paano Gamitin:</p>
        <p>1. Isulat ang buong pangalan ng paaralan o institusyong pang-edukasyon na kaugnay ng school zone kung saan nangyari o nakaapekto ang insidente o panganib.</p>
        <p>2. Isulat ang eksakto o tinatayang oras at petsa kung kailan nangyari ang insidente.</p>
        <p>3. Isulat ang eksakto o tinatayang lugar kung saan nangyari ang insidente.</p>
        <p>4. Maikling isalaysay kung ano ang nangyari. Iwasan ang haka-haka, akusasyon, o konklusyon kung sino ang may kasalanan.</p>
        <p>5. Maikling isulat kung ano ang ginawang aksyon ng Barangay Tanod o barangay personnel.</p>
        <p>6. Ilagay ang tanggapan, ahensiya, institusyon, awtoridad, o ibang barangay kung saan isinangguni o iniulat ang insidente. Kung naaksyunan ang insidente sa pamamagitan ng mga mekanismo o hakbang sa antas ng barangay nang hindi ito isinangguni sa labas ng barangay, isulat ang &ldquo;<b>Barangay</b>.&rdquo; Kung higit sa isa ang pinagsanggunian o pinag-ulatan, ilagay ang lahat ng aktuwal na tatanggap at paghiwalayin ang mga ito gamit ang tuldok-kuwit (;).</p>
        <p>7. Isulat ang pangalan ng tumugong Barangay Tanod, barangay personnel, o taong nag-log ng ulat.</p>
        <p>8. Maikling isulat ang kasalukuyang kalagayan ng insidente at anumang isinagawa o kinakailangan pang kaukulang aksyon.</p>
      </div>
    </div>`;
}

function buildAnnexDHtml(report, lh) {
  const letterheadD = !letterheadUsable(lh) ? LETTERHEAD_WARNING_HTML : `
    <div class="tw-print__letterhead">
      <p class="tw-print__republic">Republic of the Philippines</p>
      <p class="tw-print__brgy">Barangay <u>${escapeHtml(lh.barangayName || '')}</u></p>
      <p class="tw-print__line">City/Municipality of <b>${escapeHtml((lh.municipality || '').toUpperCase())}</b></p>
      <p class="tw-print__line">Province of ${escapeHtml(lh.province || '')}</p>
    </div>`;
  const titleD = `<p class="tw-print__title">ANNEX &ldquo;D&rdquo; &ndash; SAFER SCHOOL ZONES TERM-BASED REPORT FORM &ndash; ${escapeHtml((report.termLabel || '').toUpperCase())}</p>`;
  const cell = (v) => `<td>${escapeHtml(v === undefined || v === null ? '' : String(v))}</td>`;
  // A draft carries snapshot counts; it must not look like a finished filing.
  const isFinal = report.status === 'prepared' || report.status === 'submitted';
  const statusText = TERM_STATUS_LABELS[report.status] || report.status || 'Unknown';
  const draftMark = isFinal ? '' : `<p class="tw-print__draft-mark">DRAFT - NOT FOR SUBMISSION (status: ${escapeHtml(statusText)})</p>`;

  return `
    <div class="tw-print">
      ${draftMark}
      ${letterheadD}
      ${titleD}
      <p class="tw-print__subtitle">${SSZ_PURSUANT_HTML}</p>
      <p class="tw-print__note-line">To be submitted to the Office of the Mayor, copy furnished the concerned C/MLGOO or DILG City Director, on or before the applicable deadline prescribed under DILG Memorandum Circular No. 2026-037</p>

      <table class="tw-print__table tw-print__table--term">
        <tr><th scope="col">Reporting TERM</th></tr>
        <tr><td>${escapeHtml(report.termLabel || '')} (${escapeHtml(formatDateOnly(report.termStart))} &ndash; ${escapeHtml(formatDateOnly(report.termEnd))})</td></tr>
      </table>
      <table class="tw-print__table tw-print__table--term">
        <tr>
          <th scope="col"><b>Total Number of Tanods</b><br>(Annual Reporting every Term 1)</th>
          <th scope="col">Total No. of Schools Covered</th>
          <th scope="col">Total No. of Days with Tanod Deployment in Schools</th>
          <th scope="col">Total No. of Incidents Logged (As also reflected in Annex &ldquo;C-1&rdquo;)</th>
          <th scope="col">Remarks (Technical Assistance Needed / Key Issues &amp; Notable Good Practices / Notes)</th>
        </tr>
        <tr>${cell(report.totalTanods)}${cell(report.totalSchools)}${cell(report.totalDeploymentDays)}${cell(report.totalIncidents)}${cell(report.remarks)}</tr>
      </table>
      <table class="tw-print__table tw-print__table--term">
        <tr><td colspan="8" class="tw-print__cap">TOTAL NUMBER OF INCIDENTS THAT (As also reflected in Annex &ldquo;C-1&rdquo;):</td></tr>
        <tr>
          <th scope="col">Acted upon by the Barangay and without referral</th><th scope="col">Referred to the PNP</th><th scope="col">Referred to the BFP</th>
          <th scope="col">Referred to the Higher LGU (City/ Municipality)</th><th scope="col">Referred to the DOH</th><th scope="col">Referred to the DPWH</th>
          <th scope="col">Referred to other Agencies/Institutions</th>
          <th scope="col">[Please Indicate the name of institutions, Multiple Entries are allowed Ex: Department of Agriculture (DA)]</th>
        </tr>
        <tr>${cell(report.incidentsBarangayOnly)}${cell(report.incidentsPnp)}${cell(report.incidentsBfp)}${cell(report.incidentsHigherLgu)}${cell(report.incidentsDoh)}${cell(report.incidentsDpwh)}${cell(report.incidentsOtherAgencies)}${cell(report.otherInstitutions)}</tr>
      </table>

      <div class="tw-print__page-break"></div>
      <div class="tw-print__howto">
        <p class="tw-print__lead">Notes for Use:</p>
        <p>1. The barangay shall submit this <b>School Term-Based</b> report form to the Office of the Mayor, copy furnished the C/MLGOO or the DILG City Director&rsquo;s Office, whichever applicable.</p>
        <p>2. The C/MLGOO or City Director shall consolidate barangay submissions and facilitate the encoding of the same in the prescribed live and online Safer School Zones Google Monitoring Sheet (SSZ-GMS).</p>
        <p>3. Provincial and City Offices shall ensure the completeness and appropriateness of submitted reports from Barangays within their areas of jurisdiction.</p>
        <p>4. Regional Offices shall ensure the completeness and appropriateness of submitted reports from the Provinces/HUCCs and ICCs, as applicable, within their areas of jurisdiction.</p>
        <p>5. The NBOO shall consolidate regional submissions not later than the prescribed deadline prior to report generation to be submitted to the Office of the Secretary for his information, guidance and/or further appropriate action.</p>
      </div>

      <div class="tw-print__page-break"></div>
      ${draftMark}
      ${letterheadD}
      ${titleD}
      <div class="tw-print__sigbox">
        <div class="tw-print__sigrow">
          <div class="tw-print__sigcell">
            <p class="tw-print__siglbl">Prepared by:</p>
            <div class="tw-print__sigline"></div>
            <p class="tw-print__sigparen">Name and signature over printed name</p>
            <p class="tw-print__sigcap">Chief Tanod/ Executive Officer</p>
            <p class="tw-print__sigfield">Date signed: <span></span></p>
          </div>
          <div class="tw-print__sigcell">
            <p class="tw-print__siglbl">Approved by:</p>
            <div class="tw-print__sigline"></div>
            <p class="tw-print__sigparen">Name and signature over printed name</p>
            <p class="tw-print__sigcap">Punong Barangay/ BPOC Chairperson</p>
            <p class="tw-print__sigfield">Date signed: <span></span></p>
          </div>
        </div>
        <div class="tw-print__sigrow tw-print__sigrow--single">
          <p class="tw-print__siglbl">Received by:</p>
          <div class="tw-print__sigline">${escapeHtml(report.mayorOfficeReceivedBy || '')}${report.mayorOfficeReceivedAt ? ` &mdash; ${escapeHtml(formatDateOnly(report.mayorOfficeReceivedAt))}` : ''}</div>
          <p class="tw-print__sigcap">Office of the Mayor</p>
          <p class="tw-print__sigparen">(Signature over Printed Name and Date of receipt)</p>
        </div>
        <div class="tw-print__sigrow tw-print__sigrow--single">
          <p class="tw-print__siglbl">Copy Furnished:</p>
          <p class="tw-print__sigfield">DILG Field Office date received: <span>${escapeHtml(report.dilgDateReceived ? formatDateOnly(report.dilgDateReceived) : '')}</span></p>
          <p class="tw-print__sigfield">Received by: <span>${escapeHtml(report.dilgReceivedBy || '')}</span></p>
        </div>
      </div>
      <p class="tw-print__meta">Report status when printed: ${escapeHtml(statusText)}.</p>
    </div>`;
}
