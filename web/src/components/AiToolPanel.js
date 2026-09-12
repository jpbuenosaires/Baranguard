import { icons } from './icons.js';
import { showToast } from './Toast.js';
import { getAiToolsAvailability, getAiToolJob, ApiClientError } from '../api/apiClient.js';

/**
 * AiToolPanel — one local-AI assistant, mounted inside the screen where
 * that work actually happens.
 *
 * REPLACES THE STANDALONE AI TOOLS SCREEN (2026-09-10). Four assistants
 * in a rail made every tool a detour: an operator is mid-task and wants
 * help with *that* task, not a trip to an "AI" menu. Each tool now lives
 * in its host screen — Classifier in Incident Management, Blotter
 * Assistant in incident detail, SMS Composer in SMS Monitor, Threat
 * Analyzer in Analytics. Their role gates already matched those screens
 * exactly, which is the clearest sign this is where they belonged.
 *
 * Everything generic lives here so four hosts cannot grow four divergent
 * copies — the same mistake `escapeHtml`, the tab bar and the filter chip
 * each made before the 2026-09-06 audit consolidated them.
 *
 * ASYNCHRONOUS BY DESIGN. §2 Rule 5: the API never calls Ollama, it only
 * enqueues. Generate returns a job id and this polls it.
 *
 * TWO THINGS A HOST MUST DO:
 *   1. **Call `stop()` before discarding the panel's DOM.** Wiping
 *      `innerHTML` does NOT clear a `setInterval`. Incident Management
 *      rebuilds its detail pane on every row click, so a host that
 *      forgets this leaks one poll timer per click.
 *   2. Chain `stop()` into the page's own stop handle, which the router
 *      already calls on navigation.
 *
 * Model output is rendered with `textContent`, never interpolated into
 * `innerHTML` — that invariant lives in here on purpose, so no host can
 * regress it (see docs/REMAINING.md F2/F3 for what that class of bug
 * cost elsewhere in this app).
 */

const POLL_INTERVAL_MS = 3000;

/**
 * Availability is cached at MODULE level, deliberately.
 *
 * Incident Management wipes and rebuilds its detail pane on every row
 * click, which remounts this panel. Without a cache, clicking through ten
 * incidents fires ten `GET /ai-tools/availability` calls, each of which
 * takes seconds to time out when the model is unreachable — which is this
 * workstation's normal state (docs/REMAINING.md A2). In-flight sharing
 * matters for the same reason: two panels mounting together must not race
 * two probes.
 */
const AVAILABILITY_TTL_MS = 60000;
let availabilityCache = null; // { value, at }
let availabilityInFlight = null;

async function probeAvailability() {
  const now = Date.now();
  if (availabilityCache && now - availabilityCache.at < AVAILABILITY_TTL_MS) {
    return availabilityCache.value;
  }
  if (availabilityInFlight) return availabilityInFlight;

  availabilityInFlight = (async () => {
    let value;
    try {
      const { ollama } = await getAiToolsAvailability();
      value = ollama;
    } catch {
      // Treat an unreachable probe as unavailable rather than assuming
      // the model is fine — guessing "healthy" produces a button that
      // silently does nothing, which is the failure §2 Rule 6 is about.
      value = 'unhealthy';
    }
    availabilityCache = { value, at: Date.now() };
    availabilityInFlight = null;
    return value;
  })();

  return availabilityInFlight;
}

const STATUS_PILL_CLASS = {
  queued: 'status-pill--pending',
  processing: 'status-pill--info',
  completed: 'status-pill--success',
  failed: 'status-pill--critical',
};

/**
 * Worker failure codes in operator language. Codes are globally unique
 * across tools, so one shared map is simpler than four; an unmapped code
 * falls through to the raw code rather than a generic "something went
 * wrong", because a code the operator can quote is worth more than a
 * sentence that hides it.
 */
const ERROR_TEXT = {
  INCIDENT_MISSING: 'That incident no longer exists.',
  INCIDENT_MISSING_RAW: 'That incident has no narrative to work from.',
  CLASSIFICATION_NOT_APPROVED: 'That incident has no approved redaction yet, so there is nothing safe to classify.',
  THREAT_ANALYSIS_NO_DATA: 'No incidents were recorded in the last 90 days, so there is no pattern to report.',
  TOOL_INPUT_MISSING: 'The prompt was not saved with the job.',
  OLLAMA_ERROR: 'The local AI model returned an error.',
  WORKER_ERROR: 'The AI worker failed while running this job.',
};

let instanceSeq = 0;

/**
 * @param {object} options
 * @param {object} options.tool          per-tool config (see below)
 * @param {boolean} [options.collapsible]
 * @param {boolean} [options.startCollapsed]
 * @param {Array<{label:string, onClick:(output:string, job:object)=>void}>} [options.footerActions]
 *        Extra actions shown beside Copy once a draft is ready.
 * @param {(output:string, job:object)=>void} [options.onResult]
 *        Fired every time a job reaches `completed`, manual or auto-run —
 *        for a host that needs to react without waiting on a footer click
 *        (e.g. comparing a suggestion against what is already on record).
 * @returns {{el: HTMLElement, stop: () => void}}
 *
 * `tool` carries only what genuinely varies:
 *   { label, hint, input:'text'|'incident'|'none', inputLabel, placeholder,
 *     maxLength, emptyText, run(value) -> Promise<{jobId}>,
 *     autoRun?: boolean }
 *
 * `autoRun` (input:'none' tools only) queues the job as soon as the
 * model is known to be available, instead of waiting for the operator to
 * press Generate — for a check the host wants to run quietly and only
 * surface if the result disagrees with something already on record. The
 * completion toast is suppressed for an auto-started job specifically
 * because nobody asked for it; `onResult` still fires so the host can
 * decide what, if anything, to show.
 */
export function AiToolPanel({ tool, collapsible = false, startCollapsed = false, footerActions = [], onResult }) {
  // Unique per instance: the id is referenced by the label's `htmlFor`,
  // and a hardcoded one breaks the moment two panels share a document.
  const inputId = `ai-tool-input-${++instanceSeq}`;

  let availability = null; // null = still probing
  let job = null;
  let errorMessage = null;
  let busy = false;
  let value = '';
  let collapsed = collapsible && startCollapsed;
  let pollTimer = null;
  let destroyed = false;

  const el = document.createElement('section');
  el.className = 'ai-panel card';

  const head = document.createElement('div');
  head.className = 'ai-panel__head';

  const bodyEl = document.createElement('div');
  el.appendChild(head);
  el.appendChild(bodyEl);

  // ----- header (collapsible or plain) --------------------------------

  if (collapsible) {
    // The toggle button is the ONLY interactive element and carries
    // `aria-expanded` itself. gis-live-tracking.js wraps its header in a
    // second `role="button" tabindex="0"` with its own keydown handler;
    // that nests a button inside a button and relies on preventDefault to
    // stop a double toggle. Not copied.
    const toggle = document.createElement('button');
    toggle.type = 'button';
    toggle.className = 'ai-panel__toggle';
    toggle.setAttribute('aria-expanded', String(!collapsed));

    const chevron = document.createElement('span');
    chevron.className = 'ai-panel__chevron';
    chevron.setAttribute('aria-hidden', 'true');
    chevron.innerHTML = icons.chevronDown(16);

    const sparkle = document.createElement('span');
    sparkle.className = 'ai-panel__icon';
    sparkle.setAttribute('aria-hidden', 'true');
    sparkle.innerHTML = icons.sparkles(16);

    const titleEl = document.createElement('span');
    titleEl.className = 'ai-panel__title';
    titleEl.textContent = tool.label;

    toggle.appendChild(sparkle);
    toggle.appendChild(titleEl);
    toggle.appendChild(chevron);
    toggle.addEventListener('click', () => {
      collapsed = !collapsed;
      toggle.setAttribute('aria-expanded', String(!collapsed));
      el.classList.toggle('is-collapsed', collapsed);
    });
    head.appendChild(toggle);
    el.classList.toggle('is-collapsed', collapsed);
  } else {
    const titleWrap = document.createElement('div');
    titleWrap.className = 'ai-panel__title-wrap';
    const sparkle = document.createElement('span');
    sparkle.className = 'ai-panel__icon';
    sparkle.setAttribute('aria-hidden', 'true');
    sparkle.innerHTML = icons.sparkles(16);
    const titleEl = document.createElement('h3');
    titleEl.className = 'ai-panel__title';
    titleEl.textContent = tool.label;
    titleWrap.appendChild(sparkle);
    titleWrap.appendChild(titleEl);
    head.appendChild(titleWrap);
  }

  // ----- helpers ------------------------------------------------------

  let jobStartedAt = null;
  let elapsedTimer = null;

  function formatElapsed(ms) {
    const totalSec = Math.floor(ms / 1000);
    if (totalSec < 60) return `${totalSec}s`;
    const min = Math.floor(totalSec / 60);
    const sec = totalSec % 60;
    return `${min}m ${sec}s`;
  }

  function startElapsedTimer() {
    stopElapsedTimer();
    elapsedTimer = setInterval(() => {
      const timerEl = el.querySelector('.ai-panel__timer');
      if (timerEl && jobStartedAt) {
        timerEl.textContent = `· ${formatElapsed(Date.now() - jobStartedAt)}`;
      }
    }, 1000);
  }

  function stopElapsedTimer() {
    if (elapsedTimer !== null) {
      clearInterval(elapsedTimer);
      elapsedTimer = null;
    }
  }

  function isPending(j) {
    return j !== null && (j.status === 'queued' || j.status === 'processing');
  }

  function canGenerate() {
    if (tool.disabled) return false;
    return availability === 'healthy';
  }

  function stop() {
    stopElapsedTimer();
    if (pollTimer !== null) {
      clearInterval(pollTimer);
      pollTimer = null;
    }
  }

  // An auto-started job is a quiet background check, not something the
  // operator asked for — its completion toast is suppressed below, but
  // `onResult` still fires either way.
  let isAutoRun = false;

  async function runNow(rawValue, { auto = false } = {}) {
    isAutoRun = auto;
    busy = true;
    errorMessage = null;
    job = null;
    jobStartedAt = Date.now();
    render();
    try {
      const queued = await tool.run(rawValue);
      job = { ...queued, output: null, errorCode: null };
      startPollingIfPending();
    } catch (err) {
      errorMessage = err instanceof ApiClientError ? err.message : 'Could not start the job.';
      jobStartedAt = null;
    } finally {
      busy = false;
      render();
    }
  }

  function buildStatusLine(status, text) {
    const line = document.createElement('div');
    line.className = 'ai-panel__status';
    const pill = document.createElement('span');
    pill.className = `status-pill ${STATUS_PILL_CLASS[status] ?? 'status-pill--neutral'}`;
    pill.textContent = status;
    const label = document.createElement('span');
    label.textContent = text;
    line.appendChild(pill);
    line.appendChild(label);

    if (isPending(job) && jobStartedAt) {
      const timer = document.createElement('span');
      timer.className = 'ai-panel__timer';
      timer.textContent = `· ${formatElapsed(Date.now() - jobStartedAt)}`;
      line.appendChild(timer);
    }
    return line;
  }

  function buildBanner() {
    if (tool.disabled) {
      const banner = document.createElement('p');
      banner.className = 'ai-panel__banner ai-panel__banner--neutral';
      banner.setAttribute('role', 'status');
      const strong = document.createElement('strong');
      strong.textContent = tool.disabledTitle || 'Prerequisite not met.';
      const detail = document.createElement('span');
      detail.textContent = ` ${tool.disabledReason || 'This action is unavailable until required steps are completed.'}`;
      banner.append(strong, detail);
      return banner;
    }

    if (availability === null || availability === 'healthy') return null;

    const banner = document.createElement('p');
    banner.className = 'ai-panel__banner';
    banner.setAttribute('role', 'status');
    if (availability === 'not_configured') banner.classList.add('ai-panel__banner--neutral');

    const strong = document.createElement('strong');
    strong.textContent = availability === 'not_configured'
      ? 'No AI model is configured on this workstation.'
      : 'The local AI model is not responding.';
    const detail = document.createElement('span');
    detail.textContent = availability === 'not_configured'
      ? ' These tools need a local Ollama model. There is no cloud fallback by design.'
      : ' Generating is disabled until it responds. Nothing is queued in the meantime.';

    banner.appendChild(strong);
    banner.appendChild(detail);
    return banner;
  }

  function buildStructuredClassifier(output) {
    const lines = output.split('\n');
    let typeVal = null;
    let prioVal = null;
    let reasonVal = null;
    for (const line of lines) {
      const tMatch = line.match(/^Type:\s*(.+)$/i);
      if (tMatch) typeVal = tMatch[1].trim();
      const pMatch = line.match(/^Priority:\s*(.+)$/i);
      if (pMatch) prioVal = pMatch[1].trim();
      const rMatch = line.match(/^Reasoning:\s*(.+)$/i);
      if (rMatch) reasonVal = rMatch[1].trim();
    }
    if (!typeVal && !prioVal) return null;

    const card = document.createElement('div');
    card.className = 'ai-panel__structured';

    const header = document.createElement('div');
    header.className = 'ai-panel__structured-header';

    const pills = document.createElement('div');
    pills.className = 'ai-panel__structured-pills';

    if (typeVal) {
      const typePill = document.createElement('span');
      typePill.className = 'status-pill status-pill--info';
      typePill.textContent = `Type: ${typeVal.replace(/_/g, ' ')}`;
      pills.appendChild(typePill);
    }

    if (prioVal) {
      const p = prioVal.toLowerCase();
      const prioPill = document.createElement('span');
      const pClass = p === 'critical' ? 'status-pill--critical' : p === 'high' ? 'status-pill--pending' : 'status-pill--info';
      prioPill.className = `status-pill ${pClass}`;
      prioPill.textContent = `Priority: ${prioVal}`;
      pills.appendChild(prioPill);
    }
    header.appendChild(pills);
    card.appendChild(header);

    if (reasonVal) {
      const sec = document.createElement('div');
      sec.className = 'ai-panel__structured-section';
      const title = document.createElement('span');
      title.className = 'ai-panel__structured-section-title';
      title.textContent = 'Assessment Reasoning';
      const quote = document.createElement('p');
      quote.className = 'ai-panel__structured-quote';
      quote.textContent = reasonVal;
      sec.append(title, quote);
      card.appendChild(sec);
    }

    return card;
  }

  // ----- render -------------------------------------------------------

  function render() {
    if (destroyed) return;
    bodyEl.innerHTML = '';
    bodyEl.className = 'ai-panel__body';

    if (tool.hint) {
      const hint = document.createElement('p');
      hint.className = 'ai-panel__hint';
      hint.textContent = tool.hint;
      bodyEl.appendChild(hint);
    }

    const banner = buildBanner();
    if (banner) bodyEl.appendChild(banner);

    // If still probing availability, show clean skeleton loading
    if (availability === null && !tool.disabled) {
      const skeletonWrap = document.createElement('div');
      skeletonWrap.className = 'ai-panel__skeleton-wrap';
      skeletonWrap.setAttribute('role', 'status');
      skeletonWrap.setAttribute('aria-label', 'Checking AI model availability…');
      const sLine = document.createElement('div');
      sLine.className = 'skeleton skeleton--line';
      sLine.style.width = '70%';
      const sBlock = document.createElement('div');
      sBlock.className = 'skeleton skeleton--block';
      sBlock.style.height = '2.75rem';
      skeletonWrap.append(sLine, sBlock);
      bodyEl.appendChild(skeletonWrap);
      return;
    }

    // --- form ---
    const form = document.createElement('form');
    form.className = 'ai-panel__form';

    if (tool.input !== 'none') {
      const label = document.createElement('label');
      label.className = 'ai-panel__label';
      label.htmlFor = inputId;
      label.textContent = tool.inputLabel;
      form.appendChild(label);

      let field;
      if (tool.input === 'text') {
        field = document.createElement('textarea');
        field.rows = 3;
        field.className = 'textarea--resizable';
        if (tool.maxLength) field.maxLength = tool.maxLength;
      } else {
        field = document.createElement('input');
        field.type = 'number';
        field.min = '1';
        field.step = '1';
      }
      field.id = inputId;
      field.value = value;
      if (tool.placeholder) field.placeholder = tool.placeholder;
      field.addEventListener('input', () => { value = field.value; });
      form.appendChild(field);
    }

    const actions = document.createElement('div');
    actions.className = 'ai-panel__actions';
    const generate = document.createElement('button');
    generate.type = 'submit';
    generate.className = 'primary';
    generate.innerHTML = `${icons.sparkles(16)} <span>Generate</span>`;
    generate.disabled = busy || isPending(job) || !canGenerate();
    if (!canGenerate()) {
      generate.title = tool.disabled
        ? (tool.disabledReason || 'Prerequisite not met.')
        : availability === null
          ? 'Checking whether the local AI model is available…'
          : availability === 'not_configured'
            ? 'No AI model is configured on this workstation.'
            : 'The local AI model is not responding.';
    }
    actions.appendChild(generate);
    form.appendChild(actions);

    form.addEventListener('submit', async (event) => {
      event.preventDefault();
      if (!canGenerate() || busy) return;

      const raw = tool.input === 'none' ? '' : value.trim();
      if (tool.input !== 'none' && raw === '') {
        showToast(`${tool.inputLabel} is required.`, { variant: 'error' });
        return;
      }

      await runNow(raw);
    });

    bodyEl.appendChild(form);

    // --- result ---
    const result = document.createElement('div');
    result.className = 'ai-panel__result';

    if (errorMessage !== null) {
      result.classList.add('ai-panel__result--error');
      const msg = document.createElement('p');
      msg.className = 'ai-panel__message';
      msg.setAttribute('role', 'alert');
      msg.textContent = errorMessage;
      result.appendChild(msg);
    } else if (busy) {
      result.appendChild(buildStatusLine('queued', 'Starting…'));
    } else if (job === null) {
      const empty = document.createElement('p');
      empty.className = 'ai-panel__empty';
      if (availability === null) {
        empty.textContent = 'Checking whether the local AI model is available…';
      } else if (canGenerate()) {
        empty.textContent = tool.emptyText ?? 'Nothing generated yet.';
      } else {
        empty.textContent = tool.disabled
          ? (tool.disabledReason || 'Prerequisite not met.')
          : 'Generating is unavailable — see the notice above.';
      }
      result.appendChild(empty);
    } else if (isPending(job)) {
      result.appendChild(buildStatusLine(
        job.status,
        job.status === 'queued' ? 'Queued. The local model runs one job at a time.' : 'Running…'
      ));
    } else if (job.status === 'failed') {
      if (job.errorCode === 'THREAT_ANALYSIS_NO_DATA') {
        // Honest neutral empty state rather than error alert for zero incidents
        const neutralCard = document.createElement('div');
        neutralCard.className = 'ai-panel__result--neutral';

        const statusLine = document.createElement('div');
        statusLine.className = 'ai-panel__status';
        const pill = document.createElement('span');
        pill.className = 'status-pill status-pill--info';
        pill.textContent = 'No Incidents';
        const label = document.createElement('span');
        label.textContent = 'Zero incidents recorded in this timeframe';
        statusLine.append(pill, label);

        const neutralBody = document.createElement('div');
        neutralBody.className = 'ai-panel__neutral-card';
        const iconSpan = document.createElement('span');
        iconSpan.className = 'ai-panel__neutral-icon';
        iconSpan.innerHTML = icons.info(18);
        const text = document.createElement('p');
        text.className = 'ai-panel__message';
        text.textContent = 'No incidents were recorded in the selected period. This indicates a quiet period with no recorded patterns to analyze.';
        neutralBody.append(iconSpan, text);

        neutralCard.append(statusLine, neutralBody);
        result.appendChild(neutralCard);
      } else {
        result.classList.add('ai-panel__result--error');
        result.appendChild(buildStatusLine('failed', 'Failed'));
        const msg = document.createElement('p');
        msg.className = 'ai-panel__message';
        msg.setAttribute('role', 'alert');
        msg.textContent = ERROR_TEXT[job.errorCode] ?? `The job failed (${job.errorCode ?? 'no code reported'}).`;
        result.appendChild(msg);
      }
    } else {
      result.appendChild(buildStatusLine('completed', 'Draft ready'));

      // If classifier, show clean structured presentation first
      const structuredView = buildStructuredClassifier(job.output ?? '');
      if (structuredView) {
        result.appendChild(structuredView);
      } else {
        const output = document.createElement('pre');
        output.className = 'ai-panel__output';
        output.textContent = job.output ?? '';
        result.appendChild(output);
      }

      // Metadata line: word & character counts + SMS segment if applicable
      const metaLine = document.createElement('div');
      metaLine.className = 'ai-panel__meta-line';
      const outputText = job.output ?? '';
      const chars = outputText.length;
      const words = outputText.trim().split(/\s+/).filter(Boolean).length;
      let metaText = `${chars} chars · ${words} words`;
      if (tool.isSms || tool.label === 'AI Message Composer') {
        const segs = Math.ceil(chars / 160) || 1;
        metaText += ` · ${segs} SMS ${segs === 1 ? 'segment' : 'segments'}`;
      }
      metaLine.textContent = metaText;
      result.appendChild(metaLine);

      const footer = document.createElement('div');
      footer.className = 'ai-panel__footer';

      for (const action of footerActions) {
        const btn = document.createElement('button');
        btn.type = 'button';
        btn.className = 'ghost';
        btn.textContent = action.label;
        btn.addEventListener('click', () => action.onClick(job.output ?? '', job));
        footer.appendChild(btn);
      }

      const copy = document.createElement('button');
      copy.type = 'button';
      copy.className = 'ghost';
      copy.innerHTML = `${icons.copy(16)} <span>Copy</span>`;
      copy.addEventListener('click', async () => {
        try {
          await navigator.clipboard.writeText(job.output ?? '');
          showToast('Draft copied.', { variant: 'success' });
        } catch {
          showToast('Could not copy — select the text and copy it manually.', { variant: 'error' });
        }
      });
      footer.appendChild(copy);

      // Built-in Regenerate Action
      const regenBtn = document.createElement('button');
      regenBtn.type = 'button';
      regenBtn.className = 'ghost';
      regenBtn.innerHTML = `${icons.repeat(14)} <span>Regenerate</span>`;
      regenBtn.disabled = busy || isPending(job) || !canGenerate();
      regenBtn.addEventListener('click', () => {
        form.dispatchEvent(new Event('submit', { cancelable: true, bubbles: true }));
      });
      footer.appendChild(regenBtn);

      if (job.modelVersion) {
        const model = document.createElement('span');
        model.className = 'ai-panel__model';
        model.textContent = `Model: ${job.modelVersion}`;
        footer.appendChild(model);
      }

      result.appendChild(footer);
    }

    bodyEl.appendChild(result);
  }

  // ----- polling ------------------------------------------------------

  function startPollingIfPending() {
    stop();
    if (!isPending(job)) return;
    if (!jobStartedAt) jobStartedAt = Date.now();
    startElapsedTimer();

    pollTimer = setInterval(async () => {
      try {
        const fresh = await getAiToolJob(job.jobId);
        const wasPending = isPending(job);
        job = fresh;
        if (!isPending(fresh)) {
          stop();
          if (wasPending && !isAutoRun) {
            showToast(
              fresh.status === 'completed' ? 'Draft is ready.' : 'The AI job failed.',
              { variant: fresh.status === 'completed' ? 'success' : 'error' }
            );
          }
          if (wasPending && fresh.status === 'completed' && typeof onResult === 'function') {
            onResult(fresh.output ?? '', fresh);
          }
        }
        render();
      } catch {
        // A transient poll failure must not blank a populated panel —
        // same contract ai-review.js's loop keeps.
      }
    }, POLL_INTERVAL_MS);
  }

  // ----- boot ---------------------------------------------------------

  render();
  probeAvailability().then((value_) => {
    if (destroyed) return;
    availability = value_;
    render();
    if (tool.autoRun && tool.input === 'none' && job === null && !busy && canGenerate()) {
      runNow('', { auto: true });
    }
  });

  return {
    el,
    stop() {
      destroyed = true;
      stop();
    },
  };
}
