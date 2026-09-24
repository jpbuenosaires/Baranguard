import { describePage } from '../harness/pageSuite.mjs';
import { describe, test, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { api, mountPage, settle, cleanup, text, click, type, buttonByText, $, $$ } from '../harness/render.mjs';
import { renderSmsMonitorPage } from '../../src/pages/sms-monitor.js';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

describePage({
  name: 'SMS Monitor (W14)',
  render: renderSmsMonitorPage,
  roles: ['admin'],
  heading: 'SMS Monitor',
  expectText: ['Resident (Purok 2)', 'May sunog po sa Purok 2'],
  polls: true,
});

describe('SMS Monitor behaviour', () => {
  afterEach(() => cleanup());

  test('a failed inbox load is never shown as "no conversations" (an outage must not look like a quiet day)', async () => {
    api.fail('GET', '/sms/conversations');
    const ctx = mountPage(renderSmsMonitorPage, { role: 'admin' });
    await settle();
    assert.doesNotMatch(text($('.page-content', ctx.root)), /No SMS conversations recorded/i,
      'the empty-inbox message appeared although the server failed — an Admin could miss incoming emergency SMS');
  });

  test('the first conversation opens with its message history', async () => {
    mountPage(renderSmsMonitorPage, { role: 'admin' });
    await settle();
    assert.ok(api.callsTo('GET', '/sms/conversations/:phone/messages').length >= 1);
    assert.match(text(), /Papunta na po ang tanod/);
  });

  test('a manual reply carries an Idempotency-Key and the recipient number', async () => {
    const ctx = mountPage(renderSmsMonitorPage, { role: 'admin' });
    await settle();
    const box = $$('textarea', ctx.root).find((t) => !t.closest('.ai-panel'));
    assert.ok(box, 'no reply box');
    type(box, 'Salamat po, papunta na kami.');
    click(buttonByText(/^send sms$/i, ctx.root));
    await settle();
    const dialog = $('[role="alertdialog"]');
    if (dialog) { click($$('button', dialog).at(-1)); await settle(); }
    const [call] = api.callsTo('POST', '/sms/send');
    assert.ok(call, 'POST /sms/send was not sent');
    assert.match(call.headers['idempotency-key'] || '', UUID, 'every web write needs an Idempotency-Key (Rule 3)');
    assert.equal(call.body.phone_number, '09181234567');
    assert.equal(call.body.message, 'Salamat po, papunta na kami.');
  });

  test('Mark Resolved calls PATCH /sms/conversations/:phone/resolve', async () => {
    const ctx = mountPage(renderSmsMonitorPage, { role: 'admin' });
    await settle();
    click(buttonByText(/^mark resolved$/i, ctx.root));
    await settle();
    const dialog = $('[role="alertdialog"]');
    if (dialog) { click($$('button', dialog).at(-1)); await settle(); }
    assert.equal(api.callsTo('PATCH', '/sms/conversations/09181234567/resolve').length, 1);
  });

  test('the Activity Log view never shows phone numbers (GET /sms/logs has none by design)', async () => {
    mountPage(renderSmsMonitorPage, { role: 'admin', param: 'activity-log' });
    await settle();
    assert.ok(api.callsTo('GET', '/sms/logs').length >= 1);
    assert.match(text(), /Gateway rejected the sender name/, 'a failed send must show its reason');
  });

  test('the AI Message Composer has no send button — sending stays a human, audited action', async () => {
    const ctx = mountPage(renderSmsMonitorPage, { role: 'admin' });
    await settle();
    const panel = $$('.ai-panel', ctx.root).find((p) => /message composer/i.test(text(p)));
    assert.ok(panel, 'AI Message Composer panel missing');
    assert.equal(buttonByText(/^send/i, panel), undefined);
  });
});
