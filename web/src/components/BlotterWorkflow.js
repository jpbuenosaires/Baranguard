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
import { TERMINAL_INCIDENT_STATUSES } from '../utils/blotterStatus.js';

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

const INCIDENT_STATUS_TAG = {
  pending: 'Pending',
  dispatched: 'Dispatched',
  resolved: 'Resolved',
  cancelled: 'Cancelled',
  invalid: 'Invalid',
  duplicate: 'Duplicate',
  reopened: 'Reopened',
};

/**
 * @param {{incident: object, draft?: object|null, blotter?: object|null, edited?: boolean}} input
 * @returns {{closed?: boolean, stages: Array<{key:string,tab:string,title:string,anchor:string|null,status:string,tag:string,secretaryOnly?:boolean}>, next: {message:string, actionLabel:string|null, stageKey:string|null, tab:string|null, anchor:string|null}}}
 */
export function getBlotterWorkflowState({ incident, draft = null, blotter = null, edited = false }) {
  const approved = Boolean(incident?.redactionApprovedAt);
  const finalized = Boolean(blotter?.finalizedAt);
  const isClosedWithoutBlotter = !finalized && TERMINAL_INCIDENT_STATUSES.includes(incident?.status);

  const incidentTag = INCIDENT_STATUS_TAG[incident?.status] || 'Logged';

  const draftStatus = draft?.status ?? null;
  const draftPending = draftStatus === 'queued' || draftStatus === 'processing';
  const draftDone = draftStatus === 'completed';
  const summaryOutOfDate = Boolean(draft?.draftSummaryStale) || edited;

  let redactionStatus;
  let redactionTag;
  let redactionAnchor = 'ai-review-actions';
  if (approved) {
    redactionStatus = 'done';
    redactionTag = 'Approved';
  } else if (draftPending) {
    redactionStatus = 'running';
    redactionTag = 'In progress';
    redactionAnchor = 'ai-review-start';
  } else if (draftStatus === 'failed') {
    redactionStatus = 'failed';
    redactionTag = 'Failed';
    redactionAnchor = 'ai-review-start';
  } else if (draftDone && summaryOutOfDate) {
    redactionStatus = 'attention';
    redactionTag = 'Summary out of date';
  } else if (draftDone) {
    redactionStatus = 'ready';
    redactionTag = 'Ready to review';
  } else {
    redactionStatus = 'todo';
    redactionTag = 'Not started';
    redactionAnchor = 'ai-review-start';
  }

  let blotterStatus;
  let blotterTag;
  let blotterAnchor = 'blotter-finalize';
  if (finalized) {
    blotterStatus = 'done';
    blotterTag = 'Finalized';
    blotterAnchor = 'blotter-packet';
  } else if (isClosedWithoutBlotter) {
    blotterStatus = 'blocked';
    blotterTag = 'No blotter needed';
  } else if (approved) {
    blotterStatus = 'ready';
    blotterTag = 'Ready to finalize';
  } else {
    blotterStatus = 'blocked';
    blotterTag = STATUS_TEXT.blocked;
  }

  const stages = [
    { key: 'incident', tab: 'incident', title: 'Incident', anchor: null, status: 'done', tag: incidentTag },
    { key: 'redaction', tab: 'redaction', title: 'Redaction', anchor: redactionAnchor, status: redactionStatus, tag: redactionTag, secretaryOnly: true },
    { key: 'blotter', tab: 'blotter', title: 'Blotter', anchor: blotterAnchor, status: blotterStatus, tag: blotterTag },
  ];

  if (isClosedWithoutBlotter) {
    return {
      closed: true,
      stages,
      next: {
        stageKey: null,
        tab: null,
        anchor: null,
        actionLabel: null,
        message: 'This incident was closed without becoming a blotter entry. No further blotter action is needed.',
      },
    };
  }

  let next;
  if (redactionStatus === 'todo') {
    next = {
      stageKey: 'redaction',
      tab: 'redaction',
      anchor: 'ai-review-start',
      actionLabel: 'Run AI redaction',
      message: 'Run the AI redaction to draft a copy of the narrative with personal names, phone numbers, and addresses removed.',
    };
  } else if (redactionStatus === 'running') {
    next = {
      stageKey: 'redaction',
      tab: 'redaction',
      anchor: 'ai-review-start',
      actionLabel: 'View progress',
      message: 'The AI is drafting the redaction in the background. You can stay here or come back when it finishes.',
    };
  } else if (redactionStatus === 'failed') {
    next = {
      stageKey: 'redaction',
      tab: 'redaction',
      anchor: 'ai-review-start',
      actionLabel: 'Retry AI redaction',
      message: 'The AI redaction failed. Run it again; if it keeps failing, check the AI badge in the top bar.',
    };
  } else if (redactionStatus === 'attention') {
    next = {
      stageKey: 'redaction',
      tab: 'redaction',
      anchor: 'ai-review-actions',
      actionLabel: 'Review AI redaction',
      message: 'The draft changed, so the AI summary is out of date. Regenerate the summary, then approve.',
    };
  } else if (redactionStatus === 'ready') {
    next = {
      stageKey: 'redaction',
      tab: 'redaction',
      anchor: 'ai-review-actions',
      actionLabel: 'Review AI redaction',
      message: 'Compare the AI draft with the original narrative, fix anything it missed, then approve it.',
    };
  } else if (blotterStatus === 'ready') {
    next = {
      stageKey: 'blotter',
      tab: 'blotter',
      anchor: 'blotter-finalize',
      actionLabel: 'Go to the finalize form',
      message: 'Check the parties and summary, then finalize to record the entry and assign its blotter number.',
    };
  } else {
    next = {
      stageKey: 'blotter',
      tab: 'blotter',
      anchor: 'blotter-packet',
      actionLabel: null,
      message: 'Blotter entry finalized. Generate a Lupon packet on the Blotter tab if referred for conciliation, or use “Amend this entry” to make a correction.',
    };
  }

  return { stages, next };
}

/**
 * Combined Stepped Tab Bar + Contextual Next-Step Banner.
 * Replaces the separate 4-card progress tracker and 3-button tab bar with
 * a single, cohesive navigation header.
 *
 * @param {{
 *   state: ReturnType<typeof getBlotterWorkflowState>,
 *   activeTab: 'incident'|'redaction'|'blotter',
 *   onNavigate: (tab: string, anchor?: string) => void,
 *   isSecretary?: boolean,
 * }} options
 * @returns {HTMLElement}
 */
export function BlotterWorkflow({ state, activeTab, onNavigate, isSecretary = true }) {
  const section = document.createElement('nav');
  section.className = 'card blotter-flow';
  section.setAttribute('aria-label', 'Case workspace steps');

  const visibleStages = state.stages.filter((stage) => !stage.secretaryOnly || isSecretary);
  const list = document.createElement('div');
  list.className = 'blotter-flow__steps';
  list.setAttribute('role', 'tablist');

  const currentKey = state.next.stageKey;
  visibleStages.forEach((stage, index) => {
    const isActive = stage.tab === activeTab;
    const isCurrentStep = isSecretary && !state.closed && stage.key === currentKey;

    const btn = document.createElement('button');
    btn.type = 'button';
    btn.setAttribute('role', 'tab');
    btn.setAttribute('aria-selected', isActive ? 'true' : 'false');
    btn.setAttribute('aria-label', stage.title);
    btn.className = `page-tab blotter-flow__step blotter-flow__step--${stage.status}`;
    if (isActive) btn.classList.add('is-active');
    if (isCurrentStep) {
      btn.classList.add('blotter-flow__step--current');
      btn.setAttribute('aria-current', 'step');
    }

    const marker = document.createElement('span');
    marker.className = 'blotter-flow__marker';
    marker.setAttribute('aria-hidden', 'true');
    if (!isSecretary) {
      marker.innerHTML = stage.tab === 'incident' ? icons.fileText(14) : icons.shield(14);
    } else if (stage.status === 'done') {
      marker.innerHTML = icons.check(13);
    } else if (stage.status === 'running') {
      marker.innerHTML = `<span class="is-spinning">${icons.repeat(13)}</span>`;
    } else if (stage.status === 'attention' || stage.status === 'failed') {
      marker.innerHTML = icons.alertCircle(13);
    } else if (stage.status === 'blocked') {
      marker.innerHTML = icons.lock(12);
    } else {
      marker.textContent = String(index + 1);
    }

    const body = document.createElement('span');
    body.className = 'blotter-flow__body';

    const title = document.createElement('span');
    title.className = 'blotter-flow__title';
    title.textContent = isSecretary ? `${index + 1}. ${stage.title}` : stage.title;

    const tag = document.createElement('span');
    tag.className = `blotter-flow__tag blotter-flow__tag--${stage.status}`;
    tag.textContent = (!isSecretary && stage.key === 'blotter')
      ? (stage.status === 'done' ? 'Recorded' : 'Pending')
      : stage.tag;

    body.append(title, tag);
    btn.append(marker, body);
    btn.addEventListener('click', () => onNavigate(stage.tab));
    list.appendChild(btn);
  });
  section.appendChild(list);

  if (!isSecretary) {
    return section;
  }

  const next = document.createElement('div');
  next.className = 'blotter-flow__next';
  next.setAttribute('role', 'status');

  const nextText = document.createElement('p');
  nextText.className = 'blotter-flow__next-text';
  const strong = document.createElement('strong');
  strong.textContent = state.closed ? 'Closed — no blotter: ' : 'Next step: ';
  nextText.append(strong, document.createTextNode(state.next.message));
  next.appendChild(nextText);

  // Only show the navigation CTA button if the user is NOT already on the target tab.
  if (state.next.actionLabel && state.next.tab && state.next.tab !== activeTab) {
    const button = document.createElement('button');
    button.type = 'button';
    button.className = 'primary blotter-flow__next-btn';
    button.innerHTML = `<span></span> ${icons.arrowRight(15)}`;
    button.querySelector('span').textContent = state.next.actionLabel;
    button.addEventListener('click', () => onNavigate(state.next.tab, state.next.anchor));
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
