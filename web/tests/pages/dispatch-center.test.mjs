import { describePage } from '../harness/pageSuite.mjs';
import { describe, test, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { api, mountPage, settle, cleanup, text, click, type, buttonByText, $, $$, window } from '../harness/render.mjs';
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

  const dialog = () => $('[role="alertdialog"]');
  const confirmButton = () => $$('button', dialog()).at(-1);
  const dialogError = () => text($('.confirm-dialog__error', dialog()));

  test('cancelling a dispatch REQUIRES a reason: blank is refused inline and nothing is sent', async () => {
    const ctx = mountPage(renderDispatchCenterPage, { role: 'admin' });
    await settle();
    click(buttonByText(/^cancel$/i, ctx.root));
    assert.ok(dialog(), 'cancel must open a dialog');
    assert.ok($('#confirm-dialog-input', dialog()), 'the dialog must ask for a reason');
    click(confirmButton());
    await settle();
    assert.match(dialogError(), /reason/i);
    assert.equal(api.callsTo('PATCH', '/dispatch/:id/cancel').length, 0, 'a blank reason must not reach the server');
    type($('#confirm-dialog-input', dialog()), '    ');
    click(confirmButton());
    await settle();
    assert.equal(api.callsTo('PATCH', '/dispatch/:id/cancel').length, 0, 'whitespace is not a reason');
    assert.ok(dialog(), 'the dialog stays open after a refused submit');
  });

  test('a cancellation reason over 255 characters is refused before sending', async () => {
    const ctx = mountPage(renderDispatchCenterPage, { role: 'admin' });
    await settle();
    click(buttonByText(/^cancel$/i, ctx.root));
    type($('#confirm-dialog-input', dialog()), 'x'.repeat(256));
    click(confirmButton());
    await settle();
    assert.match(dialogError(), /255/);
    assert.equal(api.callsTo('PATCH', '/dispatch/:id/cancel').length, 0);
    type($('#confirm-dialog-input', dialog()), 'x'.repeat(255));
    click(confirmButton());
    await settle();
    assert.equal(api.callsTo('PATCH', '/dispatch/:id/cancel').length, 1, '255 characters is the allowed maximum');
  });

  test('a valid reason is sent as `reason` to PATCH /dispatch/:id/cancel and the dialog closes', async () => {
    const ctx = mountPage(renderDispatchCenterPage, { role: 'admin' });
    await settle();
    click(buttonByText(/^cancel$/i, ctx.root));
    type($('#confirm-dialog-input', dialog()), '  Responder reassigned to a closer incident  ');
    click(confirmButton());
    await settle();
    const [call] = api.callsTo('PATCH', '/dispatch/:id/cancel');
    assert.ok(call, 'PATCH /dispatch/:id/cancel was not sent');
    assert.deepEqual(call.body, { reason: 'Responder reassigned to a closer incident' });
    assert.equal(dialog(), null, 'the dialog closes on success');
  });

  test('a server rejection of the cancel shows inline and keeps the dialog open', async () => {
    api.fail('PATCH', '/dispatch/:id/cancel', 409, 'INVALID_TRANSITION', 'That dispatch can no longer be cancelled.');
    const ctx = mountPage(renderDispatchCenterPage, { role: 'admin' });
    await settle();
    click(buttonByText(/^cancel$/i, ctx.root));
    type($('#confirm-dialog-input', dialog()), 'Duplicate assignment');
    click(confirmButton());
    await settle();
    assert.ok(dialog(), 'dialog must stay open on a server error');
    assert.match(dialogError(), /can no longer be cancelled/);
  });

  test('an ARRIVED dispatch can be cancelled too, with a reason', async () => {
    const arrived = {
      dispatch_id: 7001, incident_id: 902, tanod_id: 5, tanod_name: 'Maria Dela Cruz', priority: 'critical',
      route_json: null, route_status: 'unavailable', status: 'arrived',
      dispatched_at: '2026-10-01 00:00:00', en_route_at: '2026-10-01 00:01:00', arrived_at: '2026-10-01 00:05:00', completed_at: null, cancelled_at: null,
    };
    api.on('GET', '/dispatch', () => ({ status: 200, body: { items: [arrived], page: 1, limit: 100, total: 1 } }));
    api.on('GET', '/incidents', ({ query }) => (query.status === 'dispatched'
      ? { status: 200, body: { items: [{ incident_id: 902, barangay_id: 1, incident_type: 'medical_emergency', priority: 'critical', status: 'dispatched', source: 'sms', latitude: 12.9172, longitude: 123.6655, created_at: '2026-10-01 00:00:00', location_description: 'Purok 6', display_id: 'INC-2026-902', dispatches: [{ dispatch_id: 7001, tanod_id: 5, tanod_name: 'Maria Dela Cruz', status: 'arrived', dispatched_at: '2026-10-01 00:00:00', arrived_at: '2026-10-01 00:05:00' }] }], page: 1, limit: 100, total: 1 } }
      : { status: 200, body: { items: [], page: 1, limit: 100, total: 0 } }));
    const ctx = mountPage(renderDispatchCenterPage, { role: 'admin' });
    await settle();
    const cancelBtn = buttonByText(/^cancel$/i, ctx.root);
    assert.ok(cancelBtn, 'an arrived responder must still offer Cancel');
    click(cancelBtn);
    assert.match(text(dialog()), /already arrived/i);
    type($('#confirm-dialog-input', dialog()), 'Scene handed to PNP, responder released');
    click(confirmButton());
    await settle();
    const [call] = api.callsTo('PATCH', '/dispatch/:id/cancel');
    assert.equal(call.path, '/dispatch/7001/cancel');
    assert.deepEqual(call.body, { reason: 'Scene handed to PNP, responder released' });
  });

  test('"Keep it" closes the cancel dialog without sending anything', async () => {
    const ctx = mountPage(renderDispatchCenterPage, { role: 'admin' });
    await settle();
    click(buttonByText(/^cancel$/i, ctx.root));
    click($$('button', dialog())[0]);
    await settle();
    assert.equal(dialog(), null);
    assert.equal(api.callsTo('PATCH', '/dispatch/:id/cancel').length, 0);
  });

  test('NO_PUBLISHED_SHIFT: the Admin must give an override reason, then the same request is resent with override_reason', async () => {
    api.on('POST', '/dispatch', ({ body }) => (body.override_reason === undefined
      ? { status: 422, body: { error: { code: 'NO_PUBLISHED_SHIFT', message: 'This Tanod has no published shift covering now.' } } }
      : { status: 201, body: { dispatch_id: 7010, status: 'assigned', incident_id: body.incident_id, route_status: 'unavailable' } }));
    const ctx = mountPage(renderDispatchCenterPage, { role: 'admin' });
    await settle();
    click(buttonByText(/^dispatch tanod$/i, ctx.root));
    await settle();
    click($$('button', dialog()).filter((b) => !b.disabled).at(-1));
    await settle();
    // First attempt carried no override and was refused.
    let calls = api.callsTo('POST', '/dispatch');
    assert.equal(calls.length, 1);
    assert.equal(calls[0].body.override_reason, undefined, 'the first attempt must not pre-fill an override');
    // The override dialog now asks for a REQUIRED reason.
    assert.match(text(dialog()), /No published shift/i);
    assert.ok($('#confirm-dialog-input', dialog()), 'override reason field missing');
    click(confirmButton());
    await settle();
    assert.match(dialogError(), /required/i);
    assert.equal(api.callsTo('POST', '/dispatch').length, 1, 'a blank override reason must not be sent');
    type($('#confirm-dialog-input', dialog()), 'x'.repeat(256));
    click(confirmButton());
    await settle();
    assert.match(dialogError(), /255/);
    assert.equal(api.callsTo('POST', '/dispatch').length, 1);
    type($('#confirm-dialog-input', dialog()), 'Roster not yet published; nearest responder');
    click(confirmButton());
    await settle();
    calls = api.callsTo('POST', '/dispatch');
    assert.equal(calls.length, 2);
    assert.equal(calls[1].body.override_reason, 'Roster not yet published; nearest responder');
    assert.equal(calls[1].body.incident_id, calls[0].body.incident_id);
    assert.equal(calls[1].body.tanod_id, calls[0].body.tanod_id);
    assert.equal(calls[1].body.request_id, calls[0].body.request_id, 'the retry reuses the idempotency request_id');
    assert.equal(dialog(), null, 'the dialog closes once the override succeeds');
  });

  test('cancelling the override dialog leaves no dispatch behind', async () => {
    api.on('POST', '/dispatch', () => ({ status: 422, body: { error: { code: 'NO_PUBLISHED_SHIFT', message: 'No published shift.' } } }));
    const ctx = mountPage(renderDispatchCenterPage, { role: 'admin' });
    await settle();
    click(buttonByText(/^dispatch tanod$/i, ctx.root));
    await settle();
    click($$('button', dialog()).filter((b) => !b.disabled).at(-1));
    await settle();
    click($$('button', dialog())[0]);
    await settle();
    assert.equal(dialog(), null);
    assert.equal(api.callsTo('POST', '/dispatch').length, 1, 'only the original refused attempt');
  });

  test('other dispatch errors still just toast (no override prompt)', async () => {
    api.on('POST', '/dispatch', () => ({ status: 409, body: { error: { code: 'TANOD_BUSY', message: 'Tanod already assigned.' } } }));
    const ctx = mountPage(renderDispatchCenterPage, { role: 'admin' });
    await settle();
    click(buttonByText(/^dispatch tanod$/i, ctx.root));
    await settle();
    click($$('button', dialog()).filter((b) => !b.disabled).at(-1));
    await settle();
    assert.equal($('#confirm-dialog-input'), null, 'no override field for non-shift errors');
    assert.match(text(), /Tanod already assigned/);
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

  test('adding a second responder from a dispatched incident card sends POST /dispatch', async () => {
    // Provide an additional active on-duty Tanod (user 7) who is not yet assigned to incident 902
    api.on('GET', '/duty-status', () => ({ status: 200, body: { items: [
      { user_id: 4, status: 'on_duty', channel: 'app', changed_at: '2026-01-01 00:00:00' },
      { user_id: 7, status: 'on_duty', channel: 'app', changed_at: '2026-01-01 00:00:00' },
    ] } }));
    api.on('GET', '/users', () => ({ status: 200, body: { items: [
      { user_id: 4, full_name: 'Jose Reyes', role: 'tanod', is_active: 1 },
      { user_id: 5, full_name: 'Maria Dela Cruz', role: 'tanod', is_active: 1 },
      { user_id: 7, full_name: 'Ana Dichoso', role: 'tanod', is_active: 1 },
    ], total: 3 } }));

    const ctx = mountPage(renderDispatchCenterPage, { role: 'admin' });
    await settle();
    const addBtn = buttonByText(/add responder/i, ctx.root);
    assert.ok(addBtn, 'dispatched incident should render an Add Responder button');
    assert.equal(addBtn.disabled, false, 'Add Responder button should be enabled when eligible Tanods exist');
    click(addBtn);
    await settle();
    const dialog = $('[role="alertdialog"], [role="dialog"]');
    assert.ok(dialog, 'Add Responder should open a picker');
    const confirm = $$('button', dialog).filter((b) => !b.disabled).at(-1);
    click(confirm);
    await settle();
    const calls = api.callsTo('POST', '/dispatch');
    assert.ok(calls.length >= 1, 'POST /dispatch was sent for second responder');
  });

  test('live Tanod positions are plotted on the map', async () => {
    mountPage(renderDispatchCenterPage, { role: 'admin' });
    await settle();
    assert.ok(maps.length >= 1, 'no map was created');
    const markers = maps.flatMap((m) => m.markers);
    assert.ok(markers.length >= 2, `expected at least the 2 live Tanods on the map, got ${markers.length}`);
  });
});

describe('Dispatch offers on the board (Wave 2)', () => {
  afterEach(() => cleanup());

  test('each incident card shows its offer state: open round/count/countdown, escalated, accepted', async () => {
    mountPage(renderDispatchCenterPage, { role: 'admin' });
    await settle();
    const body = text();
    assert.match(body, /Broadcast to 3 tanods, round 2\/3, expires [0-2]:\d{2}/);
    assert.match(body, /Escalated: no tanod accepted\. Assign a responder\./);
    assert.match(body, /Accepted by Maria Dela Cruz/);
    assert.equal(api.callsTo('GET', '/dispatch-offers').length >= 1, true);
  });

  test('Admin can cancel a live broadcast (PATCH /dispatch-offers/:id/cancel with an Idempotency-Key)', async () => {
    const ctx = mountPage(renderDispatchCenterPage, { role: 'admin' });
    await settle();
    const btns = $$('button', ctx.root).filter((b) => /^cancel broadcast$/i.test(text(b)));
    assert.equal(btns.length, 2, 'open + escalated offers are cancellable');
    click(btns[0]);
    await settle();
    const [call] = api.callsTo('PATCH', '/dispatch-offers/:id/cancel');
    assert.ok(call, 'cancel was sent');
    assert.match(call.path, /^\/dispatch-offers\/(31|32)\/cancel$/);
    assert.match(call.headers['idempotency-key'] || '', UUID);
  });

  test('Admin can broadcast a pending incident with no live offer (POST /dispatch-offers {incident_id})', async () => {
    api.on('GET', '/dispatch-offers', () => ({ status: 200, body: { items: [], page: 1, limit: 25, total: 0 } }));
    const ctx = mountPage(renderDispatchCenterPage, { role: 'admin' });
    await settle();
    assert.equal($$('button', ctx.root).filter((b) => /^cancel broadcast$/i.test(text(b))).length, 0);
    const btn = $$('button', ctx.root).find((b) => /broadcast to on-duty tanods/i.test(text(b)));
    assert.ok(btn, 'broadcast button present on a pending incident');
    click(btn);
    await settle();
    const [call] = api.callsTo('POST', '/dispatch-offers');
    assert.ok(call, 'POST /dispatch-offers was sent');
    assert.equal(typeof call.body.incident_id, 'number');
    assert.match(call.headers['idempotency-key'] || '', UUID);
    assert.match(text(window.document.body), /Broadcast sent to 2 tanods/);
  });

  test('an unreadable offers endpoint never blanks the board', async () => {
    api.fail('GET', '/dispatch-offers', 500);
    mountPage(renderDispatchCenterPage, { role: 'admin' });
    await settle();
    assert.match(text(), /INC-2026-901/);
    assert.doesNotMatch(text(), /Broadcast to \d+ tanod/);
  });

  test('a reopened incident is queued with a REOPENED badge and can be dispatched; pending ones keep PENDING', async () => {
    const original = api.routes.find((r) => r.method === 'GET' && r.path === '/incidents');
    api.on('GET', '/incidents', (req) => {
      const res = original.handler(req);
      const body = res.body ?? res;
      if (req.query.status === 'reopened') {
        const base = (original.handler({ ...req, query: { ...req.query, status: 'pending' } }).body ?? {}).items ?? [];
        return { status: 200, body: { ...body, items: base.slice(0, 1).map((i) => ({ ...i, incident_id: 950, display_id: 'INC-2026-950', status: 'reopened' })) } };
      }
      return res;
    });
    const ctx = mountPage(renderDispatchCenterPage, { role: 'admin' });
    await settle();
    const badges = $$('.queue-badge', ctx.root).map((b) => text(b));
    assert.ok(badges.includes('REOPENED'), `no REOPENED badge in ${JSON.stringify(badges)}`);
    assert.ok(badges.includes('PENDING'), 'pending incidents keep their PENDING badge');
    const card = $$('.queue-incident-card', ctx.root).find((c) => /INC-2026-950/.test(text(c)));
    assert.ok(card, 'reopened incident card missing');
    assert.ok($$('button', card).some((b) => /^dispatch tanod$/i.test(text(b))), 'a reopened incident is dispatchable');
  });
});
