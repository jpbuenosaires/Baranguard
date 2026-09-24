import { describePage } from '../harness/pageSuite.mjs';
import { describe, test, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { api, mountPage, settle, cleanup, text, click, buttonByText, $, $$ } from '../harness/render.mjs';
import { maps } from '../harness/env.mjs';
import { renderDispatchCenterPage } from '../../src/pages/dispatch-center.js';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

describePage({
  name: 'Dispatch Center (W3)',
  render: renderDispatchCenterPage,
  roles: ['admin'],
  heading: 'Dispatch Center',
  expectText: ['INC-2026-901', 'INC-2026-902', 'Maria Dela Cruz'],
  polls: true,
});

describe('Dispatch Center behaviour', () => {
  afterEach(() => cleanup());

  test('an active SOS raises the priority alert with the Tanod named', async () => {
    mountPage(renderDispatchCenterPage, { role: 'admin' });
    await settle();
    assert.match(text(), /SOS Emergency for Maria Dela Cruz/);
  });

  test('Resolve SOS asks for confirmation, then calls PATCH /tanod-sos/:id/resolve', async () => {
    const ctx = mountPage(renderDispatchCenterPage, { role: 'admin' });
    await settle();
    click(buttonByText(/^resolve sos$/i, ctx.root));
    const dialog = $('[role="alertdialog"]');
    assert.ok(dialog, 'resolving an SOS must be confirmed first');
    assert.equal(api.callsTo('PATCH', '/tanod-sos/:id/resolve').length, 0, 'nothing may be sent before confirmation');
    click($$('button', dialog).at(-1));
    await settle();
    assert.equal(api.callsTo('PATCH', '/tanod-sos/91/resolve').length, 1);
  });

  test('both concurrent responders on one incident are listed', async () => {
    mountPage(renderDispatchCenterPage, { role: 'admin' });
    await settle();
    const body = text();
    assert.match(body, /Assigned: Maria Dela Cruz/);
    assert.match(body, /Assigned: Jose Reyes/);
  });

  test('cancelling a dispatch is confirmed and hits PATCH /dispatch/:id/cancel', async () => {
    const ctx = mountPage(renderDispatchCenterPage, { role: 'admin' });
    await settle();
    click(buttonByText(/^cancel$/i, ctx.root));
    const dialog = $('[role="alertdialog"]');
    assert.ok(dialog, 'cancel must be confirmed');
    click($$('button', dialog).at(-1));
    await settle();
    assert.equal(api.callsTo('PATCH', '/dispatch/:id/cancel').length, 1);
  });

  test('dispatching a Tanod sends a fresh idempotency request_id (Rule 3)', async () => {
    const ctx = mountPage(renderDispatchCenterPage, { role: 'admin' });
    await settle();
    click(buttonByText(/^dispatch tanod$/i, ctx.root));
    await settle();
    const dialog = $('[role="alertdialog"], [role="dialog"]');
    assert.ok(dialog, 'Dispatch Tanod should open a picker');
    const confirm = $$('button', dialog).filter((b) => !b.disabled).at(-1);
    click(confirm);
    await settle();
    const [call] = api.callsTo('POST', '/dispatch');
    assert.ok(call, 'POST /dispatch was not sent');
    assert.equal(call.body.incident_id, 901);
    assert.match(String(call.body.request_id), UUID);
  });

  test('live Tanod positions are plotted on the map', async () => {
    mountPage(renderDispatchCenterPage, { role: 'admin' });
    await settle();
    assert.ok(maps.length >= 1, 'no map was created');
    const markers = maps.flatMap((m) => m.markers);
    assert.ok(markers.length >= 2, `expected at least the 2 live Tanods on the map, got ${markers.length}`);
  });
});
