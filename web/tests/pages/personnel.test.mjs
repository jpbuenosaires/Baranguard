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

  test('Scheduler tab offers Preview & Print Schedule A4 duty roster modal', async () => {
    const ctx = mountPage(renderPersonnelPage, { role: 'admin' });
    await settle();
    click(tab('Scheduler'));
    await settle();

    const printBtn = ctx.root.querySelector('#preview-schedule-print-btn');
    assert.ok(printBtn, 'Preview & Print Schedule button should be mounted in Scheduler header');
    click(printBtn);
    await settle();

    const sheet = document.querySelector('#printable-schedule-sheet');
    assert.ok(sheet, 'Printable schedule A4 sheet should be mounted');
    assert.match(text(sheet), /BARANGAY TANOD DUTY ROSTER & PATROL SCHEDULE/i);

    const closeBtn = document.querySelector('#close-print-modal');
    click(closeBtn);
    assert.ok(!document.body.classList.contains('has-print-modal'), 'closing modal should remove has-print-modal');
  });

  test('Fatigue flags display accurate threshold markers, tier styling, and copy', async () => {
    const ctx = mountPage(renderPersonnelPage, { role: 'admin' });
    await settle();
    click(tab('Fatigue'));
    await settle();

    // Check threshold marker is present
    const markers = ctx.root.querySelectorAll('.fatigue-meter-threshold-marker');
    assert.ok(markers.length > 0, 'Threshold marker should be mounted on the track');

    // Fixture has 62.5h (over limit, High Risk) and 49h (under limit, Under Limit)
    const content = text(ctx.root);
    assert.match(content, /High Risk/i);
    assert.match(content, /Under Limit/i);
    assert.match(content, /\+6\.5h over safe limit/i);
    assert.match(content, /7\.0h under limit \(historical alert\)/i);
  });

  test('Clicking "View Shifts" switches to Scheduler tab pre-filtered to Tanod', async () => {
    const ctx = mountPage(renderPersonnelPage, { role: 'admin' });
    await settle();
    click(tab('Fatigue'));
    await settle();

    const viewShiftsBtn = buttonByText(/View Shifts/i, ctx.root);
    assert.ok(viewShiftsBtn, 'View Shifts button should be present in Fatigue tab for admin');
    click(viewShiftsBtn);
    await settle();

    // Active tab is now scheduler
    assert.ok(tab('Scheduler').classList.contains('is-active'), 'Scheduler tab should now be active');
    const searchInput = ctx.root.querySelector('.personnel-search-input');
    assert.ok(searchInput.value.length > 0, 'Scheduler search query should be prefilled');
  });

  test('Fatigue Details button opens breakdown modal with triggering shift info and audit trail', async () => {
    const ctx = mountPage(renderPersonnelPage, { role: 'admin' });
    await settle();
    click(tab('Fatigue'));
    await settle();

    const detailsBtn = buttonByText(/Details/i, ctx.root);
    assert.ok(detailsBtn, 'Details button should be present');
    click(detailsBtn);
    await settle();

    const modal = document.querySelector('.personnel-modal[aria-label*="Fatigue Alert Details"]');
    assert.ok(modal, 'Fatigue Details modal should be open');
    const modalText = text(modal);
    assert.match(modalText, /Fatigue Alert Details/i);
    assert.match(modalText, /Triggering Shift & Calculation Basis/i);
    assert.match(modalText, /Safety Review & Audit Trail/i);

    // Close button works
    const closeBtn = modal.querySelector('.personnel-modal__close');
    click(closeBtn);
    await settle();
    assert.equal(document.querySelector('.personnel-modal[aria-label*="Fatigue Alert Details"]'), null);
  });

  test('Scheduler form dynamically shows proactive fatigue callout on preset or time change', async () => {
    const ctx = mountPage(renderPersonnelPage, { role: 'admin' });
    await settle();
    click(tab('Scheduler'));
    await settle();

    const morningPreset = buttonByText(/Morning/i, ctx.root);
    assert.ok(morningPreset, 'Morning preset should be available');
    click(morningPreset);
    await settle();

    const callout = ctx.root.querySelector('.scheduler-fatigue-callout');
    assert.ok(callout, 'Fatigue callout element should be mounted in form');
    assert.equal(callout.hidden, false, 'Callout should become visible once times are filled');
    assert.match(text(callout), /hrs \/ 56h max/i);
  });

  test('Edit Shift modal shows proactive fatigue preview callout', async () => {
    const ctx = mountPage(renderPersonnelPage, { role: 'admin' });
    await settle();
    click(tab('Scheduler'));
    await settle();

    const editBtn = buttonByText(/Edit Shift/i, ctx.root);
    assert.ok(editBtn, 'Edit Shift button should be present in table');
    click(editBtn);
    await settle();

    const modal = document.querySelector('.personnel-modal');
    assert.ok(modal, 'Edit Shift modal should be open');
    const callout = modal.querySelector('.scheduler-fatigue-callout');
    assert.ok(callout, 'Fatigue callout element should be in edit modal');
    assert.equal(callout.hidden, false, 'Callout should display initial capacity in modal');

    // Close modal
    const closeBtn = modal.querySelector('.personnel-modal__close');
    click(closeBtn);
    await settle();
  });
});

