import { describePage } from '../harness/pageSuite.mjs';
import { describe, test, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { api, mountPage, settle, cleanup, text, click, type, buttonByText, $, $$ } from '../harness/render.mjs';
import { renderPersonnelPage } from '../../src/pages/personnel.js';

describePage({
  name: 'Personnel',
  render: renderPersonnelPage,
  roles: ['admin', 'punong_barangay'],
  heading: 'Personnel',
});

const tabLabels = () => $$('.page-tab').map((b) => text(b).replace(/\d+$/, '').trim());
const tab = (label) => $$('.page-tab').find((b) => new RegExp(label, 'i').test(text(b)));

describe('Personnel behaviour', () => {
  afterEach(() => cleanup());

  test('Admin sees all four tabs', async () => {
    mountPage(renderPersonnelPage, { role: 'admin' });
    await settle();
    for (const label of ['Users', 'Scheduler', 'Swap', 'Fatigue']) assert.ok(tab(label), `missing ${label} tab (have: ${tabLabels().join(', ')})`);
  });

  test('Punong Barangay sees only Fatigue flags (REFERENCE.md §7)', async () => {
    mountPage(renderPersonnelPage, { role: 'punong_barangay' });
    await settle();
    for (const hidden of ['Users', 'Scheduler', 'Swap']) {
      assert.equal(tab(hidden), undefined, `PB must not see the ${hidden} tab (saw: ${tabLabels().join(', ')})`);
    }
    assert.match(text($('.page-content')), /Fatigue/i);
    assert.equal(api.callsTo('GET', '/users').length, 0, 'the read-only role must not pull the user roster');
  });

  test('user roster lists every account with its real status', async () => {
    mountPage(renderPersonnelPage, { role: 'admin' });
    await settle();
    const body = text($('.page-content'));
    assert.match(body, /Pedro Gubaton.*Suspended/);
    assert.match(body, /Ana Dichoso.*Inactive/);
  });

  test('suspending a user is confirmed before PATCH /users/:id', async () => {
    const ctx = mountPage(renderPersonnelPage, { role: 'admin' });
    await settle();
    click(buttonByText(/^suspend$/i, ctx.root));
    await settle();
    assert.equal(api.callsTo('PATCH', '/users/:id').length, 0, 'nothing may be sent before confirmation');
    const dialog = $('[role="alertdialog"], [role="dialog"]');
    assert.ok(dialog, 'suspend must be confirmed');
    const reason = $('textarea, input[type="text"]', dialog);
    if (reason) type(reason, 'Repeated no-shows');
    click($$('button', dialog).filter((b) => !b.disabled).at(-1));
    await settle();
    const [call] = api.callsTo('PATCH', '/users/:id');
    assert.ok(call, 'PATCH /users/:id was not sent');
    assert.equal(call.body.is_suspended, true);
  });

  test('the create-user password rule stays visible while typing (§13)', async () => {
    const ctx = mountPage(renderPersonnelPage, { role: 'admin' });
    await settle();
    click(buttonByText(/add (new )?user|new user|create user/i, ctx.root) ?? buttonByText(/add/i, ctx.root));
    await settle();
    const password = $('#modal-password');
    assert.ok(password, 'create-user form did not open');
    type(password, 'abc');
    assert.match(text(password.closest('.personnel-form-field')), /At least 12 characters, with mixed case and a digit/);
  });

  test('Scheduler rejects an end time before the start time without calling the server', async () => {
    mountPage(renderPersonnelPage, { role: 'admin' });
    await settle();
    click(tab('Scheduler'));
    await settle();
    type($('#scheduler-new-start'), '2026-10-01T18:00');
    type($('#scheduler-new-end'), '2026-10-01T08:00');
    const form = $('#scheduler-new-start').closest('form');
    form.dispatchEvent(new window.Event('submit', { bubbles: true, cancelable: true }));
    await settle();
    assert.match(text(form), /End time must be after the start time/);
    assert.equal(api.callsTo('POST', '/shifts').length, 0);
  });

  test('approving a swap request sends its version (optimistic concurrency)', async () => {
    const ctx = mountPage(renderPersonnelPage, { role: 'admin' });
    await settle();
    click(tab('Swap'));
    await settle();
    click(buttonByText(/^approve$/i, ctx.root));
    await settle();
    const dialog = $('[role="alertdialog"]');
    if (dialog) { click($$('button', dialog).at(-1)); await settle(); }
    const [call] = api.callsTo('PATCH', '/shift-swap-requests/:id');
    assert.ok(call, 'PATCH /shift-swap-requests/:id was not sent');
    assert.equal(call.body.status, 'approved');
    assert.equal(call.body.version, 1);
  });
});
