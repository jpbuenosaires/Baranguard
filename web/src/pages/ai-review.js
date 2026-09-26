/**
 * ai-review.js — the Redaction tab of the case workspace (formerly a
 * standalone W8 page, folded in 2026-09-27 — see DEVLOG (38) and
 * `blotter-detail.js`'s own doc for why). "Secretary only. Side-by-side
 * raw vs draft. Displays draft_version, model version, status, and stale
 * warning. Editing requires regeneration using the matching version.
 * Approval requires exact current version equality."
 *
 * EVERY VALUE ON THIS TAB COMES FROM A REAL `ai_processing_log` ROW.
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
 * NOT its own route/page anymore: `renderRedactionTab()` mounts into a
 * `body` container the shared case-workspace shell (`blotter-detail.js`)
 * already owns — no AppShell, no PageHeader, no back button of its own.
 * `switchTab()`/`refreshWorkflowBar()` are handed down by that shell so
 * this tab never needs a full `navigate()` to move between "stages" or
 * to keep the shared workflow stepper in sync with its own local state
 * (`edited`, freshly-polled `draft`).
 *
 * The pipeline is asynchronous by design (§2 Rule 15 — the API never calls
 * Ollama, only the worker does), so redaction and summary regeneration
 * both come back `queued`. This tab polls `GET /incidents/:id/ai-draft`
 * until the server reports `completed` or `failed`. Polling stops when
 * the shell switches away from this tab or unmounts — via the returned
 * `stop` handle, same contract the old standalone page had.
 *
 * kebab-case filename per §4 — kept as `ai-review.js` even though the
 * page it named is gone, same precedent `analytics.js`'s tabs set
 * (`statistical-reports.js`/`historical-heatmap.js` kept their own
 * pre-merge names too).
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
  getBlotterForIncident,
  ApiClientError,
} from '../api/apiClient.js';
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
 * @param {HTMLElement} body container the shell already mounted for this tab
 * @param {{fullName:string, role:string}} user
 * @param {number} incidentId
 * @param {{switchTab: (tab: string, anchor?: string) => void, refreshWorkflowBar: (overrides?: {incident?: object, draft?: object|null, blotter?: object|null, edited?: boolean}) => void}} shell
 * @returns {{stop: () => void}}
 */
export function renderRedactionTab(body, user, incidentId, { switchTab, refreshWorkflowBar }) {
  const content = body;
  content.innerHTML = '';

  let pollTimer = null;
  let incident = null;
  let draft = null;
  /** Independent of `draft` above — see AiJobQueue's own extraction docblock. */
  let extractionDraft = null;
  /** Blotter record (null until finalized) — drives the shared workflow bar and the Lupon packet gate. */
  let blotter = null;
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
  /**
   * When the currently-pending job was first observed as queued/processing
   * by THIS browser tab (not a server timestamp — the API doesn't expose
   * one for this). Powers the elapsed-time readout; ticks every second
   * independent of the 3s poll so the counter doesn't visibly stall.
   * Never reset to a fabricated "estimated remaining" figure — only a real
   * clock counting up, per §8's no-invented-numbers rule.
   */
  let pendingSince = null;
  let tickTimer = null;
  let elapsedEl = null;

  function stopPolling() {
    if (pollTimer) {
      clearInterval(pollTimer);
      pollTimer = null;
    }
    if (tickTimer) {
      clearInterval(tickTimer);
      tickTimer = null;
    }
    pendingSince = null;
  }

  function isPending(d) {
    return d && (d.status === 'queued' || d.status === 'processing');
  }

  function formatElapsed(ms) {
    const totalSeconds = Math.max(0, Math.floor(ms / 1000));
    const minutes = Math.floor(totalSeconds / 60);
    const seconds = totalSeconds % 60;
    return `${minutes}:${String(seconds).padStart(2, '0')}`;
  }

  function tickElapsed() {
    if (!elapsedEl || pendingSince == null) return;
    elapsedEl.textContent = formatElapsed(Date.now() - pendingSince);
  }

  function startPollingIfPending() {
    stopPolling();
    if (!isPending(draft) && !isPending(extractionDraft)) return;
    pendingSince = Date.now();
    tickTimer = setInterval(tickElapsed, 1000);
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
      [incident, draft, extractionDraft, blotter] = await Promise.all([
        getIncident(incidentId),
        getAiDraft(incidentId),
        getExtractionDraft(incidentId),
        // 404 -> null is normal (not finalized yet); any other failure
        // only costs the workflow bar its last two stages' accuracy.
        getBlotterForIncident(incidentId).catch(() => null),
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

  function render() {
    content.innerHTML = '';
    elapsedEl = null;
    const layout = document.createElement('div');
    layout.className = 'ai-review-layout';

    // The shared workflow stepper now lives once, above the tab bar, in
    // the shell (blotter-detail.js) — this tab only keeps it in sync via
    // refreshWorkflowBar(), never renders its own copy.
    refreshWorkflowBar({ incident, draft, blotter, edited });
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

    const titleRow = document.createElement('div');
    titleRow.className = 'ai-review__briefing-title-row';

    const statusPill = document.createElement('span');
    statusPill.className = `status-pill ${incident.redactionApprovedAt ? 'status-pill--success' : 'status-pill--info'}`;
    statusPill.textContent = incident.redactionApprovedAt ? 'Redaction Approved' : 'AI Redaction Pipeline';
    titleRow.appendChild(statusPill);

    if (draft) {
      const draftPill = document.createElement('span');
      draftPill.className = `status-pill ${STATUS_PILL_CLASS[draft.status] || 'status-pill--neutral'}`;
      draftPill.textContent = `${(draft.status || 'unknown').toUpperCase()} v${draft.draftVersion}`;
      titleRow.appendChild(draftPill);

      if (draft.draftSummaryStale) {
        const stalePill = document.createElement('span');
        stalePill.className = 'status-pill status-pill--warning';
        stalePill.textContent = 'Summary out of date';
        titleRow.appendChild(stalePill);
      }
    }

    const metaRow = document.createElement('div');
    metaRow.className = 'ai-review__briefing-meta';

    if (draft) {
      const modelSpan = document.createElement('span');
      modelSpan.innerHTML = `${icons.sparkles(13)} <span>Model: <code>${escapeHtml(draft.modelVersion || 'Local Ollama')}</code></span>`;
      metaRow.appendChild(modelSpan);
    }

    leftCol.append(titleRow, metaRow);

    const privacyBadge = document.createElement('div');
    privacyBadge.className = 'ai-review__privacy-badge';
    privacyBadge.innerHTML = `
      <span class="ai-review__privacy-icon">${icons.lock(13)}</span>
      <span>RA 10173 • Local Ollama</span>
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
      <span class="status-pill status-pill--critical">Contains PII</span>
    `;

    const rawBlock = document.createElement('pre');
    rawBlock.className = 'narrative-block ai-review__narrative-preview';
    rawBlock.textContent = incident.rawNarrative || 'No raw narrative text logged for this incident.';

    const leftFooter = document.createElement('div');
    leftFooter.className = 'ai-review__card-footer';
    const charCount = incident.rawNarrative ? incident.rawNarrative.length : 0;
    leftFooter.innerHTML = `
      <span>${charCount} characters</span>
      <span class="ai-review__footer-note">${icons.alertTriangle(12)} Unredacted — sanitize personal details before blotter entry.</span>
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
    engineDesc.textContent = 'Scrubs personal identifiable information (PII) and extracts complainant/respondent entities on-device.';

    const specsList = document.createElement('div');
    specsList.className = 'ai-review__specs-list';
    specsList.innerHTML = `
      <div class="ai-review__spec-item">
        <span class="ai-review__spec-label">Sanitizes:</span>
        <span class="ai-review__spec-val">Names, Phone Numbers, Addresses</span>
      </div>
      <div class="ai-review__spec-item">
        <span class="ai-review__spec-label">Extracts:</span>
        <span class="ai-review__spec-val">Complainant, Respondent & Contact</span>
      </div>
    `;

    const actionWrap = document.createElement('div');
    actionWrap.className = 'ai-review__engine-action';
    actionWrap.id = 'ai-review-start';

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

    // Left: the original narrative (read-only).
    const rawCard = document.createElement('div');
    rawCard.className = 'card ai-review__studio-card';

    const rawHeader = document.createElement('div');
    rawHeader.className = 'ai-review__studio-card-header';
    rawHeader.innerHTML = `
      <div class="ai-review__studio-card-title">
        <span class="ai-review__card-icon">${icons.fileText(16)}</span>
        <h3>Original Reported Narrative</h3>
      </div>
      <span class="status-pill status-pill--neutral">Read-only</span>
    `;

    const summaryLine = document.createElement('p');
    summaryLine.className = 'note redaction-summary';
    if (incident.rawNarrative && draft.draftRedactedNarrative) {
      const placeholders = draft.draftRedactedNarrative.match(/\[[A-Z_]+\]/g) ?? [];
      const byKind = placeholders.reduce((acc, p) => { acc[p] = (acc[p] ?? 0) + 1; return acc; }, {});
      const parts = Object.entries(byKind).map(([kind, n]) => `${n} ${kind.slice(1, -1).toLowerCase().replace('_', ' ')}`);
      summaryLine.textContent = placeholders.length === 0
        ? 'No redaction placeholders found — verify no personal identifiers were missed.'
        : `${placeholders.length} identifier${placeholders.length === 1 ? '' : 's'} removed (${parts.join(', ')}), highlighted below.`;
    } else {
      summaryLine.textContent = 'Awaiting draft completion to compute identifier diff.';
    }

    const rawText = document.createElement('pre');
    rawText.className = 'narrative-block';
    rawText.style.minHeight = '10.5rem';
    if (incident.rawNarrative && draft.draftRedactedNarrative) {
      rawText.appendChild(renderRedactionDiff(incident.rawNarrative, draft.draftRedactedNarrative));
    } else {
      rawText.textContent = incident.rawNarrative ?? '(not available)';
    }

    rawCard.append(rawHeader, summaryLine, rawText);

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
      ? 'Scrubbing PII and sensitive identifiers…'
      : 'Edit if needed. Edits require regenerating the summary before approval.';

    draftCard.append(draftHeader, draftNote);

    if (isPending) {
      const processingBanner = document.createElement('div');
      processingBanner.className = 'ai-review__processing-banner';
      processingBanner.innerHTML = `
        <div style="display:flex;align-items:center;gap:var(--spacing-sm);width:100%;">
          <span class="is-spinning">${icons.repeat(16)}</span>
          <span>
            <strong>AI Redaction in Progress:</strong> Processing incident narrative…
            <span class="ai-review__processing-elapsed" aria-live="polite"></span>
          </span>
        </div>
        <div class="ai-review__progress-track" role="progressbar" aria-label="AI job in progress" aria-valuetext="Processing">
          <div class="ai-review__progress-fill"></div>
        </div>
      `;
      draftCard.appendChild(processingBanner);
      elapsedEl = processingBanner.querySelector('.ai-review__processing-elapsed');
      tickElapsed();
    }

    const textarea = document.createElement('textarea');
    textarea.id = 'ai-draft-narrative';
    textarea.setAttribute('aria-label', 'Redacted narrative draft');
    textarea.rows = 9;
    textarea.classList.add('textarea--resizable');
    textarea.placeholder = isPending ? 'Draft is currently generating in background worker…' : 'Enter redacted narrative…';
    textarea.value = draft.draftRedactedNarrative ?? '';
    textarea.disabled = isPending;
    textarea.style.minHeight = '10.5rem';
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
        <h3>AI-suggested summary</h3>
      </div>
    `;
    if (draft.draftSummaryStale || edited) {
      const staleBadge = document.createElement('span');
      staleBadge.className = 'status-pill status-pill--warning';
      staleBadge.textContent = 'Out of date';
      summaryHeader.appendChild(staleBadge);
    }
    summaryCard.appendChild(summaryHeader);

    const summaryNote = document.createElement('p');
    summaryNote.className = 'note';
    summaryNote.style.margin = '0 0 var(--spacing-xs) 0';
    summaryNote.textContent = (draft.draftSummaryStale || edited)
      ? 'Draft changed — regenerate this summary so it matches the text you are approving.'
      : 'Pre-fills the blotter summary when you finalize the entry.';
    summaryCard.appendChild(summaryNote);

    const summaryText = document.createElement('pre');
    summaryText.className = 'narrative-block ai-review__summary-block';
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
      regenBtn.innerHTML = `${icons.repeat(14)} <span>Regenerate summary from draft</span>`;
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

    if (!extractionDraft) {
      wrap.appendChild(header);
      const note = document.createElement('p');
      note.className = 'note';
      note.textContent = 'Queues alongside redaction and appears here once the worker finishes.';
      wrap.appendChild(note);
      return wrap;
    }

    const hasApproved = incident.complainantName != null || incident.respondentName != null || incident.complainantContactNumber != null;
    const pending = extractionDraft.status === 'queued' || extractionDraft.status === 'processing';

    const baseComplainant = (hasApproved ? incident.complainantName : extractionDraft.draftComplainantName) ?? '';
    const baseRespondent = (hasApproved ? incident.respondentName : extractionDraft.draftRespondentName) ?? '';
    const baseContact = (hasApproved ? incident.complainantContactNumber : extractionDraft.draftComplainantContactNumber) ?? '';

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

    // Respondent
    const respWrap = document.createElement('div');
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
    saveButton.style.fontSize = 'var(--font-size-xs)';
    saveButton.style.padding = '0.28rem 0.65rem';
    saveButton.textContent = pending ? 'Extracting…' : 'Save Parties';
    saveButton.disabled = pending;
    saveButton.addEventListener('click', () => {
      extractionEdited = false;
      runSaveExtraction(saveButton, {
        complainantName: complainantInput.value,
        respondentName: respondentInput.value,
        complainantContactNumber: contactInput.value,
      });
    });

    header.appendChild(saveButton);
    wrap.appendChild(header);

    const note = document.createElement('p');
    note.className = 'note';
    note.style.margin = '0 0 var(--spacing-xs) 0';
    note.textContent = hasApproved
      ? 'Saved party names. Edit and save to update.'
      : 'AI-drafted from narrative. Leave blank if not applicable.';
    wrap.appendChild(note);

    const grid = document.createElement('div');
    grid.className = 'ai-review__extraction-grid';
    grid.append(compWrap, contactWrap, respWrap);

    wrap.appendChild(grid);
    return wrap;
  }

  function buildActionsDock() {
    const dock = document.createElement('div');
    dock.className = 'card ai-review__action-dock';
    dock.id = 'ai-review-actions';
    dock.tabIndex = -1;

    // Left group: Primary workflow actions
    const leftGroup = document.createElement('div');
    leftGroup.className = 'ai-review__action-dock-left';

    const approveButton = document.createElement('button');
    approveButton.className = 'primary';
    approveButton.innerHTML = `${icons.check(14)} Approve redaction`;
    approveButton.addEventListener('click', () => runApprove(approveButton));

    const regenButton = document.createElement('button');
    regenButton.className = 'ghost';
    regenButton.innerHTML = `${icons.sparkles(14)} Regenerate summary`;
    regenButton.addEventListener('click', () => runRegenerate(regenButton));

    const rerunButton = document.createElement('button');
    rerunButton.className = 'ghost';
    rerunButton.innerHTML = `${icons.repeat(14)} Re-run redaction`;
    rerunButton.addEventListener('click', () => runRedaction(rerunButton));

    leftGroup.append(approveButton, regenButton, rerunButton);

    const reason = document.createElement('span');
    reason.className = 'ai-review__action-reason';
    reason.id = 'ai-approve-reason';
    leftGroup.appendChild(reason);

    // Right group: Post-approval utilities
    const rightGroup = document.createElement('div');
    rightGroup.className = 'ai-review__action-dock-right';

    const isApproved = Boolean(incident.redactionApprovedAt);
    const isFinalized = Boolean(blotter?.finalizedAt);

    const postLabel = document.createElement('span');
    postLabel.className = 'ai-review__dock-sublabel';
    postLabel.textContent = isApproved ? 'Utilities:' : 'Locked until approved:';
    rightGroup.appendChild(postLabel);

    const packetButton = document.createElement('button');
    packetButton.type = 'button';
    packetButton.className = 'ghost';
    packetButton.disabled = !isFinalized;
    packetButton.title = isFinalized
      ? 'Go to the Blotter tab to generate the Lupon conciliation packet'
      : 'Finalize the blotter entry first (on the Blotter tab)';
    packetButton.innerHTML = `${icons.download(14)} Lupon packet`;
    packetButton.addEventListener('click', () => switchTab('blotter', 'blotter-packet'));

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
    rightGroup.append(packetButton, translateWrap);

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
    else if (draft.draftSummaryStale) blockedBecause = 'The summary is out of date — regenerate it first.';
    else if (edited) blockedBecause = 'You edited the draft — regenerate the summary to save your edits.';

    approveButton.disabled = blockedBecause !== null;
    reason.textContent = blockedBecause ?? 'Approving saves this text as the incident’s redacted narrative. Next, you finalize the blotter entry.';
    refreshWorkflowBar({ incident, draft, blotter, edited });
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
      showToast('Redaction approved. Next: finalize the blotter entry.', { variant: 'success' });
      // §9's documented flow is redact/approve -> finalize -> packet;
      // switching tabs here automatically saves the Secretary the manual
      // click that used to follow every approval (a full page nav to W7),
      // since finalizing on the Blotter tab is always the very next step.
      stopPolling();
      switchTab('blotter');
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
