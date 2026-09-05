/**
 * blotter-detail.js — W7 Electronic Blotter Detail (§9).
 *
 * "Roles: Secretary (full incl. raw), others per §7. Evidence access
 * follows the same ownership policy as the API. Finalized blotter data is
 * read-only until an explicit amendment workflow. A real status/timestamp
 * timeline (created_at, dispatched_at, arrived_at, redaction_approved_at,
 * finalized_at), never a scripted one."
 *
 * This screen is where the Secretary FINALIZES and AMENDS the blotter.
 * Those two endpoints existed and were verified before this page did, but
 * nothing in the app called them — an endpoint with no caller is not a
 * feature. This closes that.
 *
 * WHAT LIVES WHERE (§9 splits these deliberately, so don't merge them):
 *   - W7 (this screen): the blotter record — finalize, amend, timeline.
 *   - W8 (ai-review.js): the AI draft — redact, regenerate, approve,
 *     translate, and the Lupon packet.
 * A "Review AI redaction" link connects the two for the Secretary, since
 * the real workflow runs approve (W8) -> finalize (W7) -> packet (W8).
 *
 * The action panel is driven entirely by REAL server state — whether the
 * incident has an approved redaction, and whether a blotter record exists
 * and is finalized. It never guesses, and when an action is unavailable it
 * says which prerequisite is missing rather than hiding the control (§8).
 *
 * kebab-case filename per §4.
 */

import {
  getIncident,
  getBlotterForIncident,
  getIncidentEvidence,
  resolveIncident,
  finalizeBlotter,
  amendBlotter,
  logout,
  ApiClientError,
} from '../api/apiClient.js';
import { AppShell } from '../components/AppShell.js';
import { PageHeader } from '../components/PageHeader.js';
import { icons } from '../components/icons.js';
import { showToast } from '../components/Toast.js';
import { confirmDialog } from '../components/ConfirmDialog.js';

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
export function renderBlotterDetailPage(root, user, onLoggedOut, navigate, incidentId) {
  root.innerHTML = '';

  const isSecretary = user.role === 'secretary';

  const shell = AppShell(user, 'blotter', navigate, async () => {
    shell.logoutButton.disabled = true;
    await logout();
    onLoggedOut();
  });
  const { header, content } = shell;
  root.appendChild(shell.el);

  const pageHeader = PageHeader({
    title: `Blotter Entry — Incident #${incidentId}`,
    subtitle: 'Incident record, timeline, and blotter finalization',
    icon: icons.fileText,
  });
  header.appendChild(pageHeader.el);

  const backButton = document.createElement('button');
  backButton.className = 'ghost';
  backButton.textContent = '← Back to Blotter';
  backButton.addEventListener('click', () => navigate('blotter'));
  pageHeader.actions.appendChild(backButton);

  if (isSecretary) {
    const reviewButton = document.createElement('button');
    reviewButton.className = 'ghost';
    reviewButton.textContent = 'Review AI redaction';
    reviewButton.addEventListener('click', () => navigate('ai-review', incidentId));
    pageHeader.actions.appendChild(reviewButton);
  }

  let incident = null;
  let blotter = null;
  let evidence = [];

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
      // than blanking a record the Secretary may need to act on. The
      // timeline's dispatch stages come from getIncident() above, NOT from
      // GET /dispatch, which a Secretary may not call at all (403).
      evidence = await getIncidentEvidence(incidentId).catch(() => []);
      render();
    } catch (err) {
      renderError(err instanceof ApiClientError ? err.message : 'Something went wrong loading this entry.');
    }
  }

  // --- States (§8: Loading / Empty / Error / Populated) ---

  function renderLoading() {
    content.innerHTML = '';
    const wrap = document.createElement('div');
    wrap.className = 'stack';
    wrap.setAttribute('role', 'status');
    wrap.setAttribute('aria-label', 'Loading blotter entry');
    for (let i = 0; i < 3; i++) {
      const skeleton = document.createElement('div');
      skeleton.className = 'skeleton skeleton--block';
      wrap.appendChild(skeleton);
    }
    content.appendChild(wrap);
  }

  function renderError(message) {
    content.innerHTML = '';
    const block = document.createElement('div');
    block.className = 'card state-block state-block--error';
    block.setAttribute('role', 'alert');
    const text = document.createElement('p');
    text.textContent = message;
    const retry = document.createElement('button');
    retry.className = 'primary';
    retry.textContent = 'Try again';
    retry.addEventListener('click', load);
    block.append(text, retry);
    content.appendChild(block);
  }

  /**
   * Two columns rather than six full-width cards stacked down the page,
   * which left the record itself narrow and the timeline stranded below
   * the fold. `.split-panel` is the existing utility for exactly this and
   * already collapses to one column at 1024px.
   *
   * Left is the record and the work done on it; right is context —
   * when things happened, and the Admin action that isn't part of the
   * Secretary's blotter workflow.
   */
  function render() {
    content.innerHTML = '';

    const layout = document.createElement('div');
    layout.className = 'split-panel';

    const main = document.createElement('div');
    main.className = 'stack--md blotter-detail__main readable-column';
    const aside = document.createElement('div');
    aside.className = 'stack--md';

    main.appendChild(buildOverview());
    main.appendChild(buildNarrative());
    main.appendChild(buildEvidence());
    if (isSecretary) {
      main.appendChild(buildBlotterPanel());
    } else if (blotter) {
      main.appendChild(buildReadOnlyBlotter());
    }

    aside.appendChild(buildTimeline());
    // §9 W7 lists "Admin status update" among this screen's APIs — Admin
    // resolving the incident, which is a different concern from the
    // Secretary's blotter workflow on the left.
    if (user.role === 'admin') {
      aside.appendChild(buildAdminResolvePanel());
    }

    layout.append(main, aside);
    content.appendChild(layout);
  }

  function buildOverview() {
    const card = document.createElement('div');
    card.className = 'card';

    const row = document.createElement('div');
    row.className = 'row-between';
    const title = document.createElement('h3');
    title.textContent = INCIDENT_TYPE_LABELS[incident.incidentType] || incident.incidentType;
    const pill = document.createElement('span');
    pill.className = `status-pill ${STATUS_PILL_CLASS[incident.status] || 'status-pill--neutral'}`;
    pill.textContent = incident.status;
    row.append(title, pill);
    card.appendChild(row);

    const meta = document.createElement('p');
    meta.className = 'note';
    const location = incident.latitude != null && incident.longitude != null
      ? `${incident.latitude.toFixed(5)}, ${incident.longitude.toFixed(5)}`
      : 'Location not recorded';
    meta.textContent = `Priority ${incident.priority} · source ${incident.source} · ${location}`;
    card.appendChild(meta);

    return card;
  }

  /**
   * §9 W7: "a real status/timestamp timeline ... never a scripted one."
   * Every row below is a real timestamp from the API, and a stage that has
   * not happened is shown as pending rather than invented or hidden.
   */
  function buildTimeline() {
    const card = document.createElement('div');
    card.className = 'card';
    const heading = document.createElement('h3');
    heading.textContent = 'Timeline';
    card.appendChild(heading);

    // §9 W7 names these stages explicitly: created_at, dispatched_at,
    // arrived_at, redaction_approved_at, finalized_at. The dispatch stages
    // ride along on GET /incidents/:id precisely so this works for the
    // Secretary, who cannot read GET /dispatch.
    const stages = [
      ['Reported', incident.createdAt],
      ['Dispatched', incident.dispatchedAt],
      ['Arrived on scene', incident.arrivedAt],
      ['Redaction approved', incident.redactionApprovedAt],
      ['Blotter finalized', blotter ? blotter.finalizedAt : null],
      ['Last amended', blotter ? blotter.amendedAt : null],
    ];

    const visibleStages = stages.filter(([label, timestamp]) => (
      // "Last amended" is meaningless until an amendment exists — omit it
      // rather than showing a permanently-pending row.
      !(label === 'Last amended' && !timestamp)
    ));

    const list = document.createElement('div');
    list.className = 'timeline';
    visibleStages.forEach(([label, timestamp], i) => {
      const reached = Boolean(timestamp);
      const item = document.createElement('div');
      item.className = 'timeline__item';

      const rail = document.createElement('div');
      rail.className = 'timeline__rail';
      const node = document.createElement('span');
      node.className = 'timeline__node' + (reached ? ' timeline__node--done' : '');
      rail.appendChild(node);
      if (i < visibleStages.length - 1) {
        const connector = document.createElement('span');
        // A connector is "done" only once the NEXT stage has also been
        // reached — it represents the gap between two stages, not the
        // node it starts from.
        const nextReached = Boolean(visibleStages[i + 1][1]);
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
    card.appendChild(list);
    return card;
  }

  function buildNarrative() {
    const card = document.createElement('div');
    card.className = 'card';
    const heading = document.createElement('h3');
    heading.textContent = incident.redactedNarrative ? 'Approved redacted narrative' : 'Narrative';
    card.appendChild(heading);

    const body = document.createElement('pre');
    body.className = 'narrative-block';
    if (incident.redactedNarrative) {
      body.textContent = incident.redactedNarrative;
    } else if (isSecretary && incident.rawNarrative) {
      // Only the Secretary ever sees raw text (§7/§3), and only while no
      // approved redaction exists to show instead.
      body.textContent = incident.rawNarrative;
      const warn = document.createElement('p');
      warn.className = 'note';
      warn.textContent = 'This is the original unredacted narrative — no redaction has been approved yet.';
      card.appendChild(warn);
    } else {
      body.textContent = 'No approved redacted narrative yet.';
    }
    card.appendChild(body);
    return card;
  }

  /**
   * §9 W7: "Evidence access follows the same ownership policy as the API."
   * The server decides that (Secretary/Admin same-barangay; Tanod only with
   * a reporter/dispatch relationship) — this panel just renders whatever
   * came back, and shows an honest empty state otherwise.
   *
   * There is NO download link, deliberately: §6 says this endpoint never
   * returns filesystem paths, and no authorized byte-serving endpoint
   * exists yet (Sprint 7). A link that 404s would be worse than none.
   */
  function buildEvidence() {
    const card = document.createElement('div');
    card.className = 'card';

    const heading = document.createElement('h3');
    heading.textContent = `Evidence (${evidence.length})`;
    card.appendChild(heading);

    if (evidence.length === 0) {
      const empty = document.createElement('p');
      empty.className = 'note';
      empty.textContent = 'No photo or voice evidence was attached to this incident.';
      card.appendChild(empty);
      return card;
    }

    const list = document.createElement('div');
    list.className = 'stack';
    for (const item of evidence) {
      const row = document.createElement('div');
      row.className = 'row-between';

      const label = document.createElement('span');
      label.textContent = `${item.type === 'voice' ? 'Voice note' : 'Photo'} — ${item.originalFilename}`;

      const meta = document.createElement('span');
      meta.className = 'note';
      const kb = Math.max(1, Math.round(item.byteSize / 1024));
      meta.textContent = `${kb} KB · ${new Date(item.uploadedAt).toLocaleString()}`;

      row.append(label, meta);
      list.appendChild(row);
    }
    card.appendChild(list);

    const note = document.createElement('p');
    note.className = 'note';
    note.textContent = 'Evidence files are stored outside the web root and are not downloadable from this screen yet.';
    card.appendChild(note);

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

    const heading = document.createElement('h3');
    heading.textContent = 'Incident resolution';
    card.appendChild(heading);

    const activeDispatch = incident.hasActiveDispatch;

    if (incident.status === 'resolved') {
      const done = document.createElement('p');
      done.className = 'note';
      done.textContent = 'This incident is already resolved.';
      card.appendChild(done);
      return card;
    }

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
    card.className = 'card';
    const heading = document.createElement('h3');
    heading.textContent = `Blotter summary (revision ${blotter.revisionNo})`;
    card.appendChild(heading);
    if (blotter.caseStatus) card.appendChild(buildCaseStatusPill(blotter.caseStatus));
    const body = document.createElement('pre');
    body.className = 'narrative-block';
    body.textContent = blotter.narrativeSummary;
    card.appendChild(body);

    if (blotter.complainantName || blotter.respondentName || blotter.complainantContactNumber) {
      const partyNote = document.createElement('p');
      partyNote.className = 'note';
      const parts = [];
      if (blotter.complainantName) parts.push(`Complainant: ${blotter.complainantName}`);
      if (blotter.respondentName) parts.push(`Respondent: ${blotter.respondentName}`);
      if (blotter.complainantContactNumber) parts.push(`Contact: ${blotter.complainantContactNumber}`);
      partyNote.textContent = parts.join(' · ');
      card.appendChild(partyNote);
    }

    return card;
  }

  /** The Secretary's finalize/amend panel — the point of this screen. */
  function buildBlotterPanel() {
    const card = document.createElement('div');
    card.className = 'card';

    const heading = document.createElement('h3');
    heading.textContent = 'Blotter record';
    card.appendChild(heading);

    const approved = Boolean(incident.redactionApprovedAt);
    const finalized = Boolean(blotter && blotter.finalizedAt);

    if (!approved) {
      // §6: finalize requires an approved redaction. Say so plainly and
      // point at the screen that fixes it, rather than showing a form
      // whose submit would always 409.
      const note = document.createElement('p');
      note.className = 'note';
      note.textContent =
        'This incident has no approved redaction yet, so its blotter entry cannot be finalized. '
        + 'Approve the AI redaction first.';
      const link = document.createElement('button');
      link.className = 'primary';
      link.textContent = 'Go to AI Redaction Review';
      link.addEventListener('click', () => navigate('ai-review', incidentId));
      card.append(note, link);
      return card;
    }

    if (!finalized) {
      card.appendChild(buildFinalizeForm());
      return card;
    }

    // Finalized: read-only current text (§9 "read-only until an explicit
    // amendment workflow") plus the amendment form.
    if (blotter.caseStatus) card.appendChild(buildCaseStatusPill(blotter.caseStatus));
    const revision = document.createElement('p');
    revision.className = 'note';
    revision.textContent = `Finalized as revision ${blotter.revisionNo}. Amending creates an audited revision; the previous text is preserved.`;
    const current = document.createElement('pre');
    current.className = 'narrative-block';
    current.textContent = blotter.narrativeSummary;
    card.append(revision, current, buildAmendForm());
    return card;
  }

  /**
   * case_status pill (migration 0009, 2026-09-05 UX pass) — same 4 real
   * values/colors `blotter-list.js` already uses, kept as its own tiny
   * copy here rather than a shared export since it's 6 lines, not shared
   * state.
   */
  function buildCaseStatusPill(caseStatus) {
    const labels = { active: 'Active', under_investigation: 'Under Investigation', settled: 'Settled', resolved: 'Resolved' };
    const classes = { active: 'status-pill--info', under_investigation: 'status-pill--pending', settled: 'status-pill--success', resolved: 'status-pill--neutral' };
    const pill = document.createElement('span');
    pill.className = `status-pill ${classes[caseStatus] || 'status-pill--neutral'}`;
    pill.textContent = labels[caseStatus] || caseStatus;
    return pill;
  }

  function buildFinalizeForm() {
    const form = document.createElement('form');
    form.className = 'form-stack';
    form.noValidate = true;

    const label = document.createElement('label');
    label.className = 'label';
    label.htmlFor = 'blotter-finalize-summary';
    label.textContent = 'Blotter summary';

    const note = document.createElement('p');
    note.className = 'note';
    note.textContent =
      'This is the Secretary’s own record of the incident, informed by the approved redaction. '
      + 'Once finalized it cannot be overwritten — only amended, with a reason.';

    const textarea = document.createElement('textarea');
    textarea.id = 'blotter-finalize-summary';
    textarea.rows = 6;
    textarea.required = true;
    textarea.classList.add('textarea--resizable');
    // Pre-fill from the approved redaction as a starting point, since the
    // Secretary is writing a summary OF that text.
    textarea.value = incident.redactedNarrative || '';

    const { fields: partyFields, elements: partyElements } = buildPartyFields({
      complainantName: incident.complainantName,
      respondentName: incident.respondentName,
      complainantContactNumber: incident.complainantContactNumber,
    });

    const submit = document.createElement('button');
    submit.type = 'submit';
    submit.className = 'primary';
    submit.textContent = 'Finalize blotter entry';

    form.append(label, note, textarea, ...partyElements, submit);

    form.addEventListener('submit', async (event) => {
      event.preventDefault();
      const summary = textarea.value.trim();
      if (!summary) {
        showToast('Enter a blotter summary before finalizing.', { variant: 'error' });
        return;
      }
      const confirmed = await confirmDialog({
        title: 'Finalize this blotter entry?',
        description: 'A finalized entry cannot be overwritten. Later changes require an audited amendment with a reason.',
        confirmLabel: 'Finalize',
        cancelLabel: 'Keep editing',
      });
      if (!confirmed) return;

      submit.disabled = true;
      submit.textContent = 'Finalizing…';
      try {
        await finalizeBlotter(incidentId, { narrativeSummary: summary, ...partyFields() });
        showToast('Blotter entry finalized.', { variant: 'success' });
        await load();
      } catch (err) {
        submit.disabled = false;
        submit.textContent = 'Finalize blotter entry';
        showToast(err instanceof ApiClientError ? err.message : 'Could not finalize the entry.', { variant: 'error' });
      }
    });

    return form;
  }

  /**
   * Shared Complainant/Respondent/Contact input trio (§ migration 0008) —
   * used identically by finalize and amend. Returns a `fields()` getter
   * (reads the live input values at submit time, not at build time) and
   * the elements to append into the caller's own form.
   */
  function buildPartyFields({ complainantName, respondentName, complainantContactNumber }) {
    const complainantLabel = document.createElement('label');
    complainantLabel.className = 'label';
    complainantLabel.textContent = 'Complainant name (optional)';
    const complainantInput = document.createElement('input');
    complainantInput.type = 'text';
    complainantInput.value = complainantName || '';

    const respondentLabel = document.createElement('label');
    respondentLabel.className = 'label';
    respondentLabel.textContent = 'Respondent name (optional)';
    const respondentInput = document.createElement('input');
    respondentInput.type = 'text';
    respondentInput.value = respondentName || '';

    const contactLabel = document.createElement('label');
    contactLabel.className = 'label';
    contactLabel.textContent = 'Contact number (optional)';
    const contactInput = document.createElement('input');
    contactInput.type = 'tel';
    contactInput.value = complainantContactNumber || '';

    return {
      fields: () => ({
        complainantName: complainantInput.value.trim(),
        respondentName: respondentInput.value.trim(),
        complainantContactNumber: contactInput.value.trim(),
      }),
      elements: [complainantLabel, complainantInput, respondentLabel, respondentInput, contactLabel, contactInput],
    };
  }

  function buildAmendForm() {
    const form = document.createElement('form');
    form.className = 'form-stack';
    form.noValidate = true;

    const summaryLabel = document.createElement('label');
    summaryLabel.className = 'label';
    summaryLabel.htmlFor = 'blotter-amend-summary';
    summaryLabel.textContent = 'Amended summary';
    const summaryInput = document.createElement('textarea');
    summaryInput.id = 'blotter-amend-summary';
    summaryInput.rows = 6;
    summaryInput.required = true;
    summaryInput.classList.add('textarea--resizable');
    summaryInput.value = blotter.narrativeSummary;

    const reasonLabel = document.createElement('label');
    reasonLabel.className = 'label';
    reasonLabel.htmlFor = 'blotter-amend-reason';
    reasonLabel.textContent = 'Reason for amendment';
    const reasonInput = document.createElement('input');
    reasonInput.id = 'blotter-amend-reason';
    reasonInput.type = 'text';
    reasonInput.required = true;
    reasonInput.placeholder = 'e.g. Corrected the date of the incident';

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
    let caseStatusLabel = null;
    if (forwardOptions.length > 0) {
      caseStatusLabel = document.createElement('label');
      caseStatusLabel.className = 'label';
      caseStatusLabel.htmlFor = 'blotter-amend-case-status';
      caseStatusLabel.textContent = 'Case status (optional)';
      caseStatusSelect = document.createElement('select');
      caseStatusSelect.id = 'blotter-amend-case-status';
      const keepOption = document.createElement('option');
      keepOption.value = '';
      keepOption.textContent = `Keep current (${blotter.caseStatus.replace('_', ' ')})`;
      caseStatusSelect.appendChild(keepOption);
      for (const key of forwardOptions) {
        const option = document.createElement('option');
        option.value = key;
        option.textContent = `Move to: ${CASE_STATUS_LABELS[key]}`;
        caseStatusSelect.appendChild(option);
      }
    }

    const { fields: partyFields, elements: partyElements } = buildPartyFields({
      complainantName: blotter.complainantName,
      respondentName: blotter.respondentName,
      complainantContactNumber: blotter.complainantContactNumber,
    });

    const submit = document.createElement('button');
    submit.type = 'submit';
    submit.className = 'primary';
    submit.textContent = 'Save amendment';

    form.append(summaryLabel, summaryInput, ...partyElements);
    if (caseStatusSelect) form.append(caseStatusLabel, caseStatusSelect);
    form.append(reasonLabel, reasonInput, submit);

    form.addEventListener('submit', async (event) => {
      event.preventDefault();
      const summary = summaryInput.value.trim();
      const reason = reasonInput.value.trim();
      if (!summary || !reason) {
        // The server requires both; saying so here avoids a pointless 400.
        showToast('An amendment needs both a summary and a reason.', { variant: 'error' });
        return;
      }
      const confirmed = await confirmDialog({
        title: `Amend blotter revision ${blotter.revisionNo}?`,
        description: 'This creates an audited revision. The current text is preserved and remains retrievable.',
        confirmLabel: 'Amend',
        cancelLabel: 'Cancel',
      });
      if (!confirmed) return;

      submit.disabled = true;
      submit.textContent = 'Saving…';
      try {
        await amendBlotter(incidentId, {
          narrativeSummary: summary,
          reason,
          ...partyFields(),
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
}
