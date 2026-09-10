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
 * @returns {{el: HTMLElement, stop: () => void}}
 *
 * `tool` carries only what genuinely varies:
 *   { label, hint, input:'text'|'incident'|'none', inputLabel, placeholder,
 *     maxLength, emptyText, run(value) -> Promise<{jobId}> }
 */
export function AiToolPanel({ tool, collapsible = false, startCollapsed = false, footerActions = [] }) {
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

  function isPending(j) {
    return j !== null && (j.status === 'queued' || j.status === 'processing');
  }

  function canGenerate() {
    return availability === 'healthy';
  }

  function stop() {
    if (pollTimer !== null) {
      clearInterval(pollTimer);
      pollTimer = null;
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
    return line;
  }

  function buildBanner() {
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
      generate.title = availability === null
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

      busy = true;
      errorMessage = null;
      job = null;
      render();
      try {
        const queued = await tool.run(raw);
        job = { ...queued, output: null, errorCode: null };
        startPollingIfPending();
      } catch (err) {
        errorMessage = err instanceof ApiClientError ? err.message : 'Could not start the job.';
      } finally {
        busy = false;
        render();
      }
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
      // The probing case is a real few seconds, not a formality — the
      // probe waits out a connection attempt. Pointing at a banner that
      // has not rendered yet would describe a screen nobody is looking at.
      if (availability === null) {
        empty.textContent = 'Checking whether the local AI model is available…';
      } else if (canGenerate()) {
        empty.textContent = tool.emptyText ?? 'Nothing generated yet.';
      } else {
        empty.textContent = 'Generating is unavailable — see the notice above.';
      }
      result.appendChild(empty);
    } else if (isPending(job)) {
      result.appendChild(buildStatusLine(
        job.status,
        job.status === 'queued' ? 'Queued. The local model runs one job at a time.' : 'Running…'
      ));
    } else if (job.status === 'failed') {
      result.classList.add('ai-panel__result--error');
      result.appendChild(buildStatusLine('failed', 'Failed'));
      const msg = document.createElement('p');
      msg.className = 'ai-panel__message';
      msg.setAttribute('role', 'alert');
      msg.textContent = ERROR_TEXT[job.errorCode] ?? `The job failed (${job.errorCode ?? 'no code reported'}).`;
      result.appendChild(msg);
    } else {
      result.appendChild(buildStatusLine('completed', 'Draft ready'));

      // textContent, never innerHTML — this is model output.
      const output = document.createElement('pre');
      output.className = 'ai-panel__output';
      output.textContent = job.output ?? '';
      result.appendChild(output);

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

    pollTimer = setInterval(async () => {
      try {
        const fresh = await getAiToolJob(job.jobId);
        const wasPending = isPending(job);
        job = fresh;
        if (!isPending(fresh)) {
          stop();
          if (wasPending) {
            showToast(
              fresh.status === 'completed' ? 'Draft is ready.' : 'The AI job failed.',
              { variant: fresh.status === 'completed' ? 'success' : 'error' }
            );
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
  });

  return {
    el,
    stop() {
      destroyed = true;
      stop();
    },
  };
}
