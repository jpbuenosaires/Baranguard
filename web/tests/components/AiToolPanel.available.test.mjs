/**
 * AiToolPanel with a healthy model. Availability is cached per module for
 * 60s, so the unhealthy / not-configured cases live in their own files.
 */
import { api, window, signIn, cleanup, settle, wait, text, click, type, $, $$, activeIntervalCount } from '../harness/render.mjs';
import { browserCalls } from '../harness/env.mjs';
import { describe, test, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { AiToolPanel } from '../../src/components/AiToolPanel.js';
import { queueSmsCompose, queueIncidentClassification } from '../../src/api/apiClient.js';

afterEach(() => cleanup());

function mountPanel(overrides = {}, options = {}) {
  signIn('admin');
  const panel = AiToolPanel({
    tool: { label: 'AI Message Composer', hint: 'Drafts an advisory.', input: 'text', inputLabel: 'Situation', placeholder: 'Describe…', maxLength: 300, emptyText: 'Nothing drafted yet.', run: (v) => queueSmsCompose(v), ...overrides },
    ...options,
  });
  window.document.getElementById('app').appendChild(panel.el);
  return panel;
}
const form = (panel) => $('form', panel.el);
const submit = (panel) => form(panel).dispatchEvent(new window.Event('submit', { bubbles: true, cancelable: true }));

describe('AiToolPanel (model healthy)', () => {
  test('the input is labelled and Generate is enabled once the probe says healthy', async () => {
    const panel = mountPanel();
    await settle();
    const input = $('textarea, input', panel.el);
    assert.equal($(`label[for="${input.id}"]`).textContent.trim(), 'Situation');
    assert.equal($('button[type="submit"]', panel.el).disabled, false);
    assert.equal($('.ai-panel__banner', panel.el), null, 'no unavailable banner when the model is up');
    panel.stop();
  });

  test('an empty prompt is refused locally, with a message, and nothing is queued', async () => {
    const panel = mountPanel();
    await settle();
    submit(panel);
    await settle();
    assert.equal(api.callsTo('POST', '/ai-tools/sms-compose').length, 0);
    assert.match(text($('.toast-container')), /Situation is required/);
    panel.stop();
  });

  test('Generate only ENQUEUES, then polls the job, and renders output as plain text (Rule 5)', async () => {
    api.setScenario('xss');
    let result = null;
    const panel = mountPanel({}, { onResult: (out) => { result = out; } });
    await settle();
    type($('textarea, input', panel.el), 'Pulong bukas');
    submit(panel);
    await settle();
    const [queued] = api.callsTo('POST', '/ai-tools/sms-compose');
    assert.deepEqual(queued.body, { prompt: 'Pulong bukas' });
    assert.match(text(panel.el), /queued/i);
    await wait(3200);
    assert.ok(api.callsTo('GET', '/ai-tools/jobs/:id').length >= 1, 'the job was never polled');
    assert.match(text($('.ai-panel__output', panel.el)), /Paalala: may pulong/);
    assert.equal($$('[data-xss-canary]').length, 0, 'model output must never be parsed as markup');
    assert.match(result, /Paalala/, 'onResult fires on completion');
    assert.match(text(panel.el), /SMS segment/, 'SMS drafts report their segment count');
    panel.stop();
  });

  test('Copy puts the draft on the clipboard', async () => {
    const panel = mountPanel();
    await settle();
    type($('textarea, input', panel.el), 'x');
    submit(panel);
    await wait(3200);
    click([...panel.el.querySelectorAll('button')].find((b) => /copy/i.test(b.textContent)));
    await settle();
    assert.match(browserCalls.clipboard.at(-1), /Paalala/);
    panel.stop();
  });

  test('classifier output is shown as structured Type / Priority pills', async () => {
    const panel = mountPanel({ label: 'AI Classifier', input: 'none', run: () => queueIncidentClassification(903) });
    await settle();
    submit(panel);
    await wait(3200);
    assert.match(text($('.ai-panel__structured', panel.el)), /Type: theft.*Priority: critical/);
    panel.stop();
  });

  test('a failed job explains itself in operator language, with the code as fallback', async () => {
    api.on('GET', '/ai-tools/jobs/:id', ({ params }) => ({ status: 200, body: { job_id: Number(params.id), task_type: 'sms_compose', status: 'failed', output: null, error_code: 'OLLAMA_ERROR' } }));
    const panel = mountPanel();
    await settle();
    type($('textarea, input', panel.el), 'x');
    submit(panel);
    await wait(3200);
    assert.equal(text($('.ai-panel__result [role="alert"]', panel.el)), 'The local AI model returned an error.');
    panel.stop();
  });

  test('stop() clears the poll so a discarded panel cannot leak a timer', async () => {
    const panel = mountPanel();
    await settle();
    type($('textarea, input', panel.el), 'x');
    submit(panel);
    await settle();
    const before = activeIntervalCount();
    panel.stop();
    assert.ok(activeIntervalCount() < before, 'stop() left the poll running');
  });

  test('a collapsible panel toggles aria-expanded on its single toggle button', async () => {
    const panel = mountPanel({}, { collapsible: true, startCollapsed: true });
    await settle();
    const toggle = $('.ai-panel__toggle', panel.el);
    assert.equal(toggle.getAttribute('aria-expanded'), 'false');
    click(toggle);
    assert.equal(toggle.getAttribute('aria-expanded'), 'true');
    panel.stop();
  });
});
