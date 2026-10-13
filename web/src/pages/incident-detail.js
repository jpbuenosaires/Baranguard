/**
 * incident-detail.js — the app's single per-incident detail view (§9's
 * W7): dossier, narrative, evidence, response timeline, the Admin
 * resolve control, and the Secretary's lifecycle actions
 * (duplicate/invalid/cancelled/reopened).
 *
 * This page used to be a three-tab case workspace (Incident / Redaction /
 * Blotter). The Electronic Blotter and the local-AI redaction pipeline
 * were removed (migration 0029): barangays keep the blotter and the
 * Lupon records in their own binders, and DILG BIMSS/KPIS remains the
 * mandated case ledger (docs/REFERENCE.md §1). Nothing here lists or
 * browses incidents; it is only reachable per-incident, from Incident
 * Management, the dashboard, SMS Monitor, the audit log, search and
 * notifications. The action panels are driven entirely by REAL server
 * state (§8) — an unavailable action says which prerequisite is missing
 * rather than hiding the control.
 *
 * kebab-case filename per §4.
 */

import {
  getIncident,
  getIncidentEvidence,
  downloadEvidenceFile,
  resolveIncident,
  updateIncidentLifecycle,
  logout,
  ApiClientError,
} from '../api/apiClient.js';
import { AppShell } from '../components/AppShell.js';
import { PageHeader } from '../components/PageHeader.js';
import { icons } from '../components/icons.js';
import { showToast } from '../components/Toast.js';
import { confirmDialog, promptText } from '../components/ConfirmDialog.js';
import { escapeHtml } from '../utils/escapeHtml.js';
import { formatManilaDateTime, formatManilaDate } from '../utils/manilaTime.js';
import { renderLoadingSkeleton, renderErrorState } from '../components/AsyncState.js';
import { SchoolC1Card, ReferralsCard, RelatedIncidentCard, resolveIncidentReference, describeIncidentRef } from '../components/IncidentCaseCards.js';
import { reportChannelLabel } from '../utils/reportChannel.js';
import { requireReason } from '../utils/reasonText.js';
import { INCIDENT_STATUS_LABELS, DISPATCH_STATUS_LABELS as SHARED_DISPATCH_STATUS_LABELS } from '../utils/statusLabels.js';
import { formatIncidentCode } from '../services/tanodWorkflowUi.js';

const INCIDENT_TYPE_LABELS = {
  theft: 'Theft', physical_injury: 'Physical Injury', disturbance: 'Disturbance',
  domestic_dispute: 'Domestic Dispute', vandalism: 'Vandalism',
  traffic_incident: 'Traffic Incident', fire: 'Fire',
  medical_emergency: 'Medical Emergency', missing_person: 'Missing Person',
  animal_complaint: 'Animal Complaint', other: 'Other',
};

const RESTRICTED_TO_SECRETARY = 'Restricted to the Barangay Secretary';
const NOT_AVAILABLE_FOR_ROLE = 'Not available for your role';
// Raw narratives are deleted by the retention job 90 days after creation
// (RetentionService; Rule 10 constant). GET /incidents/:id does not return
// raw_narrative_purged_at, so age is the only signal the screen has.
const NARRATIVE_RETENTION_DAYS = 90;

/** Parses the API's UTC timestamps ('YYYY-MM-DD HH:MM:SS' or ISO) into a Date, or null. */
function parseApiDate(value) {
  if (!value) return null;
  const raw = String(value);
  const d = new Date(/[zZ]|[+-][0-9]{2}:?[0-9]{2}$/.test(raw) ? raw : `${raw.replace(' ', 'T')}Z`);
  return Number.isNaN(d.getTime()) ? null : d;
}

/** Operational times are shown in Asia/Manila (Rule 11). */
function formatDateTime(value) {
  const d = parseApiDate(value);
  if (!d) return null;
  return formatManilaDateTime(d);
}

const STATUS_PILL_CLASS = {
  pending: 'status-pill--pending',
  dispatched: 'status-pill--info',
  resolved: 'status-pill--success',
  reopened: 'status-pill--critical',
  duplicate: 'status-pill--neutral',
  invalid: 'status-pill--neutral',
  cancelled: 'status-pill--neutral',
};

/** Plain words for every incident state (never the raw enum value). */
const STATUS_LABELS = INCIDENT_STATUS_LABELS;
const PRIORITY_LABELS = { critical: 'Critical', urgent: 'Urgent', high: 'High', normal: 'Normal', medium: 'Normal', low: 'Low' };
const DISPATCH_STATUS_LABELS = SHARED_DISPATCH_STATUS_LABELS;

function statusLabel(status) {
  return STATUS_LABELS[status] || String(status || 'Unknown').replace(/_/g, ' ');
}


/**
 * @param {HTMLElement} root
 * @param {{fullName:string, role:string}} user
 * @param {() => void} onLoggedOut
 * @param {(page: string, param?: any) => void} navigate
 * @param {number} incidentId
 */
export function renderIncidentDetailPage(root, user, onLoggedOut, navigate, incidentId) {
  root.innerHTML = '';

  const isSecretary = user.role === 'secretary';

  // There is no browsable list of incident records on this screen's
  // behalf: it returns to whichever list the signed-in role actually has.
  // Punong Barangay reaches incidents from the dashboard, everyone else
  // from Incident Management.
  const listPage = user.role === 'punong_barangay' ? 'dashboard' : 'incident-management';
  const listLabel = listPage === 'dashboard' ? 'Dashboard' : 'Incidents';

  const shell = AppShell(user, listPage, navigate, async () => {
    shell.logoutButton.disabled = true;
    await logout();
    onLoggedOut();
  });
  const { header, content } = shell;
  shell.el.classList.add('incident-detail-shell');
  root.appendChild(shell.el);

  const pageHeader = PageHeader({
    title: `Incident Record — ${formatIncidentCode(incidentId)}`,
    subtitle: 'Incident particulars and response timeline',
    icon: icons.fileText,
  });
  header.appendChild(pageHeader.el);

  const backButton = document.createElement('button');
  backButton.className = 'ghost';
  backButton.textContent = `← Back to ${listLabel}`;
  backButton.addEventListener('click', () => navigate(listPage));
  pageHeader.actions.appendChild(backButton);

  const body = document.createElement('div');
  content.appendChild(body);

  let incident = null;
  let evidence = [];
  // True when the evidence API answered 403 for this role: restricted,
  // which must not read as "no evidence recorded".
  let evidenceDenied = false;

  load();

  async function load() {
    renderLoading();
    try {
      incident = await getIncident(incidentId);
      // Evidence is enrichment — a failure degrades that one panel rather
      // than blanking a record staff may need to act on.
      evidenceDenied = false;
      evidence = await getIncidentEvidence(incidentId).catch((err) => {
        if (err instanceof ApiClientError && err.status === 403) evidenceDenied = true;
        return [];
      });
      renderShell();
    } catch (err) {
      renderError(err instanceof ApiClientError ? err.message : 'Something went wrong loading this incident.');
    }
  }

  // --- States (§8: Loading / Empty / Error / Populated) ---

  function renderLoading() {
    renderLoadingSkeleton({ container: content, count: 3, ariaLabel: 'Loading incident' });
  }

  function renderError(message) {
    renderErrorState({ container: content, message, onRetry: load });
  }

  function renderShell() {
    content.innerHTML = '';
    content.append(body);
    body.innerHTML = '';

    const incidentDisplayId = formatIncidentCode(incident?.incidentId || incidentId, incident?.displayId);
    const titleBlock = pageHeader.el.querySelector('.page-header__title');
    if (titleBlock) {
      titleBlock.innerHTML = `<span class="page-header__icon" aria-hidden="true">${icons.fileText(22)}</span> Incident Record — <span class="page-header__id-pill font-mono">${escapeHtml(incidentDisplayId)}</span>`;
    }

    // Exactly 1 Master Console Card on the entire screen
    const consoleCard = document.createElement('div');
    consoleCard.className = 'card incident-console-card case-dossier';

    // 1. Persistent Console Header: Hero & Quick Action
    const heroHeader = document.createElement('div');
    heroHeader.className = 'console-hero-header';

    const leftGroup = document.createElement('div');
    leftGroup.className = 'console-hero-header__left';

    const iconWrap = document.createElement('div');
    iconWrap.className = 'case-hero__icon';
    iconWrap.innerHTML = icons.fileText(22);

    const titleGroup = document.createElement('div');
    titleGroup.className = 'console-hero-header__titles';

    const title = document.createElement('h3');
    title.className = 'case-hero__title';
    title.textContent = INCIDENT_TYPE_LABELS[incident.incidentType] || incident.incidentType;

    const badges = document.createElement('div');
    badges.className = 'case-hero__badges';

    const incidentBadge = document.createElement('span');
    incidentBadge.className = 'incident-id-badge';
    incidentBadge.innerHTML = `${icons.fileText(13)} <span>${escapeHtml(incidentDisplayId)}</span>`;
    incidentBadge.title = `Incident Reference ID ${escapeHtml(incidentDisplayId)}`;

    const statusPill = document.createElement('span');
    statusPill.className = `status-pill ${STATUS_PILL_CLASS[incident.status] || 'status-pill--neutral'}`;
    statusPill.textContent = statusLabel(incident.status);
    statusPill.setAttribute('aria-label', `Status: ${statusLabel(incident.status)}`);

    const priorityPill = document.createElement('span');
    priorityPill.className = `status-pill ${incident.priority === 'urgent' || incident.priority === 'critical' ? 'status-pill--critical' : incident.priority === 'high' ? 'status-pill--warning' : 'status-pill--neutral'}`;
    priorityPill.textContent = `${PRIORITY_LABELS[incident.priority] || 'Normal'} priority`;

    badges.append(incidentBadge, statusPill, priorityPill);
    titleGroup.append(title, badges);
    leftGroup.append(iconWrap, titleGroup);

    const rightActions = document.createElement('div');
    rightActions.className = 'console-hero-header__actions';
    if (incident.status === 'resolved') {
      rightActions.appendChild(buildResolvedStatusCard());
    } else if (user.role === 'admin') {
      rightActions.appendChild(buildAdminResolvePanel());
    }

    heroHeader.append(leftGroup, rightActions);
    consoleCard.appendChild(heroHeader);

    // 2. Persistent Borderless Metadata Strip
    const metaStrip = document.createElement('div');
    metaStrip.className = 'meta-strip';

    // Location
    const locTile = document.createElement('div');
    locTile.className = 'meta-tile';
    const locCoords = incident.latitude != null && incident.longitude != null
      ? `${incident.latitude.toFixed(5)}, ${incident.longitude.toFixed(5)}`
      : null;
    const locDesc = incident.locationDescription
      ? (locCoords ? `${incident.locationDescription} (${locCoords})` : incident.locationDescription)
      : (locCoords || 'No location recorded');
    locTile.innerHTML = `
      <div class="meta-tile__icon">${icons.mapPin(15)}</div>
      <div class="meta-tile__content">
        <span class="meta-tile__label">Location</span>
        <span class="meta-tile__value" title="${escapeHtml(locDesc)}">${escapeHtml(locDesc)}</span>
      </div>
    `;

    // Date Filed
    const dateTile = document.createElement('div');
    dateTile.className = 'meta-tile';
    const filedDate = escapeHtml(formatDateTime(incident.createdAt) || 'Not recorded');
    dateTile.innerHTML = `
      <div class="meta-tile__icon">${icons.clock(15)}</div>
      <div class="meta-tile__content">
        <span class="meta-tile__label">Date & Time Filed</span>
        <span class="meta-tile__value">${filedDate}</span>
      </div>
    `;

    // Channel
    const channelTile = document.createElement('div');
    channelTile.className = 'meta-tile';
    const channelLabel = reportChannelLabel(incident.reportChannel)
      || (incident.source === 'app' ? 'Mobile App' : incident.source === 'walkin' ? 'Walk-in Desk' : 'Not recorded');
    channelTile.innerHTML = `
      <div class="meta-tile__icon">${icons.phone(15)}</div>
      <div class="meta-tile__content">
        <span class="meta-tile__label">Report channel</span>
        <span class="meta-tile__value">${channelLabel}</span>
      </div>
    `;

    // Officer
    const officerTile = document.createElement('div');
    officerTile.className = 'meta-tile';
    const officerName = incident.officerName || 'Not recorded';
    officerTile.innerHTML = `
      <div class="meta-tile__icon">${icons.users(15)}</div>
      <div class="meta-tile__content">
        <span class="meta-tile__label">Recording Officer</span>
        <span class="meta-tile__value">${escapeHtml(officerName)}</span>
      </div>
    `;

    metaStrip.append(locTile, dateTile, channelTile, officerTile);
    consoleCard.appendChild(metaStrip);

    // 3. WAI-ARIA Tab Navigation Strip
    const tabList = document.createElement('div');
    tabList.className = 'console-tabs';
    tabList.setAttribute('role', 'tablist');
    tabList.setAttribute('aria-label', 'Incident record sections');

    const tabDossier = document.createElement('button');
    tabDossier.type = 'button';
    tabDossier.className = 'console-tab console-tab--active';
    tabDossier.setAttribute('role', 'tab');
    tabDossier.id = 'tab-dossier';
    tabDossier.setAttribute('aria-selected', 'true');
    tabDossier.setAttribute('aria-controls', 'panel-dossier');
    tabDossier.setAttribute('tabindex', '0');
    tabDossier.innerHTML = `<span class="console-tab__icon" aria-hidden="true">${icons.fileText(15)}</span><span>Incident Dossier & School C-1</span>`;

    const tabOperations = document.createElement('button');
    tabOperations.type = 'button';
    tabOperations.className = 'console-tab';
    tabOperations.setAttribute('role', 'tab');
    tabOperations.id = 'tab-operations';
    tabOperations.setAttribute('aria-selected', 'false');
    tabOperations.setAttribute('aria-controls', 'panel-operations');
    tabOperations.setAttribute('tabindex', '-1');
    tabOperations.innerHTML = `<span class="console-tab__icon" aria-hidden="true">${icons.clock(15)}</span><span>Response Timeline & Case Links</span>`;

    tabList.append(tabDossier, tabOperations);
    consoleCard.appendChild(tabList);

    // 4. Tab Panels Container
    const panelsWrap = document.createElement('div');
    panelsWrap.className = 'console-panels';

    // Panel 1: Dossier Body
    const panelDossier = document.createElement('div');
    panelDossier.className = 'tab-panel tab-panel--active';
    panelDossier.id = 'panel-dossier';
    panelDossier.setAttribute('role', 'tabpanel');
    panelDossier.setAttribute('aria-labelledby', 'tab-dossier');
    panelDossier.setAttribute('tabindex', '0');
    panelDossier.appendChild(buildDossierBody());
    panelsWrap.appendChild(panelDossier);

    // Panel 2: Operations Body
    const panelOperations = document.createElement('div');
    panelOperations.className = 'tab-panel';
    panelOperations.id = 'panel-operations';
    panelOperations.setAttribute('role', 'tabpanel');
    panelOperations.setAttribute('aria-labelledby', 'tab-operations');
    panelOperations.setAttribute('tabindex', '0');
    panelOperations.appendChild(buildOperationsBody());
    panelsWrap.appendChild(panelOperations);

    consoleCard.appendChild(panelsWrap);
    body.appendChild(consoleCard);

    // Tab Switching Logic
    const tabs = [tabDossier, tabOperations];
    const panels = [panelDossier, panelOperations];

    function activateTab(index) {
      tabs.forEach((t, i) => {
        const isActive = i === index;
        t.setAttribute('aria-selected', isActive ? 'true' : 'false');
        t.setAttribute('tabindex', isActive ? '0' : '-1');
        t.classList.toggle('console-tab--active', isActive);
      });
      panels.forEach((p, i) => {
        p.classList.toggle('tab-panel--active', i === index);
      });
    }

    tabDossier.addEventListener('click', () => activateTab(0));
    tabOperations.addEventListener('click', () => activateTab(1));

    tabList.addEventListener('keydown', (e) => {
      let currentIndex = tabs.findIndex((t) => t.getAttribute('aria-selected') === 'true');
      if (e.key === 'ArrowRight' || e.key === 'ArrowDown') {
        e.preventDefault();
        const next = (currentIndex + 1) % tabs.length;
        activateTab(next);
        tabs[next].focus();
      } else if (e.key === 'ArrowLeft' || e.key === 'ArrowUp') {
        e.preventDefault();
        const prev = (currentIndex - 1 + tabs.length) % tabs.length;
        activateTab(prev);
        tabs[prev].focus();
      } else if (e.key === 'Home') {
        e.preventDefault();
        activateTab(0);
        tabs[0].focus();
      } else if (e.key === 'End') {
        e.preventDefault();
        activateTab(tabs.length - 1);
        tabs[tabs.length - 1].focus();
      }
    });
  }

  /**
   * Tab 1: Incident Dossier & Safer School Zone (Annex C-1) Body.
   */
  function buildDossierBody() {
    const dossierBody = document.createElement('div');
    dossierBody.className = 'dossier-body';

    // 1. Involved Parties & Privacy Section
    const partiesSection = document.createElement('div');
    partiesSection.className = 'dossier-section dossier-section--parties';

    const missingParty = isSecretary ? 'Not recorded' : RESTRICTED_TO_SECRETARY;

    if (!isSecretary) {
      const shield = document.createElement('div');
      shield.className = 'dossier-privacy-shield';
      shield.setAttribute('role', 'note');
      shield.innerHTML = `
        <div class="dossier-privacy-shield__icon" aria-hidden="true">${icons.shield(18)}</div>
        <div class="dossier-privacy-shield__body">
          <div class="dossier-privacy-shield__header">
            <span class="dossier-privacy-shield__title">Confidential Records Protection</span>
            <span class="dossier-privacy-shield__citation">RA 10173 & RA 7160 §394</span>
          </div>
          <p class="dossier-privacy-shield__desc">
            Complainant, respondent, and narrative details are <strong>${RESTRICTED_TO_SECRETARY}</strong> as designated records custodian.
          </p>
          <div class="dossier-privacy-shield__tags">
            <span class="party-card__tag privacy-pill party-card__tag--complainant">Complainant: ${RESTRICTED_TO_SECRETARY}</span>
            <span class="party-card__tag privacy-pill party-card__tag--respondent">Respondent: ${RESTRICTED_TO_SECRETARY}</span>
            <span class="party-card__tag privacy-pill party-card__tag--narrative">Narrative: The narrative is restricted to the Barangay Secretary (RA 10173).</span>
          </div>
        </div>
      `;
      partiesSection.appendChild(shield);
    } else {
      const partiesGrid = document.createElement('div');
      partiesGrid.className = 'parties-grid';

      const compCard = document.createElement('div');
      compCard.className = 'party-card';
      const compName = incident.complainantName || missingParty;
      const compContact = incident.complainantContactNumber || missingParty;
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
      const respName = incident.respondentName || missingParty;
      respCard.innerHTML = `
        <div class="party-card__role">
          <span class="party-card__tag party-card__tag--respondent">Respondent</span>
        </div>
        <div class="party-card__name">${escapeHtml(respName)}</div>
      `;

      partiesGrid.append(compCard, respCard);
      partiesSection.appendChild(partiesGrid);
    }

    dossierBody.appendChild(partiesSection);

    // 2. Narrative Section (Secretary-only readable view)
    if (isSecretary) {
      const narrativeSection = document.createElement('div');
      narrativeSection.className = 'dossier-section dossier-section--narrative';

      const narrativeHeader = document.createElement('div');
      narrativeHeader.className = 'dossier-subheading';
      narrativeHeader.innerHTML = `<span>Incident Narrative</span>`;
      narrativeSection.appendChild(narrativeHeader);

      const narrativeText = incident.rawNarrative || missingNarrativeText();
      const narrativeBody = document.createElement('div');
      narrativeBody.className = 'doc-blockquote';
      narrativeBody.textContent = narrativeText;
      narrativeSection.appendChild(narrativeBody);
      dossierBody.appendChild(narrativeSection);
    }

    // 3. Digital Evidence Section
    const evidenceSection = document.createElement('div');
    evidenceSection.className = 'dossier-section dossier-section--evidence';
    evidenceSection.appendChild(buildEvidence());
    dossierBody.appendChild(evidenceSection);

    // 4. Safer School Zone (Annex C-1) Subsection
    dossierBody.appendChild(SchoolC1Card({ incidentId, canEdit: user.role === 'admin' || isSecretary }));

    return dossierBody;
  }

  /**
   * Tab 2: Response Timeline, Responders, Case Lifecycle & Links Body.
   */
  function buildOperationsBody() {
    const opsBody = document.createElement('div');
    opsBody.className = 'operations-body case-ops-panel';

    opsBody.appendChild(buildTimeline());
    opsBody.appendChild(buildResponders());

    const refsHeader = document.createElement('div');
    refsHeader.className = 'panel-command-header panel-command-header--sub';
    refsHeader.innerHTML = `
      <div class="panel-command-header__title">
        <span class="panel-command-header__icon" aria-hidden="true">${icons.layers(16)}</span>
        <h4 class="panel-command-title">Case Connections & References</h4>
      </div>
    `;
    opsBody.appendChild(refsHeader);

    if (isSecretary) opsBody.appendChild(buildLifecycleCard());
    opsBody.appendChild(RelatedIncidentCard({
      incidentId,
      relatedIncident: incident.relatedIncident,
      relatedBy: incident.relatedBy,
      canEdit: user.role === 'admin' || isSecretary,
      navigate,
      onChanged: load,
    }));
    opsBody.appendChild(ReferralsCard({
      incidentId,
      canAdd: user.role === 'admin' || isSecretary,
      incidentLabel: formatIncidentCode(incidentId, incident.displayId),
    }));

    return opsBody;
  }

  /**
   * Empty-narrative wording for the Secretary. Raw narratives are deleted 90
   * days after the incident is logged, and the API does not say whether this
   * one was purged, so an old record is described honestly as "removed" and a
   * recent one as "not recorded".
   */
  function missingNarrativeText() {
    const created = parseApiDate(incident.createdAt);
    const ageDays = created ? (Date.now() - created.getTime()) / 86400000 : 0;
    if (ageDays > NARRATIVE_RETENTION_DAYS) {
      return `The confidential narrative was removed after the ${NARRATIVE_RETENTION_DAYS}-day retention period.`;
    }
    return 'No narrative recorded.';
  }

  function buildEvidence() {
    if (evidence.length === 0) {
      const bar = document.createElement('div');
      bar.className = 'evidence-bar--empty';
      const message = evidenceDenied
        ? `Digital evidence: ${NOT_AVAILABLE_FOR_ROLE}.`
        : 'No digital evidence attachments recorded for this incident.';
      bar.innerHTML = `
        <div class="evidence-bar--empty__left">
          <span style="color:var(--color-text-secondary);display:flex;align-items:center;">${icons.fileText(15)}</span>
          <span>${escapeHtml(message)}</span>
        </div>
      `;
      return bar;
    }

    const card = document.createElement('div');
    card.className = 'card doc-card';

    const header = document.createElement('div');
    header.className = 'doc-card__header';

    const titleGroup = document.createElement('div');
    titleGroup.className = 'doc-card__title-group';
    const iconWrap = document.createElement('span');
    iconWrap.className = 'doc-card__icon';
    iconWrap.innerHTML = icons.fileText(18);
    const heading = document.createElement('h3');
    heading.textContent = `Digital Evidence (${evidence.length})`;
    titleGroup.append(iconWrap, heading);

    const badge = document.createElement('span');
    badge.className = 'status-pill status-pill--info';
    badge.textContent = 'Chain of Custody Logged';

    header.append(titleGroup, badge);
    card.appendChild(header);

    const body = document.createElement('div');
    body.className = 'doc-card__body';

    const list = document.createElement('div');
    list.className = 'evidence-list';
    for (const item of evidence) {
      const itemWrap = document.createElement('div');
      itemWrap.className = 'evidence-item-wrap';

      const row = document.createElement('div');
      row.className = 'evidence-item';

      const left = document.createElement('div');
      left.className = 'evidence-item__left';
      const icon = document.createElement('div');
      icon.className = 'evidence-item__icon';
      icon.innerHTML = item.type === 'voice' ? icons.radio(18) : icons.fileText(18);

      const details = document.createElement('div');
      details.className = 'evidence-item__details';

      const title = document.createElement('span');
      title.className = 'evidence-item__title';
      title.textContent = `${item.type === 'voice' ? 'Voice note' : 'Photo'} — ${item.originalFilename}`;

      const meta = document.createElement('span');
      meta.className = 'evidence-item__meta';
      const kb = Math.max(1, Math.round(item.byteSize / 1024));
      meta.textContent = `${kb} KB · ${formatDateTime(item.uploadedAt) || 'time not recorded'}`;

      details.append(title, meta);
      left.append(icon, details);

      const right = document.createElement('div');
      right.className = 'evidence-item__right';

      const typeBadge = document.createElement('span');
      typeBadge.className = 'evidence-type-badge';
      typeBadge.textContent = item.type === 'voice' ? 'Voice Audio' : 'Photo Attachment';
      right.appendChild(typeBadge);

      if (item.sha256) {
        const hashBadge = document.createElement('span');
        hashBadge.className = 'evidence-hash-badge';
        hashBadge.textContent = `SHA-256: ${String(item.sha256).slice(0, 10)}…`;
        right.appendChild(hashBadge);
      }

      const previewSlot = document.createElement('div');
      previewSlot.className = 'evidence-item__preview';
      let objectUrl = null;

      const viewButton = document.createElement('button');
      viewButton.type = 'button';
      viewButton.className = 'ghost evidence-item__view-btn';
      viewButton.textContent = item.type === 'voice' ? 'Play' : 'View';

      viewButton.addEventListener('click', async () => {
        // Toggle off — collapse the preview and free the blob rather than
        // leaving it (and, for audio, playback) running in the background.
        if (objectUrl) {
          URL.revokeObjectURL(objectUrl);
          objectUrl = null;
          previewSlot.replaceChildren();
          viewButton.textContent = item.type === 'voice' ? 'Play' : 'View';
          return;
        }
        viewButton.disabled = true;
        const originalLabel = viewButton.textContent;
        viewButton.textContent = 'Loading…';
        try {
          const blob = await downloadEvidenceFile(item.incidentId, item.attachmentId);
          objectUrl = URL.createObjectURL(blob);
          previewSlot.replaceChildren();
          if (item.type === 'voice') {
            const audio = document.createElement('audio');
            audio.controls = true;
            audio.src = objectUrl;
            audio.className = 'evidence-item__audio';
            previewSlot.appendChild(audio);
          } else {
            const img = document.createElement('img');
            img.src = objectUrl;
            img.alt = item.originalFilename || 'Incident photo evidence';
            img.className = 'evidence-item__image';
            previewSlot.appendChild(img);
          }
          viewButton.textContent = 'Hide';
        } catch (err) {
          viewButton.textContent = originalLabel;
          showToast(err instanceof ApiClientError ? err.message : 'Could not load this evidence file.', { variant: 'error' });
        } finally {
          viewButton.disabled = false;
        }
      });
      right.appendChild(viewButton);

      row.append(left, right);
      itemWrap.append(row, previewSlot);
      list.appendChild(itemWrap);
    }
    body.appendChild(list);
    card.appendChild(body);

    return card;
  }

  /** Every responder ever dispatched to this incident (A-13). Names are shown to the Admin only. */
  function buildResponders() {
    const card = document.createElement('div');
    card.className = 'card';
    const heading = document.createElement('h3');
    heading.className = 'incident-card-heading';
    heading.textContent = 'Responders';
    card.appendChild(heading);
    const list = Array.isArray(incident.dispatches) ? incident.dispatches : [];
    if (list.length === 0) {
      const none = document.createElement('p');
      none.className = 'note';
      none.textContent = 'No tanod has been dispatched to this incident.';
      card.appendChild(none);
      return card;
    }
    const wrap = document.createElement('div');
    wrap.className = 'responders-table-wrap';

    const table = document.createElement('table');
    table.className = 'responders-table';
    const caption = document.createElement('caption');
    caption.className = 'sr-only';
    caption.textContent = 'Responders dispatched to this incident';
    table.appendChild(caption);
    const head = document.createElement('thead');
    const headRow = document.createElement('tr');
    for (const label of ['Responder', 'Status', 'Dispatched', 'On scene']) {
      const th = document.createElement('th');
      th.scope = 'col';
      th.textContent = label;
      headRow.appendChild(th);
    }
    head.appendChild(headRow);
    table.appendChild(head);
    const tbody = document.createElement('tbody');
    list.forEach((d, i) => {
      const tr = document.createElement('tr');
      const cells = [
        user.role === 'admin' ? (d.tanodName || `Responder ${i + 1}`) : `Responder ${i + 1}`,
        DISPATCH_STATUS_LABELS[d.status] || String(d.status || '').replace(/_/g, ' '),
        formatDateTime(d.dispatchedAt) || 'Not recorded',
        d.arrivedAt ? formatDateTime(d.arrivedAt) : 'Not yet',
      ];
      for (const text of cells) {
        const td = document.createElement('td');
        td.textContent = text;
        tr.appendChild(td);
      }
      tbody.appendChild(tr);
    });
    table.appendChild(tbody);
    wrap.appendChild(table);
    card.appendChild(wrap);
    return card;
  }

  function buildTimeline() {
    const card = document.createElement('div');
    card.className = 'card';

    const headerRow = document.createElement('div');
    headerRow.className = 'incident-card-heading';

    const iconWrap = document.createElement('span');
    iconWrap.className = 'incident-card-heading__icon';
    iconWrap.innerHTML = icons.clock(18);

    const heading = document.createElement('h3');
    heading.textContent = 'Incident Timeline';

    headerRow.append(iconWrap, heading);
    card.appendChild(headerRow);

    const isResolved = incident.status === 'resolved';
    const firstDispatch = Array.isArray(incident.dispatches) ? incident.dispatches[0] : null;
    const effectiveDispatchedAt = incident.dispatchedAt || firstDispatch?.dispatchedAt || null;
    const effectiveArrivedAt = incident.arrivedAt || firstDispatch?.arrivedAt || null;
    const resolvedTs = incident.resolvedAt
      || (isResolved ? (incident.dispatches?.find((d) => d.completedAt)?.completedAt || incident.createdAt) : null);

    const stages = [
      ['Reported', incident.createdAt],
      ['Dispatched', effectiveDispatchedAt],
      ['Arrived on scene', effectiveArrivedAt],
      ['Resolved', isResolved ? (resolvedTs || incident.createdAt) : null],
    ];

    const visibleStages = stages;

    let lastReachedIdx = -1;
    visibleStages.forEach(([_, ts], idx) => {
      if (ts) lastReachedIdx = idx;
    });

    const list = document.createElement('ol');
    list.className = 'timeline';
    list.setAttribute('role', 'list');
    list.setAttribute('aria-label', 'Incident response timeline');

    visibleStages.forEach(([label, timestamp], i) => {
      const reached = Boolean(timestamp);
      // When resolved, all reached nodes are done; none pulse as in-progress!
      const isLatest = !isResolved && (i === lastReachedIdx);

      const item = document.createElement('li');
      item.className = 'timeline__item';
      item.setAttribute('role', 'listitem');
      if (isLatest) {
        item.setAttribute('aria-current', 'step');
      }

      const rail = document.createElement('div');
      rail.className = 'timeline__rail';
      const node = document.createElement('span');
      let nodeClass = 'timeline__node';
      if (reached) {
        if (isLatest) {
          nodeClass += ' timeline__node--current';
          node.innerHTML = '<span class="timeline__node-dot" aria-hidden="true"></span>';
        } else if (isResolved && i === visibleStages.length - 1) {
          nodeClass += ' timeline__node--resolved';
          node.innerHTML = icons.check(11);
        } else {
          nodeClass += ' timeline__node--done';
          node.innerHTML = icons.check(11);
        }
      } else {
        nodeClass += ' timeline__node--pending';
        node.innerHTML = '<span class="timeline__node-hollow" aria-hidden="true"></span>';
      }
      node.className = nodeClass;
      rail.appendChild(node);

      if (i < visibleStages.length - 1) {
        const connector = document.createElement('span');
        const nextReached = Boolean(visibleStages[i + 1][1]);
        connector.className = 'timeline__connector' + (reached && nextReached ? (isResolved ? ' timeline__connector--done timeline__connector--resolved' : ' timeline__connector--done') : '');
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
      value.textContent = reached ? (formatDateTime(timestamp) || (isResolved && label === 'Resolved' ? 'Resolved' : 'Completed')) : 'Pending';

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
    if (incident.status === 'resolved') {
      return buildResolvedStatusCard();
    }

    const card = document.createElement('div');
    card.className = 'card doc-card';

    const activeDispatch = incident.hasActiveDispatch;
    let blockedBecause = null;
    // A pending or reopened incident that never needed a dispatch can be
    // closed with a written reason (migration 0039); a dispatched one is
    // resolved once its responders have finished.
    const noDispatchResolve = incident.status === 'pending' || incident.status === 'reopened';
    if (incident.status !== 'dispatched' && !noDispatchResolve) {
      blockedBecause = `This incident is ${statusLabel(incident.status)} and cannot be resolved from here.`;
    } else if (activeDispatch) {
      blockedBecause = 'A dispatch is still active. Complete or cancel it before resolving.';
    }

    const header = document.createElement('div');
    header.className = 'doc-card__header';

    const titleGroup = document.createElement('div');
    titleGroup.className = 'doc-card__title-group';
    const iconWrap = document.createElement('span');
    iconWrap.className = 'doc-card__icon';
    iconWrap.innerHTML = icons.checkCircle(18);
    const heading = document.createElement('h3');
    heading.textContent = 'Incident resolution';
    titleGroup.append(iconWrap, heading);

    const statusPill = document.createElement('span');
    statusPill.className = blockedBecause === null
      ? 'status-pill status-pill--success'
      : 'status-pill status-pill--neutral';
    statusPill.textContent = blockedBecause === null ? 'Ready to Resolve' : 'Prerequisite Pending';

    header.append(titleGroup, statusPill);
    card.appendChild(header);

    const body = document.createElement('div');
    body.className = 'doc-card__body';

    const button = document.createElement('button');
    button.className = 'primary';
    const buttonLabel = noDispatchResolve ? 'Resolve without dispatch' : 'Mark incident resolved';
    button.textContent = buttonLabel;
    button.disabled = blockedBecause !== null;

    button.addEventListener('click', async () => {
      if (noDispatchResolve) {
        const reason = await promptText({
          title: 'Resolve without dispatch?',
          description: 'No tanod was sent to this incident. Say why it needed no dispatch. The reason is kept with the incident.',
          label: 'Reason (required)',
          confirmLabel: 'Mark resolved',
          cancelLabel: 'Cancel',
          onConfirmAsync: async (value) => {
            await resolveIncident(incidentId, requireReason(value, 'reason'));
          },
        });
        if (reason === null) return;
        showToast('Incident marked resolved.', { variant: 'success' });
        await load();
        return;
      }
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
        await resolveIncident(incidentId);
        showToast('Incident marked resolved.', { variant: 'success' });
        await load();
      } catch (err) {
        button.disabled = false;
        button.textContent = buttonLabel;
        showToast(err instanceof ApiClientError ? err.message : 'Could not resolve the incident.', { variant: 'error' });
      }
    });

    body.appendChild(button);

    if (blockedBecause) {
      const callout = document.createElement('div');
      callout.className = 'resolve-prerequisite-callout';
      const reason = document.createElement('p');
      reason.className = 'note';
      reason.textContent = blockedBecause;
      callout.appendChild(reason);
      body.appendChild(callout);
    }

    card.appendChild(body);
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
    card.className = 'card doc-card';

    const header = document.createElement('div');
    header.className = 'doc-card__header';

    const titleGroup = document.createElement('div');
    titleGroup.className = 'doc-card__title-group';
    const iconWrap = document.createElement('span');
    iconWrap.className = 'doc-card__icon';
    iconWrap.innerHTML = icons.shield(18);
    const heading = document.createElement('h3');
    heading.textContent = 'Case lifecycle';
    titleGroup.append(iconWrap, heading);

    const statusBadge = document.createElement('span');
    statusBadge.className = 'status-pill status-pill--neutral';
    statusBadge.textContent = `Status: ${statusLabel(incident.status)}`;

    header.append(titleGroup, statusBadge);
    card.appendChild(header);

    const body = document.createElement('div');
    body.className = 'doc-card__body';

    if (incident.status === 'duplicate' && incident.duplicateOfIncidentId) {
      const note = document.createElement('p');
      note.className = 'note';
      note.textContent = 'Linked as a duplicate of another incident.';
      body.appendChild(note);
      const viewLink = document.createElement('button');
      viewLink.className = 'ghost';
      viewLink.textContent = 'View the linked incident';
      viewLink.addEventListener('click', () => navigate('incident-detail', incident.duplicateOfIncidentId));
      body.appendChild(viewLink);
    }

    const legalTargets = LIFECYCLE_TRANSITIONS[incident.status] || [];
    if (legalTargets.length === 0) {
      const note = document.createElement('p');
      note.className = 'note';
      note.textContent = 'No lifecycle action is available from this status.';
      body.appendChild(note);
      card.appendChild(body);
      return card;
    }

    const activeDispatch = incident.hasActiveDispatch;
    const actionsRow = document.createElement('div');
    actionsRow.className = 'incident-form-actions';

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
    body.appendChild(actionsRow);

    if (activeDispatch && legalTargets.some((t) => t !== 'reopened')) {
      const callout = document.createElement('div');
      callout.className = 'resolve-prerequisite-callout';
      const reason = document.createElement('p');
      reason.className = 'note';
      reason.textContent = 'A dispatch is still active. Complete or cancel it before changing the lifecycle (reopening is exempt).';
      callout.appendChild(reason);
      body.appendChild(callout);
    }

    if (incident.lifecycleChangedAt) {
      const meta = document.createElement('p');
      meta.className = 'note';
      meta.textContent = `Last lifecycle change: ${formatDateTime(incident.lifecycleChangedAt)}.`;
      body.appendChild(meta);
    }

    card.appendChild(body);
    return card;
  }

  async function runLifecycleAction(target, meta) {
    if (target === 'duplicate') {
      // Step 1: the incident number as staff see it everywhere (INC-2026-048).
      // Step 2: look it up and show what it is before anything is saved.
      let targetRef = null;
      await promptText({
        title: meta.label,
        description: `${meta.description} Enter the incident number this is a duplicate of (same barangay only), for example INC-2026-048.`,
        label: 'Duplicate of incident number',
        placeholder: 'e.g. INC-2026-048',
        inputType: 'text',
        confirmLabel: 'Look up incident',
        onConfirmAsync: async (value) => {
          const found = await resolveIncidentReference(value);
          if (found.incidentId === incident.incidentId) {
            throw new Error('An incident cannot be a duplicate of itself.');
          }
          targetRef = found;
        },
      });
      if (!targetRef) return;
      const targetLabel = formatIncidentCode(targetRef.incidentId, targetRef.displayId);
      await confirmDialog({
        title: `Mark as duplicate of ${targetLabel}?`,
        description: describeIncidentRef(targetRef),
        confirmLabel: meta.label,
        onConfirmAsync: async () => {
          await updateIncidentLifecycle(incidentId, {
            status: 'duplicate',
            duplicateOfIncidentId: targetRef.incidentId,
            idempotencyKey: crypto.randomUUID(),
          });
          showToast(`Marked as a duplicate of ${targetLabel}.`, { variant: 'success' });
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
    const resolvedTime = incident.resolvedAt
      ? formatDateTime(incident.resolvedAt)
      : (incident.dispatches?.find((d) => d.completedAt)?.completedAt ? formatDateTime(incident.dispatches.find((d) => d.completedAt).completedAt) : null);
    card.innerHTML = `
      <div class="resolution-badge-card__icon">${icons.checkCircle(20)}</div>
      <div style="flex:1;min-width:0;">
        <h4 class="resolution-badge-card__title">Case Closed & Resolved</h4>
        <p class="resolution-badge-card__desc">This incident has been marked resolved.${resolvedTime ? ` (${escapeHtml(resolvedTime)})` : ''}</p>
      </div>
    `;
    return card;
  }
}
