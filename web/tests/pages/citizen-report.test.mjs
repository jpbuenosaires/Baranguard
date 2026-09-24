/** W19 public citizen report — reachable with no account at all. */
import { api, window, cleanup, settle, text, click, type, $, $$, assertAccessible, assertNoRuntimeErrors, assertNoBrokenValues, buttonByText } from '../harness/render.mjs';
import { geolocation } from '../harness/env.mjs';
import { describe, test, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { renderCitizenReportPage } from '../../src/pages/citizen-report.js';

afterEach(() => cleanup());

async function mount() {
  const root = window.document.getElementById('app');
  renderCitizenReportPage(root);
  await settle();
  return root;
}
const submit = (root) => $('form', root).dispatchEvent(new window.Event('submit', { bubbles: true, cancelable: true }));

describe('Public citizen report (W19)', () => {
  test('loads with no session, offers exactly the four real barangays, and sends no token', async () => {
    const root = await mount();
    const options = [...$('#citizen-report-barangay', root).options].map((o) => o.textContent.trim());
    assert.deepEqual(options, ['Dao', 'Binanuahan', 'Marifosque', 'Banuyo']);
    for (const call of api.calls) assert.equal(call.headers.authorization, undefined);
    assertNoRuntimeErrors();
    assertNoBrokenValues();
  });

  test('every field is labelled', async () => {
    await mount();
    assertAccessible();
  });

  test('an empty description is caught before anything is sent', async () => {
    const root = await mount();
    submit(root);
    await settle();
    assert.match(text($('[role="alert"]', root)), /describing what happened/);
    assert.equal(window.document.activeElement, $('#citizen-report-description'));
    assert.equal(api.callsTo('POST', '/citizen-reports').length, 0);
  });

  test('a valid report is posted without a token and confirmed with its reference', async () => {
    const root = await mount();
    type($('#citizen-report-barangay', root), '3');
    type($('#citizen-report-description', root), 'Fallen tree blocking the road');
    type($('#citizen-report-contact', root), '09181234567');
    submit(root);
    await settle();
    const [call] = api.callsTo('POST', '/citizen-reports');
    assert.deepEqual(call.body, { barangay_id: 3, description: 'Fallen tree blocking the road', contact_number: '09181234567' });
    assert.equal(call.headers.authorization, undefined);
    assert.match(text(root), /399/, 'the confirmation must show the report reference');
    assert.match(text(root), /Marifosque/);
  });

  test('the server\'s own validation message is shown, and the form stays usable', async () => {
    api.on('POST', '/citizen-reports', () => ({ status: 400, body: { error: { code: 'VALIDATION_ERROR', message: 'Contact number must contain 11 digits.' } } }));
    const root = await mount();
    type($('#citizen-report-description', root), 'Flooding');
    submit(root);
    await settle();
    assert.equal(text($('[role="alert"]', root)), 'Contact number must contain 11 digits.');
    assert.equal($('button[type="submit"]', root).disabled, false);
  });

  test('the rate limit gets a plain-language explanation', async () => {
    api.on('POST', '/citizen-reports', () => ({ status: 429, body: { error: { code: 'RATE_LIMITED', message: 'Too many requests.' } } }));
    const root = await mount();
    type($('#citizen-report-description', root), 'Flooding');
    submit(root);
    await settle();
    assert.match(text($('[role="alert"]', root)), /wait a few minutes/);
  });

  test('denied location permission is explained and the report can still be sent', async () => {
    geolocation.mode = 'deny';
    const root = await mount();
    const gps = $$('button', root).find((b) => /gps|location/i.test(b.textContent));
    click(gps);
    await settle();
    assert.match(text(root), /Location permission was denied/);
    type($('#citizen-report-description', root), 'Flooding');
    submit(root);
    await settle();
    const [call] = api.callsTo('POST', '/citizen-reports');
    assert.equal(call.body.latitude, undefined, 'no location must be sent, not a fake 0,0');
  });

  test('an attached location is sent with the report', async () => {
    geolocation.mode = 'allow';
    const root = await mount();
    click($$('button', root).find((b) => /gps|location/i.test(b.textContent)));
    await settle();
    type($('#citizen-report-description', root), 'Flooding');
    submit(root);
    await settle();
    const [call] = api.callsTo('POST', '/citizen-reports');
    assert.equal(call.body.latitude, 12.9186);
    assert.equal(call.body.longitude, 123.6667);
  });

  test('if the barangay list cannot load, the page says so with a retry', async () => {
    api.fail('GET', '/barangays');
    const root = await mount();
    assert.ok($('.state-block--error, [role="alert"]', root), 'no error state');
    const retry = buttonByText(/try again|retry/i, root);
    assert.ok(retry, 'no retry');
    api.overrides.length = 0;
    click(retry);
    await settle();
    assert.ok($('#citizen-report-barangay', root), 'retry did not recover');
  });
});
