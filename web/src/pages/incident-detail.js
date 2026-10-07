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
import { renderLoadingSkeleton, renderErrorState } from '../components/AsyncState.js';
import { SchoolC1Card, ReferralsCard, RelatedIncidentCard } from '../components/IncidentCaseCards.js';
import { reportChannelLabel } from '../utils/reportChannel.js';

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
  root.appendChild(shell.el);

  const pageHeader = PageHeader({
    title: `Incident Record — #${incidentId}`,
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

  load();

  async function load() {
    renderLoading();
    try {
      incident = await getIncident(incidentId);
      // Evidence is enrichment — a failure degrades that one panel rather
      // than blanking a record staff may need to act on.
      evidence = await getIncidentEvidence(incidentId).catch(() => []);
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

    const incidentDisplayId = incident?.displayId || `#${incident?.incidentId || incidentId}`;
    const titleBlock = pageHeader.el.querySelector('.page-header__title');
    if (titleBlock) {
      titleBlock.innerHTML = `<span class="page-header__icon" aria-hidden="true">${icons.fileText(22)}</span> Incident Record — <span class="page-header__id-pill font-mono">${escapeHtml(incidentDisplayId)}</span>`;
    }

    const layout = document.createElement('div');
    layout.className = 'split-panel';

    const main = document.createElement('div');
    main.className = 'incident-detail__main';
    const aside = document.createElement('div');
    aside.className = 'incident-detail__aside';

    main.appendChild(buildDossierCard());
    main.appendChild(buildNarrative());
    main.appendChild(buildEvidence());
    // 2026-10 (contract §5, §7): school link + Annex C-1 fields (Admin and
    // Secretary edit, Punong Barangay reads) and the referrals list. Both
    // cards load and fail independently of the rest of the record.
    main.appendChild(SchoolC1Card({ incidentId, canEdit: user.role === 'admin' || isSecretary }));

    if (incident.status === 'resolved') {
      aside.appendChild(buildResolvedStatusCard());
    } else if (user.role === 'admin') {
      aside.appendChild(buildAdminResolvePanel());
    }
    if (isSecretary) aside.appendChild(buildLifecycleCard());
    // Reference link to another incident (admin|secretary may change it;
    // Punong Barangay reads it). Separate from the Secretary's duplicate
    // lifecycle action above, and it never changes status or dispatch.
    aside.appendChild(RelatedIncidentCard({
      incidentId,
      relatedIncident: incident.relatedIncident,
      relatedBy: incident.relatedBy,
      canEdit: user.role === 'admin' || isSecretary,
      navigate,
      onChanged: load,
    }));
    aside.appendChild(ReferralsCard({
      incidentId,
      canAdd: user.role === 'admin' || isSecretary,
      incidentLabel: incident.displayId || `#${incidentId}`,
    }));
    aside.appendChild(buildTimeline());

    layout.append(main, aside);
    body.appendChild(layout);
  }

  /**
   * Unified Case Dossier: Combines Incident Type, Badges, Involved Parties,
   * and Incident Particulars into a clear, spacious tiered layout with zero truncation.
   */
  function buildDossierCard() {
    const card = document.createElement('div');
    card.className = 'card case-hero';

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

    const incidentBadge = document.createElement('span');
    incidentBadge.className = 'incident-id-badge';
    incidentBadge.innerHTML = `${icons.fileText(13)} <span>${escapeHtml(incidentDisplayId)}</span>`;
    incidentBadge.title = `Incident Reference ID ${escapeHtml(incidentDisplayId)}`;
    badgesToAppend.push(incidentBadge);

    const statusPill = document.createElement('span');
    statusPill.className = `status-pill ${STATUS_PILL_CLASS[incident.status] || 'status-pill--neutral'}`;
    statusPill.textContent = (incident.status || 'unknown').toUpperCase();
    badgesToAppend.push(statusPill);

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
    // `report_channel` (migration 0036) says how the matter was reported;
    // an older row/server without it falls back to the creating client.
    const channelLabel = reportChannelLabel(incident.reportChannel)
      || (incident.source === 'app' ? 'Mobile App' : incident.source === 'walkin' ? 'Walk-in Desk' : 'Hotline Call');
    channelTile.innerHTML = `
      <div class="meta-tile__icon">${icons.phone(16)}</div>
      <div class="meta-tile__content">
        <span class="meta-tile__label">Report channel</span>
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
    const compName = incident.complainantName || 'Walk-in Complainant / Confidential';
    const compContact = incident.complainantContactNumber || 'No contact number provided';
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
    const respName = incident.respondentName || 'Unspecified / Under Investigation';
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
    heading.textContent = 'Incident Narrative';
    titleGroup.appendChild(heading);

    const actions = document.createElement('div');
    actions.className = 'doc-card__actions';

    // Rule 1: raw_narrative is only ever returned to a Secretary
    // (RA 7160 §394(c) records custodian); every other role gets nothing.
    const narrativeText = isSecretary
      ? (incident.rawNarrative || 'No narrative recorded yet.')
      : 'The narrative is restricted to the Barangay Secretary (RA 10173).';

    if (isSecretary && incident.rawNarrative) {
      const copyBtn = document.createElement('button');
      copyBtn.className = 'btn-copy';
      copyBtn.innerHTML = `${icons.fileText(14)} Copy Narrative`;
      copyBtn.addEventListener('click', () => {
        navigator.clipboard.writeText(incident.rawNarrative);
        showToast('Narrative copied to clipboard.', { variant: 'success' });
      });
      actions.appendChild(copyBtn);
    }

    header.append(titleGroup, actions);
    card.appendChild(header);

    const body = document.createElement('div');
    body.className = 'doc-blockquote';
    body.textContent = narrativeText;
    card.appendChild(body);

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
      meta.textContent = `${kb} KB · ${new Date(item.uploadedAt).toLocaleString()}`;

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
    heading.textContent = 'Incident Timeline';
    heading.style.margin = '0';

    headerRow.append(iconWrap, heading);
    card.appendChild(headerRow);

    const stages = [
      ['Reported', incident.createdAt],
      ['Dispatched', incident.dispatchedAt],
      ['Arrived on scene', incident.arrivedAt],
    ];

    const visibleStages = stages;

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
    if (incident.status === 'resolved') {
      return buildResolvedStatusCard();
    }

    const card = document.createElement('div');
    card.className = 'card doc-card';

    const activeDispatch = incident.hasActiveDispatch;
    let blockedBecause = null;
    if (incident.status !== 'dispatched') {
      blockedBecause = `Only a dispatched incident can be resolved — this one is ${incident.status}.`;
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
    button.textContent = 'Mark incident resolved';
    button.disabled = blockedBecause !== null;

    button.addEventListener('click', async () => {
      const description = 'This closes the incident. It cannot be reopened from this screen.';
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
    statusBadge.textContent = `Status: ${String(incident.status || '').replace(/_/g, ' ').toUpperCase()}`;

    header.append(titleGroup, statusBadge);
    card.appendChild(header);

    const body = document.createElement('div');
    body.className = 'doc-card__body';

    if (incident.status === 'duplicate' && incident.duplicateOfIncidentId) {
      const note = document.createElement('p');
      note.className = 'note';
      note.textContent = `Linked as a duplicate of incident #${incident.duplicateOfIncidentId}.`;
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

  function formatDateTime(value) {
    if (!value) return null;
    return new Date(value).toLocaleDateString('en-US', {
      month: 'short', day: 'numeric', year: 'numeric', hour: '2-digit', minute: '2-digit',
    });
  }
}
