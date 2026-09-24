/**
 * ai-review.js — W8 AI Redaction Review (§9): "Secretary only. Side-by-side
 * raw vs draft. Displays draft_version, model version, status, and stale
 * warning. Editing requires regeneration using the matching version.
 * Approval requires exact current version equality."
 *
 * EVERY VALUE ON THIS SCREEN COMES FROM A REAL `ai_processing_log` ROW.
 * §8's exclusions call out the Figma mockup's "AI Assistant" panel by name:
 * it shows hardcoded output behind a `setTimeout` fake spinner, with
 * invented confidence scores (94%, 95%, a 78/100 "risk score") and a
 * "Claude AI" badge. None of that is reproduced here —
 *   - the model badge shows `draft.modelVersion`, the real self-hosted
 *     model the run actually used, never a vendor name;
 *   - there is no confidence/accuracy number at all, because none is
 *     backed by an `ai_evaluation_run` yet (§5) — a plausible-looking
 *     percentage would be fabricated data, which is worse than none;
 *   - the "generating" state is driven by real polling of the server's
 *     own `status` field, not a timer.
 *
 * WHY THIS SCREEN HAS NO SIDEBAR ENTRY: W8 is a per-incident detail view
 * and cannot render without an incident id, so a nav item would be a link
 * to a broken screen. It is reached from incident detail's "Review AI
 * redaction" button (Secretary only), and reports 'incident-management'
 * as the active nav item so the shell stays coherent.
 *
 * The pipeline is asynchronous by design (§2 Rule 15 — the API never calls
 * Ollama, only the worker does), so redaction and summary regeneration
 * both come back `queued`. This page polls `GET /incidents/:id/ai-draft`
 * until the server reports `completed` or `failed`. Polling stops on
 * navigate away via the returned `stop` handle.
 *
 * kebab-case filename per §4.
 */

import {
  getIncident,
  getAiDraft,
  getExtractionDraft,
  requestRedaction,
  regenerateSummary,
  approveAiDraft,
  approveExtraction,
  translateAiDraft,
  generateLuponPacket,
  downloadLuponPacket,
  logout,
  ApiClientError,
} from '../api/apiClient.js';
import { AppShell } from '../components/AppShell.js';
import { PageHeader } from '../components/PageHeader.js';
import { icons } from '../components/icons.js';
import { showToast } from '../components/Toast.js';
import { confirmDialog } from '../components/ConfirmDialog.js';
import { renderLoadingSkeleton, renderErrorState } from '../components/AsyncState.js';
import { escapeHtml } from '../utils/escapeHtml.js';

const POLL_INTERVAL_MS = 3000;

const STATUS_PILL_CLASS = {
  queued: 'status-pill--pending',
  processing: 'status-pill--info',
  completed: 'status-pill--success',
  failed: 'status-pill--critical',
  superseded: 'status-pill--neutral',
};

const INCIDENT_TYPE_LABELS = {
  theft: 'Theft', physical_injury: 'Physical Injury', disturbance: 'Disturbance',
  domestic_dispute: 'Domestic Dispute', vandalism: 'Vandalism',
  traffic_incident: 'Traffic Incident', fire: 'Fire',
  medical_emergency: 'Medical Emergency', missing_person: 'Missing Person',
  animal_complaint: 'Animal Complaint', other: 'Other',
};

/**
 * @param {HTMLElement} root
 * @param {{fullName:string, role:string}} user
 * @param {() => void} onLoggedOut
 * @param {(page: string, param?: any) => void} navigate
 * @param {number} incidentId
 * @returns {{stop: () => void}}
 */
export function renderAiReviewPage(root, user, onLoggedOut, navigate, incidentId) {
  root.innerHTML = '';

  // W6's blotter list was removed 2026-09-10 (DILG BIMSS/KPIS owns the
  // case ledger). This screen is only ever opened from incident detail's
  // "Review AI redaction" button, so it reports that flow's nav item and
  // goes back to the incident it came from rather than to a list.
  const shell = AppShell(user, 'incident-management', navigate, async () => {
    shell.logoutButton.disabled = true;
    stopPolling();
    await logout();
    onLoggedOut();
  });
  const { header, content } = shell;
  root.appendChild(shell.el);

  const pageHeader = PageHeader({
    title: `AI Redaction Review — Incident #${incidentId}`,
    subtitle: 'Review the AI draft against the original narrative, then approve it',
    icon: icons.fileText,
  });
  header.appendChild(pageHeader.el);

  const backButton = document.createElement('button');
  backButton.className = 'ghost';
  backButton.textContent = '← Back to Incident';
  backButton.addEventListener('click', () => {
    stopPolling();
    navigate('blotter-detail', incidentId);
  });
  pageHeader.actions.appendChild(backButton);

  let pollTimer = null;
  let incident = null;
  let draft = null;
  /** Independent of `draft` above — see AiJobQueue's own extraction docblock. */
  let extractionDraft = null;
  /** Tracks whether the Secretary has edited the draft text away from what the server holds. */
  let edited = false;
  let extractionInputs = { complainant: null, respondent: null, contact: null };
  let extractionEdited = false;
  /**
   * Live references into the current render. Declared HERE, above the
   * `return` below — a `let` declared after the return would never be
   * initialised, and the async render() that touches it would then throw
   * a temporal-dead-zone ReferenceError.
   */
  let draftTextarea = null;
  let actionRefs = null;

  function stopPolling() {
    if (pollTimer) {
      clearInterval(pollTimer);
      pollTimer = null;
    }
  }

  function isPending(d) {
    return d && (d.status === 'queued' || d.status === 'processing');
  }

  function startPollingIfPending() {
    stopPolling();
    if (!isPending(draft) && !isPending(extractionDraft)) return;
    pollTimer = setInterval(async () => {
      try {
        // Independent jobs (§ migration 0008) — refresh whichever is
        // still pending; a settled one is left as-is by getAiDraft()/
        // getExtractionDraft() returning null only on 404 (never happens
        // once a job has been enqueued at all).
        const wasPending = isPending(draft);
        const wasExtractionPending = isPending(extractionDraft);

        if (wasPending) {
          const fresh = await getAiDraft(incidentId);
          if (fresh) draft = fresh;
        }
        if (wasExtractionPending) {
          const freshExtraction = await getExtractionDraft(incidentId);
          if (freshExtraction) extractionDraft = freshExtraction;
        }

        if (!isPending(draft) && !isPending(extractionDraft)) stopPolling();
        if (wasPending && !isPending(draft)) {
          edited = false;
          showToast(
            draft.status === 'completed' ? 'AI draft is ready.' : 'The AI job failed.',
            { variant: draft.status === 'completed' ? 'success' : 'error' }
          );
        }
        render();
      } catch {
        // A transient poll failure shouldn't blank a populated screen;
        // the next tick retries.
      }
    }, POLL_INTERVAL_MS);
  }

  load();
  return { stop: stopPolling };

  async function load() {
    renderLoading();
    try {
      // The drafts legitimately may not exist (404 → null); the incident
      // must exist, so its failure is a real error.
      [incident, draft, extractionDraft] = await Promise.all([
        getIncident(incidentId),
        getAiDraft(incidentId),
        getExtractionDraft(incidentId),
      ]);
      edited = false;
      render();
      startPollingIfPending();
    } catch (err) {
      console.error('Error loading AI review:', err);
      const message = err instanceof ApiClientError ? err.message : 'Something went wrong loading this incident.';
      renderError(message);
    }
  }

  // --- States (§8: Loading / Empty / Error / Populated on every screen) ---

  function renderLoading() {
    renderLoadingSkeleton({ container: content, count: 4, ariaLabel: 'Loading AI draft' });
  }

  function renderError(message) {
    renderErrorState({ container: content, message, onRetry: load });
  }

  function buildWorkflowStepper() {
    const nav = document.createElement('nav');
    nav.className = 'ai-review__stepper';
    nav.setAttribute('aria-label', 'Redaction workflow progress');

    const step1Done = Boolean(draft && draft.status === 'completed');
    const step1Running = Boolean(draft && (draft.status === 'queued' || draft.status === 'processing'));
    const step1Active = !step1Done && !step1Running;

    const step2Active = step1Done && !incident.redactionApprovedAt;
    const step2Done = step1Done && (incident.redactionApprovedAt || (!edited && !draft?.draftSummaryStale));

    const step3Warning = Boolean(draft && (draft.draftSummaryStale || edited));
    const step3Done = Boolean(draft && !draft.draftSummaryStale && !edited && draft.draftSummary);

    const step4Done = Boolean(incident.redactionApprovedAt);
    const step4Ready = step1Done && !step3Warning && !step4Done;

    const steps = [
      {
        num: '1',
        label: 'Intake Redaction',
        sub: step1Done ? 'Draft Ready' : step1Running ? 'Processing…' : 'Awaiting Run',
        state: step1Done ? 'done' : step1Running ? 'running' : 'active',
      },
      {
        num: '2',
        label: 'Review & Edit',
        sub: step2Done ? 'Verified' : step2Active ? 'Active Review' : 'Side-by-Side Diff',
        state: step2Done ? 'done' : step2Active ? 'active' : 'pending',
      },
      {
        num: '3',
        label: 'Summary Sync',
        sub: step3Warning ? 'Sync Required' : step3Done ? 'In Sync' : 'Entity Check',
        state: step3Warning ? 'warning' : step3Done ? 'done' : 'pending',
      },
      {
        num: '4',
        label: 'Approve & Commit',
        sub: step4Done ? 'Approved' : step4Ready ? 'Ready to Seal' : 'Permanent Seal',
        state: step4Done ? 'done' : step4Ready ? 'active' : 'pending',
      },
    ];

    const track = document.createElement('div');
    track.className = 'ai-review__stepper-track';

    for (let i = 0; i < steps.length; i++) {
      const s = steps[i];
      const item = document.createElement('div');
      item.className = `ai-review__step ai-review__step--${s.state}`;

      const icon = document.createElement('span');
      icon.className = 'ai-review__step-icon';
      if (s.state === 'done') icon.innerHTML = icons.check(14);
      else if (s.state === 'warning') icon.innerHTML = icons.alertCircle(14);
      else if (s.state === 'running') icon.innerHTML = `<span class="is-spinning">${icons.repeat(14)}</span>`;
      else icon.textContent = s.num;

      const contentDiv = document.createElement('div');
      contentDiv.className = 'ai-review__step-content';

      const label = document.createElement('span');
      label.className = 'ai-review__step-label';
      label.textContent = s.label;

      const sub = document.createElement('span');
      sub.className = 'ai-review__step-sub';
      sub.textContent = s.sub;

      contentDiv.append(label, sub);
      item.append(icon, contentDiv);
      track.appendChild(item);

      if (i < steps.length - 1) {
        const connector = document.createElement('div');
        connector.className = `ai-review__step-connector ${steps[i].state === 'done' ? 'is-done' : ''}`;
        track.appendChild(connector);
      }
    }

    nav.appendChild(track);
    return nav;
  }

  function render() {
    content.innerHTML = '';
    const layout = document.createElement('div');
    layout.className = 'ai-review-layout';

    layout.appendChild(buildWorkflowStepper());
    layout.appendChild(buildIncidentSummary());

    if (!draft) {
      layout.appendChild(buildNoDraftState());
      if (incident.redactionApprovedAt) layout.appendChild(buildActionsDock());
      content.appendChild(layout);
      return;
    }

    layout.appendChild(buildSideBySide());
    layout.appendChild(buildSecondarySection());
    layout.appendChild(buildActionsDock());
    content.appendChild(layout);
  }

  /**
   * §9 W8: "Once approved, translation and Lupon packet are available only
   * when their prerequisites are met."
   */
  function buildIncidentSummary() {
    const card = document.createElement('div');
    card.className = 'card ai-review__briefing';

    const leftCol = document.createElement('div');
    leftCol.className = 'ai-review__briefing-main';

    const iconBadge = document.createElement('div');
    iconBadge.className = 'ai-review__briefing-icon';
    iconBadge.setAttribute('aria-hidden', 'true');
    iconBadge.innerHTML = icons.fileText(24);

    const info = document.createElement('div');
    info.className = 'ai-review__briefing-info';

    const titleRow = document.createElement('div');
    titleRow.className = 'ai-review__briefing-title-row';

    const title = document.createElement('h2');
    title.className = 'ai-review__briefing-title';
    title.textContent = INCIDENT_TYPE_LABELS[incident.incidentType] || incident.incidentType;

    const idBadge = document.createElement('span');
    idBadge.className = 'ai-review__id-badge';
    idBadge.textContent = incident.displayId || `#INC-${incident.incidentId}`;

    const priorityPill = document.createElement('span');
    const priority = (incident.priority || 'medium').toLowerCase();
    priorityPill.className = `status-pill status-pill--${priority === 'critical' ? 'critical' : priority === 'high' ? 'warning' : 'info'}`;
    priorityPill.textContent = `${priority.charAt(0).toUpperCase() + priority.slice(1)} Priority`;

    const statusPill = document.createElement('span');
    statusPill.className = `status-pill ${incident.redactionApprovedAt ? 'status-pill--success' : 'status-pill--pending'}`;
    statusPill.textContent = incident.redactionApprovedAt ? 'Redaction Approved' : `Status: ${incident.status}`;

    titleRow.append(title, idBadge, priorityPill, statusPill);

    if (draft) {
      const draftPill = document.createElement('span');
      draftPill.className = `status-pill ${STATUS_PILL_CLASS[draft.status] || 'status-pill--neutral'}`;
      draftPill.textContent = `${(draft.status || 'unknown').toUpperCase()} v${draft.draftVersion}`;
      titleRow.appendChild(draftPill);

      if (draft.draftSummaryStale) {
        const stalePill = document.createElement('span');
        stalePill.className = 'status-pill status-pill--warning';
        stalePill.textContent = 'Summary Stale';
        titleRow.appendChild(stalePill);
      }
    }

    const metaRow = document.createElement('div');
    metaRow.className = 'ai-review__briefing-meta';

    const timeSpan = document.createElement('span');
    timeSpan.innerHTML = `${icons.clock(13)} <span>Logged ${new Date(incident.createdAt).toLocaleString()}</span>`;

    const locSpan = document.createElement('span');
    const locText = incident.locationDescription || (incident.latitude && incident.longitude ? `${incident.latitude}, ${incident.longitude}` : 'No location recorded');
    locSpan.innerHTML = `${icons.mapPin(13)} <span>${escapeHtml(locText)}</span>`;

    const sourceSpan = document.createElement('span');
    sourceSpan.innerHTML = `${icons.shield(13)} <span>${escapeHtml(incident.source ? incident.source.toUpperCase() : 'DESK')} Intake</span>`;

    metaRow.append(timeSpan, locSpan, sourceSpan);

    if (draft) {
      const modelSpan = document.createElement('span');
      modelSpan.innerHTML = `${icons.sparkles(13)} <span>Model: <code style="font-family:var(--font-mono);font-size:0.76rem;background:var(--tint-neutral-bg);padding:0.08rem 0.35rem;border-radius:4px;border:1px solid var(--color-border);">${escapeHtml(draft.modelVersion || 'Local Ollama')}</code></span>`;
      metaRow.appendChild(modelSpan);
    }

    info.append(titleRow, metaRow);
    leftCol.append(iconBadge, info);

    // Right: Privacy compliance badge
    const privacyBadge = document.createElement('div');
    privacyBadge.className = 'ai-review__privacy-badge';
    privacyBadge.innerHTML = `
      <div class="ai-review__privacy-icon">${icons.lock(16)}</div>
      <div class="ai-review__privacy-text">
        <strong>RA 10173 Compliant</strong>
        <span>100% Local Ollama • Zero Cloud Egress</span>
      </div>
    `;

    card.append(leftCol, privacyBadge);

    if (draft && draft.status === 'failed' && draft.errorCode) {
      const err = document.createElement('p');
      err.className = 'state-block--error';
      err.setAttribute('role', 'alert');
      err.style.margin = 'var(--spacing-xs) 0 0 0';
      err.textContent = `The AI job failed (${draft.errorCode}). Re-run redaction to try again.`;
      card.appendChild(err);
    }

    return card;
  }

  function buildNoDraftState() {
    const container = document.createElement('div');
    container.className = 'ai-review__pre-studio';

    // Left Column: Raw Narrative Preview
    const leftCard = document.createElement('div');
    leftCard.className = 'card ai-review__narrative-card';

    const leftHeader = document.createElement('div');
    leftHeader.className = 'ai-review__card-header';
    leftHeader.innerHTML = `
      <div class="ai-review__card-title">
        <span class="ai-review__card-icon">${icons.fileText(16)}</span>
        <h3>Original Reported Narrative</h3>
      </div>
      <span class="status-pill status-pill--critical">Restricted Access • Contains PII</span>
    `;

    const rawBlock = document.createElement('pre');
    rawBlock.className = 'narrative-block ai-review__narrative-preview';
    rawBlock.textContent = incident.rawNarrative || 'No raw narrative text logged for this incident.';

    const leftFooter = document.createElement('div');
    leftFooter.className = 'ai-review__card-footer';
    const charCount = incident.rawNarrative ? incident.rawNarrative.length : 0;
    leftFooter.innerHTML = `
      <span>Length: ${charCount} characters</span>
      <span class="ai-review__footer-note">${icons.alertTriangle(12)} Unredacted — personal names and contact details must be sanitized before blotter entry.</span>
    `;

    leftCard.append(leftHeader, rawBlock, leftFooter);

    // Right Column: Automated Redaction Engine Studio
    const rightCard = document.createElement('div');
    rightCard.className = 'card ai-review__engine-card';

    const rightHeader = document.createElement('div');
    rightHeader.className = 'ai-review__card-header';
    rightHeader.innerHTML = `
      <div class="ai-review__card-title">
        <span class="ai-review__card-icon ai-review__card-icon--ai">${icons.sparkles(16)}</span>
        <h3>Automated Redaction Engine</h3>
      </div>
      <span class="status-pill status-pill--info">Ollama Local Pipeline</span>
    `;

    const engineDesc = document.createElement('p');
    engineDesc.className = 'note';
    engineDesc.textContent = 'Queues an on-premises worker to scrub personal identifiable information (PII) per statutory standards and extract legal blotter entities.';

    const specsList = document.createElement('div');
    specsList.className = 'ai-review__specs-list';
    specsList.innerHTML = `
      <div class="ai-review__spec-item">
        <span class="ai-review__spec-label">Target Model:</span>
        <span class="ai-review__spec-val">Llama-SEA-LION-v3.5-8B-R</span>
      </div>
      <div class="ai-review__spec-item">
        <span class="ai-review__spec-label">Sanitizes:</span>
        <span class="ai-review__spec-val">Full Names, Phone Numbers, Exact Addresses</span>
      </div>
      <div class="ai-review__spec-item">
        <span class="ai-review__spec-label">Extracts:</span>
        <span class="ai-review__spec-val">Complainant, Respondent & Contact metadata</span>
      </div>
    `;

    const actionWrap = document.createElement('div');
    actionWrap.className = 'ai-review__engine-action';

    const runBtn = document.createElement('button');
    runBtn.type = 'button';
    runBtn.className = 'primary ai-review__run-btn';
    runBtn.innerHTML = `${icons.sparkles(16)} <span>Run AI Redaction Now</span>`;
    runBtn.addEventListener('click', () => runRedaction(runBtn));

    actionWrap.appendChild(runBtn);
    rightCard.append(rightHeader, engineDesc, specsList, actionWrap);

    container.append(leftCard, rightCard);
    return container;
  }



  function buildSideBySide() {
    const layout = document.createElement('div');
    layout.className = 'ai-review__studio-grid';

    // Left: the original narrative. Read-only — this is the record of what
    // was actually reported and must never be editable from this screen.
    const rawCard = document.createElement('div');
    rawCard.className = 'card ai-review__studio-card';

    const rawHeader = document.createElement('div');
    rawHeader.className = 'ai-review__studio-card-header';
    rawHeader.innerHTML = `
      <div class="ai-review__studio-card-title">
        <span class="ai-review__card-icon">${icons.fileText(16)}</span>
        <h3>Original Reported Narrative</h3>
      </div>
      <span class="status-pill status-pill--critical">Restricted Access • Secretary</span>
    `;

    const rawNote = document.createElement('p');
    rawNote.className = 'note';
    rawNote.style.margin = '0 0 var(--spacing-xs) 0';
    rawNote.textContent = 'Read-only original record from intake. Redacted spans are highlighted below.';

    const rawText = document.createElement('pre');
    rawText.className = 'narrative-block';
    rawText.style.minHeight = '14rem';
    if (incident.rawNarrative && draft.draftRedactedNarrative) {
      rawText.appendChild(renderRedactionDiff(incident.rawNarrative, draft.draftRedactedNarrative));
    } else {
      rawText.textContent = incident.rawNarrative ?? '(not available)';
    }

    const summaryLine = document.createElement('p');
    summaryLine.className = 'note redaction-summary';
    summaryLine.style.marginTop = 'var(--spacing-xs)';
    if (incident.rawNarrative && draft.draftRedactedNarrative) {
      const placeholders = draft.draftRedactedNarrative.match(/\[[A-Z_]+\]/g) ?? [];
      const byKind = placeholders.reduce((acc, p) => { acc[p] = (acc[p] ?? 0) + 1; return acc; }, {});
      const parts = Object.entries(byKind).map(([kind, n]) => `${n} ${kind.slice(1, -1).toLowerCase().replace('_', ' ')}`);
      summaryLine.textContent = placeholders.length === 0
        ? 'The draft contains no redaction placeholders — check that nothing identifying was missed.'
        : `${placeholders.length} identifier${placeholders.length === 1 ? '' : 's'} removed: ${parts.join(', ')}. Highlighted below.`;
    } else {
      summaryLine.textContent = 'Awaiting draft completion to compute identifier diff.';
    }
    rawCard.append(rawHeader, rawNote, rawText, summaryLine);

    // Right: the editable draft.
    const draftCard = document.createElement('div');
    draftCard.className = 'card ai-review__studio-card';

    const isPending = draft.status === 'queued' || draft.status === 'processing';

    const draftHeader = document.createElement('div');
    draftHeader.className = 'ai-review__studio-card-header';
    draftHeader.innerHTML = `
      <div class="ai-review__studio-card-title">
        <span class="ai-review__card-icon ai-review__card-icon--ai">${icons.sparkles(16)}</span>
        <h3>Redacted Narrative Draft</h3>
      </div>
      <span class="status-pill ${STATUS_PILL_CLASS[draft.status] || 'status-pill--neutral'}">${(draft.status || 'draft').toUpperCase()}</span>
    `;

    const draftNote = document.createElement('p');
    draftNote.className = 'note';
    draftNote.style.margin = '0 0 var(--spacing-xs) 0';
    draftNote.textContent = isPending
      ? 'The AI worker is actively scrubbing PII and sensitive identifiers...'
      : 'Review and edit if needed. Any edits will require summary regeneration before approval.';

    draftCard.append(draftHeader, draftNote);

    if (isPending) {
      const processingBanner = document.createElement('div');
      processingBanner.className = 'ai-review__processing-banner';
      processingBanner.innerHTML = `
        <span class="is-spinning">${icons.repeat(16)}</span>
        <span><strong>AI Redaction in Progress:</strong> Local Ollama engine is processing incident narrative...</span>
      `;
      draftCard.appendChild(processingBanner);
    }

    const textarea = document.createElement('textarea');
    textarea.id = 'ai-draft-narrative';
    textarea.setAttribute('aria-label', 'Redacted narrative draft');
    textarea.rows = 12;
    textarea.classList.add('textarea--resizable');
    textarea.placeholder = isPending ? 'Draft is currently generating in background worker…' : 'Enter redacted narrative…';
    textarea.value = draft.draftRedactedNarrative ?? '';
    textarea.disabled = isPending;
    textarea.style.minHeight = '14rem';
    textarea.addEventListener('input', () => {
      edited = textarea.value !== (draft.draftRedactedNarrative ?? '');
      syncActionState();
    });

    draftCard.appendChild(textarea);

    layout.append(rawCard, draftCard);
    draftTextarea = textarea;
    return layout;
  }

  function buildSecondarySection() {
    const layout = document.createElement('div');
    layout.className = 'ai-review__secondary-grid';

    // Left: Official Blotter Summary
    const summaryCard = document.createElement('div');
    summaryCard.className = 'card ai-review__studio-card';

    const isPending = draft.status === 'queued' || draft.status === 'processing';

    const summaryHeader = document.createElement('div');
    summaryHeader.className = 'ai-review__studio-card-header';
    summaryHeader.innerHTML = `
      <div class="ai-review__studio-card-title">
        <span class="ai-review__card-icon">${icons.fileText(16)}</span>
        <h3>Official Blotter Summary</h3>
      </div>
    `;
    if (draft.draftSummaryStale || edited) {
      const staleBadge = document.createElement('span');
      staleBadge.className = 'status-pill status-pill--warning';
      staleBadge.textContent = 'Sync Required';
      summaryHeader.appendChild(staleBadge);
    }
    summaryCard.appendChild(summaryHeader);

    const summaryNote = document.createElement('p');
    summaryNote.className = 'note';
    summaryNote.style.margin = '0 0 var(--spacing-xs) 0';
    summaryNote.textContent = 'Concise factual summary synthesized for the Katarungang Pambarangay ledger.';
    summaryCard.appendChild(summaryNote);

    const summaryText = document.createElement('pre');
    summaryText.className = 'narrative-block';
    summaryText.style.minHeight = '9rem';
    summaryText.textContent = isPending
      ? 'Summary will generate once the redaction draft completes…'
      : (draft.draftSummary ?? '(not generated yet)');
    summaryCard.appendChild(summaryText);

    if (draft.draftSummaryStale || edited) {
      const inlineRegen = document.createElement('div');
      inlineRegen.className = 'ai-review__inline-regen';
      const regenBtn = document.createElement('button');
      regenBtn.type = 'button';
      regenBtn.className = 'ghost';
      regenBtn.style.fontSize = 'var(--font-size-xs)';
      regenBtn.innerHTML = `${icons.repeat(14)} <span>Sync / Regenerate Summary</span>`;
      regenBtn.disabled = isPending;
      regenBtn.addEventListener('click', () => runRegenerate(regenBtn));
      inlineRegen.appendChild(regenBtn);
      summaryCard.appendChild(inlineRegen);
    }

    // Right: Involved Parties / Entity Extraction
    const extractionCard = document.createElement('div');
    extractionCard.className = 'card ai-review__studio-card';
    extractionCard.appendChild(buildExtractionSection());

    layout.append(summaryCard, extractionCard);
    return layout;
  }

  /**
   * Complainant/Respondent/Contact — Electronic Blotter follow-up.
   * Independent of the redaction draft next to it (own endpoint, own
   * draft_version, own Save action) — same relationship translation
   * already has to redaction on this same screen. All three fields are
   * optional; a blank input saves as null, meaning "cleared"/"none".
   */
  function buildExtractionSection() {
    const wrap = document.createElement('div');
    wrap.className = 'form-stack';

    const header = document.createElement('div');
    header.className = 'ai-review__studio-card-header';
    header.innerHTML = `
      <div class="ai-review__studio-card-title">
        <span class="ai-review__card-icon">${icons.users(16)}</span>
        <h3>Involved Parties (KP Law)</h3>
      </div>
    `;
    wrap.appendChild(header);

    if (!extractionDraft) {
      const note = document.createElement('p');
      note.className = 'note';
      note.textContent = 'No extraction draft yet — it queues alongside redaction and appears here once the worker finishes.';
      wrap.appendChild(note);
      return wrap;
    }

    // Once ANY field has been approved at least once, prefer the
    // approved values on `incident` over the raw draft — otherwise a
    // Secretary who edits and saves sees their own edit "revert" to the
    // AI's original suggestion on the next load, which looks like the
    // save silently failed even though it didn't (the draft row itself
    // is never rewritten by approve — only `incident` is).
    const hasApproved = incident.complainantName != null || incident.respondentName != null || incident.complainantContactNumber != null;
    const note = document.createElement('p');
    note.className = 'note';
    note.style.margin = '0 0 var(--spacing-xs) 0';
    note.textContent = hasApproved
      ? 'Showing the last saved values. Edit and save again to change them.'
      : 'AI-drafted from the original narrative. Review and edit before saving — leave a field blank if it does not apply.';
    wrap.appendChild(note);

    const pending = extractionDraft.status === 'queued' || extractionDraft.status === 'processing';

    const baseComplainant = (hasApproved ? incident.complainantName : extractionDraft.draftComplainantName) ?? '';
    const baseRespondent = (hasApproved ? incident.respondentName : extractionDraft.draftRespondentName) ?? '';
    const baseContact = (hasApproved ? incident.complainantContactNumber : extractionDraft.draftComplainantContactNumber) ?? '';

    const grid = document.createElement('div');
    grid.className = 'ai-review__extraction-grid';

    // Complainant
    const compWrap = document.createElement('div');
    const complainantLabel = document.createElement('label');
    complainantLabel.className = 'label';
    complainantLabel.htmlFor = 'ai-extract-complainant';
    complainantLabel.textContent = 'Complainant name';
    const complainantInput = document.createElement('input');
    complainantInput.id = 'ai-extract-complainant';
    complainantInput.type = 'text';
    complainantInput.placeholder = pending ? 'Extracting…' : 'Enter complainant name';
    complainantInput.value = baseComplainant;
    complainantInput.disabled = pending;
    compWrap.append(complainantLabel, complainantInput);

    // Contact
    const contactWrap = document.createElement('div');
    const contactLabel = document.createElement('label');
    contactLabel.className = 'label';
    contactLabel.htmlFor = 'ai-extract-contact';
    contactLabel.textContent = 'Contact number';
    const contactInput = document.createElement('input');
    contactInput.id = 'ai-extract-contact';
    contactInput.type = 'tel';
    contactInput.placeholder = pending ? 'Extracting…' : 'e.g. 0917-123-4567';
    contactInput.value = baseContact;
    contactInput.disabled = pending;
    contactWrap.append(contactLabel, contactInput);

    grid.append(compWrap, contactWrap);

    // Respondent (full width)
    const respWrap = document.createElement('div');
    respWrap.style.marginTop = 'var(--spacing-sm)';
    const respondentLabel = document.createElement('label');
    respondentLabel.className = 'label';
    respondentLabel.htmlFor = 'ai-extract-respondent';
    respondentLabel.textContent = 'Respondent name';
    const respondentInput = document.createElement('input');
    respondentInput.id = 'ai-extract-respondent';
    respondentInput.type = 'text';
    respondentInput.placeholder = pending ? 'Extracting…' : 'Enter respondent name';
    respondentInput.value = baseRespondent;
    respondentInput.disabled = pending;
    respWrap.append(respondentLabel, respondentInput);

    extractionInputs = {
      complainant: complainantInput,
      respondent: respondentInput,
      contact: contactInput,
    };

    const checkExtractionEdited = () => {
      extractionEdited = complainantInput.value !== baseComplainant
        || respondentInput.value !== baseRespondent
        || contactInput.value !== baseContact;
    };
    complainantInput.addEventListener('input', checkExtractionEdited);
    respondentInput.addEventListener('input', checkExtractionEdited);
    contactInput.addEventListener('input', checkExtractionEdited);

    const saveButton = document.createElement('button');
    saveButton.type = 'button';
    saveButton.className = 'ghost';
    saveButton.style.marginTop = 'var(--spacing-sm)';
    saveButton.textContent = pending ? 'Extraction still running…' : 'Save Parties';
    saveButton.disabled = pending;
    saveButton.addEventListener('click', () => {
      extractionEdited = false;
      runSaveExtraction(saveButton, {
        complainantName: complainantInput.value,
        respondentName: respondentInput.value,
        complainantContactNumber: contactInput.value,
      });
    });

    wrap.append(grid, respWrap, saveButton);
    return wrap;
  }

  function buildActionsDock() {
    const dock = document.createElement('div');
    dock.className = 'card ai-review__action-dock';

    // Left group: Primary workflow actions
    const leftGroup = document.createElement('div');
    leftGroup.className = 'ai-review__action-dock-left';

    const rerunButton = document.createElement('button');
    rerunButton.className = 'ghost';
    rerunButton.innerHTML = `${icons.repeat(14)} Re-run redaction`;
    rerunButton.addEventListener('click', () => runRedaction(rerunButton));

    const regenButton = document.createElement('button');
    regenButton.className = 'ghost';
    regenButton.innerHTML = `${icons.sparkles(14)} Regenerate summary`;
    regenButton.addEventListener('click', () => runRegenerate(regenButton));

    const approveButton = document.createElement('button');
    approveButton.className = 'primary';
    approveButton.innerHTML = `${icons.check(14)} Approve & Commit Redaction`;
    approveButton.addEventListener('click', () => runApprove(approveButton));

    leftGroup.append(rerunButton, regenButton, approveButton);

    const reason = document.createElement('span');
    reason.className = 'ai-review__action-reason';
    reason.id = 'ai-approve-reason';
    leftGroup.appendChild(reason);

    // Right group: Post-approval tools
    const rightGroup = document.createElement('div');
    rightGroup.className = 'ai-review__action-dock-right';

    const isApproved = Boolean(incident.redactionApprovedAt);

    const postLabel = document.createElement('span');
    postLabel.className = 'ai-review__dock-sublabel';
    postLabel.textContent = isApproved ? 'Post-Approval:' : 'Post-Approval (Locked):';
    rightGroup.appendChild(postLabel);

    const packetButton = document.createElement('button');
    packetButton.className = 'ghost';
    packetButton.disabled = !isApproved;
    packetButton.title = isApproved ? 'Generate Lupon conciliation dossier' : 'Requires approved redaction first';
    packetButton.innerHTML = `${icons.fileText(14)} Lupon Packet`;
    packetButton.addEventListener('click', async () => {
      packetButton.disabled = true;
      packetButton.textContent = 'Generating…';
      try {
        await generateLuponPacket(incidentId);
        showToast('Lupon packet generated.', { variant: 'success' });
        downloadLink.hidden = false;
      } catch (err) {
        showToast(err instanceof ApiClientError ? err.message : 'Could not generate the packet.', { variant: 'error' });
      } finally {
        packetButton.disabled = false;
        packetButton.innerHTML = `${icons.fileText(14)} Lupon Packet`;
      }
    });

    const downloadLink = document.createElement('button');
    downloadLink.type = 'button';
    downloadLink.className = 'ghost';
    downloadLink.hidden = true;
    downloadLink.innerHTML = `${icons.fileText(14)} Download PDF`;
    downloadLink.addEventListener('click', async () => {
      downloadLink.disabled = true;
      downloadLink.textContent = 'Downloading…';
      try {
        const blob = await downloadLuponPacket(incidentId);
        const blobUrl = URL.createObjectURL(blob);
        const link = document.createElement('a');
        link.href = blobUrl;
        link.download = `lupon-packet-incident-${incidentId}.pdf`;
        document.body.appendChild(link);
        link.click();
        link.remove();
        URL.revokeObjectURL(blobUrl);
      } catch (err) {
        showToast(err instanceof ApiClientError ? err.message : 'Could not download the packet.', { variant: 'error' });
      } finally {
        downloadLink.disabled = false;
        downloadLink.innerHTML = `${icons.fileText(14)} Download PDF`;
      }
    });

    const translateWrap = document.createElement('div');
    translateWrap.style.display = 'inline-flex';
    translateWrap.style.alignItems = 'center';
    translateWrap.style.gap = '0.35rem';

    const languageSelect = document.createElement('select');
    languageSelect.id = 'ai-translate-language';
    languageSelect.setAttribute('aria-label', 'Translation language');
    languageSelect.disabled = !isApproved;
    languageSelect.style.height = '2.1rem';
    languageSelect.style.fontSize = '0.78rem';
    for (const [value, label] of [['en', 'English'], ['fil', 'Filipino'], ['bcl', 'Bikol']]) {
      const option = document.createElement('option');
      option.value = value;
      option.textContent = label;
      languageSelect.appendChild(option);
    }

    const translateButton = document.createElement('button');
    translateButton.className = 'ghost';
    translateButton.disabled = !isApproved;
    translateButton.style.padding = '0.25rem 0.55rem';
    translateButton.style.fontSize = '0.78rem';
    translateButton.textContent = 'Translate';
    translateButton.addEventListener('click', async () => {
      translateButton.disabled = true;
      try {
        const result = await translateAiDraft(incidentId, languageSelect.value);
        showToast(
          result.languageValidated
            ? 'Translation queued.'
            : 'Translation queued. Bikol output is not yet validated for quality — review it before relying on it.',
          { variant: result.languageValidated ? 'info' : 'error' }
        );
      } catch (err) {
        showToast(err instanceof ApiClientError ? err.message : 'Could not queue the translation.', { variant: 'error' });
      } finally {
        translateButton.disabled = false;
      }
    });

    translateWrap.append(languageSelect, translateButton);
    rightGroup.append(packetButton, downloadLink, translateWrap);

    dock.append(leftGroup, rightGroup);

    actionRefs = { rerunButton, regenButton, approveButton, reason };
    syncActionState();
    return dock;
  }

  /**
   * Enables/disables the actions from the REAL server state, and always
   * says why when Approve is unavailable — §8's "never a dead control with
   * no explanation".
   */
  function syncActionState() {
    if (!actionRefs) return;
    const { regenButton, approveButton, reason } = actionRefs;

    // A code-review finding caught that returning early here (when an
    // incident is already approved and has no active draft) left both
    // buttons at their default enabled state — clicking either threw on
    // `draft.draftVersion`/`draft.draftRedactedNarrative` being null and
    // surfaced only a generic "Could not approve/regenerate" toast,
    // instead of the real reason this dock is meant to always show (§8
    // "never a dead control with no explanation").
    if (!draft) {
      regenButton.disabled = true;
      approveButton.disabled = true;
      reason.textContent = incident.redactionApprovedAt
        ? 'This incident already has an approved redaction.'
        : 'No AI draft exists yet for this incident.';
      return;
    }

    const pending = draft.status === 'queued' || draft.status === 'processing';
    regenButton.disabled = pending;

    let blockedBecause = null;
    if (incident.redactionApprovedAt) blockedBecause = 'This incident already has an approved redaction.';
    else if (pending) blockedBecause = 'The AI job is still running.';
    else if (draft.status !== 'completed') blockedBecause = 'The draft is not complete.';
    else if (draft.draftSummaryStale) blockedBecause = 'The summary is stale — regenerate it first.';
    else if (edited) blockedBecause = 'You have unsaved edits — regenerate the summary to apply them.';

    approveButton.disabled = blockedBecause !== null;
    reason.textContent = blockedBecause ?? 'Approving commits this text as the incident’s permanent redacted narrative.';
  }

  // --- Actions ---

  async function runRedaction(button) {
    button.disabled = true;
    try {
      await requestRedaction(incidentId);
      showToast('Redaction queued — the worker will process it shortly.', { variant: 'info' });
      await load();
    } catch (err) {
      button.disabled = false;
      showToast(err instanceof ApiClientError ? err.message : 'Could not queue redaction.', { variant: 'error' });
    }
  }

  async function runRegenerate(button) {
    button.disabled = true;
    try {
      await regenerateSummary(incidentId, {
        draftRedactedNarrative: draftTextarea ? draftTextarea.value : draft.draftRedactedNarrative,
        draftVersion: draft.draftVersion,
      });
      showToast('Summary regeneration queued.', { variant: 'info' });
      await load();
    } catch (err) {
      button.disabled = false;
      if (err instanceof ApiClientError && err.status === 409) {
        // §2 Rule 23: a stale tab must reload rather than overwrite.
        showToast('This draft changed since you loaded it — reloading.', { variant: 'error' });
        await load();
        return;
      }
      showToast(err instanceof ApiClientError ? err.message : 'Could not regenerate the summary.', { variant: 'error' });
    }
  }

  async function runApprove(button) {
    button.disabled = true;

    if (extractionEdited && extractionDraft) {
      const shouldSaveFirst = await confirmDialog({
        title: 'Save Party Information?',
        description: 'You modified the Complainant or Respondent fields. Would you like to save these names before finalizing the redaction approval?',
        confirmLabel: 'Save & Approve',
        cancelLabel: 'Approve Without Saving',
      });
      if (shouldSaveFirst) {
        try {
          await approveExtraction(incidentId, {
            complainantName: extractionInputs.complainant?.value,
            respondentName: extractionInputs.respondent?.value,
            complainantContactNumber: extractionInputs.contact?.value,
            draftVersion: extractionDraft.draftVersion,
          });
          extractionEdited = false;
        } catch {
          showToast('Could not save party names, but continuing with redaction approval.', { variant: 'error' });
        }
      }
    }

    try {
      await approveAiDraft(incidentId, {
        // Approval sends the SERVER's current draft text, not the
        // textarea's — the server requires exact equality, and approving
        // unsaved edits would silently commit text whose summary was
        // never regenerated.
        approvedNarrative: draft.draftRedactedNarrative,
        draftVersion: draft.draftVersion,
      });
      showToast('Redaction approved.', { variant: 'success' });
      await load();
    } catch (err) {
      button.disabled = false;
      if (err instanceof ApiClientError && err.status === 409) {
        showToast('This draft changed since you loaded it — reloading.', { variant: 'error' });
        await load();
        return;
      }
      showToast(err instanceof ApiClientError ? err.message : 'Could not approve the draft.', { variant: 'error' });
    }
  }

  async function runSaveExtraction(button, { complainantName, respondentName, complainantContactNumber }) {
    button.disabled = true;
    const originalLabel = button.textContent;
    button.textContent = 'Saving…';
    try {
      await approveExtraction(incidentId, {
        complainantName,
        respondentName,
        complainantContactNumber,
        draftVersion: extractionDraft.draftVersion,
      });
      showToast('Saved.', { variant: 'success' });
      await load();
    } catch (err) {
      button.disabled = false;
      button.textContent = originalLabel;
      if (err instanceof ApiClientError && err.status === 409) {
        showToast('This changed since you loaded it — reloading.', { variant: 'error' });
        await load();
        return;
      }
      showToast(err instanceof ApiClientError ? err.message : 'Could not save these fields.', { variant: 'error' });
    }
  }
}

/**
 * audit W8 — mark, in the ORIGINAL narrative, the words the draft no
 * longer contains. That is the reviewer's actual question ("what did the
 * model take out, and did it miss anything?"), and answering it by eye
 * across two paragraphs is the step most likely to be rushed.
 *
 * A word-level longest-common-subsequence diff. No library: this runs on
 * one incident narrative at a time — a few hundred tokens at most — so
 * the O(n·m) table is trivially small here, and §1's stack has no bundler
 * to pull a diff package through anyway.
 *
 * Returns a DocumentFragment of text nodes and <mark> elements; every
 * piece of narrative text is set via textContent, never innerHTML, so no
 * reported text is ever parsed as markup.
 *
 * @param {string} raw the original narrative
 * @param {string} redacted the draft
 * @returns {DocumentFragment}
 */
function renderRedactionDiff(raw, redacted) {
  // Split keeping whitespace, so the original spacing survives rebuilding.
  const rawTokens = raw.split(/(\s+)/);
  const draftTokens = redacted.split(/(\s+)/).filter((t) => t.trim() !== '');

  // LCS over non-whitespace tokens only — whitespace would otherwise
  // dominate the match and blur the result.
  const rawWords = rawTokens.filter((t) => t.trim() !== '');
  const n = rawWords.length;
  const m = draftTokens.length;
  const lcs = Array.from({ length: n + 1 }, () => new Uint16Array(m + 1));
  for (let i = n - 1; i >= 0; i -= 1) {
    for (let j = m - 1; j >= 0; j -= 1) {
      lcs[i][j] = rawWords[i] === draftTokens[j]
        ? lcs[i + 1][j + 1] + 1
        : Math.max(lcs[i + 1][j], lcs[i][j + 1]);
    }
  }
  // Walk the table to decide, for each original word, whether it survived.
  const survived = new Array(n).fill(false);
  let i = 0;
  let j = 0;
  while (i < n && j < m) {
    if (rawWords[i] === draftTokens[j]) {
      survived[i] = true;
      i += 1;
      j += 1;
    } else if (lcs[i + 1][j] >= lcs[i][j + 1]) {
      i += 1;
    } else {
      j += 1;
    }
  }

  const fragment = document.createDocumentFragment();
  let wordIndex = 0;
  let pendingRemoved = [];
  const flushRemoved = () => {
    if (pendingRemoved.length === 0) return;
    const mark = document.createElement('mark');
    mark.className = 'redaction-diff__removed';
    mark.textContent = pendingRemoved.join('');
    fragment.appendChild(mark);
    pendingRemoved = [];
  };

  for (const token of rawTokens) {
    if (token.trim() === '') {
      // Whitespace joins the current run rather than breaking it, so a
      // removed phrase highlights as one span instead of several.
      if (pendingRemoved.length > 0) pendingRemoved.push(token);
      else fragment.appendChild(document.createTextNode(token));
      continue;
    }
    if (survived[wordIndex]) {
      flushRemoved();
      fragment.appendChild(document.createTextNode(token));
    } else {
      pendingRemoved.push(token);
    }
    wordIndex += 1;
  }
  flushRemoved();
  return fragment;
}
