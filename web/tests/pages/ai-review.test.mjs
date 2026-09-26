import { describePage } from '../harness/pageSuite.mjs';
import { describe, test, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { api, mountPage, settle, cleanup, text, click, type, buttonByText, $, $$ } from '../harness/render.mjs';
import { renderAiReviewPage } from '../../src/pages/ai-review.js';

describePage({
  name: 'AI Redaction Review (W8)',
  render: renderAiReviewPage,
  roles: ['secretary'],
  param: 901,
  heading: /^AI Redaction Review — Incident #901/,
  expectText: ['RAW-NARRATIVE-901', 'Original Reported Narrative'],
});

describe('AI Redaction Review behaviour', () => {
  afterEach(() => cleanup());

  test('raw narrative and AI draft are shown side by side', async () => {
    mountPage(renderAiReviewPage, { role: 'secretary', param: 901 });
    await settle();
    const body = text();
    assert.match(body, /Original Reported Narrative/);
    assert.match(body, /Redacted Narrative Draft/);
  });

  test('a stale summary is flagged before approval (pipeline order, Rule 4)', async () => {
    mountPage(renderAiReviewPage, { role: 'secretary', param: 901 });
    await settle();
    assert.match(text(), /Summary out of date/i);
  });

  test('approval is blocked while the summary is out of sync with the draft', async () => {
    const ctx = mountPage(renderAiReviewPage, { role: 'secretary', param: 901 });
    await settle();
    const approve = buttonByText(/^approve redaction$/i, ctx.root);
    assert.ok(approve, 'no approve control');
    assert.equal(approve.disabled, true, 'Approve must be disabled while the summary is stale');
    click(approve);
    await settle();
    const dialog = $('[role="alertdialog"]');
    if (dialog) { click($$('button', dialog).at(-1)); await settle(); }
    assert.equal(api.callsTo('POST', '/incidents/:id/ai-draft/approve').length, 0, 'a stale summary must not be committable');
  });

  test('approval sends the exact draft_version and the draft text (Rule 4)', async () => {
    api.on('GET', '/incidents/:id/ai-draft', ({ params }) => ({ status: 200, body: {
      log_id: 9901, incident_id: Number(params.id), pipeline_run_id: 'run-901', task_type: 'redaction', model_version: 'm',
      draft_redacted_narrative: 'Complainant [PERSON] reported the incident at [PHONE].', draft_summary: 'A theft was reported.',
      draft_summary_stale: false, draft_version: 2, status: 'completed', error_code: null,
    } }));
    const ctx = mountPage(renderAiReviewPage, { role: 'secretary', param: 901 });
    await settle();
    click(buttonByText(/^approve redaction$/i, ctx.root));
    await settle();
    const dialog = $('[role="alertdialog"]');
    if (dialog) { click($$('button', dialog).at(-1)); await settle(); }
    const [call] = api.callsTo('POST', '/incidents/:id/ai-draft/approve');
    assert.ok(call, 'POST /ai-draft/approve was not sent');
    assert.deepEqual(call.body, { approved_narrative: 'Complainant [PERSON] reported the incident at [PHONE].', draft_version: 2 });
  });

  test('editing the draft marks it unsaved and regeneration sends the edited text', async () => {
    const ctx = mountPage(renderAiReviewPage, { role: 'secretary', param: 901 });
    await settle();
    const draft = $('#ai-draft-narrative');
    assert.ok(draft, 'no editable draft');
    type(draft, 'Complainant [PERSON] reported a theft at [LOCATION].');
    click(buttonByText(/regenerate summary|sync \/ regenerate/i, ctx.root));
    await settle();
    const [call] = api.callsTo('POST', '/incidents/:id/ai-draft/regenerate-summary');
    assert.ok(call, 'regenerate-summary was not sent');
    assert.equal(call.body.draft_redacted_narrative, 'Complainant [PERSON] reported a theft at [LOCATION].');
    assert.equal(call.body.draft_version, 2);
  });

  test('no draft yet is an empty state with a way to run redaction', async () => {
    const ctx = mountPage(renderAiReviewPage, { role: 'secretary', param: 904 });
    await settle();
    assert.equal($('.state-block--error', ctx.root), null);
    const run = buttonByText(/run|redact|generate/i, ctx.root);
    assert.ok(run, 'no way to start the redaction pipeline');
  });

  test('Bikol translation is labelled as not yet validated (§2 Rule 16)', async () => {
    const ctx = mountPage(renderAiReviewPage, { role: 'secretary', param: 903 });
    await settle();
    const select = $('#ai-translate-language');
    assert.ok(select, 'no translate control for an approved incident');
    type(select, 'bcl');
    click(buttonByText(/^translate$/i, ctx.root));
    await settle();
    assert.equal(api.callsTo('POST', '/incidents/:id/ai-draft/translate').length, 1);
    assert.match(text(), /not (yet )?validated|unvalidated/i, 'the Bikol caveat (a toast) must be shown');
  });

  test('the Lupon packet stays disabled until the blotter entry is finalized (server prerequisite)', async () => {
    const ctx = mountPage(renderAiReviewPage, { role: 'secretary', param: 901 });
    await settle();
    assert.equal(buttonByText(/lupon packet/i, ctx.root).disabled, true);
    cleanup();
    const ctx2 = mountPage(renderAiReviewPage, { role: 'secretary', param: 903 });
    await settle();
    assert.equal(buttonByText(/lupon packet/i, ctx2.root).disabled, false);
  });

  test('the workflow bar shows all four stages and the next step', async () => {
    const ctx = mountPage(renderAiReviewPage, { role: 'secretary', param: 901 });
    await settle();
    const steps = $$('.blotter-flow__step', ctx.root).map((el) => text(el));
    assert.equal(steps.length, 4);
    assert.match(steps[2], /Finalize blotter entry[\s\S]*Cannot start yet/);
    assert.match(text($('.blotter-flow__next', ctx.root)), /summary is out of date/i);
  });

  test('the location line never falls back to a hard-coded barangay', async () => {
    api.on('GET', '/incidents/:id', ({ params }) => ({ status: 200, body: {
      incident_id: Number(params.id), barangay_id: 2, reported_by: 4, incident_type: 'theft', priority: 'normal', status: 'pending', source: 'app',
      latitude: null, longitude: null, created_at: '2026-09-20 01:00:00', synced_at: null, location_description: null, display_id: 'INC-2026-777',
      raw_narrative: 'x', redacted_narrative: null, redaction_approved_at: null, redaction_approved_by: null, dispatches: [],
    } }));
    const ctx = mountPage(renderAiReviewPage, { role: 'secretary', param: 777, userOverrides: { barangayId: 2 } });
    await settle();
    assert.doesNotMatch(text(ctx.root), /Brgy\. Dao/, 'a Binanuahan incident with no location must not claim to be in Dao (§2 Rule 6: no hard-coded identities)');
  });
});
