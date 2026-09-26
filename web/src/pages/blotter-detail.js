/**
 * blotter-detail.js — the case workspace: the app's single per-incident
 * detail view (§9's W7), now the shared shell for THREE in-case tabs —
 * Incident / Redaction / Blotter — one URL, no full page navigation
 * between them.
 *
 * 2026-09-27 REDESIGN (DEVLOG (38)), replacing the two-screen split this
 * file's own comment used to insist on keeping separate: a user-reported
 * "the blotter workflow is confusing" session found the real cause was
 * this record and its AI redaction step (formerly a standalone W8 page,
 * `ai-review.js`) living on two different page loads, connected only by
 * a shared progress bar (`BlotterWorkflow.js`) that could tell you WHERE
 * to go next but still made you go there via a full re-render — and that
 * "when does an incident actually become a blotter" was never a clearly
 * labelled moment, just a card that appeared mid-scroll once you'd
 * clicked through the right buttons. Both are fixed by three tabs on ONE
 * page, sharing one data load, with the workflow stepper's "Next step"
 * button now switching tabs instead of navigating:
 *
 *   - **Incident** — dossier, narrative, evidence, timeline, legal
 *     guide, and (Admin) the incident-resolution control. Every role
 *     that reaches this page gets this tab.
 *   - **Redaction** — `ai-review.js`'s content (redact, regenerate,
 *     approve, translate), unchanged in substance, now mounted as a tab
 *     via its exported `renderRedactionTab()`. Secretary only, matching
 *     what the old standalone page already restricted.
 *   - **Blotter** — finalize/amend (Secretary) or a read-only summary
 *     (Admin/Punong Barangay, if one exists), the Lupon packet control,
 *     and the W21 lifecycle actions (mark duplicate/invalid/cancelled/
 *     reopened). An explicit tab titled "Blotter" is itself the answer
 *     to "when does this become a blotter" — it's the one place that
 *     says so, instead of an unlabelled mid-page card.
 *
 * STILL TRUE, unchanged by the redesign: the standalone blotter records
 * list (W6) stays removed (DILG BIMSS/KPIS is the mandated Katarungang
 * Pambarangay ledger — see docs/REFERENCE.md §1). Nothing here lists or
 * browses blotters; this is still only reachable per-incident, and the
 * 'blotter-detail' route key survives (all ~12 `navigate()` call sites
 * are unchanged). The action panels are still driven entirely by REAL
 * server state (§8) — never guessed, and an unavailable action says
 * which prerequisite is missing rather than hiding the control.
 *
 * kebab-case filename per §4.
 */

import {
  getIncident,
  getBlotterForIncident,
  getIncidentEvidence,
  resolveIncident,
  updateIncidentLifecycle,
  getAiDraft,
  finalizeBlotter,
  amendBlotter,
  logout,
  ApiClientError,
} from '../api/apiClient.js';
import { AppShell } from '../components/AppShell.js';
import { PageHeader } from '../components/PageHeader.js';
import { icons } from '../components/icons.js';
import { showToast } from '../components/Toast.js';
import { confirmDialog, promptText } from '../components/ConfirmDialog.js';
import { escapeHtml } from '../utils/escapeHtml.js';
import { renderLoadingSkeleton, renderErrorState } from '../components/AsyncState.js';
import { BlotterWorkflow, getBlotterWorkflowState, generateAndDownloadLuponPacket } from '../components/BlotterWorkflow.js';
import { openPrintPreviewModal } from '../components/PrintPreviewModal.js';
import { renderRedactionTab } from './ai-review.js';
import { getBlotterStatusInfo, TERMINAL_INCIDENT_STATUSES } from '../utils/blotterStatus.js';

const TABS = [
  { key: 'incident', label: 'Incident' },
  { key: 'redaction', label: 'Redaction', secretaryOnly: true },
  { key: 'blotter', label: 'Blotter' },
];

let partyFieldSeq = 0;

const INCIDENT_TYPE_LABELS = {
  theft: 'Theft', physical_injury: 'Physical Injury', disturbance: 'Disturbance',
  domestic_dispute: 'Domestic Dispute', vandalism: 'Vandalism',
  traffic_incident: 'Traffic Incident', fire: 'Fire',
  medical_emergency: 'Medical Emergency', missing_person: 'Missing Person',
  animal_complaint: 'Animal Complaint', other: 'Other',
};

const STATUS_PILL_CLASS = {
  pending: 'status-pill--pending',
  dispatched: 'status-pill--info',
  resolved: 'status-pill--success',
};

const BLOTTER_STATUS_TONE_CLASS = {
  positive: 'status-pill--success',
  attention: 'status-pill--warning',
  neutral: 'status-pill--neutral',
};

/**
 * Renders a `getBlotterStatusInfo()` result as the shared status-pill
 * pattern plus a plain-text explanation — the single place the Blotter
 * tab says "not decided yet" vs "closed, no blotter needed" vs
 * "finalized" instead of a flat note that reads the same in all cases.
 */
function buildBlotterStatusNote(statusInfo) {
  const wrap = document.createElement('div');
  wrap.className = 'form-stack';

  const pill = document.createElement('span');
  pill.className = `status-pill ${BLOTTER_STATUS_TONE_CLASS[statusInfo.tone] || 'status-pill--neutral'}`;
  pill.style.alignSelf = 'flex-start';
  pill.textContent = statusInfo.label.toUpperCase();

  const description = document.createElement('p');
  description.className = 'note';
  description.style.margin = '0';
  description.textContent = statusInfo.description;

  wrap.append(pill, description);
  return wrap;
}

/**
 * Opens an official printable Barangay Blotter & Case Excerpt sheet modal.
 * Uses semantic classes in blotter-detail.css and @media print rules so
 * printing produces a clean A4 document without dark-mode UI chrome.
 */
function openPrintModal(incident, blotter, evidence, { isSecretary = false, incidentId = null } = {}) {
  const hasBlotter = Boolean(blotter?.displayId || blotter?.blotterId);
  const entryId = blotter?.displayId || (blotter?.blotterId ? `#${blotter.blotterId}` : (incident?.displayId || `#${incident.incidentId}`));
  const entryLabel = hasBlotter ? 'Blotter Entry No.' : 'Incident Reference No.';
  const incidentDate = new Date(incident.createdAt).toLocaleDateString('en-US', {
    month: 'short', day: 'numeric', year: 'numeric', hour: '2-digit', minute: '2-digit',
  });
  const finalizedDate = blotter?.finalizedAt
    ? new Date(blotter.finalizedAt).toLocaleDateString('en-US', {
        month: 'short', day: 'numeric', year: 'numeric', hour: '2-digit', minute: '2-digit',
      })
    : null;

  const caseStatusText = blotter?.caseStatus
    ? blotter.caseStatus.replace(/_/g, ' ').toUpperCase()
    : (incident.status || 'pending').toUpperCase();
  const typeLabel = INCIDENT_TYPE_LABELS[incident.incidentType] || incident.incidentType;
  const locText = incident.locationDescription
    || (incident.latitude != null && incident.longitude != null
      ? `${incident.latitude.toFixed(5)}, ${incident.longitude.toFixed(5)}`
      : 'No location recorded');
  const complainantText = blotter?.complainantName || incident.complainantName || 'Not recorded';
  const contactText = blotter?.complainantContactNumber || incident.complainantContactNumber || 'Not recorded';
  const respondentText = blotter?.respondentName || incident.respondentName || 'Not recorded';
  const officerText = incident.officerName || 'Barangay Desk Officer';
  const evidenceText = Array.isArray(evidence) && evidence.length > 0
    ? `${evidence.length} attachment${evidence.length === 1 ? '' : 's'} on file (${evidence.map((e) => e.originalFilename || e.type).join(', ')})`
    : 'No attachments logged';

  // Never print unredacted rawNarrative on a working sheet (Rule 1 / RA 10173).
  const officialSummary = blotter?.narrativeSummary || null;
  const approvedNarrative = incident.redactedNarrative || null;

  const sheetHtml = `
    <div class="print-sheet__masthead">
      <p class="print-sheet__republic">Republic of the Philippines</p>
      <h2 class="print-sheet__office">OFFICE OF THE LUPONG TAGAPAMAYAPA</h2>
      <p class="print-sheet__doctype">BARANGAY ELECTRONIC BLOTTER &amp; CASE RECORD</p>
    </div>

    <div class="print-sheet__meta-bar">
      <div class="print-sheet__meta-cell">
        <span class="print-sheet__label">${escapeHtml(entryLabel)}</span>
        <strong class="print-sheet__mono">${escapeHtml(entryId)}${blotter?.revisionNo ? ` (Rev. ${blotter.revisionNo})` : ''}</strong>
      </div>
      <div class="print-sheet__meta-cell">
        <span class="print-sheet__label">Classification</span>
        <strong>${escapeHtml(typeLabel)}</strong>
      </div>
      <div class="print-sheet__meta-cell">
        <span class="print-sheet__label">Case Status</span>
        <strong>${escapeHtml(caseStatusText)}</strong>
      </div>
      <div class="print-sheet__meta-cell">
        <span class="print-sheet__label">${finalizedDate ? 'Finalized' : 'Date Logged'}</span>
        <strong>${escapeHtml(finalizedDate || incidentDate)}</strong>
      </div>
    </div>

    <div class="print-sheet__parties">
      <div class="print-sheet__party">
        <span class="print-sheet__party-role">Complainant / Reporting Party</span>
        <p class="print-sheet__party-name">${escapeHtml(complainantText)}</p>
        <p class="print-sheet__party-sub">Contact: ${escapeHtml(contactText)}</p>
      </div>
      <div class="print-sheet__party print-sheet__party--respondent">
        <span class="print-sheet__party-role">Respondent / Subject of Inquiry</span>
        <p class="print-sheet__party-name">${escapeHtml(respondentText)}</p>
        <p class="print-sheet__party-sub">Recording Officer: ${escapeHtml(officerText)}</p>
      </div>
    </div>

    <div class="print-sheet__grid-2col">
      <div class="print-sheet__field-box">
        <span class="print-sheet__label">Incident Location</span>
        <p class="print-sheet__field-val">${escapeHtml(locText)}</p>
      </div>
      <div class="print-sheet__field-box">
        <span class="print-sheet__label">Evidence Inventory</span>
        <p class="print-sheet__field-val">${escapeHtml(evidenceText)}</p>
      </div>
    </div>

    ${officialSummary ? `
      <div class="print-sheet__section">
        <span class="print-sheet__label">Official Blotter Summary</span>
        <div class="print-sheet__narrative">${escapeHtml(officialSummary)}</div>
      </div>
    ` : ''}

    <div class="print-sheet__section">
      <span class="print-sheet__label">Approved Redacted Narrative (RA 10173 Compliant)</span>
      <div class="print-sheet__narrative">${
        approvedNarrative
          ? escapeHtml(approvedNarrative)
          : 'Pending AI redaction approval. Unredacted intake narrative is restricted under Republic Act 10173.'
      }</div>
    </div>

    ${hasBlotter ? `
      <div class="print-sheet__grid-2col">
        <div class="print-sheet__field-box">
          <span class="print-sheet__label">Originating Incident</span>
          <p class="print-sheet__field-val">${escapeHtml(incident.displayId || `#${incident.incidentId}`)} · Logged ${escapeHtml(incidentDate)}</p>
        </div>
        <div class="print-sheet__field-box">
          <span class="print-sheet__label">Record Revision &amp; Audit</span>
          <p class="print-sheet__field-val">Revision ${escapeHtml(String(blotter.revisionNo || 1))} · RA 10173 Redacted</p>
        </div>
      </div>
    ` : ''}

    <div class="print-sheet__signatures">
      <div class="print-sheet__sig-col">
        <div class="print-sheet__sig-line"></div>
        <p class="print-sheet__sig-name">${escapeHtml(officerText.toUpperCase())}</p>
        <p class="print-sheet__sig-role">Barangay Secretary / Recording Officer</p>
      </div>
      <div class="print-sheet__sig-col">
        <div class="print-sheet__sig-line"></div>
        <p class="print-sheet__sig-name">PUNONG BARANGAY / LUPON CHAIRPERSON</p>
        <p class="print-sheet__sig-role">Attested &amp; Certified</p>
      </div>
    </div>

    <p class="print-sheet__footer">
      Working copy printed from the Baranguard console (${escapeHtml(incidentDate)}). For formal Lupon Tagapamayapa referral, generate the audited Lupon Conciliation Packet PDF with SHA-256 verification code.
    </p>
  `;

  const extraActions = [];
  if (isSecretary && blotter?.finalizedAt && incidentId) {
    extraActions.push({
      label: 'Download Official Lupon PDF',
      icon: icons.download(16),
      className: 'ghost',
      onClick: (btn) => generateAndDownloadLuponPacket(incidentId, btn),
    });
  }

  openPrintPreviewModal({
    title: 'Printable Case & Blotter Excerpt',
    subtitle: 'Formatted A4 working sheet • Unredacted PII is automatically withheld',
    sheetId: 'printable-blotter-sheet',
    sheetHtml,
    extraActions,
  });
}

/**
 * @param {HTMLElement} root
 * @param {{fullName:string, role:string}} user
 * @param {() => void} onLoggedOut
 * @param {(page: string, param?: any) => void} navigate
 * @param {number} incidentId
 */
export function renderBlotterDetailPage(root, user, onLoggedOut, navigate, incidentId) {
  root.innerHTML = '';

  const isSecretary = user.role === 'secretary';

  // The standalone blotter records list (W6) was removed 2026-09-10 —
  // DILG BIMSS's KPIS module is the mandated Katarungang Pambarangay
  // ledger, so Baranguard no longer ships a competing one. This screen
  // stays (it is the app's only per-incident detail view) and now returns
  // to whichever list the signed-in role actually has: Punong Barangay
  // reaches incidents from the dashboard, everyone else from Incident
  // Management.
  const listPage = user.role === 'punong_barangay' ? 'dashboard' : 'incident-management';
  const listLabel = listPage === 'dashboard' ? 'Dashboard' : 'Incidents';

  const shell = AppShell(user, listPage, navigate, async () => {
    shell.logoutButton.disabled = true;
    if (redactionHandle) redactionHandle.stop();
    await logout();
    onLoggedOut();
  });
  const { header, content } = shell;
  root.appendChild(shell.el);

  const pageHeader = PageHeader({
    title: `Incident Record — #${incidentId}`,
    subtitle: 'Incident particulars, response timeline, and blotter intake',
    icon: icons.fileText,
  });
  header.appendChild(pageHeader.el);

  const backButton = document.createElement('button');
  backButton.className = 'ghost';
  backButton.textContent = `← Back to ${listLabel}`;
  backButton.addEventListener('click', () => navigate(listPage));
  pageHeader.actions.appendChild(backButton);

  // Unified stepped-tab + workflow progress bar. One component for the
  // whole case workspace — replaces the old separate 4-card progress
  // tracker + 3-button tab bar that stacked on top of each other.
  const stepperHost = document.createElement('div');
  content.appendChild(stepperHost);

  const body = document.createElement('div');
  content.appendChild(body);

  let incident = null;
  let blotter = null;
  let evidence = [];
  /** Secretary only — its AI summary pre-fills the finalize form and feeds the workflow stepper. */
  let aiDraft = null;
  let activeTab = 'incident';
  /** Set only while the Redaction tab is mounted, so leaving it stops that tab's own polling. */
  let redactionHandle = null;

  function availableTabs() {
    return TABS.filter((tab) => !tab.secretaryOnly || isSecretary);
  }

  /**
   * Switches tabs with NO full page navigation. 'incident'/'blotter' share
   * this file's own `incident`/`blotter`/`evidence`/`aiDraft` state and
   * re-fetch it fresh via load() on every switch; 'redaction' manages its
   * own independent load/poll cycle.
   */
  async function switchTab(key, anchor) {
    if (!availableTabs().some((tab) => tab.key === key)) key = 'incident';
    if (activeTab === 'redaction' && key !== 'redaction' && redactionHandle) {
      redactionHandle.stop();
      redactionHandle = null;
    }
    activeTab = key;
    refreshWorkflowBar();
    if (key === 'redaction') {
      renderActiveTab();
    } else {
      await load();
    }
    if (anchor) {
      requestAnimationFrame(() => {
        const target = document.getElementById(anchor);
        if (!target) return;
        target.scrollIntoView?.({ behavior: 'smooth', block: 'start' });
        const focusable = target.querySelector('input, textarea, select, button:not([disabled])');
        (focusable || target).focus?.({ preventScroll: true });
      });
    }
  }

  /**
   * Re-renders the unified stepped-tab + workflow bar. Overrides let
   * whichever tab is currently the freshest source of truth (the Redaction
   * tab while mounted) report its `draft` / `edited` state without forcing
   * a full shell reload on every poll tick.
   */
  function refreshWorkflowBar(overrides = {}) {
    stepperHost.innerHTML = '';
    if (!incident) return;
    stepperHost.appendChild(BlotterWorkflow({
      state: getBlotterWorkflowState({
        incident: overrides.incident ?? incident,
        draft: overrides.draft !== undefined ? overrides.draft : aiDraft,
        blotter: overrides.blotter ?? blotter,
        edited: overrides.edited ?? false,
      }),
      activeTab,
      onNavigate: switchTab,
      isSecretary,
    }));
  }

  function renderActiveTab() {
    body.innerHTML = '';
    if (activeTab === 'redaction' && isSecretary) {
      redactionHandle = renderRedactionTab(body, user, incidentId, { switchTab, refreshWorkflowBar });
    } else if (activeTab === 'blotter') {
      renderBlotterTab(body);
    } else {
      renderIncidentTab(body);
    }
  }

  load();

  async function load() {
    renderLoading();
    try {
      // The blotter legitimately may not exist yet (404 -> null); the
      // incident must, so its failure is a real error.
      [incident, blotter] = await Promise.all([
        getIncident(incidentId),
        getBlotterForIncident(incidentId),
      ]);
      // Evidence is enrichment — a failure degrades that one panel rather
      // than blanking a record the Secretary may need to act on.
      evidence = await getIncidentEvidence(incidentId).catch(() => []);
      aiDraft = isSecretary ? await getAiDraft(incidentId).catch(() => null) : null;
      renderShell();
    } catch (err) {
      renderError(err instanceof ApiClientError ? err.message : 'Something went wrong loading this entry.');
    }
  }

  // --- States (§8: Loading / Empty / Error / Populated) ---

  function renderLoading() {
    renderLoadingSkeleton({ container: content, count: 3, ariaLabel: 'Loading blotter entry' });
  }

  function renderError(message) {
    renderErrorState({ container: content, message, onRetry: load });
  }

  function renderShell() {
    content.innerHTML = '';
    content.append(stepperHost, body);

    const hasBlotter = Boolean(blotter?.displayId || blotter?.blotterId);
    const blotterDisplayId = blotter?.displayId || (blotter?.blotterId ? 'Not yet assigned' : null);
    const incidentDisplayId = incident?.displayId || `#${incident?.incidentId || incidentId}`;

    const titleBlock = pageHeader.el.querySelector('.page-header__title');
    if (titleBlock) {
      if (hasBlotter) {
        titleBlock.innerHTML = `<span class="page-header__icon" aria-hidden="true">${icons.fileText(22)}</span> Blotter Entry — <span class="page-header__id-pill font-mono">${escapeHtml(blotterDisplayId)}</span>`;
      } else {
        titleBlock.innerHTML = `<span class="page-header__icon" aria-hidden="true">${icons.fileText(22)}</span> Incident Record — <span class="page-header__id-pill font-mono">${escapeHtml(incidentDisplayId)}</span>`;
      }
    }
    const subtitleBlock = pageHeader.el.querySelector('.page-header__subtitle');
    if (subtitleBlock) {
      subtitleBlock.textContent = hasBlotter
        ? 'Official Barangay Blotter Ledger · Katarungang Pambarangay §394'
        : 'Incident particulars, privacy redaction, and blotter intake';
    }

    pageHeader.actions.innerHTML = '';
    const actionsGroup = document.createElement('div');
    actionsGroup.className = 'blotter-detail-header-actions';

    const headerBackButton = document.createElement('button');
    headerBackButton.className = 'ghost';
    headerBackButton.textContent = `← Back to ${listLabel}`;
    headerBackButton.addEventListener('click', () => navigate(listPage));
    actionsGroup.appendChild(headerBackButton);

    const printButton = document.createElement('button');
    printButton.className = 'ghost';
    printButton.innerHTML = `${icons.printer(16)} Print Excerpt`;
    printButton.title = 'Print an unaudited working copy. The official, audited document is the Lupon Packet.';
    printButton.addEventListener('click', () => openPrintModal(incident, blotter, evidence, { isSecretary, incidentId }));
    actionsGroup.appendChild(printButton);

    pageHeader.actions.appendChild(actionsGroup);

    refreshWorkflowBar();
    renderActiveTab();
  }

  /**
   * Incident tab: dossier, narrative, evidence, timeline, and (Admin) the
   * incident-resolution control.
   */
  function renderIncidentTab(container) {
    const layout = document.createElement('div');
    layout.className = 'split-panel';

    const main = document.createElement('div');
    main.className = 'blotter-detail__main';
    const aside = document.createElement('div');
    aside.className = 'blotter-detail__aside';

    main.appendChild(buildDossierCard());
    main.appendChild(buildNarrative());
    main.appendChild(buildEvidence());

    if (incident.status === 'resolved') {
      aside.appendChild(buildResolvedStatusCard());
    } else if (user.role === 'admin') {
      aside.appendChild(buildAdminResolvePanel());
    }
    aside.appendChild(buildTimeline());

    layout.append(main, aside);
    container.appendChild(layout);
  }

  /**
   * Blotter tab: the official record itself — finalize/amend for a
   * Secretary, a read-only summary for anyone else who can see one, the
   * Lupon packet, and the W21 lifecycle actions. This tab EXISTING,
   * clearly labelled, is itself the answer to "when does an incident
   * become a blotter" — see this file's own class doc.
   */
  function renderBlotterTab(container) {
    const layout = document.createElement('div');
    layout.className = 'split-panel';

    const main = document.createElement('div');
    main.className = 'blotter-detail__main';
    const aside = document.createElement('div');
    aside.className = 'blotter-detail__aside';

    if (isSecretary) {
      main.appendChild(buildBlotterPanel());
      if (blotter?.finalizedAt) main.appendChild(buildLuponPacketCard());
      aside.appendChild(buildLifecycleCard());
    } else if (blotter) {
      main.appendChild(buildReadOnlyBlotter());
    } else {
      const note = document.createElement('div');
      note.className = 'card';
      const heading = document.createElement('h3');
      heading.textContent = 'Blotter';
      note.appendChild(heading);
      note.appendChild(buildBlotterStatusNote(getBlotterStatusInfo(incident, blotter)));
      main.appendChild(note);
    }

    layout.append(main, aside);
    container.appendChild(layout);
  }

  /**
   * Lupon Conciliation Packet Studio — only once the entry is finalized
   * (the server's own prerequisite, BlotterController::luponPacket()).
   * Shows a clear manifest of what goes into the packet alongside direct
   * PDF generation and printable working-copy preview actions.
   */
  function buildLuponPacketCard() {
    const card = document.createElement('div');
    card.className = 'card doc-card';
    card.id = 'blotter-packet';
    card.tabIndex = -1;

    const header = document.createElement('div');
    header.className = 'doc-card__header';

    const titleGroup = document.createElement('div');
    titleGroup.className = 'doc-card__title-group';

    const heading = document.createElement('h3');
    heading.className = 'doc-card__title';
    heading.textContent = 'Lupon Conciliation Packet';

    const badge = document.createElement('span');
    badge.className = 'status-pill status-pill--info';
    badge.textContent = 'RA 7160 §394 · Audited PDF';

    titleGroup.append(heading, badge);
    header.appendChild(titleGroup);

    const note = document.createElement('p');
    note.className = 'note';
    note.style.margin = '0';
    note.textContent = 'Use when this case is referred to the Lupong Tagapamayapa for conciliation. '
      + 'Generates an official, cryptographically verified PDF of the finalized blotter entry and approved redacted narrative.';

    const manifest = document.createElement('div');
    manifest.className = 'lupon-packet-manifest';

    const caseStatusFormatted = (blotter.caseStatus || 'active')
      .replace(/_/g, ' ')
      .replace(/\b\w/g, (c) => c.toUpperCase());

    const tiles = [
      {
        label: 'Blotter Entry',
        value: `${blotter.displayId || `#${blotter.blotterId}`} · Rev. ${blotter.revisionNo || 1}`,
      },
      {
        label: 'Case Disposition',
        value: caseStatusFormatted,
      },
      {
        label: 'Included Materials',
        value: 'Official Summary + Redacted Narrative',
      },
      {
        label: 'Privacy & Integrity',
        value: 'RA 10173 Redacted · SHA-256 Verified',
      },
    ];

    for (const item of tiles) {
      const tile = document.createElement('div');
      tile.className = 'lupon-packet-tile';
      const tileLabel = document.createElement('span');
      tileLabel.className = 'lupon-packet-tile__label';
      tileLabel.textContent = item.label;
      const tileValue = document.createElement('span');
      tileValue.className = 'lupon-packet-tile__value';
      tileValue.textContent = item.value;
      tile.append(tileLabel, tileValue);
      manifest.appendChild(tile);
    }

    const actions = document.createElement('div');
    actions.className = 'lupon-packet-actions';

    const button = document.createElement('button');
    button.type = 'button';
    button.className = 'primary';
    button.innerHTML = `${icons.download(16)} Generate & download Lupon packet`;
    button.addEventListener('click', () => generateAndDownloadLuponPacket(incidentId, button));

    const previewBtn = document.createElement('button');
    previewBtn.type = 'button';
    previewBtn.className = 'ghost';
    previewBtn.innerHTML = `${icons.printer(16)} Preview printable excerpt`;
    previewBtn.addEventListener('click', () => openPrintModal(incident, blotter, evidence, { isSecretary, incidentId }));

    actions.append(button, previewBtn);
    card.append(header, note, manifest, actions);
    return card;
  }

  /**
   * Unified Case Dossier: Combines Incident Type, Badges, Involved Parties,
   * and Incident Particulars into a clear, spacious tiered layout with zero truncation.
   */
  function buildDossierCard() {
    const card = document.createElement('div');
    card.className = 'card case-hero';

    const hasBlotter = Boolean(blotter?.displayId || blotter?.blotterId);
    const blotterDisplayId = blotter?.displayId || (blotter?.blotterId ? 'Not yet assigned' : null);
    const incidentDisplayId = incident?.displayId || `#${incident.incidentId}`;

    // Header Row: Type + Icon + Badges
    const headerRow = document.createElement('div');
    headerRow.className = 'case-hero__header';

    const titleGroup = document.createElement('div');
    titleGroup.className = 'case-hero__title-group';

    const iconWrap = document.createElement('div');
    iconWrap.className = 'case-hero__icon';
    iconWrap.innerHTML = icons.fileText(22);

    const title = document.createElement('h3');
    title.className = 'case-hero__title';
    title.textContent = INCIDENT_TYPE_LABELS[incident.incidentType] || incident.incidentType;

    titleGroup.append(iconWrap, title);

    const badges = document.createElement('div');
    badges.className = 'case-hero__badges';

    const badgesToAppend = [];

    if (hasBlotter) {
      // Official Blotter Reference ID
      const blotterBadge = document.createElement('span');
      blotterBadge.className = 'blotter-id-badge';
      blotterBadge.innerHTML = `${icons.fileText(13)} <span>${escapeHtml(blotterDisplayId)}</span>`;
      blotterBadge.title = 'Statutory Blotter Reference ID';
      badgesToAppend.push(blotterBadge);

      // Originating Incident Reference
      const incidentBadge = document.createElement('span');
      incidentBadge.className = 'blotter-id-badge blotter-id-badge--incident';
      incidentBadge.innerHTML = `<span>Ref: ${escapeHtml(incidentDisplayId)}</span>`;
      incidentBadge.title = `Originating Incident ID ${escapeHtml(incidentDisplayId)}`;
      badgesToAppend.push(incidentBadge);
    } else {
      // Unfinalized Incident: Single clear primary Incident ID badge (no duplicate #123)
      const incidentBadge = document.createElement('span');
      incidentBadge.className = 'blotter-id-badge';
      incidentBadge.innerHTML = `${icons.fileText(13)} <span>${escapeHtml(incidentDisplayId)}</span>`;
      incidentBadge.title = `Incident Reference ID ${escapeHtml(incidentDisplayId)}`;
      badgesToAppend.push(incidentBadge);
    }

    const statusPill = document.createElement('span');
    statusPill.className = `status-pill ${STATUS_PILL_CLASS[incident.status] || 'status-pill--neutral'}`;
    statusPill.textContent = (incident.status || 'unknown').toUpperCase();
    badgesToAppend.push(statusPill);

    if (blotter?.caseStatus) {
      badgesToAppend.push(buildCaseStatusPill(blotter.caseStatus));
    }

    const priorityPill = document.createElement('span');
    priorityPill.className = `status-pill ${incident.priority === 'urgent' || incident.priority === 'critical' ? 'status-pill--critical' : incident.priority === 'high' ? 'status-pill--warning' : 'status-pill--neutral'}`;
    priorityPill.textContent = `${(incident.priority || 'normal').toUpperCase()} PRIORITY`;
    badgesToAppend.push(priorityPill);

    badges.append(...badgesToAppend);
    headerRow.append(titleGroup, badges);
    card.appendChild(headerRow);

    // Dossier Body
    const dossierBody = document.createElement('div');
    dossierBody.className = 'dossier-body';

    // 1. Incident Particulars - 4-tile responsive grid
    const metaSection = document.createElement('div');
    metaSection.className = 'dossier-section';

    const metaGrid = document.createElement('div');
    metaGrid.className = 'meta-grid-4col';

    // Location
    const locTile = document.createElement('div');
    locTile.className = 'meta-tile';
    const locCoords = incident.latitude != null && incident.longitude != null
      ? `${incident.latitude.toFixed(5)}, ${incident.longitude.toFixed(5)}`
      : 'Barangay Center';
    const locDesc = incident.locationDescription ? `${incident.locationDescription} (${locCoords})` : locCoords;
    locTile.innerHTML = `
      <div class="meta-tile__icon">${icons.mapPin(16)}</div>
      <div class="meta-tile__content">
        <span class="meta-tile__label">Location</span>
        <span class="meta-tile__value" title="${escapeHtml(locDesc)}">${escapeHtml(locDesc)}</span>
      </div>
    `;

    // Date Filed
    const dateTile = document.createElement('div');
    dateTile.className = 'meta-tile';
    const filedDate = new Date(incident.createdAt).toLocaleDateString('en-US', {
      month: 'short', day: 'numeric', year: 'numeric', hour: '2-digit', minute: '2-digit'
    });
    dateTile.innerHTML = `
      <div class="meta-tile__icon">${icons.clock(16)}</div>
      <div class="meta-tile__content">
        <span class="meta-tile__label">Date & Time Filed</span>
        <span class="meta-tile__value">${filedDate}</span>
      </div>
    `;

    // Channel
    const channelTile = document.createElement('div');
    channelTile.className = 'meta-tile';
    const channelLabel = incident.source === 'app' ? 'Mobile App' : incident.source === 'walkin' ? 'Walk-in Desk' : 'Hotline Call';
    channelTile.innerHTML = `
      <div class="meta-tile__icon">${icons.phone(16)}</div>
      <div class="meta-tile__content">
        <span class="meta-tile__label">Channel</span>
        <span class="meta-tile__value">${channelLabel}</span>
      </div>
    `;

    // Officer
    const officerTile = document.createElement('div');
    officerTile.className = 'meta-tile';
    const officerName = incident.officerName || 'Barangay Desk Secretary';
    officerTile.innerHTML = `
      <div class="meta-tile__icon">${icons.users(16)}</div>
      <div class="meta-tile__content">
        <span class="meta-tile__label">Recording Officer</span>
        <span class="meta-tile__value">${escapeHtml(officerName)}</span>
      </div>
    `;

    metaGrid.append(locTile, dateTile, channelTile, officerTile);
    metaSection.appendChild(metaGrid);

    // 2. Involved Parties - Clean 2-column grid without filler text
    const partiesSection = document.createElement('div');
    partiesSection.className = 'dossier-section';

    const partiesGrid = document.createElement('div');
    partiesGrid.className = 'parties-grid';

    const compCard = document.createElement('div');
    compCard.className = 'party-card';
    const compName = incident.complainantName || blotter?.complainantName || 'Walk-in Complainant / Confidential';
    const compContact = incident.complainantContactNumber || blotter?.complainantContactNumber || 'No contact number provided';
    compCard.innerHTML = `
      <div class="party-card__role">
        <span class="party-card__tag party-card__tag--complainant">Complainant</span>
      </div>
      <div class="party-card__name">${escapeHtml(compName)}</div>
      <div class="party-card__contact">
        ${icons.phone(13)}
        <span>${escapeHtml(compContact)}</span>
      </div>
    `;

    const respCard = document.createElement('div');
    respCard.className = 'party-card';
    const respName = incident.respondentName || blotter?.respondentName || 'Unspecified / Under Investigation';
    respCard.innerHTML = `
      <div class="party-card__role">
        <span class="party-card__tag party-card__tag--respondent">Respondent</span>
      </div>
      <div class="party-card__name">${escapeHtml(respName)}</div>
    `;

    partiesGrid.append(compCard, respCard);
    partiesSection.appendChild(partiesGrid);

    dossierBody.append(metaSection, partiesSection);
    card.appendChild(dossierBody);

    return card;
  }

  function buildNarrative() {
    const card = document.createElement('div');
    card.className = 'card doc-card';

    const header = document.createElement('div');
    header.className = 'doc-card__header';

    const titleGroup = document.createElement('div');
    titleGroup.className = 'doc-card__title-group';
    const heading = document.createElement('h3');
    heading.className = 'doc-card__title';
    heading.textContent = incident.redactedNarrative ? 'Approved Redacted Narrative' : 'Incident Narrative';
    titleGroup.appendChild(heading);

    const actions = document.createElement('div');
    actions.className = 'doc-card__actions';

    let isViewingRaw = false;

    if (incident.redactedNarrative) {
      const privacyBadge = document.createElement('span');
      privacyBadge.className = 'doc-privacy-badge';
      privacyBadge.title = 'A Secretary approved this redaction. This is a record of that approval, not a certification of statutory compliance.';
      privacyBadge.innerHTML = `${icons.shield(12)} Redaction approved`;
      actions.appendChild(privacyBadge);
    }

    let body = null;
    let secretaryNotice = null;

    if (isSecretary && incident.rawNarrative && incident.redactedNarrative) {
      const toggleBtn = document.createElement('button');
      toggleBtn.className = 'btn-copy';
      toggleBtn.innerHTML = `${icons.eye(14)} View Raw Intake`;
      toggleBtn.title = 'Toggle between public approved redacted narrative and original intake record (Secretary Privilege)';
      toggleBtn.addEventListener('click', () => {
        isViewingRaw = !isViewingRaw;
        if (isViewingRaw) {
          heading.textContent = 'Original Unredacted Intake Record';
          body.textContent = incident.rawNarrative;
          toggleBtn.innerHTML = `${icons.shield(14)} View Redacted`;
          secretaryNotice.style.display = 'block';
        } else {
          heading.textContent = 'Approved Redacted Narrative';
          body.textContent = incident.redactedNarrative;
          toggleBtn.innerHTML = `${icons.eye(14)} View Raw Intake`;
          secretaryNotice.style.display = 'none';
        }
      });
      actions.appendChild(toggleBtn);
    }

    const narrativeText = incident.redactedNarrative || (isSecretary ? incident.rawNarrative : null) || 'No narrative recorded yet.';

    const copyBtn = document.createElement('button');
    copyBtn.className = 'btn-copy';
    copyBtn.innerHTML = `${icons.fileText(14)} Copy Narrative`;
    copyBtn.addEventListener('click', () => {
      const currentText = body ? body.textContent : narrativeText;
      navigator.clipboard.writeText(currentText);
      showToast('Narrative copied to clipboard.', { variant: 'success' });
    });
    actions.appendChild(copyBtn);

    header.append(titleGroup, actions);
    card.appendChild(header);

    body = document.createElement('div');
    body.className = 'doc-blockquote';
    body.textContent = narrativeText;
    card.appendChild(body);

    secretaryNotice = document.createElement('p');
    secretaryNotice.className = 'note';
    secretaryNotice.style.marginTop = '0.5rem';
    secretaryNotice.style.display = 'none';
    secretaryNotice.style.color = 'var(--color-warning)';
    secretaryNotice.textContent = '🔒 Viewing original intake record with unredacted details under RA 7160 §394 statutory records privilege.';
    card.appendChild(secretaryNotice);

    if (!incident.redactedNarrative && isSecretary && incident.rawNarrative) {
      const warn = document.createElement('p');
      warn.className = 'note';
      warn.style.marginTop = '0.5rem';
      warn.textContent = 'This is the original unredacted narrative — no redaction has been approved yet.';
      card.appendChild(warn);
    }

    return card;
  }

  function buildEvidence() {
    if (evidence.length === 0) {
      const bar = document.createElement('div');
      bar.className = 'evidence-bar--empty';
      bar.innerHTML = `
        <div class="evidence-bar--empty__left">
          <span style="color:var(--color-text-secondary);display:flex;align-items:center;">${icons.fileText(15)}</span>
          <span>No digital evidence attachments recorded for this incident.</span>
        </div>
      `;
      return bar;
    }

    const card = document.createElement('div');
    card.className = 'card';

    const heading = document.createElement('h3');
    heading.textContent = `Digital Evidence (${evidence.length})`;
    card.appendChild(heading);

    const list = document.createElement('div');
    list.className = 'stack';
    list.style.gap = '0.5rem';
    for (const item of evidence) {
      const row = document.createElement('div');
      row.className = 'evidence-item';

      const left = document.createElement('div');
      left.className = 'evidence-item__left';
      const icon = document.createElement('div');
      icon.className = 'evidence-item__icon';
      icon.innerHTML = item.type === 'voice' ? icons.radio(18) : icons.fileText(18);

      const title = document.createElement('span');
      title.className = 'evidence-item__title';
      title.textContent = `${item.type === 'voice' ? 'Voice note' : 'Photo'} — ${item.originalFilename}`;
      left.append(icon, title);

      const meta = document.createElement('span');
      meta.className = 'evidence-item__meta';
      const kb = Math.max(1, Math.round(item.byteSize / 1024));
      meta.textContent = `${kb} KB · ${new Date(item.uploadedAt).toLocaleString()}`;

      row.append(left, meta);
      list.appendChild(row);
    }
    card.appendChild(list);

    return card;
  }

  function buildTimeline() {
    const card = document.createElement('div');
    card.className = 'card';

    const headerRow = document.createElement('div');
    headerRow.style.display = 'flex';
    headerRow.style.alignItems = 'center';
    headerRow.style.gap = '0.5rem';
    headerRow.style.marginBottom = '0.75rem';

    const iconWrap = document.createElement('span');
    iconWrap.style.color = 'var(--color-info)';
    iconWrap.innerHTML = icons.clock(18);

    const heading = document.createElement('h3');
    heading.textContent = 'Case Timeline';
    heading.style.margin = '0';

    headerRow.append(iconWrap, heading);
    card.appendChild(headerRow);

    const stages = [
      ['Reported', incident.createdAt],
      ['Dispatched', incident.dispatchedAt],
      ['Arrived on scene', incident.arrivedAt],
      ['Redaction approved', incident.redactionApprovedAt],
      ['Blotter finalized', blotter ? blotter.finalizedAt : null],
      ['Last amended', blotter ? blotter.amendedAt : null],
    ];

    const visibleStages = stages.filter(([label, timestamp]) => (
      !(label === 'Last amended' && !timestamp)
    ));

    let lastReachedIdx = -1;
    visibleStages.forEach(([_, ts], idx) => {
      if (ts) lastReachedIdx = idx;
    });

    const list = document.createElement('div');
    list.className = 'timeline';
    visibleStages.forEach(([label, timestamp], i) => {
      const reached = Boolean(timestamp);
      const isLatest = i === lastReachedIdx;

      const item = document.createElement('div');
      item.className = 'timeline__item';

      const rail = document.createElement('div');
      rail.className = 'timeline__rail';
      const node = document.createElement('span');
      let nodeClass = 'timeline__node';
      if (reached) {
        nodeClass += isLatest ? ' timeline__node--current' : ' timeline__node--done';
      }
      node.className = nodeClass;
      rail.appendChild(node);

      if (i < visibleStages.length - 1) {
        const connector = document.createElement('span');
        const nextReached = Boolean(visibleStages[i + 1][1]);
        connector.className = 'timeline__connector' + (reached && nextReached ? ' timeline__connector--done' : '');
        rail.appendChild(connector);
      }

      const body = document.createElement('div');
      body.className = 'timeline__body';

      const row = document.createElement('div');
      row.className = 'timeline__row';

      const name = document.createElement('span');
      name.className = 'timeline__label' + (reached ? '' : ' timeline__label--pending');
      name.textContent = label;

      const value = document.createElement('span');
      value.className = 'timeline__value';
      value.textContent = reached
        ? new Date(timestamp).toLocaleDateString('en-US', {
            month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit'
          })
        : 'Pending';

      row.append(name, value);
      body.appendChild(row);
      item.append(rail, body);
      list.appendChild(item);
    });

    card.appendChild(list);
    return card;
  }

  /**
   * §9 W7: "Admin incident resolution is shown only when the dispatch/state
   * prerequisites are met" — i.e. the incident is `dispatched` and no
   * dispatch is still active. Those are exactly the conditions the server
   * enforces (§6 PATCH /incidents/:id/status), checked here so the button
   * is never a control that would 409 on click.
   *
   * §8 forbids the mockup's invented 4-state model: the label and
   * availability come from the real `incident.status` and real dispatch
   * rows, nothing else.
   */
  function buildAdminResolvePanel() {
    const card = document.createElement('div');
    card.className = 'card';

    if (incident.status === 'resolved') {
      return buildResolvedStatusCard();
    }

    const heading = document.createElement('h3');
    heading.textContent = 'Incident resolution';
    card.appendChild(heading);

    const activeDispatch = incident.hasActiveDispatch;

    const button = document.createElement('button');
    button.className = 'primary';
    button.textContent = 'Mark incident resolved';

    let blockedBecause = null;
    if (incident.status !== 'dispatched') {
      blockedBecause = `Only a dispatched incident can be resolved — this one is ${incident.status}.`;
    } else if (activeDispatch) {
      blockedBecause = 'A dispatch is still active. Complete or cancel it before resolving.';
    }
    button.disabled = blockedBecause !== null;

    button.addEventListener('click', async () => {
      const noBlotterYet = !blotter?.finalizedAt;
      const description = incident.redactionApprovedAt && noBlotterYet
        ? 'This closes the incident. It cannot be reopened from this screen. This incident hasn’t been turned into a blotter record — resolving will close it as a report-only incident.'
        : 'This closes the incident. It cannot be reopened from this screen.';
      const confirmed = await confirmDialog({
        title: 'Mark this incident resolved?',
        description,
        confirmLabel: 'Mark resolved',
        cancelLabel: 'Cancel',
      });
      if (!confirmed) return;

      button.disabled = true;
      button.textContent = 'Resolving…';
      try {
        await resolveIncident(incidentId);
        showToast('Incident marked resolved.', { variant: 'success' });
        await load();
      } catch (err) {
        button.disabled = false;
        button.textContent = 'Mark incident resolved';
        showToast(err instanceof ApiClientError ? err.message : 'Could not resolve the incident.', { variant: 'error' });
      }
    });

    card.appendChild(button);

    if (blockedBecause) {
      const reason = document.createElement('p');
      reason.className = 'note';
      reason.textContent = blockedBecause;
      card.appendChild(reason);
    }

    return card;
  }

  function buildReadOnlyBlotter() {
    const card = document.createElement('div');
    card.className = 'card doc-card';

    const header = document.createElement('div');
    header.className = 'doc-card__header';

    const titleGroup = document.createElement('div');
    titleGroup.className = 'doc-card__title-group';
    const heading = document.createElement('h3');
    heading.className = 'doc-card__title';
    heading.textContent = `Official Blotter Summary (Revision ${blotter.revisionNo})`;
    titleGroup.appendChild(heading);
    if (blotter.caseStatus) titleGroup.appendChild(buildCaseStatusPill(blotter.caseStatus));

    const actions = document.createElement('div');
    actions.className = 'doc-card__actions';

    const printExcerptBtn = document.createElement('button');
    printExcerptBtn.type = 'button';
    printExcerptBtn.className = 'btn-copy';
    printExcerptBtn.innerHTML = `${icons.printer(14)} Print Excerpt`;
    printExcerptBtn.addEventListener('click', () => openPrintModal(incident, blotter, evidence, { isSecretary, incidentId }));

    const copyBtn = document.createElement('button');
    copyBtn.type = 'button';
    copyBtn.className = 'btn-copy';
    copyBtn.innerHTML = `${icons.fileText(14)} Copy Summary`;
    copyBtn.addEventListener('click', () => {
      navigator.clipboard.writeText(blotter.narrativeSummary);
      showToast('Blotter summary copied to clipboard.', { variant: 'success' });
    });
    actions.append(printExcerptBtn, copyBtn);

    header.append(titleGroup, actions);
    card.appendChild(header);

    const body = document.createElement('div');
    body.className = 'doc-blockquote doc-blockquote--blotter';
    body.textContent = blotter.narrativeSummary;
    card.appendChild(body);

    card.appendChild(buildSummaryList([
      { key: 'Blotter number', value: blotter.displayId },
      { key: 'Complainant', value: blotter.complainantName },
      { key: 'Contact number', value: blotter.complainantContactNumber },
      { key: 'Respondent', value: blotter.respondentName },
      { key: 'Finalized', value: formatDateTime(blotter.finalizedAt) },
      ...(blotter.amendedAt ? [{ key: 'Last amended', value: formatDateTime(blotter.amendedAt) }] : []),
    ], { grid: true }));

    return card;
  }

  /**
   * The Secretary's finalize/amend panel — the point of this screen.
   *
   * 2026-09-26 UX pass (GOV.UK "check answers" + error-message patterns):
   *   - not approved yet → a short, plain explanation and ONE button to
   *     the step that unblocks it (was a legal-heavy callout);
   *   - not finalized → a two-view form: enter details, then CHECK them
   *     (summary list with Change links) before the irreversible
   *     "Finalize blotter entry" — replacing a generic confirm dialog;
   *   - finalized → the record plus a readable summary list; the
   *     amendment form stays collapsed behind "Amend this entry" instead
   *     of always sitting open under every finalized record.
   */
  /**
   * The "approve the AI redaction first" explanation, shared between the
   * normal not-approved state and the collapsed "finalize anyway" toggle
   * on an already-closed incident.
   */
  function buildRedactionRequiredNote() {
    const body = document.createElement('p');
    body.style.margin = '0';
    body.textContent = 'The narrative still contains names, phone numbers, and addresses. '
      + 'Approve the AI redaction first — then you can finalize the blotter entry here.';

    const why = document.createElement('p');
    why.className = 'note';
    why.style.margin = '0';
    why.textContent = 'Why: under the Data Privacy Act (RA 10173), personal details are removed and checked by the Secretary before an entry is recorded.';

    const button = document.createElement('button');
    button.type = 'button';
    button.className = 'primary';
    button.style.alignSelf = 'flex-start';
    button.innerHTML = `<span>Review AI redaction</span> ${icons.arrowRight(16)}`;
    button.addEventListener('click', () => switchTab('redaction'));

    const stack = document.createElement('div');
    stack.className = 'form-stack';
    stack.append(body, why, button);
    return stack;
  }

  function buildBlotterPanel() {
    const card = document.createElement('div');
    card.className = 'card doc-card';
    card.id = 'blotter-finalize';
    card.tabIndex = -1;

    const approved = Boolean(incident.redactionApprovedAt);
    const finalized = Boolean(blotter && blotter.finalizedAt);

    // An incident already closed out (resolved/cancelled/invalid/duplicate)
    // without a blotter is a deliberate "report only" outcome — don't keep
    // visually inviting a finalize action as if a decision were still
    // pending. The finalize flow stays reachable behind an explicit toggle
    // for the rare case a closed incident genuinely still needs one (the
    // server itself has no status precondition on finalize).
    if (!finalized && TERMINAL_INCIDENT_STATUSES.includes(incident.status)) {
      const header = document.createElement('div');
      header.className = 'doc-card__header';
      const heading = document.createElement('h3');
      heading.className = 'doc-card__title';
      heading.textContent = 'Blotter';
      header.appendChild(heading);
      card.appendChild(header);
      card.appendChild(buildBlotterStatusNote(getBlotterStatusInfo(incident, blotter)));

      const toggle = document.createElement('button');
      toggle.type = 'button';
      toggle.className = 'ghost';
      toggle.style.alignSelf = 'flex-start';
      toggle.style.marginTop = 'var(--spacing-md)';
      toggle.textContent = 'This incident still needs a blotter entry';
      toggle.setAttribute('aria-expanded', 'false');

      const finalizeArea = document.createElement('div');
      finalizeArea.hidden = true;
      finalizeArea.style.marginTop = 'var(--spacing-md)';
      finalizeArea.appendChild(approved ? buildFinalizeForm() : buildRedactionRequiredNote());

      toggle.addEventListener('click', () => {
        finalizeArea.hidden = false;
        toggle.hidden = true;
        toggle.setAttribute('aria-expanded', 'true');
      });

      card.append(toggle, finalizeArea);
      return card;
    }

    if (!approved) {
      const header = document.createElement('div');
      header.className = 'doc-card__header';
      const heading = document.createElement('h3');
      heading.className = 'doc-card__title';
      heading.textContent = 'Finalize blotter entry';
      const pill = document.createElement('span');
      pill.className = 'status-pill status-pill--neutral';
      pill.textContent = 'Not available yet';
      header.append(heading, pill);
      card.append(header, buildRedactionRequiredNote());
      return card;
    }

    if (!finalized) {
      const header = document.createElement('div');
      header.className = 'doc-card__header';
      const heading = document.createElement('h3');
      heading.className = 'doc-card__title';
      heading.textContent = 'Finalize blotter entry';
      const pill = document.createElement('span');
      pill.className = `status-pill ${BLOTTER_STATUS_TONE_CLASS.attention}`;
      pill.textContent = 'AWAITING BLOTTER DECISION';
      header.append(heading, pill);
      card.append(header, buildFinalizeForm());
      return card;
    }

    // Finalized: the record as a readable summary, amendment on demand.
    const header = document.createElement('div');
    header.className = 'doc-card__header';

    const titleGroup = document.createElement('div');
    titleGroup.className = 'doc-card__title-group';
    const heading = document.createElement('h3');
    heading.className = 'doc-card__title';
    heading.textContent = `Official Blotter Summary (Revision ${blotter.revisionNo})`;
    titleGroup.appendChild(heading);
    if (blotter.caseStatus) titleGroup.appendChild(buildCaseStatusPill(blotter.caseStatus));

    const actions = document.createElement('div');
    actions.className = 'doc-card__actions';

    const printExcerptBtn = document.createElement('button');
    printExcerptBtn.type = 'button';
    printExcerptBtn.className = 'btn-copy';
    printExcerptBtn.innerHTML = `${icons.printer(14)} Print Excerpt`;
    printExcerptBtn.addEventListener('click', () => openPrintModal(incident, blotter, evidence, { isSecretary, incidentId }));

    const copyBtn = document.createElement('button');
    copyBtn.type = 'button';
    copyBtn.className = 'btn-copy';
    copyBtn.innerHTML = `${icons.fileText(14)} Copy Summary`;
    copyBtn.addEventListener('click', () => {
      navigator.clipboard.writeText(blotter.narrativeSummary);
      showToast('Blotter summary copied.', { variant: 'success' });
    });
    actions.append(printExcerptBtn, copyBtn);

    header.append(titleGroup, actions);
    card.appendChild(header);

    const current = document.createElement('div');
    current.className = 'doc-blockquote doc-blockquote--blotter';
    current.textContent = blotter.narrativeSummary;
    card.appendChild(current);

    card.appendChild(buildSummaryList([
      { key: 'Blotter number', value: blotter.displayId },
      { key: 'Complainant', value: blotter.complainantName },
      { key: 'Contact number', value: blotter.complainantContactNumber },
      { key: 'Respondent', value: blotter.respondentName },
      { key: 'Finalized', value: formatDateTime(blotter.finalizedAt) },
      ...(blotter.amendedAt ? [{ key: 'Last amended', value: formatDateTime(blotter.amendedAt) }] : []),
    ], { grid: true }));

    card.appendChild(buildAmendSection());
    return card;
  }

  // Mirrors IncidentsController::LIFECYCLE_TRANSITIONS exactly (H-16/M-03,
  // migration 0025) -- UI-only convenience for which buttons to show; the
  // server is still the real enforcement point, so a stale client copy
  // here only means a button that would 409, not a bypass.
  const LIFECYCLE_TRANSITIONS = {
    pending: ['duplicate', 'invalid', 'cancelled'],
    dispatched: ['duplicate', 'invalid', 'cancelled'],
    resolved: ['reopened'],
    cancelled: ['reopened'],
    invalid: ['reopened'],
    duplicate: ['reopened'],
    reopened: ['duplicate', 'invalid', 'cancelled'],
  };
  const LIFECYCLE_ACTION_META = {
    duplicate: {
      label: 'Mark as duplicate',
      icon: icons.copy,
      description: 'Links this incident to another that already covers it. MERGE MEANS LINK, NOT DELETE — the other incident is untouched and both stay independently retained.',
    },
    invalid: {
      label: 'Mark invalid',
      icon: icons.alertTriangle,
      description: 'Marks this incident as not a valid report. It can be reopened later if that turns out to be wrong.',
    },
    cancelled: {
      label: 'Cancel this incident',
      icon: icons.x,
      description: 'Cancels this incident. It can be reopened later if needed.',
    },
    reopened: {
      label: 'Reopen this case',
      icon: icons.rotateCcw,
      description: 'Reopens this case for further action.',
    },
  };

  /**
   * W21: the web UI for `PATCH /incidents/:id/lifecycle` (H-16/M-03),
   * Secretary-only — the backend/policy side of this has existed since
   * migration 0025, but nothing in the web app ever called it (a
   * Secretary had to hit the endpoint directly). Card shows only the
   * legal targets from the incident's CURRENT status (forward-only, same
   * table the server enforces), disables every target except `reopened`
   * while a dispatch is still active (same guard the server applies),
   * and surfaces the duplicate link / last-change timestamp once set.
   */
  function buildLifecycleCard() {
    const card = document.createElement('div');
    card.className = 'card';

    const heading = document.createElement('h3');
    heading.textContent = 'Case lifecycle';
    card.appendChild(heading);

    if (incident.status === 'duplicate' && incident.duplicateOfIncidentId) {
      const note = document.createElement('p');
      note.className = 'note';
      note.textContent = `Linked as a duplicate of incident #${incident.duplicateOfIncidentId}.`;
      card.appendChild(note);
      const viewLink = document.createElement('button');
      viewLink.className = 'ghost';
      viewLink.textContent = 'View the linked incident';
      viewLink.addEventListener('click', () => navigate('blotter-detail', incident.duplicateOfIncidentId));
      card.appendChild(viewLink);
    }

    const legalTargets = LIFECYCLE_TRANSITIONS[incident.status] || [];
    if (legalTargets.length === 0) {
      const note = document.createElement('p');
      note.className = 'note';
      note.textContent = 'No lifecycle action is available from this status.';
      card.appendChild(note);
      return card;
    }

    const activeDispatch = incident.hasActiveDispatch;
    const actionsRow = document.createElement('div');
    actionsRow.className = 'blotter-form-actions';

    for (const target of legalTargets) {
      const meta = LIFECYCLE_ACTION_META[target];
      const button = document.createElement('button');
      button.className = 'ghost';
      button.innerHTML = `${meta.icon(16)} ${escapeHtml(meta.label)}`;

      const blockedByDispatch = target !== 'reopened' && activeDispatch;
      button.disabled = blockedByDispatch;
      if (blockedByDispatch) {
        button.title = 'A dispatch is still active. Complete or cancel it first.';
      }

      button.addEventListener('click', () => runLifecycleAction(target, meta));
      actionsRow.appendChild(button);
    }
    card.appendChild(actionsRow);

    if (activeDispatch && legalTargets.some((t) => t !== 'reopened')) {
      const reason = document.createElement('p');
      reason.className = 'note';
      reason.textContent = 'A dispatch is still active. Complete or cancel it before changing the lifecycle (reopening is exempt).';
      card.appendChild(reason);
    }

    if (incident.lifecycleChangedAt) {
      const meta = document.createElement('p');
      meta.className = 'note';
      meta.textContent = `Last lifecycle change: ${formatDateTime(incident.lifecycleChangedAt)}.`;
      card.appendChild(meta);
    }

    return card;
  }

  async function runLifecycleAction(target, meta) {
    if (target === 'duplicate') {
      await promptText({
        title: meta.label,
        description: `${meta.description} Enter the incident id this is a duplicate of (same barangay only).`,
        label: 'Duplicate of incident #',
        placeholder: 'e.g. 42',
        inputType: 'number',
        confirmLabel: meta.label,
        onConfirmAsync: async (value) => {
          const duplicateOfIncidentId = Number.parseInt(value, 10);
          if (!Number.isInteger(duplicateOfIncidentId) || duplicateOfIncidentId <= 0) {
            throw new Error('Enter a valid incident id.');
          }
          if (duplicateOfIncidentId === incident.incidentId) {
            throw new Error('An incident cannot be a duplicate of itself.');
          }
          await updateIncidentLifecycle(incidentId, {
            status: 'duplicate',
            duplicateOfIncidentId,
            idempotencyKey: crypto.randomUUID(),
          });
          showToast(`Marked as a duplicate of incident #${duplicateOfIncidentId}.`, { variant: 'success' });
          await load();
        },
      });
      return;
    }

    await confirmDialog({
      title: `${meta.label}?`,
      description: meta.description,
      confirmLabel: meta.label,
      onConfirmAsync: async () => {
        await updateIncidentLifecycle(incidentId, { status: target, idempotencyKey: crypto.randomUUID() });
        showToast(target === 'reopened' ? 'Incident reopened.' : `Incident marked ${target}.`, { variant: 'success' });
        await load();
      },
    });
  }

  function buildResolvedStatusCard() {
    const card = document.createElement('div');
    card.className = 'card resolution-badge-card';
    const resolutionDate = incident.syncedAt || incident.createdAt;
    const formattedResDate = resolutionDate
      ? new Date(resolutionDate).toLocaleDateString('en-US', {
          month: 'short', day: 'numeric', year: 'numeric', hour: '2-digit', minute: '2-digit'
        })
      : null;

    card.innerHTML = `
      <div class="resolution-badge-card__icon">${icons.checkCircle(20)}</div>
      <div style="flex:1;min-width:0;">
        <h4 class="resolution-badge-card__title">Case Closed & Resolved</h4>
        <p class="resolution-badge-card__desc">This incident was officially closed and resolved. Permanent statutory retention policies apply under Republic Act 7160 Section 394.</p>
        <div class="resolution-badge-card__meta">
          ${formattedResDate ? `<span><strong>Resolution Logged:</strong> ${formattedResDate}</span>` : ''}
          <span><strong>Dispatch Status:</strong> All active dispatches cleared</span>
        </div>
      </div>
    `;
    return card;
  }

  /**
   * case_status pill (migration 0009, 2026-09-05 UX pass) — displays Lupon Case status.
   */
  function buildCaseStatusPill(caseStatus) {
    const labels = {
      active: 'Lupon Case: Active',
      under_investigation: 'Lupon: Under Investigation',
      settled: 'Lupon: Settled',
      resolved: 'Lupon: Resolved'
    };
    const classes = {
      active: 'status-pill--info',
      under_investigation: 'status-pill--pending',
      settled: 'status-pill--success',
      resolved: 'status-pill--neutral'
    };
    const pill = document.createElement('span');
    pill.className = `status-pill ${classes[caseStatus] || 'status-pill--neutral'}`;
    pill.textContent = (labels[caseStatus] || caseStatus).toUpperCase();
    return pill;
  }

  function formatDateTime(value) {
    if (!value) return null;
    return new Date(value).toLocaleDateString('en-US', {
      month: 'short', day: 'numeric', year: 'numeric', hour: '2-digit', minute: '2-digit',
    });
  }

  /**
   * GOV.UK-style summary list. rows: {key, value, onChange?, changeLabel?}.
   * Every value is set via textContent (server data, never innerHTML).
   * When `grid: true` is passed, renders a compact 2-column ledger grid
   * without the 3rd action column.
   */
  function buildSummaryList(rows, { grid = false } = {}) {
    const list = document.createElement('dl');
    list.className = grid ? 'blotter-summary-list blotter-summary-list--grid' : 'blotter-summary-list';
    for (const row of rows) {
      const item = document.createElement('div');
      item.className = 'blotter-summary-list__row';

      const key = document.createElement('dt');
      key.className = 'blotter-summary-list__key';
      key.textContent = row.key;

      const value = document.createElement('dd');
      value.className = 'blotter-summary-list__value';
      const text = typeof row.value === 'string' ? row.value.trim() : row.value;
      if (text) {
        value.textContent = text;
      } else {
        value.classList.add('blotter-summary-list__value--empty');
        value.textContent = 'Not provided';
      }

      if (grid) {
        item.append(key, value);
      } else {
        const action = document.createElement('dd');
        action.style.margin = '0';
        if (row.onChange) {
          const change = document.createElement('button');
          change.type = 'button';
          change.className = 'blotter-link-btn';
          change.textContent = 'Change';
          change.setAttribute('aria-label', `Change ${row.changeLabel || row.key.toLowerCase()}`);
          change.addEventListener('click', row.onChange);
          action.appendChild(change);
        }
        item.append(key, value, action);
      }

      list.appendChild(item);
    }
    return list;
  }

  /**
   * One labelled form field with hint + inline error message (GOV.UK
   * error-message pattern: the error sits next to the field it's about,
   * not only in a toast that disappears).
   */
  function buildField({ id, label, hint, control }) {
    const wrap = document.createElement('div');
    wrap.className = 'blotter-field';

    const labelEl = document.createElement('label');
    labelEl.className = 'label';
    labelEl.htmlFor = id;
    labelEl.textContent = label;
    wrap.appendChild(labelEl);

    const hintEl = document.createElement('p');
    hintEl.className = 'blotter-field__hint';
    hintEl.id = `${id}-hint`;
    hintEl.textContent = hint || '';
    hintEl.hidden = !hint;
    wrap.appendChild(hintEl);

    const errorEl = document.createElement('p');
    errorEl.className = 'blotter-field__error';
    errorEl.id = `${id}-error`;
    errorEl.hidden = true;
    wrap.appendChild(errorEl);

    control.id = id;
    const describe = (withError) => {
      const ids = [];
      if (!hintEl.hidden) ids.push(hintEl.id);
      if (withError) ids.push(errorEl.id);
      if (ids.length) control.setAttribute('aria-describedby', ids.join(' '));
      else control.removeAttribute('aria-describedby');
    };
    describe(false);
    wrap.appendChild(control);

    return {
      el: wrap,
      setHint(text) {
        hintEl.textContent = text;
        hintEl.hidden = !text;
        describe(!errorEl.hidden);
      },
      setError(message) {
        errorEl.hidden = !message;
        errorEl.textContent = message || '';
        wrap.classList.toggle('blotter-field--error', Boolean(message));
        if (message) control.setAttribute('aria-invalid', 'true');
        else control.removeAttribute('aria-invalid');
        describe(Boolean(message));
      },
    };
  }

  /** Error summary at the top of a form, linking to each bad field. */
  function showErrorSummary(box, errors) {
    box.innerHTML = '';
    box.hidden = errors.length === 0;
    if (errors.length === 0) return;
    const title = document.createElement('h4');
    title.className = 'blotter-error-summary__title';
    title.textContent = 'There is a problem';
    const list = document.createElement('ul');
    for (const { fieldId, message } of errors) {
      const li = document.createElement('li');
      const link = document.createElement('button');
      link.type = 'button';
      link.className = 'blotter-link-btn';
      link.textContent = message;
      link.addEventListener('click', () => document.getElementById(fieldId)?.focus());
      li.appendChild(link);
      list.appendChild(li);
    }
    box.append(title, list);
    box.focus?.();
  }

  function newErrorSummary() {
    const box = document.createElement('div');
    box.className = 'blotter-error-summary';
    box.setAttribute('role', 'alert');
    box.tabIndex = -1;
    box.hidden = true;
    return box;
  }

  function buildFinalizeForm() {
    const container = document.createElement('div');

    const aiSummary = aiDraft && aiDraft.status === 'completed' && !aiDraft.draftSummaryStale && aiDraft.draftSummary?.trim()
      ? aiDraft.draftSummary.trim()
      : null;
    const redacted = (incident.redactedNarrative || '').trim();
    let source = aiSummary ? 'ai' : 'redacted';
    let lastPrefill = aiSummary || redacted;

    // --- View 1: enter details ---
    const form = document.createElement('form');
    form.className = 'form-stack';
    form.noValidate = true;

    const intro = document.createElement('p');
    intro.className = 'note';
    intro.style.margin = '0';
    intro.textContent = 'Pre-filled from the approved redaction. Review and edit if needed before confirming.';

    const errorSummary = newErrorSummary();

    const party = buildPartyFields({
      complainantName: incident.complainantName,
      respondentName: incident.respondentName,
      complainantContactNumber: incident.complainantContactNumber,
    }, 'Verify names against the intake statement. Leave blank if unknown.');

    const summaryFieldset = document.createElement('fieldset');
    summaryFieldset.className = 'blotter-fieldset';
    const summaryLegend = document.createElement('legend');
    summaryLegend.className = 'blotter-fieldset__legend';
    summaryLegend.textContent = 'What happened';

    const textarea = document.createElement('textarea');
    textarea.rows = 6;
    textarea.required = true;
    textarea.classList.add('textarea--resizable');
    textarea.value = lastPrefill;

    const summaryField = buildField({ id: 'blotter-finalize-summary', label: 'Blotter summary', control: textarea });
    const refreshHint = () => summaryField.setHint(
      source === 'ai'
        ? 'Factual summary pre-filled by AI. Keep personal names and phone numbers in the party fields above.'
        : 'Pre-filled from the approved redacted narrative — shorten to a brief factual summary.'
    );
    refreshHint();

    const meta = document.createElement('div');
    meta.className = 'blotter-field__meta';
    const count = document.createElement('span');
    const updateCount = () => { count.textContent = `${textarea.value.trim().length} characters`; };
    updateCount();
    textarea.addEventListener('input', updateCount);
    meta.appendChild(count);

    if (aiSummary && redacted && aiSummary !== redacted) {
      const swap = document.createElement('button');
      swap.type = 'button';
      swap.className = 'blotter-link-btn';
      const swapLabel = () => (source === 'ai' ? 'Start from the full redacted narrative instead' : 'Start from the AI summary instead');
      swap.textContent = swapLabel();
      swap.addEventListener('click', async () => {
        if (textarea.value.trim() !== lastPrefill) {
          const ok = await confirmDialog({
            title: 'Replace your edits?',
            description: 'The summary text you typed will be replaced.',
            confirmLabel: 'Replace',
            cancelLabel: 'Keep my text',
          });
          if (!ok) return;
        }
        source = source === 'ai' ? 'redacted' : 'ai';
        lastPrefill = source === 'ai' ? aiSummary : redacted;
        textarea.value = lastPrefill;
        swap.textContent = swapLabel();
        refreshHint();
        updateCount();
        textarea.focus();
      });
      meta.appendChild(swap);
    }
    summaryField.el.appendChild(meta);
    summaryFieldset.append(summaryLegend, summaryField.el);

    const continueBtn = document.createElement('button');
    continueBtn.type = 'submit';
    continueBtn.className = 'primary';
    continueBtn.innerHTML = `<span>Continue to check entry</span> ${icons.arrowRight(16)}`;
    const formActions = document.createElement('div');
    formActions.className = 'blotter-form-actions';
    formActions.appendChild(continueBtn);

    form.append(intro, errorSummary, party.element, summaryFieldset, formActions);

    // --- View 2: check before finalizing ---
    const review = document.createElement('div');
    review.className = 'form-stack';
    review.hidden = true;

    function showEdit(focusId) {
      review.hidden = true;
      form.hidden = false;
      const target = focusId ? document.getElementById(focusId) : null;
      (target || textarea).focus();
    }

    function showReview() {
      const values = party.fields();
      review.innerHTML = '';

      const heading = document.createElement('h4');
      heading.style.margin = '0';
      heading.tabIndex = -1;
      heading.textContent = 'Check the entry before finalizing';

      const list = buildSummaryList([
        { key: 'Complainant', value: values.complainantName, onChange: () => showEdit(party.ids.complainant), changeLabel: 'complainant name' },
        { key: 'Contact number', value: values.complainantContactNumber, onChange: () => showEdit(party.ids.contact), changeLabel: 'contact number' },
        { key: 'Respondent', value: values.respondentName, onChange: () => showEdit(party.ids.respondent), changeLabel: 'respondent name' },
        { key: 'Blotter summary', value: textarea.value.trim(), onChange: () => showEdit('blotter-finalize-summary'), changeLabel: 'blotter summary' },
      ]);

      const warning = document.createElement('div');
      warning.className = 'blotter-warning';
      warning.innerHTML = `<span aria-hidden="true">${icons.alertTriangle(18)}</span>`;
      const warningText = document.createElement('p');
      const strong = document.createElement('strong');
      strong.textContent = 'This cannot be undone. ';
      warningText.append(strong, document.createTextNode(
        'Finalizing records this entry in the barangay blotter and assigns its permanent blotter number. '
        + 'After that it can only be amended with a written reason, and every earlier version is kept.'
      ));
      warning.appendChild(warningText);

      const finalizeBtn = document.createElement('button');
      finalizeBtn.type = 'button';
      finalizeBtn.className = 'primary';
      const finalizeLabel = `${icons.check(16)} <span>Finalize blotter entry</span>`;
      finalizeBtn.innerHTML = finalizeLabel;

      const backBtn = document.createElement('button');
      backBtn.type = 'button';
      backBtn.className = 'ghost';
      backBtn.textContent = 'Back to editing';
      backBtn.addEventListener('click', () => showEdit());

      finalizeBtn.addEventListener('click', async () => {
        finalizeBtn.disabled = true;
        backBtn.disabled = true;
        finalizeBtn.textContent = 'Finalizing…';
        try {
          await finalizeBlotter(incidentId, { narrativeSummary: textarea.value.trim(), ...party.fields() });
          showToast('Blotter entry finalized and numbered.', { variant: 'success' });
          await load();
        } catch (err) {
          finalizeBtn.disabled = false;
          backBtn.disabled = false;
          finalizeBtn.innerHTML = finalizeLabel;
          showToast(err instanceof ApiClientError ? err.message : 'Could not finalize the entry.', { variant: 'error' });
        }
      });

      const actions = document.createElement('div');
      actions.className = 'blotter-form-actions';
      actions.append(finalizeBtn, backBtn);

      review.append(heading, list, warning, actions);
      form.hidden = true;
      review.hidden = false;
      heading.focus();
    }

    form.addEventListener('submit', (event) => {
      event.preventDefault();
      const summary = textarea.value.trim();
      const errors = summary ? [] : [{ fieldId: 'blotter-finalize-summary', message: 'Enter a blotter summary' }];
      summaryField.setError(summary ? null : 'Enter a blotter summary');
      showErrorSummary(errorSummary, errors);
      if (errors.length === 0) showReview();
    });

    container.append(form, review);
    return container;
  }

  /**
   * Shared Complainant/Contact/Respondent inputs (§ migration 0008) —
   * used by finalize and amend, grouped as one fieldset. Returns a
   * `fields()` getter (reads live values at submit time), the fieldset
   * element, and the input ids (for "Change" links). maxLength mirrors
   * BlotterController::parsePartyFields() (255 / 32).
   */
  function buildPartyFields({ complainantName, respondentName, complainantContactNumber }, hint) {
    const idPrefix = `blotter-party-${++partyFieldSeq}`;

    const fieldset = document.createElement('fieldset');
    fieldset.className = 'blotter-fieldset';
    const legend = document.createElement('legend');
    legend.className = 'blotter-fieldset__legend';
    legend.textContent = 'Parties involved (optional)';
    fieldset.appendChild(legend);
    if (hint) {
      const hintEl = document.createElement('p');
      hintEl.className = 'blotter-field__hint';
      hintEl.textContent = hint;
      fieldset.appendChild(hintEl);
    }

    const complainantInput = document.createElement('input');
    complainantInput.type = 'text';
    complainantInput.maxLength = 255;
    complainantInput.autocomplete = 'off';
    complainantInput.value = complainantName || '';

    const contactInput = document.createElement('input');
    contactInput.type = 'tel';
    contactInput.maxLength = 32;
    contactInput.autocomplete = 'off';
    contactInput.placeholder = 'e.g. 0917 123 4567';
    contactInput.value = complainantContactNumber || '';

    const respondentInput = document.createElement('input');
    respondentInput.type = 'text';
    respondentInput.maxLength = 255;
    respondentInput.autocomplete = 'off';
    respondentInput.value = respondentName || '';

    const grid = document.createElement('div');
    grid.className = 'blotter-field__grid';
    grid.append(
      buildField({ id: `${idPrefix}-complainant`, label: 'Complainant name', control: complainantInput }).el,
      buildField({ id: `${idPrefix}-contact`, label: 'Contact number', control: contactInput }).el,
      buildField({ id: `${idPrefix}-respondent`, label: 'Respondent name', control: respondentInput }).el,
    );
    fieldset.appendChild(grid);

    return {
      fields: () => ({
        complainantName: complainantInput.value.trim(),
        respondentName: respondentInput.value.trim(),
        complainantContactNumber: contactInput.value.trim(),
      }),
      element: fieldset,
      ids: {
        complainant: `${idPrefix}-complainant`,
        contact: `${idPrefix}-contact`,
        respondent: `${idPrefix}-respondent`,
      },
    };
  }

  /**
   * "Amend this entry" — collapsed until asked for. The form is built up
   * front (hidden) so what the Secretary typed survives Cancel/reopen.
   */
  function buildAmendSection() {
    const section = document.createElement('div');
    section.className = 'form-stack';
    section.id = 'blotter-amend';
    section.style.marginTop = 'var(--spacing-md)';

    const toggle = document.createElement('button');
    toggle.type = 'button';
    toggle.className = 'ghost';
    toggle.style.alignSelf = 'flex-start';
    toggle.innerHTML = `${icons.edit(16)} <span>Amend this entry</span>`;
    toggle.setAttribute('aria-expanded', 'false');
    toggle.setAttribute('aria-controls', 'blotter-amend-form');

    const form = buildAmendForm(() => {
      form.hidden = true;
      toggle.hidden = false;
      toggle.setAttribute('aria-expanded', 'false');
      toggle.focus();
    });
    form.id = 'blotter-amend-form';
    form.hidden = true;

    toggle.addEventListener('click', () => {
      form.hidden = false;
      toggle.hidden = true;
      toggle.setAttribute('aria-expanded', 'true');
      form.querySelector('select, textarea')?.focus();
    });

    section.append(toggle, form);
    return section;
  }

  function buildAmendForm(onCancel) {
    const form = document.createElement('form');
    form.className = 'form-stack';
    form.noValidate = true;
    form.style.borderTop = '1px solid var(--color-border)';
    form.style.paddingTop = 'var(--spacing-md)';

    const heading = document.createElement('h4');
    heading.style.margin = '0';
    heading.textContent = `Amend blotter entry (creates revision ${blotter.revisionNo + 1})`;

    const intro = document.createElement('p');
    intro.className = 'note';
    intro.style.margin = '0';
    intro.textContent = 'Change only what needs correcting. The current version stays on record and can still be retrieved.';

    const errorSummary = newErrorSummary();
    form.append(heading, intro, errorSummary);

    // case_status (migration 0009, 2026-09-05 UX pass) — forward-only,
    // matching BlotterController::amend()'s own enforcement exactly:
    // only options STRICTLY ahead of the current status are offered, and
    // 'resolved' never appears here at all — it's set only when the
    // parent incident itself is resolved (IncidentsController::
    // updateStatus()), never a Secretary's direct choice.
    const CASE_STATUS_RANK = { active: 0, under_investigation: 1, settled: 2, resolved: 3 };
    const CASE_STATUS_LABELS = { under_investigation: 'Under Investigation', settled: 'Settled' };
    const currentRank = CASE_STATUS_RANK[blotter.caseStatus] ?? 0;
    const forwardOptions = Object.keys(CASE_STATUS_LABELS).filter((key) => CASE_STATUS_RANK[key] > currentRank);

    let caseStatusSelect = null;
    if (forwardOptions.length > 0) {
      caseStatusSelect = document.createElement('select');
      const keepOption = document.createElement('option');
      keepOption.value = '';
      keepOption.textContent = `Keep current (${(blotter.caseStatus || 'active').replace('_', ' ')})`;
      caseStatusSelect.appendChild(keepOption);
      for (const key of forwardOptions) {
        const option = document.createElement('option');
        option.value = key;
        option.textContent = `Move to: ${CASE_STATUS_LABELS[key]}`;
        caseStatusSelect.appendChild(option);
      }
      form.appendChild(buildField({
        id: 'blotter-amend-case-status',
        label: 'Case status',
        hint: 'Moves forward only. “Resolved” is set automatically when the incident itself is resolved.',
        control: caseStatusSelect,
      }).el);
    }

    const summaryInput = document.createElement('textarea');
    summaryInput.rows = 6;
    summaryInput.required = true;
    summaryInput.classList.add('textarea--resizable');
    summaryInput.value = blotter.narrativeSummary;
    const summaryField = buildField({ id: 'blotter-amend-summary', label: 'Blotter summary', control: summaryInput });
    form.appendChild(summaryField.el);

    const party = buildPartyFields({
      complainantName: blotter.complainantName,
      respondentName: blotter.respondentName,
      complainantContactNumber: blotter.complainantContactNumber,
    });
    form.appendChild(party.element);

    const reasonInput = document.createElement('input');
    reasonInput.type = 'text';
    reasonInput.required = true;
    reasonInput.placeholder = 'e.g. Respondent’s name was misspelled at intake';
    const reasonField = buildField({
      id: 'blotter-amend-reason',
      label: 'Reason for amendment',
      hint: 'Required. Saved with the revision in the audit trail.',
      control: reasonInput,
    });
    form.appendChild(reasonField.el);

    const submit = document.createElement('button');
    submit.type = 'submit';
    submit.className = 'primary';
    submit.textContent = 'Save amendment';
    const cancel = document.createElement('button');
    cancel.type = 'button';
    cancel.className = 'ghost';
    cancel.textContent = 'Cancel';
    cancel.addEventListener('click', onCancel);
    const actions = document.createElement('div');
    actions.className = 'blotter-form-actions';
    actions.append(submit, cancel);
    form.appendChild(actions);

    form.addEventListener('submit', async (event) => {
      event.preventDefault();
      const summary = summaryInput.value.trim();
      const reason = reasonInput.value.trim();
      // The server requires both; saying so here, next to the field,
      // avoids a pointless 400.
      const errors = [];
      if (!summary) errors.push({ fieldId: 'blotter-amend-summary', message: 'Enter a blotter summary' });
      if (!reason) errors.push({ fieldId: 'blotter-amend-reason', message: 'Enter the reason for this amendment' });
      summaryField.setError(summary ? null : 'Enter a blotter summary');
      reasonField.setError(reason ? null : 'Enter the reason for this amendment');
      showErrorSummary(errorSummary, errors);
      if (errors.length > 0) return;

      const confirmed = await confirmDialog({
        title: `Save revision ${blotter.revisionNo + 1}?`,
        description: 'This creates an audited revision. The current text is preserved and remains retrievable.',
        confirmLabel: 'Save amendment',
        cancelLabel: 'Keep editing',
      });
      if (!confirmed) return;

      submit.disabled = true;
      submit.textContent = 'Saving…';
      try {
        await amendBlotter(incidentId, {
          narrativeSummary: summary,
          reason,
          ...party.fields(),
          caseStatus: caseStatusSelect?.value || undefined,
        });
        showToast('Amendment saved.', { variant: 'success' });
        await load();
      } catch (err) {
        submit.disabled = false;
        submit.textContent = 'Save amendment';
        showToast(err instanceof ApiClientError ? err.message : 'Could not save the amendment.', { variant: 'error' });
      }
    });

    return form;
  }

  // The Redaction tab polls while a job is queued/processing (its own
  // `renderRedactionTab()` doc explains why); this shell must stop that
  // on a full unmount too, not just on switching tabs away from it —
  // same `{stop}` contract main.js's boot() already expects from this
  // page (it used to cite a since-removed "AI Blotter Assistant" for the
  // reason; this is the real one now).
  return {
    stop() {
      if (redactionHandle) redactionHandle.stop();
    },
  };
}
