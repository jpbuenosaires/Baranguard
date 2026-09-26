/**
 * BlotterWorkflow.js — the Secretary's end-to-end blotter progress bar,
 * shared by the Redaction and Blotter tabs of `blotter-detail.js`'s
 * single case workspace.
 *
 * WHY THIS EXISTS (2026-09-26 UX pass, revised 2026-09-27): the blotter
 * workflow used to span two full page navigations — redact + approve on
 * a separate W8 page, finalize + Lupon packet on W7 — and each screen
 * only ever described its own half, forcing a Secretary to lose their
 * place jumping between them. 2026-09-27's tab merge (DEVLOG (38))
 * folded both into one page with in-case tabs, so a stage's `screen` is
 * now a TAB KEY ('redaction'/'blotter') the shared shell switches to,
 * not a page `navigate()` target.
 *
 * Modelled on the GOV.UK Design System's task list component/"complete
 * multiple tasks" pattern: every stage has a plain-language name and a
 * status tag ("Completed", "Ready", "Cannot start yet"), incomplete stages
 * carry the colour and completed ones stay neutral, and exactly one
 * "Next step" line says what to do now — with a button to get there.
 *
 * Every status is derived from REAL server state (incident, AI draft,
 * blotter record) — never guessed (§2 Rule 6). The only client-side input
 * is `edited` (unsaved textarea edits on the Redaction tab), which the
 * server can't know.
 */

import { generateLuponPacket, downloadLuponPacket, ApiClientError } from '../api/apiClient.js';
import { icons } from './icons.js';
import { showToast } from './Toast.js';

const STATUS_TEXT = {
  done: 'Completed',
  ready: 'Ready',
  running: 'In progress',
  attention: 'Needs attention',
  failed: 'Failed',
  todo: 'Not started',
  available: 'Available',
  blocked: 'Cannot start yet',
};

/**
 * @param {{incident: object, draft?: object|null, blotter?: object|null, edited?: boolean}} input
 * @returns {{stages: Array<{key:string,title:string,screen:string,anchor:string,status:string}>, next: {message:string, actionLabel:string|null, stageKey:string|null}}}
 */
export function getBlotterWorkflowState({ incident, draft = null, blotter = null, edited = false }) {
  const approved = Boolean(incident?.redactionApprovedAt);
  const finalized = Boolean(blotter?.finalizedAt);
  const draftStatus = draft?.status ?? null;
  const draftPending = draftStatus === 'queued' || draftStatus === 'processing';
  const draftDone = draftStatus === 'completed';
  const summaryOutOfDate = Boolean(draft?.draftSummaryStale) || edited;

  let redact;
  if (approved || draftDone) redact = 'done';
  else if (draftPending) redact = 'running';
  else if (draftStatus === 'failed') redact = 'failed';
  else redact = 'todo';

  let approve;
  if (approved) approve = 'done';
  else if (draftDone && summaryOutOfDate) approve = 'attention';
  else if (draftDone) approve = 'ready';
  else approve = 'blocked';

  const finalize = finalized ? 'done' : approved ? 'ready' : 'blocked';
  const packet = finalized ? 'available' : 'blocked';

  const stages = [
    { key: 'redact', title: 'Remove personal details', tab: 'redaction', anchor: 'ai-review-start', status: redact },
    { key: 'approve', title: 'Check & approve redaction', tab: 'redaction', anchor: 'ai-review-actions', status: approve },
    { key: 'finalize', title: 'Finalize blotter entry', tab: 'blotter', anchor: 'blotter-finalize', status: finalize },
    { key: 'packet', title: 'Lupon packet (if referred)', tab: 'blotter', anchor: 'blotter-packet', status: packet },
  ];

  let next;
  if (redact === 'todo') {
    next = { stageKey: 'redact', actionLabel: 'Run AI redaction', message: 'Run the AI redaction. It drafts a copy of the narrative with names, phone numbers, and addresses removed.' };
  } else if (redact === 'running') {
    next = { stageKey: 'redact', actionLabel: 'View progress', message: 'The AI is drafting the redaction on this workstation. You can leave — it keeps running, and the draft will be waiting here.' };
  } else if (redact === 'failed') {
    next = { stageKey: 'redact', actionLabel: 'Run it again', message: 'The AI redaction failed. Run it again; if it keeps failing, check the AI badge in the top bar.' };
  } else if (approve === 'attention') {
    next = { stageKey: 'approve', actionLabel: 'Review AI redaction', message: 'The draft changed, so the AI summary is out of date. Refresh the summary, then approve.' };
  } else if (approve === 'ready') {
    next = { stageKey: 'approve', actionLabel: 'Review AI redaction', message: 'Compare the AI draft with the original narrative, fix anything it missed, then approve it.' };
  } else if (finalize === 'ready') {
    next = { stageKey: 'finalize', actionLabel: 'Go to the finalize form', message: 'Check the parties and summary, then finalize to record the entry and assign its blotter number.' };
  } else {
    next = { stageKey: 'packet', actionLabel: null, message: 'This blotter entry is finalized. Generate a Lupon packet only if the case is referred for conciliation. To correct the entry, use “Amend this entry”.' };
  }

  return { stages, next };
}

/**
 * @param {{
 *   state: ReturnType<typeof getBlotterWorkflowState>,
 *   activeTab: 'incident'|'redaction'|'blotter',
 *   onNavigate: (tab: string, anchor: string) => void,
 * }} options
 * @returns {HTMLElement}
 */
export function BlotterWorkflow({ state, activeTab, onNavigate }) {
  const section = document.createElement('section');
  section.className = 'card blotter-flow';
  section.setAttribute('aria-label', 'Blotter workflow progress');

  const heading = document.createElement('h3');
  heading.className = 'blotter-flow__heading';
  heading.textContent = 'Blotter workflow';
  section.appendChild(heading);

  const list = document.createElement('ol');
  list.className = 'blotter-flow__steps';

  const currentKey = state.next.stageKey;
  state.stages.forEach((stage, index) => {
    const item = document.createElement('li');
    item.className = `blotter-flow__step blotter-flow__step--${stage.status}`;
    if (stage.key === currentKey && stage.status !== 'available') {
      item.classList.add('blotter-flow__step--current');
      item.setAttribute('aria-current', 'step');
    }

    const marker = document.createElement('span');
    marker.className = 'blotter-flow__marker';
    marker.setAttribute('aria-hidden', 'true');
    if (stage.status === 'done') marker.innerHTML = icons.check(14);
    else if (stage.status === 'running') marker.innerHTML = `<span class="is-spinning">${icons.repeat(14)}</span>`;
    else if (stage.status === 'attention' || stage.status === 'failed') marker.innerHTML = icons.alertCircle(14);
    else if (stage.status === 'blocked') marker.innerHTML = icons.lock(12);
    else marker.textContent = String(index + 1);

    const body = document.createElement('span');
    body.className = 'blotter-flow__body';

    const title = document.createElement('span');
    title.className = 'blotter-flow__title';
    title.textContent = stage.title;

    const tag = document.createElement('span');
    tag.className = `blotter-flow__tag blotter-flow__tag--${stage.status}`;
    tag.textContent = STATUS_TEXT[stage.status];

    const where = document.createElement('span');
    where.className = 'blotter-flow__where';
    where.textContent = stage.tab === 'redaction' ? 'Redaction tab' : 'Blotter tab';

    body.append(title, tag, where);
    item.append(marker, body);
    list.appendChild(item);
  });
  section.appendChild(list);

  const next = document.createElement('div');
  next.className = 'blotter-flow__next';
  next.setAttribute('role', 'status');

  const nextText = document.createElement('p');
  nextText.className = 'blotter-flow__next-text';
  const strong = document.createElement('strong');
  strong.textContent = 'Next step: ';
  nextText.append(strong, document.createTextNode(state.next.message));
  next.appendChild(nextText);

  const currentStage = state.stages.find((s) => s.key === currentKey);
  if (state.next.actionLabel && currentStage) {
    const button = document.createElement('button');
    button.type = 'button';
    button.className = 'primary blotter-flow__next-btn';
    button.innerHTML = `<span></span> ${icons.arrowRight(16)}`;
    button.querySelector('span').textContent = state.next.actionLabel;
    button.addEventListener('click', () => onNavigate(currentStage.tab, currentStage.anchor));
    next.appendChild(button);
  }
  section.appendChild(next);

  return section;
}

/**
 * Generate the Lupon packet and download it in one action. It used to be
 * two buttons (Generate, then a second Download that appeared afterwards),
 * duplicated on W7 and W8 — the second step was easy to miss entirely.
 * Download goes through an authenticated fetch()->Blob because the API
 * is Bearer-token only (no browser-navigable URL).
 *
 * @param {number} incidentId
 * @param {HTMLButtonElement} button
 */
export async function generateAndDownloadLuponPacket(incidentId, button) {
  const originalHtml = button.innerHTML;
  button.disabled = true;
  button.textContent = 'Preparing packet…';
  try {
    await generateLuponPacket(incidentId);
    const blob = await downloadLuponPacket(incidentId);
    const blobUrl = URL.createObjectURL(blob);
    const link = document.createElement('a');
    link.href = blobUrl;
    link.download = `lupon-packet-incident-${incidentId}.pdf`;
    document.body.appendChild(link);
    link.click();
    link.remove();
    URL.revokeObjectURL(blobUrl);
    showToast('Lupon packet generated and downloaded.', { variant: 'success' });
  } catch (err) {
    showToast(err instanceof ApiClientError ? err.message : 'Could not prepare the Lupon packet.', { variant: 'error' });
  } finally {
    button.disabled = false;
    button.innerHTML = originalHtml;
  }
}
