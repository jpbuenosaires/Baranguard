/**
 * incident-management.js — Phase 5 of the mockup-driven UI round 2
 * (see .claude/plans/clever-wishing-hummingbird.md), extended by the
 * 2026-09-05 UX pass (see .claude/plans/fancy-crafting-lark.md) to add an
 * inline detail pane and a direct Dispatch Tanod action.
 *
 * Before that pass, this screen only listed incidents and forwarded a row
 * click to `blotter-detail.js` — there was no way to view or act on an
 * incident (dispatch a Tanod, see who's assigned) without leaving the
 * screen and re-finding it in Dispatch Center's separate queue. This now
 * mirrors `blotter-list.js`'s already-established list+detail-pane
 * pattern (`split-panel`, `DataTable`'s `selectedKey`/`onRowClick`) so an
 * operator can triage AND act from one screen.
 *
 * Distinct from W6 Electronic Blotter (`blotter-list.js`/
 * `blotter-detail.js`), which is the finalized-record view over
 * `blotter_record`, not `incident`. This screen's detail pane never
 * duplicates the finalize/amend workflow — a Secretary's "Open Blotter
 * workflow" button here just navigates into the existing, unchanged
 * `blotter-detail.js`.
 *
 * Backed entirely by already-built endpoints — no new backend surface.
 * `GET /incidents` (status/priority/page/limit, tenant + role scoped
 * server-side) drives the list. The detail pane adds `GET /incidents/:id`
 * (already used by `blotter-detail.js`) and, Admin-only, `GET /dispatch`
 * + `GET /users` + `GET /duty-status` — the exact same calls
 * `dispatch-center.js` already makes for its own Tanod picker.
 *
 * Role-gated by what those backend endpoints already allow (see
 * fancy-crafting-lark.md's "Role-matrix constraints" section):
 *   - `GET /users` and `GET /dispatch` are Admin-only server-side
 *     (`UsersController`/`DispatchController`) — Secretary gets a 403 on
 *     both. So the Dispatch Tanod action and the assigned-Tanod Contact
 *     button only ever render for Admin; Secretary sees the officer's
 *     name only (`officerName`, already on the list item) with no
 *     contact affordance and no dispatch action, matching §3 exactly.
 *   - Dispatch creation stays Admin-only
 *     (`DispatchController::create` -> `requireRole(['admin'])`).
 *   - Only Secretary may work the blotter (§3), so "Open Blotter
 *     workflow" is Secretary-only, never shown to Admin — copying the
 *     mockup's generic "Create Blotter" button as an Admin-visible action
 *     would violate that split.
 *
 * Status chips use the real 3-state model (`pending`/`dispatched`/
 * `resolved`) already on `incident.status` — deliberately not the
 * mockup's invented `Active/Responding/Closed` states, which don't exist
 * anywhere in §5's schema.
 *
 * Full-text search was deliberately left out of this cut (logged in the
 * plan): `GET /incidents` has no `q=` param, and `GET /search` caps at 10
 * results with no location/officer fields — reusing it here would mean a
 * second, thinner list shape sitting inside the same table. Chips +
 * priority + pagination cover the mockup's real filtering intent.
 *
 * Roles: Admin and Secretary — the two roles that actually work incidents
 * end-to-end. Punong Barangay's incident-facing screen is the finalized
 * Blotter record view; Tanod is mobile-only.
 *
 * Also carries the "New Entry" incident-creation form W6 used to host —
 * moved here in Phase 6, since logging a brand-new incident is
 * operational work on `incident`, not the finalized `blotter_record` W6
 * became a view over. It now shares the same right-hand pane slot as the
 * detail view (mutually exclusive: form OR selected-incident detail OR
 * the default placeholder) rather than toggling the whole layout to a
 * single column.
 *
 * kebab-case filename per §4.
 */

import {
  getIncidents, createIncident, getIncident, getUsers, getDutyStatus, getDispatches,
  updateIncidentStatus, logout, ApiClientError,
} from '../api/apiClient.js';
import { AppShell } from '../components/AppShell.js';
import { PageHeader } from '../components/PageHeader.js';
import { DataTable } from '../components/DataTable.js';
import { icons } from '../components/icons.js';
import { showToast } from '../components/Toast.js';
import { confirmDialog } from '../components/ConfirmDialog.js';
import { promptDispatchTanod } from '../components/DispatchAction.js';

const INCIDENT_TYPE_LABELS = {
  theft: 'Theft', physical_injury: 'Physical Injury', disturbance: 'Disturbance',
  domestic_dispute: 'Domestic Dispute', vandalism: 'Vandalism',
  traffic_incident: 'Traffic Incident', fire: 'Fire',
  medical_emergency: 'Medical Emergency', missing_person: 'Missing Person',
  animal_complaint: 'Animal Complaint', other: 'Other',
};
const STATUS_PILL_CLASS = { pending: 'status-pill--pending', dispatched: 'status-pill--info', resolved: 'status-pill--success' };
const PRIORITY_PILL_CLASS = { normal: 'status-pill--neutral', high: 'status-pill--pending', critical: 'status-pill--critical' };
const STATUSES = ['pending', 'dispatched', 'resolved'];
// Display-only relabeling (2026-09-05 UX pass) — the mockup's operator-
// facing language ("Active"/"Responding") reads better than the raw enum
// name, but the enum itself never changes: filter values, API params, and
// `incident.status` all stay pending/dispatched/resolved exactly as
// before. Never add a 4th value here — there is no 'closed' state
// anywhere in §5's schema (see this file's own header).
const STATUS_DISPLAY_LABELS = { pending: 'Active', dispatched: 'Responding', resolved: 'Resolved' };
const PAGE_SIZE = 25;
const SEARCH_DEBOUNCE_MS = 400;

const COLUMNS = [
  { key: 'incident', label: 'Incident' },
  { key: 'location', label: 'Location' },
  { key: 'tanod', label: 'Tanod Assigned' },
  { key: 'priority', label: 'Priority' },
  { key: 'status', label: 'Status', align: 'right' },
  { key: 'open', label: '', width: '3rem', align: 'right' },
];

/**
 * @param {HTMLElement} root
 * @param {{fullName:string, role:string, barangayId:number}} user
 * @param {() => void} onLoggedOut
 * @param {(page: string, param?: any) => void} navigate
 */
export function renderIncidentManagementPage(root, user, onLoggedOut, navigate) {
  root.innerHTML = '';

  const isAdmin = user.role === 'admin';
  const isSecretary = user.role === 'secretary';
  const canCreate = isAdmin || isSecretary;

  const shell = AppShell(user, 'incident-management', navigate, async () => {
    shell.logoutButton.disabled = true;
    await logout();
    onLoggedOut();
  });
  const { header, content } = shell;
  root.appendChild(shell.el);

  const pageHeader = PageHeader({
    title: 'Incident Management',
    subtitle: 'Every logged incident, any status — filter by stage or priority',
    icon: icons.alertTriangle,
  });
  header.appendChild(pageHeader.el);

  let showForm = false;
  if (canCreate) {
    const newButton = document.createElement('button');
    newButton.type = 'button';
    newButton.className = 'primary';
    newButton.innerHTML = `<span aria-hidden="true">${icons.plus(16)}</span><span>Log Incident</span>`;
    newButton.addEventListener('click', () => {
      showForm = !showForm;
      if (showForm) selectedIncidentId = null;
      renderRightPane();
    });
    pageHeader.actions.appendChild(newButton);
  }

  const chipRow = document.createElement('div');
  chipRow.className = 'filter-chip-row';
  const chips = {};
  for (const key of ['all', ...STATUSES]) {
    const chip = document.createElement('button');
    chip.type = 'button';
    chip.className = 'filter-chip';
    chip.textContent = key === 'all' ? 'All' : STATUS_DISPLAY_LABELS[key];
    chip.addEventListener('click', () => { statusFilter = key === 'all' ? undefined : key; currentPage = 1; syncChips(); load(); });
    chips[key] = chip;
    chipRow.appendChild(chip);
  }

  const filterPanel = document.createElement('div');
  filterPanel.className = 'filter-panel';
  filterPanel.appendChild(chipRow);

  // Search (2026-09-05 UX pass): real server-side `q=` — see
  // apiClient.js's getIncidents() doc for why this isn't a client-side
  // filter over one loaded page. Debounced so every keystroke doesn't
  // fire a request.
  let searchQuery = undefined;
  let searchDebounceHandle = null;
  const searchWrap = document.createElement('div');
  searchWrap.className = 'filter-panel__search';
  const searchIcon = document.createElement('span');
  searchIcon.className = 'filter-panel__search-icon';
  searchIcon.setAttribute('aria-hidden', 'true');
  searchIcon.innerHTML = icons.search(16);
  const searchLabel = document.createElement('label');
  searchLabel.className = 'sr-only';
  searchLabel.htmlFor = 'incident-mgmt-search';
  searchLabel.textContent = 'Search incidents';
  const searchInput = document.createElement('input');
  searchInput.id = 'incident-mgmt-search';
  searchInput.type = 'search';
  searchInput.placeholder = 'Search by case number or type…';
  searchInput.addEventListener('input', () => {
    clearTimeout(searchDebounceHandle);
    searchDebounceHandle = setTimeout(() => {
      searchQuery = searchInput.value.trim() || undefined;
      currentPage = 1;
      load();
    }, SEARCH_DEBOUNCE_MS);
  });
  searchWrap.append(searchIcon, searchLabel, searchInput);
  filterPanel.appendChild(searchWrap);

  const prioritySelect = document.createElement('select');
  prioritySelect.setAttribute('aria-label', 'Filter by priority');
  for (const [value, label] of [['', 'All priorities'], ['normal', 'Normal'], ['high', 'High'], ['critical', 'Critical']]) {
    const option = document.createElement('option');
    option.value = value;
    option.textContent = label;
    prioritySelect.appendChild(option);
  }
  prioritySelect.addEventListener('change', () => { currentPage = 1; load(); });
  filterPanel.appendChild(prioritySelect);
  header.appendChild(filterPanel);

  const layout = document.createElement('div');
  layout.className = 'split-panel';
  content.appendChild(layout);

  const listPane = document.createElement('div');
  layout.appendChild(listPane);

  // Right-hand pane: placeholder / Log Incident form / selected incident
  // detail — exactly one of the three, same mutually-exclusive-slot
  // pattern `blotter-list.js` already uses for its own detail pane.
  const detailPane = document.createElement('div');
  detailPane.className = 'blotter-detail-pane';
  layout.appendChild(detailPane);

  let statusFilter = undefined;
  let currentPage = 1;
  let selectedIncidentId = null;
  let lastItems = [];

  // Admin-only Tanod roster + on-duty set for the Dispatch Tanod action —
  // same computation `dispatch-center.js` already does, loaded once here
  // rather than on every row selection. Secretary never calls this: both
  // `GET /users` and the on-duty lookup are Admin-only server-side (see
  // this file's own header), so a Secretary session would only get a
  // 403 for no benefit — the Dispatch action never renders for her.
  let eligibleTanods = [];
  let tanodRosterById = new Map();
  if (isAdmin) loadTanodRoster();

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
      // The Dispatch action degrades to "no on-duty Tanods" rather than
      // blocking the rest of the screen — the list and its filters still
      // work regardless of this roster fetch's outcome.
    }
  }

  function syncChips() {
    for (const [key, chip] of Object.entries(chips)) {
      const active = (key === 'all' && statusFilter === undefined) || key === statusFilter;
      chip.classList.toggle('is-active', active);
    }
  }
  syncChips();
  refreshChipCounts();
  renderDetailPlaceholder();

  async function refreshChipCounts() {
    try {
      const [all, pending, dispatched, resolved] = await Promise.all([
        getIncidents({ limit: 1 }),
        getIncidents({ status: 'pending', limit: 1 }),
        getIncidents({ status: 'dispatched', limit: 1 }),
        getIncidents({ status: 'resolved', limit: 1 }),
      ]);
      chips.all.textContent = `All (${all.total})`;
      chips.pending.textContent = `${STATUS_DISPLAY_LABELS.pending} (${pending.total})`;
      chips.dispatched.textContent = `${STATUS_DISPLAY_LABELS.dispatched} (${dispatched.total})`;
      chips.resolved.textContent = `${STATUS_DISPLAY_LABELS.resolved} (${resolved.total})`;
    } catch {
      // Chips are a filter convenience; a failed count fetch just leaves
      // the plain labels, the filters themselves still work.
    }
  }

  load();

  async function load() {
    renderLoading(listPane);
    try {
      const result = await getIncidents({
        status: statusFilter,
        priority: prioritySelect.value || undefined,
        q: searchQuery,
        page: currentPage,
        limit: PAGE_SIZE,
      });
      lastItems = result.items;
      renderList(result.items, result.total, (nextPage) => { currentPage = nextPage; load(); });
    } catch (err) {
      const message = err instanceof ApiClientError ? err.message : 'Something went wrong loading incidents.';
      renderError(listPane, message, load);
    }
  }

  function renderList(items, totalItems, onPageChange) {
    listPane.innerHTML = '';
    const table = DataTable({
      columns: COLUMNS,
      rows: items,
      rowKey: (row) => row.incidentId,
      selectedKey: selectedIncidentId,
      onRowClick: (row) => { showForm = false; selectIncident(row); },
      caption: 'Incidents',
      emptyIcon: icons.alertTriangle,
      emptyMessage: 'No incidents match these filters.',
      page: currentPage,
      totalItems,
      pageSize: PAGE_SIZE,
      onPageChange,
      renderCell: renderIncidentCell,
    });
    listPane.appendChild(table);
  }

  /** Same fast-path re-highlight `blotter-list.js` uses — DataTable's own
   * `selectedKey` prop already handles this on any full re-render (e.g.
   * from `load()`); this just avoids rebuilding the table for a plain
   * row click. */
  function highlightSelected() {
    for (const tr of listPane.querySelectorAll('tbody tr')) {
      tr.classList.remove('is-selected');
    }
    const idx = lastItems.findIndex((r) => r.incidentId === selectedIncidentId);
    const rows = listPane.querySelectorAll('tbody tr');
    if (idx > -1 && rows[idx]) rows[idx].classList.add('is-selected');
  }

  function renderRightPane() {
    if (showForm) {
      renderFormPane();
    } else if (selectedIncidentId != null) {
      const row = lastItems.find((r) => r.incidentId === selectedIncidentId);
      if (row) selectIncident(row);
      else renderDetailPlaceholder();
    } else {
      renderDetailPlaceholder();
    }
  }

  function renderFormPane() {
    detailPane.innerHTML = '';
    detailPane.appendChild(buildNewEntryForm(() => {
      showForm = false;
      renderRightPane();
      load();
      refreshChipCounts();
    }));
  }

  function renderDetailPlaceholder() {
    detailPane.innerHTML = '';
    const card = document.createElement('div');
    card.className = 'card state-block';
    card.innerHTML = '<h3>Select an entry</h3><p>Choose a row on the left to see its full record here.</p>';
    detailPane.appendChild(card);
  }

  /**
   * Selecting a row loads the richer `GET /incidents/:id` fields
   * (narrative, dispatch-stage timestamps) on top of the list row's own
   * fields (officerName, which only the collection endpoint returns).
   * Admin additionally resolves the assigned Tanod's contact number via
   * `GET /dispatch?incident_id=` + the already-loaded roster — never via
   * a name match, which would be ambiguous if two Tanods shared a name.
   */
  async function selectIncident(row) {
    selectedIncidentId = row.incidentId;
    highlightSelected(); // toggle the row's .is-selected class without a full table rebuild
    detailPane.innerHTML = '';
    const loadingCard = document.createElement('div');
    loadingCard.className = 'skeleton skeleton--block';
    loadingCard.setAttribute('role', 'status');
    loadingCard.setAttribute('aria-label', 'Loading incident detail');
    detailPane.appendChild(loadingCard);

    try {
      const detail = await getIncident(row.incidentId);
      let officerContact = null;
      if (isAdmin && row.status !== 'pending') {
        try {
          const dispatches = await getDispatches({ incidentId: row.incidentId, limit: 5 });
          const latest = dispatches.items[0]; // already ORDER BY dispatched_at DESC
          officerContact = latest ? tanodRosterById.get(latest.tanodId)?.contactNumber || null : null;
        } catch {
          // Contact is enrichment only — the panel still renders without it.
        }
      }
      renderDetail(row, detail, officerContact);
    } catch (err) {
      renderDetailError(err instanceof ApiClientError ? err.message : 'Could not load this incident.', row);
    }
  }

  function renderDetailError(message, row) {
    detailPane.innerHTML = '';
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
    detailPane.appendChild(block);
  }

  function renderDetail(row, detail, officerContact) {
    detailPane.innerHTML = '';
    const card = document.createElement('div');
    card.className = 'card';

    const heading = document.createElement('div');
    heading.className = 'row-between';
    const title = document.createElement('h3');
    title.textContent = `${row.displayId || '#' + row.incidentId} — ${INCIDENT_TYPE_LABELS[row.incidentType] || row.incidentType}`;
    const statusPill = document.createElement('span');
    statusPill.className = `status-pill ${STATUS_PILL_CLASS[row.status] || 'status-pill--neutral'}`;
    statusPill.textContent = STATUS_DISPLAY_LABELS[row.status] || row.status;
    heading.append(title, statusPill);
    card.appendChild(heading);

    const priorityPill = document.createElement('span');
    priorityPill.className = `status-pill ${PRIORITY_PILL_CLASS[row.priority] || 'status-pill--neutral'}`;
    priorityPill.textContent = `${row.priority} priority`;
    card.appendChild(priorityPill);

    const fields = document.createElement('dl');
    fields.className = 'detail-fields';
    const addField = (label, value) => {
      const dt = document.createElement('dt');
      dt.textContent = label;
      const dd = document.createElement('dd');
      dd.textContent = value;
      fields.append(dt, dd);
    };
    addField('Location', detail.locationDescription
      || (row.latitude != null && row.longitude != null
        ? `${row.latitude.toFixed(5)}, ${row.longitude.toFixed(5)}`
        : 'Not recorded'));
    addField('Reported', new Date(row.createdAt).toLocaleString());
    addField('Source', row.source);
    card.appendChild(fields);

    const officerRow = document.createElement('div');
    officerRow.className = 'row-between';
    const officerLabel = document.createElement('span');
    officerLabel.textContent = row.officerName ? `Assigned: ${row.officerName}` : 'Not yet assigned';
    officerRow.appendChild(officerLabel);
    if (officerContact) {
      const callLink = document.createElement('a');
      callLink.href = `tel:${officerContact}`;
      callLink.className = 'ghost';
      callLink.innerHTML = `<span aria-hidden="true">${icons.phone(16)}</span><span>Call</span>`;
      officerRow.appendChild(callLink);
    }
    card.appendChild(officerRow);

    const narrativeHeading = document.createElement('h4');
    narrativeHeading.textContent = 'Narrative';
    const narrativeBody = document.createElement('pre');
    narrativeBody.className = 'narrative-block';
    narrativeBody.textContent = detail.redactedNarrative || 'No approved redacted narrative yet.';
    card.append(narrativeHeading, narrativeBody);

    card.appendChild(buildMiniTimeline(detail));

    const actions = document.createElement('div');
    actions.className = 'blotter-detail-pane__actions';

    if (isAdmin) {
      actions.appendChild(buildDispatchAction(row));
      if (row.status === 'dispatched' && !detail.hasActiveDispatch) {
        actions.appendChild(buildResolveAction(row));
      }
    }
    if (isSecretary) {
      const blotterButton = document.createElement('button');
      blotterButton.type = 'button';
      blotterButton.className = 'ghost';
      blotterButton.innerHTML = `<span aria-hidden="true">${icons.fileText(16)}</span><span>Open Blotter workflow</span>`;
      blotterButton.addEventListener('click', () => navigate('blotter-detail', row.incidentId));
      actions.appendChild(blotterButton);
    }
    card.appendChild(actions);

    detailPane.appendChild(card);
  }

  /**
   * Admin-only Dispatch Tanod action — the one capability this screen
   * was missing entirely before this pass. Reuses
   * `promptDispatchTanod()` (extracted from `dispatch-center.js`) so both
   * screens share one Tanod-picker-dialog + `POST /dispatch` flow rather
   * than growing a second copy that could drift.
   */
  function buildDispatchAction(row) {
    const wrap = document.createElement('div');
    if (row.status !== 'pending') {
      const note = document.createElement('p');
      note.className = 'note';
      note.textContent = row.status === 'dispatched'
        ? 'A Tanod is already assigned to this incident.'
        : 'This incident is resolved.';
      wrap.appendChild(note);
      return wrap;
    }
    if (eligibleTanods.length === 0) {
      const note = document.createElement('p');
      note.className = 'note';
      note.textContent = 'No on-duty Tanods are available to assign right now.';
      wrap.appendChild(note);
      return wrap;
    }
    const button = document.createElement('button');
    button.type = 'button';
    button.className = 'primary';
    button.innerHTML = `<span aria-hidden="true">${icons.radio(16)}</span><span>Dispatch Tanod</span>`;
    button.addEventListener('click', async () => {
      button.disabled = true;
      const typeLabel = INCIDENT_TYPE_LABELS[row.incidentType] || row.incidentType;
      const dispatched = await promptDispatchTanod({ incident: row, incidentTypeLabel: typeLabel, eligibleTanods });
      if (dispatched) {
        await load();
        refreshChipCounts();
        const refreshed = lastItems.find((r) => r.incidentId === row.incidentId);
        if (refreshed) selectIncident(refreshed);
      } else {
        button.disabled = false;
      }
    });
    wrap.appendChild(button);
    return wrap;
  }

  /**
   * Admin-only Resolve action (2026-09-05 UX pass) — `PATCH
   * /incidents/:id/status` already existed and was already callable from
   * `blotter-detail.js`'s own Admin panel; this is a second entry point
   * into the SAME endpoint (not a new capability) so an Admin doesn't
   * have to leave Incident Management to close out a case. Only rendered
   * when the caller (`renderDetail`) has already confirmed the real
   * preconditions (`status==='dispatched' && !hasActiveDispatch`) —
   * mirrors `blotter-detail.js`'s `buildAdminResolvePanel()` exactly so
   * the two screens never disagree about wording or behavior.
   */
  function buildResolveAction(row) {
    const wrap = document.createElement('div');
    const button = document.createElement('button');
    button.type = 'button';
    button.className = 'primary';
    button.innerHTML = `<span aria-hidden="true">${icons.checkCircle(16)}</span><span>Resolve Incident</span>`;
    button.addEventListener('click', async () => {
      const confirmed = await confirmDialog({
        title: 'Mark this incident resolved?',
        description: 'This closes the incident. It cannot be reopened from this screen.',
        confirmLabel: 'Mark resolved',
        cancelLabel: 'Cancel',
      });
      if (!confirmed) return;
      button.disabled = true;
      button.textContent = 'Resolving…';
      try {
        await updateIncidentStatus(row.incidentId);
        showToast('Incident marked resolved.', { variant: 'success' });
        await load();
        refreshChipCounts();
        const refreshed = lastItems.find((r) => r.incidentId === row.incidentId);
        if (refreshed) selectIncident(refreshed);
      } catch (err) {
        button.disabled = false;
        button.innerHTML = `<span aria-hidden="true">${icons.checkCircle(16)}</span><span>Resolve Incident</span>`;
        showToast(err instanceof ApiClientError ? err.message : 'Could not resolve the incident.', { variant: 'error' });
      }
    });
    wrap.appendChild(button);
    return wrap;
  }

  /**
   * A smaller, 3-stage variant of `blotter-detail.js`'s own timeline —
   * Reported/Dispatched/Arrived only, since this screen has no blotter
   * data (redaction/finalize stages belong to the Blotter workflow the
   * Secretary's button above links into). Not extracted into a shared
   * helper: the two timelines show different stage sets, and the overlap
   * is small enough that a shared abstraction would add more indirection
   * than the ~25 lines it would save.
   */
  function buildMiniTimeline(detail) {
    const wrap = document.createElement('div');
    const heading = document.createElement('h4');
    heading.textContent = 'Timeline';
    wrap.appendChild(heading);

    const stages = [
      ['Reported', detail.createdAt],
      ['Dispatched', detail.dispatchedAt],
      ['Arrived on scene', detail.arrivedAt],
    ];

    const list = document.createElement('div');
    list.className = 'timeline';
    stages.forEach(([label, timestamp], i) => {
      const reached = Boolean(timestamp);
      const item = document.createElement('div');
      item.className = 'timeline__item';

      const rail = document.createElement('div');
      rail.className = 'timeline__rail';
      const node = document.createElement('span');
      node.className = 'timeline__node' + (reached ? ' timeline__node--done' : '');
      rail.appendChild(node);
      if (i < stages.length - 1) {
        const nextReached = Boolean(stages[i + 1][1]);
        const connector = document.createElement('span');
        connector.className = 'timeline__connector' + (reached && nextReached ? ' timeline__connector--done' : '');
        rail.appendChild(connector);
      }

      const body = document.createElement('div');
      body.className = 'timeline__body';
      const name = document.createElement('span');
      name.className = 'timeline__label' + (reached ? '' : ' timeline__label--pending');
      name.textContent = label;
      const value = document.createElement('span');
      value.className = 'timeline__value';
      value.textContent = reached ? new Date(timestamp).toLocaleString() : 'Not yet';
      body.append(name, value);

      item.append(rail, body);
      list.appendChild(item);
    });
    wrap.appendChild(list);
    return wrap;
  }
}

/** Moved from the old W6 blotter-list.js — see this file's own header. */
function buildNewEntryForm(onCreated) {
  const card = document.createElement('div');
  card.className = 'card';

  const heading = document.createElement('h3');
  heading.textContent = 'Log Incident';

  const form = document.createElement('form');
  form.className = 'form-stack';
  form.noValidate = true;

  const errorBox = document.createElement('div');
  errorBox.className = 'login-form__error';
  errorBox.setAttribute('role', 'alert');
  errorBox.hidden = true;

  const typeLabel = document.createElement('label');
  typeLabel.className = 'label';
  typeLabel.htmlFor = 'incident-new-type';
  typeLabel.textContent = 'Incident Type';
  const typeSelect = document.createElement('select');
  typeSelect.id = 'incident-new-type';
  for (const [value, label] of Object.entries(INCIDENT_TYPE_LABELS)) {
    const option = document.createElement('option');
    option.value = value;
    option.textContent = label;
    typeSelect.appendChild(option);
  }

  const narrativeLabel = document.createElement('label');
  narrativeLabel.className = 'label';
  narrativeLabel.htmlFor = 'incident-new-narrative';
  narrativeLabel.textContent = 'Narrative';
  const narrativeInput = document.createElement('textarea');
  narrativeInput.id = 'incident-new-narrative';
  narrativeInput.rows = 5;
  narrativeInput.required = true;
  narrativeInput.classList.add('textarea--resizable');

  // location_description (migration 0010, 2026-09-05 UX pass) — optional,
  // manual-entry-only this session (see that migration's own comment for
  // why mobile auto-reverse-geocoding is a separate, deferred effort).
  const locationLabel = document.createElement('label');
  locationLabel.className = 'label';
  locationLabel.htmlFor = 'incident-new-location';
  locationLabel.textContent = 'Location description (optional)';
  const locationInput = document.createElement('input');
  locationInput.type = 'text';
  locationInput.id = 'incident-new-location';
  locationInput.placeholder = 'e.g. Purok 3, near the market';

  // Complainant/respondent/contact (migration 0008, ported from
  // blotter-detail.js's `buildPartyFields()` — same three optional
  // fields, same widget shape, kept as its own small copy here rather
  // than an import since the two forms differ in surrounding markup and
  // this is a ~20-line widget, not shared state or logic worth the
  // cross-file indirection).
  const complainantLabel = document.createElement('label');
  complainantLabel.className = 'label';
  complainantLabel.textContent = 'Complainant name (optional)';
  const complainantInput = document.createElement('input');
  complainantInput.type = 'text';

  const respondentLabel = document.createElement('label');
  respondentLabel.className = 'label';
  respondentLabel.textContent = 'Respondent name (optional)';
  const respondentInput = document.createElement('input');
  respondentInput.type = 'text';

  const contactLabel = document.createElement('label');
  contactLabel.className = 'label';
  contactLabel.textContent = 'Contact number (optional)';
  const contactInput = document.createElement('input');
  contactInput.type = 'tel';

  const submitButton = document.createElement('button');
  submitButton.type = 'submit';
  submitButton.className = 'primary';
  submitButton.textContent = 'Log Entry';

  form.append(
    errorBox, typeLabel, typeSelect, narrativeLabel, narrativeInput,
    locationLabel, locationInput,
    complainantLabel, complainantInput, respondentLabel, respondentInput, contactLabel, contactInput,
    submitButton,
  );
  card.append(heading, form);

  form.addEventListener('submit', async (event) => {
    event.preventDefault();
    errorBox.hidden = true;

    const rawNarrative = narrativeInput.value.trim();
    if (!rawNarrative) {
      errorBox.textContent = 'Enter a narrative for this entry.';
      errorBox.hidden = false;
      return;
    }

    submitButton.disabled = true;
    submitButton.textContent = 'Logging…';
    try {
      await createIncident({
        incidentType: typeSelect.value,
        rawNarrative,
        locationDescription: locationInput.value.trim(),
        complainantName: complainantInput.value.trim(),
        respondentName: respondentInput.value.trim(),
        complainantContactNumber: contactInput.value.trim(),
        idempotencyKey: crypto.randomUUID(),
      });
      onCreated();
    } catch (err) {
      const message = err instanceof ApiClientError ? err.message : 'Could not log this entry.';
      errorBox.textContent = message;
      errorBox.hidden = false;
    } finally {
      submitButton.disabled = false;
      submitButton.textContent = 'Log Entry';
    }
  });

  return card;
}

function renderIncidentCell(row, key) {
  switch (key) {
    case 'incident': {
      const wrap = document.createElement('span');
      wrap.className = 'data-table__stacked';
      const top = document.createElement('span');
      top.className = 'data-table__stacked-primary';
      top.textContent = `${row.displayId || '#' + row.incidentId} — ${INCIDENT_TYPE_LABELS[row.incidentType] || row.incidentType}`;
      const bottom = document.createElement('span');
      bottom.className = 'data-table__sub';
      bottom.textContent = new Date(row.createdAt).toLocaleString();
      wrap.append(top, bottom);
      return wrap;
    }
    case 'location':
      if (row.locationDescription) return row.locationDescription;
      return row.latitude != null && row.longitude != null
        ? `${row.latitude.toFixed(4)}, ${row.longitude.toFixed(4)}`
        : '<span class="text-tertiary">—</span>';
    case 'tanod':
      return row.officerName || '<span class="text-tertiary">—</span>';
    case 'priority': {
      const span = document.createElement('span');
      span.className = `status-pill ${PRIORITY_PILL_CLASS[row.priority] || 'status-pill--neutral'}`;
      span.textContent = row.priority;
      return span;
    }
    case 'status': {
      const span = document.createElement('span');
      span.className = `status-pill ${STATUS_PILL_CLASS[row.status] || 'status-pill--neutral'}`;
      span.textContent = STATUS_DISPLAY_LABELS[row.status] || row.status;
      return span;
    }
    case 'open': {
      const chevron = document.createElement('span');
      chevron.className = 'row-open-hint';
      chevron.setAttribute('aria-hidden', 'true');
      chevron.innerHTML = icons.eye(16);
      return chevron;
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
  wrap.setAttribute('aria-label', 'Loading incidents');
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
