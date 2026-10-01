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
 *                prepared -> approved -> submitted with the authority
 *                gating the contract names, and the Annex D + signature
 *                page print. No deadline is hardcoded anywhere; the form
 *                text defers to the circular exactly as the user's file does.
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
import { showToast } from '../components/Toast.js';
import { confirmDialog } from '../components/ConfirmDialog.js';
import { openPrintPreviewModal } from '../components/PrintPreviewModal.js';
import { icons } from '../components/icons.js';
import {
  getSchools, createSchool, updateSchool, getSchoolIncidents, getIncidentReferrals,
  getSchoolTermLive, getTermReports, getTermReport, createTermReport, updateTermReport,
  prepareTermReport, approveTermReport, markTermReportSubmitted, getUserById, getUserNames,
  REFERRED_TO_LABELS, SCHOOL_LEVEL_LABELS, SCHOOL_TYPE_LABELS, TERM_STATUS_LABELS,
} from '../services/tanodWorkflowApi.js';
import {
  h, escapeHtml, mountPageFrame, buildTabBar, showLoading, showError, showEmpty, card, field,
  selectOf, getMyAuthority, statusPill, formatDateOnly, formatManilaDateTime, actionErrorMessage,
  loadLetterhead, letterheadHtml, applyPrintOrientation, SSZ_PURSUANT_HTML,
} from '../services/tanodWorkflowUi.js';

const TABS = [
  { id: 'schools', label: 'Schools (Annex B)' },
  { id: 'incidents', label: 'Incidents (Annex C-1)' },
  { id: 'term', label: 'Term Report (Annex D)' },
];
const INCIDENT_PAGE_SIZE = 25;
const PRINT_INCIDENT_CAP = 200;
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
  const t = Date.parse(value);
  if (Number.isNaN(t)) return '';
  return new Date(t + 8 * 3600 * 1000).toISOString().slice(0, 10);
}

function typeLabel(value) {
  if (!value) return '—';
  const text = String(value).replace(/_/g, ' ');
  return text.charAt(0).toUpperCase() + text.slice(1);
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
    let activeOnly = true;

    const toolbar = h('div', 'tw-toolbar');
    const chips = h('div', 'filter-chips');
    const chipActive = h('button', 'filter-chip is-active', 'Active');
    const chipAll = h('button', 'filter-chip', 'All');
    chipActive.type = 'button';
    chipAll.type = 'button';
    const setChip = (active) => {
      activeOnly = active;
      chipActive.classList.toggle('is-active', active);
      chipAll.classList.toggle('is-active', !active);
      renderTable();
    };
    chipActive.addEventListener('click', () => setChip(true));
    chipAll.addEventListener('click', () => setChip(false));
    chips.append(chipActive, chipAll);
    toolbar.appendChild(chips);

    const printBtn = h('button', 'ghost');
    printBtn.type = 'button';
    printBtn.innerHTML = `${icons.printer(16)}<span>Preview &amp; print Annex B</span>`;
    printBtn.addEventListener('click', async () => {
      const active = schools.filter((s) => s.isActive !== false && s.isActive !== 0);
      if (active.length === 0) { showToast('There are no active schools to print.', { variant: 'info' }); return; }
      const lh = await loadLetterhead(user);
      const preview = openPrintPreviewModal({
        title: 'Annex B — Safer School Zones Inventory',
        subtitle: `${active.length} active school${active.length === 1 ? '' : 's'}`,
        sheetId: 'printable-annex-b',
        sheetHtml: buildAnnexBHtml(active, lh),
      });
      applyPrintOrientation(preview, 'landscape');
    });
    pageHeader.actions.appendChild(printBtn);

    const formHost = h('div');
    const tableHost = h('div');
    host.append(toolbar, formHost, tableHost);

    if (canEdit) {
      const addBtn = h('button', 'primary');
      addBtn.type = 'button';
      addBtn.innerHTML = `${icons.plus(16)}<span>Add school</span>`;
      addBtn.addEventListener('click', () => openForm(null));
      pageHeader.actions.appendChild(addBtn);
    }

    function openForm(school) {
      formHost.innerHTML = '';
      formHost.appendChild(buildSchoolForm(school, async () => {
        formHost.innerHTML = '';
        await load(true);
      }, () => { formHost.innerHTML = ''; }));
      formHost.scrollIntoView?.({ block: 'nearest' });
    }

    async function load(force = false) {
      showLoading(tableHost, 'Loading schools');
      try {
        const res = await loadSchools(force);
        schools = res.items;
        renderTable();
      } catch (err) {
        showError(tableHost, err, () => load(true), 'Could not load the school list.');
      }
    }

    function renderTable() {
      tableHost.innerHTML = '';
      if (schools.length === 0) {
        showEmpty(
          tableHost,
          'No schools yet',
          canEdit ? 'Add the schools in this barangay to build the Annex B inventory.' : 'No schools have been added to the inventory yet.',
        );
        return;
      }
      const rows = activeOnly ? schools.filter((s) => s.isActive !== false && s.isActive !== 0) : schools;
      const inactive = schools.length - schools.filter((s) => s.isActive !== false && s.isActive !== 0).length;
      tableHost.appendChild(StatStrip({
        items: [
          { label: 'Active schools', value: schools.length - inactive, tone: 'success' },
          { label: 'Deactivated', value: inactive },
        ],
      }));
      const columns = [
        { key: 'name', label: 'School' },
        { key: 'type', label: 'Public / Private' },
        { key: 'level', label: 'Level' },
        { key: 'address', label: 'Address' },
        { key: 'focal', label: 'SSZ focal person' },
        { key: 'remarks', label: 'Remarks' },
        { key: 'status', label: 'Status' },
      ];
      if (canEdit) columns.push({ key: 'actions', label: 'Actions', align: 'right' });
      tableHost.appendChild(DataTable({
        columns,
        rows,
        rowKey: (s) => s.schoolId,
        caption: 'Schools',
        emptyMessage: 'No active schools. Switch to All to see deactivated ones.',
        emptyIcon: icons.shield,
        renderCell: (s, key) => {
          switch (key) {
            case 'name': return h('span', 'tw-strong', s.name);
            case 'type': return h('span', '', SCHOOL_TYPE_LABELS[s.schoolType] || s.schoolType || '—');
            case 'level': return h('span', '', SCHOOL_LEVEL_LABELS[s.level] || s.level || '—');
            case 'address': return h('span', '', s.address || '—');
            case 'focal': {
              const wrap = h('span');
              wrap.appendChild(document.createTextNode(s.focalPerson || '—'));
              if (s.focalContact) wrap.append(document.createElement('br'), h('span', 'tw-muted', s.focalContact));
              return wrap;
            }
            case 'remarks': return h('span', '', s.remarks || '—');
            case 'status': return s.isActive === false || s.isActive === 0
              ? h('span', 'status-pill status-pill--neutral', 'Deactivated')
              : h('span', 'status-pill status-pill--success', 'Active');
            case 'actions': return schoolActions(s);
            default: return '';
          }
        },
      }));
    }

    function schoolActions(s) {
      const wrap = h('div', 'user-actions-group');
      const edit = h('button', 'ghost', 'Edit');
      edit.type = 'button';
      edit.setAttribute('aria-label', `Edit ${s.name}`);
      edit.addEventListener('click', () => openForm(s));
      const isActive = !(s.isActive === false || s.isActive === 0);
      const toggle = h('button', isActive ? 'danger' : 'ghost', isActive ? 'Deactivate' : 'Reactivate');
      toggle.type = 'button';
      toggle.setAttribute('aria-label', `${isActive ? 'Deactivate' : 'Reactivate'} ${s.name}`);
      toggle.addEventListener('click', async () => {
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
      wrap.append(edit, toggle);
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
    const state = { from: '', to: '', schoolId: '', page: 1 };
    let all = [];
    let schoolNames = new Map();
    let truncated = false;

    const filters = h('div', 'tw-filter-bar');
    const fromInput = document.createElement('input'); fromInput.type = 'date'; fromInput.id = 'tw-c1-from';
    const toInput = document.createElement('input'); toInput.type = 'date'; toInput.id = 'tw-c1-to';
    const schoolSelect = selectOf([], { placeholder: 'All schools' });
    schoolSelect.id = 'tw-c1-school';
    const wrapField = (text, input) => {
      const wrap = h('div', 'form-stack tw-field');
      const label = h('label', 'label', text);
      label.htmlFor = input.id;
      wrap.append(label, input);
      return wrap;
    };
    const clear = h('button', 'ghost', 'Clear filters');
    clear.type = 'button';
    filters.append(wrapField('From', fromInput), wrapField('To', toInput), wrapField('School', schoolSelect), clear);

    const note = h('p', 'tw-notice', 'Annex C-1 is factual and short. The summary, action taken and status notes are separate from the confidential incident narrative and must not name students or victims. Secretary or Admin add them on the incident.');
    const tableHost = h('div');
    host.append(note, filters, tableHost);

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
        const lh = await loadLetterhead(user);
        const preview = openPrintPreviewModal({
          title: 'Annex C-1 — Incident Report, Safer School Zones',
          subtitle: `${toPrint.length} incident${toPrint.length === 1 ? '' : 's'}`,
          sheetId: 'printable-annex-c1',
          sheetHtml: buildAnnexC1Html(toPrint.map(toC1Row), lh),
        });
        applyPrintOrientation(preview, 'landscape');
      } finally {
        printBtn.disabled = false;
      }
    });

    const apply = () => {
      state.from = fromInput.value; state.to = toInput.value; state.schoolId = schoolSelect.value; state.page = 1;
      renderTable();
    };
    fromInput.addEventListener('change', apply);
    toInput.addEventListener('change', apply);
    schoolSelect.addEventListener('change', apply);
    clear.addEventListener('click', () => { fromInput.value = ''; toInput.value = ''; schoolSelect.value = ''; apply(); });

    function filtered() {
      return all.filter((i) => {
        const day = manilaDateOf(i.createdAt);
        if (state.from && day < state.from) return false;
        if (state.to && day > state.to) return false;
        if (state.schoolId && String(i.schoolId) !== state.schoolId) return false;
        return true;
      });
    }

    async function ensureReferrals(rows) {
      const missing = rows.filter((r) => !referralCache.has(r.incidentId));
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
        schoolName: schoolNames.get(i.schoolId) || i.schoolName || `School #${i.schoolId}`,
        when: formatManilaDateTime(i.createdAt),
        location: i.locationDescription || '',
        narrative: i.c1Summary || '',
        action: i.c1ActionTaken || '',
        referredTo: referredText(i.incidentId) ?? '',
        personnel: i.officerName || '',
        status: i.c1StatusNotes || typeLabel(i.status),
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
        await renderTable();
      } catch (err) {
        showError(tableHost, err, load, 'Could not load school incidents.');
      }
    }

    async function renderTable() {
      const rows = filtered();
      tableHost.innerHTML = '';
      if (all.length === 0) {
        showEmpty(tableHost, 'No school incidents', 'Incidents appear here once they are linked to a school. Link a school from the incident, or when it is reported.');
        return;
      }
      if (rows.length === 0) {
        showEmpty(tableHost, 'No incidents match', 'Adjust the dates or school filter.');
        return;
      }
      const start = (state.page - 1) * INCIDENT_PAGE_SIZE;
      const slice = rows.slice(start, start + INCIDENT_PAGE_SIZE);
      showLoading(tableHost, 'Loading referrals');
      await ensureReferrals(slice);
      tableHost.innerHTML = '';

      const items = [{ label: 'School incidents', value: rows.length }];
      tableHost.appendChild(StatStrip({ items }));
      if (truncated) {
        tableHost.appendChild(h('p', 'tw-notice tw-notice--warning', 'Only the most recent incidents were scanned for school links. Older school incidents may be missing here.'));
      }
      tableHost.appendChild(DataTable({
        columns: [
          { key: 'school', label: 'School' },
          { key: 'when', label: 'When' },
          { key: 'where', label: 'Exact location' },
          { key: 'what', label: 'Brief summary' },
          { key: 'action', label: 'Action taken' },
          { key: 'referred', label: 'Referred / reported to' },
          { key: 'who', label: 'Responding personnel' },
          { key: 'status', label: 'Status / notes' },
        ],
        rows: slice,
        rowKey: (i) => i.incidentId,
        caption: 'School incidents (Annex C-1)',
        emptyMessage: 'No incidents on this page.',
        emptyIcon: icons.shield,
        onRowClick: (i) => navigate('incident-detail', i.incidentId),
        page: state.page,
        totalItems: rows.length,
        pageSize: INCIDENT_PAGE_SIZE,
        onPageChange: (next) => { state.page = next; renderTable(); },
        renderCell: (i, key) => {
          const c1 = toC1Row(i);
          switch (key) {
            case 'school': return h('span', 'tw-strong', c1.schoolName);
            case 'when': return h('span', '', c1.when);
            case 'where': return h('span', '', c1.location || '—');
            case 'what': return h('span', '', c1.narrative || '—');
            case 'action': return h('span', '', c1.action || '—');
            case 'referred': return h('span', '', referredText(i.incidentId) ?? 'Unavailable');
            case 'who': return h('span', '', c1.personnel || '—');
            case 'status': return h('span', '', c1.status || '—');
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
    let mine = { authority: new Set(), officialTitle: null, failed: false };
    const livePanel = h('div');
    const listHost = h('div');
    const detailHost = h('div');
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
      const el = card('Live counts for a term', 'Computed now from check-ins, schools and referrals. Nothing is saved until you create a draft.');
      const label = document.createElement('input'); label.maxLength = 40; label.placeholder = 'e.g. Term 1 S.Y. 2026-2027';
      const start = document.createElement('input'); start.type = 'date';
      const end = document.createElement('input'); end.type = 'date';
      const remarks = document.createElement('textarea'); remarks.rows = 2; remarks.maxLength = 1000;

      const grid = h('div', 'tw-form-grid');
      grid.append(field('Term label', label).wrap, field('Term starts', start).wrap, field('Term ends', end).wrap);
      el.appendChild(grid);

      const countsHost = h('div', 'tw-counts-host');
      const error = h('p', 'tw-form-error'); error.setAttribute('role', 'alert'); error.hidden = true;
      const actions = h('div', 'tw-action-bar');

      el.append(countsHost);

      let createBtn = null;
      if (canEdit) {
        const remarksField = field('Remarks (technical assistance needed, key issues, good practices)', remarks);
        el.appendChild(remarksField.wrap);
        createBtn = h('button', 'primary', 'Create draft term report');
        createBtn.type = 'button';
        actions.appendChild(createBtn);
      }
      el.append(error, actions);
      livePanel.appendChild(el);

      let seq = 0;
      async function refreshCounts() {
        error.hidden = true;
        if (!start.value || !end.value) {
          countsHost.innerHTML = '';
          countsHost.appendChild(h('p', 'tw-empty-note', 'Pick the first and last day of the term to see live counts.'));
          return;
        }
        if (start.value > end.value) {
          countsHost.innerHTML = '';
          countsHost.appendChild(h('p', 'tw-empty-note', 'The term start is after the term end.'));
          return;
        }
        const mySeq = ++seq;
        showLoading(countsHost, 'Loading live term counts');
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

    async function loadList() {
      showLoading(listHost, 'Loading term reports');
      try {
        const res = await getTermReports();
        listHost.innerHTML = '';
        const el = card('Saved term reports');
        if (res.items.length === 0) {
          el.appendChild(h('p', 'tw-empty-note', canEdit ? 'No term reports yet. Create a draft above once a term range is chosen.' : 'No term reports have been created yet.'));
        } else {
          el.appendChild(DataTable({
            columns: [
              { key: 'label', label: 'Term' },
              { key: 'range', label: 'Dates' },
              { key: 'status', label: 'Status' },
              { key: 'incidents', label: 'Incidents', align: 'right' },
            ],
            rows: res.items,
            rowKey: (r) => r.reportId,
            caption: 'Saved term reports',
            emptyMessage: 'No term reports.',
            emptyIcon: icons.fileText,
            onRowClick: (r) => openDetail(r.reportId),
            renderCell: (r, key) => {
              switch (key) {
                case 'label': return h('span', 'tw-strong', r.termLabel);
                case 'range': return h('span', '', `${formatDateOnly(r.termStart)} to ${formatDateOnly(r.termEnd)}`);
                case 'status': return statusPill(r.status, 'term');
                case 'incidents': return h('span', '', r.totalIncidents ?? '—');
                default: return '';
              }
            },
          }));
        }
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

    async function personName(id) {
      if (!id) return '';
      if (id === user.userId) return user.fullName;
      try { return (await getUserById(id)).fullName; } catch { /* fall through */ }
      try { return (await getUserNames()).get(id) || ''; } catch { return ''; }
    }

    function renderDetail(report) {
      detailHost.innerHTML = '';
      pageHeader.actions.innerHTML = '';

      const back = h('button', 'ghost', 'Back to term reports');
      back.type = 'button';
      back.addEventListener('click', () => { pageHeader.actions.innerHTML = ''; showList(); });

      const printBtn = h('button', 'ghost');
      printBtn.type = 'button';
      printBtn.innerHTML = `${icons.printer(16)}<span>Preview &amp; print Annex D</span>`;
      printBtn.addEventListener('click', async () => {
        printBtn.disabled = true;
        try {
          const [lh, preparedByName, approvedByName] = await Promise.all([
            loadLetterhead(user),
            report.preparedByName ? Promise.resolve(report.preparedByName) : personName(report.preparedBy),
            report.approvedByName ? Promise.resolve(report.approvedByName) : personName(report.approvedBy),
          ]);
          openPrintPreviewModal({
            title: 'Annex D — Safer School Zones Term-Based Report',
            subtitle: `${report.termLabel} · ${TERM_STATUS_LABELS[report.status] || report.status}`,
            sheetId: 'printable-annex-d',
            sheetHtml: buildAnnexDHtml(report, lh, { preparedByName, approvedByName }),
          });
        } finally {
          printBtn.disabled = false;
        }
      });
      pageHeader.actions.appendChild(printBtn);

      const head = card();
      const row = h('div', 'tw-detail-head__row');
      const titles = h('div');
      titles.append(
        h('h3', 'tw-card__title', report.termLabel),
        h('p', 'tw-card__subtitle', `${formatDateOnly(report.termStart)} to ${formatDateOnly(report.termEnd)}`),
      );
      row.append(titles, statusPill(report.status, 'term'));
      head.appendChild(row);
      head.appendChild(countsGrid(report));
      if (report.status === 'draft') {
        head.appendChild(h('p', 'tw-notice', 'These counts are a snapshot from when the draft was created. Preparing the report recomputes them from live data.'));
      }
      if (report.otherInstitutions) head.appendChild(h('p', 'tw-other-inst', `Other institutions: ${report.otherInstitutions}`));
      if (report.remarks && !(report.status === 'draft' && canEdit)) head.appendChild(h('p', 'tw-remarks', `Remarks: ${report.remarks}`));

      const trail = h('ul', 'tw-trail');
      const addTrail = (label, value) => {
        const li = h('li', 'tw-trail__item');
        li.append(h('span', 'tw-trail__label', label), h('span', 'tw-trail__value', value));
        trail.appendChild(li);
      };
      if (report.preparedAt) addTrail('Prepared', formatManilaDateTime(report.preparedAt));
      if (report.approvedAt) addTrail('Approved', formatManilaDateTime(report.approvedAt));
      if (report.mayorOfficeReceivedBy) addTrail('Received by Office of the Mayor', `${report.mayorOfficeReceivedBy}${report.mayorOfficeReceivedAt ? ` · ${formatDateOnly(report.mayorOfficeReceivedAt)}` : ''}`);
      if (report.dilgReceivedBy || report.dilgDateReceived) addTrail('DILG copy received', `${report.dilgReceivedBy || '—'}${report.dilgDateReceived ? ` · ${formatDateOnly(report.dilgDateReceived)}` : ''}`);
      if (trail.children.length) head.appendChild(trail);

      detailHost.append(back, head);

      if (report.status === 'draft' && canEdit) detailHost.appendChild(buildDraftEditor(report));
      detailHost.appendChild(buildTermActions(report));
    }

    function buildDraftEditor(report) {
      const el = card('Remarks and other institutions', 'Editable while the report is a draft.');
      const remarks = document.createElement('textarea'); remarks.rows = 3; remarks.maxLength = 1000; remarks.value = report.remarks ?? '';
      const other = document.createElement('input'); other.maxLength = 500; other.value = report.otherInstitutions ?? '';
      el.append(
        field('Remarks (technical assistance needed, key issues, good practices)', remarks).wrap,
        field('Other institutions referred to (separate with semicolons)', other).wrap,
      );
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
      el.append(error, save);
      return el;
    }

    function buildTermActions(report) {
      const el = card('Actions');
      const bar = h('div', 'tw-action-bar');
      const preparedBySelf = report.preparedBy === user.userId;

      const canPrepare = report.status === 'draft' && mine.authority.has('prepare_annex_d');
      const canApprove = report.status === 'prepared' && mine.authority.has('approve_annex_d') && !preparedBySelf;
      const canSubmit = report.status === 'approved' && canEdit;

      if (canPrepare) {
        const btn = h('button', 'primary', 'Prepare report');
        btn.type = 'button';
        btn.addEventListener('click', async () => {
          const ok = await confirmDialog({
            title: 'Prepare this term report?',
            description: 'The counts are recomputed from live data and the report moves to Prepared. Someone else must approve it.',
            confirmLabel: 'Prepare report',
            onConfirmAsync: async () => { try { await prepareTermReport(report.reportId); } catch (err) { throw new Error(actionErrorMessage(err)); } },
          });
          if (ok) { showToast('Term report prepared.', { variant: 'success' }); loadDetail(report.reportId); }
        });
        bar.appendChild(btn);
      }
      if (canApprove) {
        const btn = h('button', 'primary', 'Approve report');
        btn.type = 'button';
        btn.addEventListener('click', async () => {
          const ok = await confirmDialog({
            title: 'Approve this term report?',
            description: 'Approval is final. It can then be printed, signed and marked as submitted.',
            confirmLabel: 'Approve report',
            onConfirmAsync: async () => { try { await approveTermReport(report.reportId); } catch (err) { throw new Error(actionErrorMessage(err)); } },
          });
          if (ok) { showToast('Term report approved.', { variant: 'success' }); loadDetail(report.reportId); }
        });
        bar.appendChild(btn);
      }
      if (bar.children.length) el.appendChild(bar);

      if (canSubmit) el.appendChild(buildSubmitForm(report));

      if (!bar.children.length && !canSubmit) {
        el.appendChild(h('p', 'tw-empty-note', termNoActionText(report, preparedBySelf)));
      }
      return el;
    }

    function termNoActionText(report, preparedBySelf) {
      if (mine.failed) return 'Could not check your approval authority, so no actions are offered. Reload to try again.';
      if (report.status === 'draft') return 'Waiting for someone with the Annex D prepare authority to prepare this report.';
      if (report.status === 'prepared') return preparedBySelf
        ? 'You prepared this report, so someone else with the approve authority must approve it.'
        : 'Waiting for an official with the Annex D approve authority.';
      if (report.status === 'approved') return 'Approved. An Admin or Secretary records receipt once it is submitted.';
      return 'This report has been submitted. Nothing further to do.';
    }

    function buildSubmitForm(report) {
      const wrap = h('div', 'tw-submit-form');
      wrap.appendChild(h('h4', 'tw-subhead', 'Mark as submitted'));
      wrap.appendChild(h('p', 'tw-card__subtitle', 'Record who at the Office of the Mayor received the signed report, and the DILG copy if known.'));
      const mayorBy = document.createElement('input'); mayorBy.maxLength = 120;
      const mayorAt = document.createElement('input'); mayorAt.type = 'date';
      const dilgBy = document.createElement('input'); dilgBy.maxLength = 120;
      const dilgAt = document.createElement('input'); dilgAt.type = 'date';
      const grid = h('div', 'tw-form-grid');
      grid.append(
        field('Received by (Office of the Mayor)', mayorBy).wrap,
        field('Date received', mayorAt).wrap,
        field('DILG copy received by (optional)', dilgBy).wrap,
        field('DILG date received (optional)', dilgAt).wrap,
      );
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
      wrap.append(grid, error, btn);
      return wrap;
    }

    // ----- boot ---------------------------------------------------------------

    (async () => {
      mine = await getMyAuthority(user);
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

/** Tiles for the Annex D counts, used for both the live preview and a saved snapshot. */
function countsGrid(counts) {
  const grid = h('div', 'tw-counts');
  for (const [key, label] of COUNT_TILES) {
    const tile = h('div', 'tw-count-tile');
    tile.append(h('span', 'tw-count-tile__value', counts[key] ?? '—'), h('span', 'tw-count-tile__label', label));
    grid.appendChild(tile);
  }
  return grid;
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
      ${letterheadHtml(lh, { office: true })}
      ${titleBlock}
      <table class="tw-print__table tw-print__table--inv">
        <thead><tr>
          <th>Name of School</th><th>Public/<br>Private</th><th>Level</th><th>Complete Address</th>
          <th>SSZ Focal Person</th><th>SSZ Focal Contact<br>Number</th><th>Remarks<br>(include possible hotspots)</th>
        </tr></thead>
        <tbody>${rows}</tbody>
      </table>
      <div class="tw-print__page-break"></div>
      ${letterheadHtml(lh, { office: true })}
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

function buildAnnexC1Html(rows, lh) {
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
      ${letterheadHtml(lh, { office: true })}
      <p class="tw-print__title">ANNEX C-1 &ndash; PORMULARYO NG ULAT SA INSIDENTE SA SAFER SCHOOL ZONES</p>
      <p class="tw-print__subtitle">${SSZ_PURSUANT_HTML}</p>
      <p class="tw-print__intro">Itala ang mga insidente o panganib na nangyari sa, o may direktang epekto sa, <i>school zone</i>. Panatilihing batay sa katotohanan, maikli, at hindi para sa imbestigasyon o pagtukoy ng pananagutan.</p>
      <table class="tw-print__table tw-print__table--c1">
        <thead><tr>
          <th>Pangalan ng Paaralan na malapit sa pinangyarihan ng insidente</th>
          <th>Oras / Petsa ng Insidente (Kailan)</th>
          <th>Eksaktong Lugar (Saan)</th>
          <th>Maikling Salaysay ng Insidente (Ano ang Nangyari at Paano)</th>
          <th>Ginawang Aksyon</th>
          <th>ISINANGGUNI O INIULAT SA<div class="tw-print__th-sub">(PNP / BFP / Higher LGU / DPWH / DOH / Iba pa, gaya ng 911)</div></th>
          <th>Tumugong Tauhan ng Barangay</th>
          <th>Kalagayan / Mga Tala</th>
        </tr></thead>
        <tbody>${body}</tbody>
      </table>
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

function buildAnnexDHtml(report, lh, { preparedByName, approvedByName }) {
  const letterheadD = `
    <div class="tw-print__letterhead">
      <p class="tw-print__republic">Republic of the Philippines</p>
      <p class="tw-print__brgy">Barangay <u>${escapeHtml(lh.barangayName || '')}</u></p>
      <p class="tw-print__line">City/Municipality of <b>${escapeHtml((lh.municipality || '').toUpperCase())}</b></p>
      <p class="tw-print__line">Province of ${escapeHtml(lh.province || '')}</p>
    </div>`;
  const titleD = `<p class="tw-print__title">ANNEX &ldquo;D&rdquo; &ndash; SAFER SCHOOL ZONES TERM-BASED REPORT FORM &ndash; ${escapeHtml((report.termLabel || '').toUpperCase())}</p>`;
  const cell = (v) => `<td>${escapeHtml(v === undefined || v === null ? '' : String(v))}</td>`;

  return `
    <div class="tw-print">
      ${letterheadD}
      ${titleD}
      <p class="tw-print__subtitle">${SSZ_PURSUANT_HTML}</p>
      <p class="tw-print__note-line">To be submitted to the Office of the Mayor, copy furnished the concerned C/MLGOO or DILG City Director, on or before the applicable deadline prescribed under DILG Memorandum Circular No. 2026-037</p>

      <table class="tw-print__table tw-print__table--term">
        <tr><th>Reporting TERM</th></tr>
        <tr><td>${escapeHtml(report.termLabel || '')} (${escapeHtml(formatDateOnly(report.termStart))} &ndash; ${escapeHtml(formatDateOnly(report.termEnd))})</td></tr>
      </table>
      <table class="tw-print__table tw-print__table--term">
        <tr>
          <th><b>Total Number of Tanods</b><br>(Annual Reporting every Term 1)</th>
          <th>Total No. of Schools Covered</th>
          <th>Total No. of Days with Tanod Deployment in Schools</th>
          <th>Total No. of Incidents Logged (As also reflected in Annex &ldquo;C-1&rdquo;)</th>
          <th>Remarks (Technical Assistance Needed / Key Issues &amp; Notable Good Practices / Notes)</th>
        </tr>
        <tr>${cell(report.totalTanods)}${cell(report.totalSchools)}${cell(report.totalDeploymentDays)}${cell(report.totalIncidents)}${cell(report.remarks)}</tr>
      </table>
      <table class="tw-print__table tw-print__table--term">
        <tr><td colspan="8" class="tw-print__cap">TOTAL NUMBER OF INCIDENTS THAT (As also reflected in Annex &ldquo;C-1&rdquo;):</td></tr>
        <tr>
          <th>Acted upon by the Barangay and without referral</th><th>Referred to the PNP</th><th>Referred to the BFP</th>
          <th>Referred to the Higher LGU (City/ Municipality)</th><th>Referred to the DOH</th><th>Referred to the DPWH</th>
          <th>Referred to other Agencies/Institutions</th>
          <th>[Please Indicate the name of institutions, Multiple Entries are allowed Ex: Department of Agriculture (DA)]</th>
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
      ${letterheadD}
      ${titleD}
      <div class="tw-print__sigbox">
        <div class="tw-print__sigrow">
          <div class="tw-print__sigcell">
            <p class="tw-print__siglbl">Prepared by:</p>
            <div class="tw-print__sigline">${escapeHtml(preparedByName || '')}</div>
            ${report.preparedByTitle ? `<p class="tw-print__sigtitle">${escapeHtml(report.preparedByTitle)}</p>` : ''}
            <p class="tw-print__sigcap">Chief Tanod/ Executive Officer</p>
          </div>
          <div class="tw-print__sigcell">
            <p class="tw-print__siglbl">Approved by:</p>
            <div class="tw-print__sigline">${escapeHtml(approvedByName || '')}</div>
            ${report.approvedByTitle ? `<p class="tw-print__sigtitle">${escapeHtml(report.approvedByTitle)}</p>` : ''}
            <p class="tw-print__sigcap">Punong Barangay/ BPOC Chairperson</p>
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
    </div>`;
}
