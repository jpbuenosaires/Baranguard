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
 * to a broken screen. It is reached by clicking a row in W6 Electronic
 * Blotter (Secretary only), and reports 'blotter' as the active nav item
 * so the shell stays coherent.
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
  luponPacketDownloadUrl,
  logout,
  ApiClientError,
} from '../api/apiClient.js';
import { AppShell } from '../components/AppShell.js';
import { PageHeader } from '../components/PageHeader.js';
import { icons } from '../components/icons.js';
import { showToast } from '../components/Toast.js';

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

  const shell = AppShell(user, 'blotter', navigate, async () => {
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
  backButton.textContent = '← Back to Blotter';
  backButton.addEventListener('click', () => {
    stopPolling();
    navigate('blotter');
  });
  pageHeader.actions.appendChild(backButton);

  let pollTimer = null;
  let incident = null;
  let draft = null;
  /** Independent of `draft` above — see AiJobQueue's own extraction docblock. */
  let extractionDraft = null;
  /** Tracks whether the Secretary has edited the draft text away from what the server holds. */
  let edited = false;
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
      const message = err instanceof ApiClientError ? err.message : 'Something went wrong loading this incident.';
      renderError(message);
    }
  }

  // --- States (§8: Loading / Empty / Error / Populated on every screen) ---

  function renderLoading() {
    content.innerHTML = '';
    const wrap = document.createElement('div');
    wrap.className = 'stack';
    wrap.setAttribute('role', 'status');
    wrap.setAttribute('aria-label', 'Loading AI draft');
    for (let i = 0; i < 4; i++) {
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

  function render() {
    content.innerHTML = '';
    content.appendChild(buildIncidentSummary());

    if (!draft) {
      content.appendChild(buildNoDraftState());
      // Post-approval tools stay reachable even with no draft — an
      // incident approved earlier still needs translation and its packet.
      if (incident.redactionApprovedAt) content.appendChild(buildPostApprovalPanel());
      return;
    }

    content.appendChild(buildDraftMeta());
    content.appendChild(buildSideBySide());
    content.appendChild(buildActions());
    content.appendChild(buildPostApprovalPanel());
  }

  /**
   * §9 W8: "Once approved, translation and Lupon packet are available only
   * when their prerequisites are met."
   *
   * Both controls are always VISIBLE once a redaction is approved, and
   * disabled with the specific missing prerequisite named — §8 forbids a
   * dead control with no explanation, and the packet's second prerequisite
   * (a finalized blotter) lives on a different screen, so silently
   * disabling it would leave the Secretary with no idea what to do next.
   */
  function buildPostApprovalPanel() {
    const card = document.createElement('div');
    card.className = 'card';

    const heading = document.createElement('h3');
    heading.textContent = 'After approval';
    card.appendChild(heading);

    if (!incident.redactionApprovedAt) {
      const note = document.createElement('p');
      note.className = 'note';
      note.textContent = 'Translation and the Lupon packet become available once the redaction is approved.';
      card.appendChild(note);
      return card;
    }

    // --- Translation ---
    const translateRow = document.createElement('div');
    translateRow.className = 'ai-review__actions';

    const languageLabel = document.createElement('label');
    languageLabel.className = 'sr-only';
    languageLabel.htmlFor = 'ai-translate-language';
    languageLabel.textContent = 'Target language';
    const languageSelect = document.createElement('select');
    languageSelect.id = 'ai-translate-language';
    for (const [value, label] of [['en', 'English'], ['fil', 'Filipino'], ['bcl', 'Bikol']]) {
      const option = document.createElement('option');
      option.value = value;
      option.textContent = label;
      languageSelect.appendChild(option);
    }

    const translateButton = document.createElement('button');
    translateButton.className = 'ghost';
    translateButton.textContent = 'Queue translation';
    translateButton.addEventListener('click', async () => {
      translateButton.disabled = true;
      try {
        const result = await translateAiDraft(incidentId, languageSelect.value);
        // Rule 16: Bikol is unvalidated until a real evaluation run says
        // otherwise. Surface that instead of quietly returning it.
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

    translateRow.append(languageLabel, languageSelect, translateButton);
    card.appendChild(translateRow);

    // --- Lupon packet ---
    const packetRow = document.createElement('div');
    packetRow.className = 'ai-review__actions';

    const packetButton = document.createElement('button');
    packetButton.className = 'ghost';
    packetButton.textContent = 'Generate Lupon packet';
    packetButton.addEventListener('click', async () => {
      packetButton.disabled = true;
      packetButton.textContent = 'Generating…';
      try {
        await generateLuponPacket(incidentId);
        showToast('Lupon packet generated.', { variant: 'success' });
        packetNote.textContent = 'Packet ready.';
        downloadLink.hidden = false;
      } catch (err) {
        // The likeliest failure is "no finalized blotter yet", which is
        // fixed on W7 — say that rather than just echoing a 409.
        showToast(
          err instanceof ApiClientError ? err.message : 'Could not generate the packet.',
          { variant: 'error' }
        );
      } finally {
        packetButton.disabled = false;
        packetButton.textContent = 'Generate Lupon packet';
      }
    });

    const downloadLink = document.createElement('a');
    downloadLink.className = 'ghost';
    downloadLink.textContent = 'Download packet';
    downloadLink.href = luponPacketDownloadUrl(incidentId);
    downloadLink.target = '_blank';
    downloadLink.rel = 'noopener';
    downloadLink.hidden = true;

    packetRow.append(packetButton, downloadLink);
    card.appendChild(packetRow);

    const packetNote = document.createElement('p');
    packetNote.className = 'note';
    packetNote.textContent =
      'The packet needs a finalized blotter entry as well as the approved redaction. Finalize it on the blotter entry screen.';
    card.appendChild(packetNote);

    return card;
  }

  function buildIncidentSummary() {
    const card = document.createElement('div');
    card.className = 'card';
    const row = document.createElement('div');
    row.className = 'ai-review__meta';

    const title = document.createElement('h3');
    title.textContent = INCIDENT_TYPE_LABELS[incident.incidentType] || incident.incidentType;
    row.appendChild(title);

    if (incident.redactionApprovedAt) {
      const pill = document.createElement('span');
      pill.className = 'status-pill status-pill--success';
      pill.textContent = 'Redaction approved';
      row.appendChild(pill);
    }
    card.appendChild(row);

    const meta = document.createElement('p');
    meta.className = 'note';
    meta.textContent = `Logged ${new Date(incident.createdAt).toLocaleString()} · status ${incident.status}`;
    card.appendChild(meta);
    return card;
  }

  function buildNoDraftState() {
    const block = document.createElement('div');
    block.className = 'card state-block';
    const heading = document.createElement('h3');
    heading.textContent = 'No AI draft yet';
    const text = document.createElement('p');
    text.textContent =
      'Running redaction queues a job for the local model. It is processed by the worker on this workstation, so the draft appears here once that finishes — it does not happen instantly.';
    const button = document.createElement('button');
    button.className = 'primary';
    button.textContent = 'Run redaction';
    button.addEventListener('click', () => runRedaction(button));
    block.append(heading, text, button);
    return block;
  }

  function buildDraftMeta() {
    const card = document.createElement('div');
    card.className = 'card';
    const row = document.createElement('div');
    row.className = 'ai-review__meta';

    const statusPill = document.createElement('span');
    statusPill.className = `status-pill ${STATUS_PILL_CLASS[draft.status] || 'status-pill--neutral'}`;
    statusPill.textContent = draft.status;
    row.appendChild(statusPill);

    const version = document.createElement('span');
    version.className = 'note';
    version.textContent = `Draft v${draft.draftVersion}`;
    row.appendChild(version);

    // §8: the badge names the REAL self-hosted model from the row.
    const model = document.createElement('span');
    model.className = 'note';
    model.textContent = `Model: ${draft.modelVersion}`;
    row.appendChild(model);

    card.appendChild(row);

    if (draft.draftSummaryStale) {
      const warn = document.createElement('p');
      warn.className = 'state-block--error';
      warn.setAttribute('role', 'status');
      warn.textContent =
        'The summary is stale for the current draft text. Regenerate it before approving — approval is blocked until then.';
      card.appendChild(warn);
    }

    if (draft.status === 'failed' && draft.errorCode) {
      const err = document.createElement('p');
      err.className = 'state-block--error';
      err.setAttribute('role', 'alert');
      err.textContent = `The AI job failed (${draft.errorCode}). Re-run redaction to try again.`;
      card.appendChild(err);
    }

    return card;
  }

  function buildSideBySide() {
    const layout = document.createElement('div');
    layout.className = 'split-panel';

    // Left: the original narrative. Read-only — this is the record of what
    // was actually reported and must never be editable from this screen.
    const rawCard = document.createElement('div');
    rawCard.className = 'card';
    const rawHeading = document.createElement('h3');
    rawHeading.textContent = 'Original narrative';
    const rawNote = document.createElement('p');
    rawNote.className = 'note';
    rawNote.textContent = 'Read-only. Visible to the Secretary only.';
    const rawText = document.createElement('pre');
    rawText.className = 'narrative-block';
    // Never innerHTML with the raw string — this is unredacted reported
    // text. renderRedactionDiff builds nodes with textContent per token.
    if (incident.rawNarrative && draft.draftRedactedNarrative) {
      rawText.appendChild(renderRedactionDiff(incident.rawNarrative, draft.draftRedactedNarrative));
    } else {
      rawText.textContent = incident.rawNarrative ?? '(not available)';
    }

    // audit W8: this is the screen where a person certifies that personal
    // information has been removed before it becomes a permanent record,
    // and it presented two plain blocks of prose — finding what changed
    // was a manual character-by-character read. The removed spans are now
    // marked in the original, and a count states what to check for.
    const summaryLine = document.createElement('p');
    summaryLine.className = 'note redaction-summary';
    if (incident.rawNarrative && draft.draftRedactedNarrative) {
      const placeholders = draft.draftRedactedNarrative.match(/\[[A-Z_]+\]/g) ?? [];
      const byKind = placeholders.reduce((acc, p) => { acc[p] = (acc[p] ?? 0) + 1; return acc; }, {});
      const parts = Object.entries(byKind).map(([kind, n]) => `${n} ${kind.slice(1, -1).toLowerCase().replace('_', ' ')}`);
      summaryLine.textContent = placeholders.length === 0
        ? 'The draft contains no redaction placeholders — check that nothing identifying was missed.'
        : `${placeholders.length} identifier${placeholders.length === 1 ? '' : 's'} removed: ${parts.join(', ')}. Highlighted below.`;
    }
    rawCard.append(rawHeading, rawNote, summaryLine, rawText);

    // Right: the editable draft.
    const draftCard = document.createElement('div');
    draftCard.className = 'card';
    const draftHeading = document.createElement('h3');
    draftHeading.textContent = 'Redaction draft';
    const draftNote = document.createElement('p');
    draftNote.className = 'note';
    draftNote.textContent = 'Edit if needed, then regenerate the summary before approving.';

    const textarea = document.createElement('textarea');
    textarea.id = 'ai-draft-narrative';
    textarea.rows = 16;
    textarea.classList.add('textarea--resizable');
    textarea.value = draft.draftRedactedNarrative ?? '';
    textarea.disabled = draft.status === 'queued' || draft.status === 'processing';
    textarea.addEventListener('input', () => {
      edited = textarea.value !== (draft.draftRedactedNarrative ?? '');
      syncActionState();
    });
    draftCard.append(draftHeading, draftNote, textarea);

    const summaryHeading = document.createElement('h3');
    summaryHeading.textContent = 'Summary';
    const summaryText = document.createElement('pre');
    summaryText.className = 'narrative-block';
    summaryText.textContent = draft.draftSummary ?? '(not generated yet)';
    draftCard.append(summaryHeading, summaryText);

    draftCard.appendChild(buildExtractionSection());

    layout.append(rawCard, draftCard);
    draftTextarea = textarea;
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

    const heading = document.createElement('h3');
    heading.textContent = 'Complainant / Respondent';
    wrap.appendChild(heading);

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
    note.textContent = hasApproved
      ? 'Showing the last saved values. Edit and save again to change them.'
      : 'AI-drafted from the original narrative. Review and edit before saving — leave a field blank if it does not apply.';
    wrap.appendChild(note);

    const pending = extractionDraft.status === 'queued' || extractionDraft.status === 'processing';

    const complainantLabel = document.createElement('label');
    complainantLabel.className = 'label';
    complainantLabel.textContent = 'Complainant name';
    const complainantInput = document.createElement('input');
    complainantInput.type = 'text';
    complainantInput.value = (hasApproved ? incident.complainantName : extractionDraft.draftComplainantName) ?? '';
    complainantInput.disabled = pending;

    const respondentLabel = document.createElement('label');
    respondentLabel.className = 'label';
    respondentLabel.textContent = 'Respondent name';
    const respondentInput = document.createElement('input');
    respondentInput.type = 'text';
    respondentInput.value = (hasApproved ? incident.respondentName : extractionDraft.draftRespondentName) ?? '';
    respondentInput.disabled = pending;

    const contactLabel = document.createElement('label');
    contactLabel.className = 'label';
    contactLabel.textContent = 'Contact number';
    const contactInput = document.createElement('input');
    contactInput.type = 'tel';
    contactInput.value = (hasApproved ? incident.complainantContactNumber : extractionDraft.draftComplainantContactNumber) ?? '';
    contactInput.disabled = pending;

    const saveButton = document.createElement('button');
    saveButton.type = 'button';
    saveButton.className = 'ghost';
    saveButton.textContent = pending ? 'Extraction still running…' : 'Save';
    saveButton.disabled = pending;
    saveButton.addEventListener('click', () => runSaveExtraction(saveButton, {
      complainantName: complainantInput.value,
      respondentName: respondentInput.value,
      complainantContactNumber: contactInput.value,
    }));

    wrap.append(complainantLabel, complainantInput, respondentLabel, respondentInput, contactLabel, contactInput, saveButton);
    return wrap;
  }

  function buildActions() {
    const card = document.createElement('div');
    card.className = 'card';
    const row = document.createElement('div');
    row.className = 'ai-review__actions';

    const rerunButton = document.createElement('button');
    rerunButton.className = 'ghost';
    rerunButton.textContent = 'Re-run redaction';
    rerunButton.addEventListener('click', () => runRedaction(rerunButton));

    const regenButton = document.createElement('button');
    regenButton.className = 'ghost';
    regenButton.textContent = 'Regenerate summary';
    regenButton.addEventListener('click', () => runRegenerate(regenButton));

    const approveButton = document.createElement('button');
    approveButton.className = 'primary';
    approveButton.textContent = 'Approve redaction';
    approveButton.addEventListener('click', () => runApprove(approveButton));

    row.append(rerunButton, regenButton, approveButton);
    card.appendChild(row);

    const reason = document.createElement('p');
    reason.className = 'note';
    reason.id = 'ai-approve-reason';
    card.appendChild(reason);

    actionRefs = { rerunButton, regenButton, approveButton, reason };
    syncActionState();
    return card;
  }

  /**
   * Enables/disables the actions from the REAL server state, and always
   * says why when Approve is unavailable — §8's "never a dead control with
   * no explanation".
   */
  function syncActionState() {
    if (!actionRefs || !draft) return;
    const { regenButton, approveButton, reason } = actionRefs;

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
