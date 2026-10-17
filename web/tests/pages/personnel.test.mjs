import { describePage } from '../harness/pageSuite.mjs';
import { describe, test, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { api, mountPage, settle, cleanup, text, click, type, buttonByText, $, $$, window } from '../harness/render.mjs';
import { renderPersonnelPage } from '../../src/pages/personnel.js';
import { getMyAuthority, clearAuthorityCache, manilaToday } from '../../src/services/tanodWorkflowUi.js';
import { weekStartOf, addDays } from '../../src/services/rosterWeek.js';

describePage({
  name: 'Personnel',
  render: renderPersonnelPage,
  // Admin: Users / Scheduler / Swap requests. Secretary and Punong Barangay
  // land on the Scheduler tab (availability review / roster publishing).
  roles: ['admin', 'secretary', 'punong_barangay'],
  heading: 'Personnel',
});

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const tabLabels = () => $$('.page-tab').map((b) => text(b).replace(/\d+$/, '').trim());
const tab = (label) => $$('.page-tab').find((b) => new RegExp(label, 'i').test(text(b)));

// The Scheduler opens on the week grid; most older tests exercise the list.
async function openScheduler(role = 'admin', { view = 'list' } = {}) {
  const ctx = mountPage(renderPersonnelPage, { role });
  await settle();
  if (role === 'admin') {
    click(tab('Scheduler'));
    await settle();
  }
  if (view === 'list') await showList();
  return ctx;
}

async function showList() {
  click($$('.scheduler-view-toggle button').find((b) => text(b) === 'List'));
  await settle();
}

// Fixed shifts/availability in the CURRENT Manila week, so the grid tests do
// not depend on the day they run. Times are wire-format UTC (Manila - 8h).
const WEEK = weekStartOf(manilaToday());
const day = (n) => addDays(WEEK, n);
const utc = (date, hhmm) => {
  const [y, m, d] = date.split('-').map(Number);
  const [hh, mm] = hhmm.split(':').map(Number);
  return new Date(Date.UTC(y, m - 1, d, hh - 8, mm)).toISOString().slice(0, 19).replace('T', ' ');
};
function useWeekData({ shifts, availability } = {}) {
  const shiftRows = shifts ?? [
    // Mon morning for Jose Reyes (inside availability), draft
    { shift_id: 601, user_id: 4, patrol_zone: 'Zone 1', start_at: utc(day(0), '06:00'), end_at: utc(day(0), '14:00'), version: 1, approval_status: 'draft', pending_reapproval: 0 },
    // Tue afternoon for Jose Reyes (outside availability), published
    { shift_id: 602, user_id: 4, patrol_zone: null, start_at: utc(day(1), '14:00'), end_at: utc(day(1), '22:00'), version: 2, approval_status: 'published', pending_reapproval: 0 },
    // Last week's Wed morning for Maria Dela Cruz (copy source)
    { shift_id: 603, user_id: 5, patrol_zone: 'Market', start_at: utc(addDays(WEEK, -5), '06:00'), end_at: utc(addDays(WEEK, -5), '14:00'), version: 1, approval_status: 'published', pending_reapproval: 0 },
    // Last week's Thu morning for Maria Dela Cruz (she is not available this Thu)
    { shift_id: 604, user_id: 5, patrol_zone: null, start_at: utc(addDays(WEEK, -4), '06:00'), end_at: utc(addDays(WEEK, -4), '14:00'), version: 1, approval_status: 'published', pending_reapproval: 0 },
  ];
  const availRows = availability ?? [
    { avail_id: 81, user_id: 4, full_name: 'Jose Reyes', period_start: WEEK, period_end: day(6), windows_json: [{ date: day(0), start: '06:00', end: '18:00' }, { date: day(2), start: '06:00', end: '14:00' }], status: 'submitted', version: 1 },
    { avail_id: 82, user_id: 5, full_name: 'Maria Dela Cruz', period_start: WEEK, period_end: day(6), windows_json: [{ date: day(2), start: '06:00', end: '14:00' }], status: 'submitted', version: 1 },
  ];
  api.on('GET', '/shifts', () => ({ status: 200, body: { items: shiftRows, page: 1, limit: 100, total: shiftRows.length } }));
  api.on('GET', '/availability', () => ({ status: 200, body: { items: availRows, page: 1, limit: 100, total: availRows.length } }));
}

// The fixture Admin holds no roster authority; give them approve_roster for
// the tests that publish (the Publish controls are authority-gated).
function grantRosterAuthority() {
  api.on('GET', '/users/:id', ({ params }) => ({
    status: 200,
    body: { user_id: Number(params.id), full_name: 'Ramon Elcano', role: 'admin', official_title: 'Chief Tanod', approval_authority: ['approve_roster'], is_active: 1, is_suspended: 0 },
  }));
}

describe('Personnel behaviour', () => {
  afterEach(() => cleanup());

  test('the Admin sees a plain Publish button and the print-and-sign reminder', async () => {
    await openScheduler('admin');
    assert.equal($('#publish-shifts-paper-btn'), null, 'no signed-paper publish any more');
    assert.match(text($('#publish-shifts-btn')), /^Publish \(0\)$/);
    assert.match(text($('.scheduler-publish-bar')), /Print the schedule and have it signed on paper/);
    assert.doesNotMatch(text(window.document.body), /signed paper/i);
  });

  test('Publish: a simple confirm (no signer or date), then POST /shifts/publish with only shift_ids', async () => {
    await openScheduler('admin');
    const dialog = () => $('[role="alertdialog"]');
    $$('tbody input[type="checkbox"]')[0].click();
    await settle();
    click($('#publish-shifts-btn'));
    await settle();
    assert.ok(dialog(), 'the confirm dialog opens');
    assert.equal($('#confirm-dialog-field-signer', dialog()), null, 'no signer picker');
    assert.equal($('#confirm-dialog-field-signedOn', dialog()), null, 'no signed-on date');
    assert.equal(api.callsTo('GET', '/users/directory').filter((c) => c.query?.purpose === 'signer').length, 0);
    assert.equal(api.callsTo('POST', '/shifts/publish').length, 0, 'nothing is sent before confirmation');
    click($$('button', dialog()).filter((b) => !b.disabled).at(-1));
    await settle();
    const [pub] = api.callsTo('POST', '/shifts/publish');
    assert.ok(pub, 'POST /shifts/publish was sent');
    assert.equal(pub.body.recorded_from_paper, undefined);
    assert.deepEqual(Object.keys(pub.body), ['shift_ids']);
  });

  test('Admin sees Users, Scheduler and Swap requests, and no Fatigue tab (contract §10)', async () => {
    mountPage(renderPersonnelPage, { role: 'admin' });
    await settle();
    for (const label of ['Users', 'Scheduler', 'Swap']) assert.ok(tab(label), `missing ${label} tab (have: ${tabLabels().join(', ')})`);
    assert.equal(tab('Fatigue'), undefined, 'the Fatigue tab must be gone from the hub');
  });

  test('punong_barangay sees the Scheduler tab only; no user roster is pulled and shifts cannot be created or edited', async () => {
    mountPage(renderPersonnelPage, { role: 'punong_barangay' });
    await settle();
    assert.deepEqual(tabLabels(), ['Scheduler']);
    assert.equal(api.callsTo('GET', '/users').length, 0, 'GET /users is Admin-only; this role must not call it');
    assert.equal($('#scheduler-new-start'), null, 'a Punong Barangay may not create shifts');
    assert.equal(buttonByText(/edit shift/i), undefined, 'a Punong Barangay may not edit shifts');
    assert.equal(buttonByText(/swap requests/i), undefined, 'no Swap requests entry for a Punong Barangay');
  });

  test('secretary sees Scheduler and Swap requests tabs, never Users (2026-10-07)', async () => {
    mountPage(renderPersonnelPage, { role: 'secretary' });
    await settle();
    assert.deepEqual(tabLabels(), ['Scheduler', 'Swap requests']);
    assert.equal(api.callsTo('GET', '/users').length, 0, 'GET /users is Admin-only; the Secretary must not call it');
  });

  test('secretary gets the create-shift form and Edit Shift controls and can publish', async () => {
    mountPage(renderPersonnelPage, { role: 'secretary' });
    await settle();
    await showList();
    assert.ok($('#scheduler-new-start'), 'the Secretary must be able to create shifts');
    assert.ok(buttonByText(/edit shift/i), 'the Secretary must be able to edit shifts');
    assert.ok($('#publish-shifts-btn'));
  });

  test('the shift picker is built from GET /users/directory?purpose=roster (no GET /users) and names the Chief Tanod', async () => {
    mountPage(renderPersonnelPage, { role: 'secretary' });
    await settle();
    const options = $$('#scheduler-new-tanod option').map((o) => text(o));
    assert.equal(options.length, 3, 'the Chief Tanod (admin) plus the two active, non-suspended tanods');
    assert.ok(options.some((o) => /Jose Reyes/.test(o)));
    assert.ok(options.some((o) => /Maria Dela Cruz/.test(o)));
    assert.ok(options.some((o) => /Ramon Elcano - Chief Tanod/.test(o)), 'the Chief Tanod is labelled by official title');
    assert.equal(options.filter((o) => /Liwayway|Teresa/.test(o)).length, 0, 'secretary / PB are never rosterable');
    assert.equal(api.callsTo('GET', '/users').length, 0);
    assert.equal(api.callsTo('GET', '/users/directory').filter((c) => c.query?.purpose === 'roster').length >= 1, true);
    assert.equal(api.callsTo('GET', '/users/directory').filter((c) => c.query?.purpose === 'tanod').length, 0, 'the Scheduler no longer asks for tanods only');
  });

  test('Admin also uses the roster directory for the shift picker', async () => {
    await openScheduler('admin');
    assert.equal(api.callsTo('GET', '/users/directory').filter((c) => c.query?.purpose === 'roster').length >= 1, true);
    assert.equal($$('#scheduler-new-tanod option').length, 3);
  });

  test('the edit-shift picker also offers the Chief Tanod', async () => {
    mountPage(renderPersonnelPage, { role: 'secretary' });
    await settle();
    await showList();
    click(buttonByText(/edit shift/i));
    await settle();
    const opts = $$('select option', $('.personnel-modal')).map((o) => text(o));
    assert.ok(opts.some((o) => /Ramon Elcano - Chief Tanod/.test(o)));
  });

  test('a Secretary-created shift is POSTed as a draft with the chosen tanod', async () => {
    mountPage(renderPersonnelPage, { role: 'secretary' });
    await settle();
    const select = $('#scheduler-new-tanod');
    select.value = '5';
    type($('#scheduler-new-start'), '2026-10-12T08:00');
    type($('#scheduler-new-end'), '2026-10-12T16:00');
    $('#scheduler-new-start').closest('form').dispatchEvent(new window.Event('submit', { bubbles: true, cancelable: true }));
    await settle();
    const [call] = api.callsTo('POST', '/shifts');
    assert.ok(call, 'POST /shifts was not sent');
    assert.equal(call.body.user_id, 5);
    assert.match(text(window.document.body), /Shift saved as a draft\./);
  });

  test('the tanod picker says so when the directory has no active tanods', async () => {
    api.on('GET', '/users/directory', () => ({ status: 200, body: { items: [] } }));
    mountPage(renderPersonnelPage, { role: 'secretary' });
    await settle();
    assert.match(text($('.page-content')), /No active Tanods exist/);
    assert.equal($('#scheduler-new-start').closest('form').hidden, true, 'the form is hidden when there is nobody to assign');
  });

  test('editing a shift whose tanod is not in the Secretary list keeps that tanod selected (never silently unassigns)', async () => {
    api.on('GET', '/users/directory', () => ({ status: 200, body: { items: [] } }));
    const ctx = mountPage(renderPersonnelPage, { role: 'secretary' });
    await settle();
    await showList();
    const rows = $$('tbody tr', ctx.root).filter((r) => /Tanod #4/.test(text(r)));
    click(buttonByText(/edit shift/i, rows[0]));
    await settle();
    const modal = $('.personnel-modal');
    const select = $('select', modal);
    assert.equal(select.value, '4');
    assert.match(text($('option:checked', select)), /Tanod #4 \(current\)/);
  });

  test('a shift awaiting re-approval after a swap is labelled as such (pending_reapproval)', async () => {
    api.on('GET', '/shifts', () => ({ status: 200, body: { items: [
      { shift_id: 510, user_id: 4, patrol_zone: 'Zone 1', start_at: '2026-10-20 00:00:00', end_at: '2026-10-20 08:00:00', version: 3, approval_status: 'draft', pending_reapproval: 1, approved_by: null, approved_at: null, source_availability_id: null },
      { shift_id: 511, user_id: 5, patrol_zone: 'Zone 2', start_at: '2026-10-21 00:00:00', end_at: '2026-10-21 08:00:00', version: 1, approval_status: 'draft', pending_reapproval: 0, approved_by: null, approved_at: null, source_availability_id: null },
    ], page: 1, limit: 100, total: 2 } }));
    await openScheduler('admin');
    const pills = $$('.shift-approval-pill').map((p) => text(p));
    assert.deepEqual(pills.sort(), ['Draft', 'Draft — swap awaiting re-approval']);
  });

  test('secretary Swap requests tab loads without GET /users and approves a swap', async () => {
    const ctx = mountPage(renderPersonnelPage, { role: 'secretary' });
    await settle();
    click(tab('Swap'));
    await settle();
    assert.equal(api.callsTo('GET', '/users').length, 0, 'GET /users is Admin-only');
    assert.ok(api.callsTo('GET', '/shift-swap-requests').length >= 1); // the page walks all pages (audit F-09)
    assert.match(text($('.page-content')), /Jose Reyes|Maria Dela Cruz/, 'names come from availability');
    click(buttonByText(/^approve$/i, ctx.root));
    await settle();
    const dialog = $('[role="alertdialog"]');
    if (dialog) { click($$('button', dialog).at(-1)); await settle(); }
    const [call] = api.callsTo('PATCH', '/shift-swap-requests/:id');
    assert.ok(call, 'PATCH /shift-swap-requests/:id was not sent');
    assert.equal(call.body.status, 'approved');
  });

  test('the Scheduler header offers a Swap requests shortcut to Admin and Secretary, not Punong Barangay', async () => {
    const ctx = mountPage(renderPersonnelPage, { role: 'secretary' });
    await settle();
    assert.ok(buttonByText(/swap requests/i, $('.page-header', ctx.root) ?? ctx.root));
  });

  test('availability is fixed: no review panel, no accept/revise, and every submission is read for the grid', async () => {
    mountPage(renderPersonnelPage, { role: 'secretary' });
    await settle();
    assert.doesNotMatch(text($('.page-content')), /Availability to review/);
    assert.equal(buttonByText(/^accept$/i), undefined);
    assert.equal(buttonByText(/ask to revise/i), undefined);
    const calls = api.callsTo('GET', '/availability');
    assert.ok(calls.length >= 1);
    assert.equal(calls.filter((c) => c.query?.status).length, 0, 'any status: availability is shown as given');
    assert.equal(api.callsTo('PATCH', '/availability/:id').length, 0);
  });

  test('an object param ({ tab }) opens that tab, as the Approvals page sends it', async () => {
    const ctx = mountPage(renderPersonnelPage, { role: 'admin', param: { tab: 'scheduler' } });
    await settle();
    assert.ok(tab('Scheduler').classList.contains('is-active'));
    assert.ok(ctx.root);
    cleanup();
    mountPage(renderPersonnelPage, { role: 'admin', param: { userId: 5 } });
    await settle();
    assert.ok(tab('Users').classList.contains('is-active'), 'an unrelated object param falls back to the first tab');
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

  test('the Users tab has no approval-authority column or button (Admin and Secretary hold sign-off by role)', async () => {
    mountPage(renderPersonnelPage, { role: 'admin' });
    await settle();
    assert.doesNotMatch(text($('.page-content')), /Title & authority|Sign and publish the duty roster/);
    assert.equal(buttonByText(/approval authority/i, $('.page-content')), undefined);
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

  test('a new shift is created as a draft and the form says so (contract §3)', async () => {
    await openScheduler('admin');
    assert.match(text($('#scheduler-new-start').closest('form')), /saved as drafts/i);
    type($('#scheduler-new-start'), '2026-10-12T08:00');
    type($('#scheduler-new-end'), '2026-10-12T16:00');
    $('#scheduler-new-start').closest('form').dispatchEvent(new window.Event('submit', { bubbles: true, cancelable: true }));
    await settle();
    assert.equal(api.callsTo('POST', '/shifts').length, 1);
    assert.match(text(window.document.body), /Shift saved as a draft\./);
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
    const ctx = await openScheduler('admin');

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

  test('Scheduler marks every shift Draft or Published from the server value', async () => {
    await openScheduler('admin');
    const pills = $$('.shift-approval-pill').map((p) => text(p));
    assert.equal(pills.filter((p) => p === 'Draft').length, 2);
    assert.equal(pills.filter((p) => p === 'Published').length, 2);
  });

  test('publishing: only drafts are selectable; the PB publishes after a plain confirm and the POST carries shift_ids and an Idempotency-Key', async () => {
    await openScheduler('punong_barangay');
    const publish = $('#publish-shifts-btn');
    assert.equal(publish.disabled, true, 'nothing selected yet');
    assert.equal($$('tbody input[type="checkbox"]').length, 2, 'only the two draft shifts have a checkbox');
    click(buttonByText(/select all drafts/i));
    assert.equal($('#publish-shifts-btn').disabled, false);
    click($('#publish-shifts-btn'));
    await settle();
    const dialog = $('[role="alertdialog"], [role="dialog"]');
    assert.ok(dialog, 'publishing asks for a confirmation');
    assert.equal(api.callsTo('POST', '/shifts/publish').length, 0, 'nothing is sent before confirmation');
    click($$('button', dialog).filter((b) => !b.disabled).at(-1));
    await settle();
    const [call] = api.callsTo('POST', '/shifts/publish');
    assert.ok(call, 'POST /shifts/publish was not sent');
    assert.deepEqual(call.body.shift_ids.sort(), [502, 503]);
    assert.match(call.headers['idempotency-key'] || '', UUID);
    assert.match(text($('.scheduler-publish-warnings')), /2026-10-07.*no tanod is scheduled/i);
  });

  test('a publish refused by the server shows the server message and sends nothing else', async () => {
    api.on('POST', '/shifts/publish', () => ({ status: 403, body: { error: { code: 'FORBIDDEN', message: 'You are not designated to perform this action.' } } }));
    await openScheduler('punong_barangay');
    click(buttonByText(/select all drafts/i));
    click($('#publish-shifts-btn'));
    await settle();
    const dialog = $('[role="alertdialog"], [role="dialog"]');
    click($$('button', dialog).filter((b) => !b.disabled).at(-1));
    await settle();
    assert.match(text(window.document.body), /not designated to perform this action/);
    assert.equal($('.scheduler-publish-warnings'), null);
    assert.equal(api.callsTo('POST', '/shifts/publish').length, 1);
  });

  test('Scheduler create form has no fatigue callout and no "[Over Limit]" labels (fatigue removed)', async () => {
    const ctx = await openScheduler('admin');

    const morningPreset = buttonByText(/Morning/i, ctx.root);
    assert.ok(morningPreset, 'Morning preset should be available');
    click(morningPreset);
    await settle();

    assert.equal(ctx.root.querySelector('.scheduler-fatigue-callout'), null, 'no fatigue callout may exist');
    assert.doesNotMatch(text(ctx.root), /fatigue|Over Limit|Near Limit|56h/i);
  });

  test('Edit Shift modal shows no fatigue callout (fatigue removed)', async () => {
    const ctx = await openScheduler('admin');

    const editBtn = buttonByText(/Edit Shift/i, ctx.root);
    assert.ok(editBtn, 'Edit Shift button should be present in table');
    click(editBtn);
    await settle();

    const modal = document.querySelector('.personnel-modal');
    assert.ok(modal, 'Edit Shift modal should be open');
    assert.equal(modal.querySelector('.scheduler-fatigue-callout'), null, 'no fatigue callout in the edit modal');
    assert.doesNotMatch(text(modal), /fatigue|Over Limit|Near Limit|56h/i);

    // Close modal
    const closeBtn = modal.querySelector('.personnel-modal__close');
    click(closeBtn);
    await settle();
  });

  test('Punong Barangay can publish drafts (the server checks approve_roster) but cannot edit them', async () => {
    await openScheduler('punong_barangay');
    assert.ok($('#publish-shifts-btn'));
    assert.equal(buttonByText(/edit shift/i), undefined);
    assert.match(text($('.page-content')), /Tanod #5/, 'an assigned shift shows its id when the roster is unavailable, not "Unassigned"');
  });
  test('a hand-built shift sends no source_availability_id', async () => {
    await openScheduler('admin');
    type($('#scheduler-new-start'), '2026-10-12T08:00');
    type($('#scheduler-new-end'), '2026-10-12T16:00');
    $('#scheduler-new-start').closest('form').dispatchEvent(new window.Event('submit', { bubbles: true, cancelable: true }));
    await settle();
    assert.equal('source_availability_id' in api.callsTo('POST', '/shifts')[0].body, false);
  });

  test('the Edit Shift dialog has a name, a labelled close button and labelled fields', async () => {
    const ctx = await openScheduler('admin');
    click(buttonByText(/Edit Shift/i, ctx.root));
    await settle();
    const modal = document.querySelector('.personnel-modal');
    const titleId = modal.getAttribute('aria-labelledby');
    assert.ok(titleId && document.getElementById(titleId), 'dialog is named by its heading');
    assert.equal(modal.querySelector('.personnel-modal__close').getAttribute('aria-label'), 'Close');
    for (const id of ['scheduler-edit-tanod', 'scheduler-edit-zone', 'scheduler-edit-start', 'scheduler-edit-end']) {
      assert.ok(modal.querySelector(`label[for="${id}"]`) && modal.querySelector(`#${id}`), `${id} is labelled`);
    }
    click(modal.querySelector('.personnel-modal__close'));
  });

  test('the active Personnel tab is exposed with aria-current, not by colour alone', async () => {
    mountPage(renderPersonnelPage, { role: 'admin' });
    await settle();
    assert.equal(tab('Users').getAttribute('aria-current'), 'page');
    click(tab('Scheduler'));
    await settle();
    assert.equal(tab('Scheduler').getAttribute('aria-current'), 'page');
    assert.equal(tab('Users').getAttribute('aria-current'), null);
  });

});

describe('Scheduler week grid', () => {
  afterEach(() => cleanup());

  const gridRow = (name) => $$('.week-grid__row').find((r) => text($('.week-grid__name', r)) === name);
  const cell = (name, dayIndex) => $$('.week-grid__cell', gridRow(name))[dayIndex];
  const dialog = () => $('[role="alertdialog"], [role="dialog"]');
  const confirm = async () => { click($$('button', dialog()).filter((b) => !b.disabled).at(-1)); await settle(); };
  function drop(target, shiftId) {
    const ev = new window.Event('drop', { bubbles: true, cancelable: true });
    Object.defineProperty(ev, 'dataTransfer', { value: { getData: () => String(shiftId) } });
    target.dispatchEvent(ev);
  }

  test('opens on the week: a row per rostered tanod, fixed availability shaded, coverage per day', async () => {
    useWeekData();
    await openScheduler('admin', { view: 'week' });
    assert.ok($('.week-grid'), 'the week grid is the default view');
    assert.ok(gridRow('Jose Reyes') && gridRow('Maria Dela Cruz'), 'every rostered tanod gets a row');
    assert.ok(gridRow('Ramon Elcano'), 'the Chief Tanod is rosterable too');
    assert.match($('.week-grid__avail', cell('Jose Reyes', 0)).title, /Available 06:00–18:00/);
    assert.ok(cell('Maria Dela Cruz', 0).classList.contains('is-unavailable'), 'no availability that day is hatched');
    const coverage = $$('.week-grid__coverage').map((c) => text(c));
    assert.equal(coverage[0], '1/3', 'Monday has only the morning covered');
    assert.match(text($('.scheduler-week-toolbar__label')), /–/);
  });

  test('a shift outside the tanod\'s availability is flagged; one inside is not', async () => {
    useWeekData();
    await openScheduler('admin', { view: 'week' });
    const inside = $('.shift-chip[data-shift-id="601"]');
    const outside = $('.shift-chip[data-shift-id="602"]');
    assert.ok(inside.classList.contains('shift-chip--draft'));
    assert.equal(inside.classList.contains('shift-chip--warn'), false);
    assert.ok(outside.classList.contains('shift-chip--warn'));
    assert.match(outside.title, /outside availability/);
    assert.equal(text($('.week-grid__hours', gridRow('Jose Reyes'))), '16', 'week hours per tanod');
  });

  test('more than 56 hours in a week is no longer flagged (fatigue removed); the hours cell is just a number', async () => {
    const shifts = [0, 1, 2, 3, 4, 5, 6, 6].map((d, i) => ({
      shift_id: 700 + i, user_id: 4, patrol_zone: null,
      start_at: utc(day(d), i === 7 ? '18:00' : '06:00'), end_at: utc(day(d), i === 7 ? '22:00' : '14:00'),
      version: 1, approval_status: 'draft', pending_reapproval: 0,
    }));
    useWeekData({ shifts });
    await openScheduler('admin', { view: 'week' });
    assert.equal($('.shift-chip[data-shift-id="707"]').classList.contains('shift-chip--danger'), false);
    assert.equal($('.week-grid__hours', gridRow('Jose Reyes')).classList.contains('is-over'), false);
    assert.doesNotMatch(text($('.week-grid__legend')), /56|a week/i);
  });

  test('more than 12 hours in one Manila day is still flagged red (the 12 h/day cap stays)', async () => {
    const shifts = [
      { shift_id: 710, user_id: 4, patrol_zone: null, start_at: utc(day(0), '06:00'), end_at: utc(day(0), '14:00'), version: 1, approval_status: 'draft', pending_reapproval: 0 },
      { shift_id: 711, user_id: 4, patrol_zone: null, start_at: utc(day(0), '14:00'), end_at: utc(day(0), '22:00'), version: 1, approval_status: 'draft', pending_reapproval: 0 },
    ];
    useWeekData({ shifts });
    await openScheduler('admin', { view: 'week' });
    assert.ok($('.shift-chip[data-shift-id="711"]').classList.contains('shift-chip--danger'));
    assert.match(text($('.week-grid__legend')), /12 h in one day/);
  });

  test('+ adds the chosen standard shift as a draft, linked to the availability that covers it', async () => {
    useWeekData();
    await openScheduler('admin', { view: 'week' });
    click($('.week-grid__add', cell('Jose Reyes', 2)));
    await settle();
    assert.equal(dialog(), null, 'no question when the tanod is available');
    const [call] = api.callsTo('POST', '/shifts');
    assert.ok(call, 'POST /shifts was not sent');
    assert.equal(call.body.user_id, 4);
    assert.equal(call.body.start_at, `${day(2)}T06:00`);
    assert.equal(call.body.end_at, `${day(2)}T14:00`);
    assert.equal(call.body.source_availability_id, 81);
    assert.match(call.body.request_id, UUID);
  });

  test('the Night preset ends at 06:00 the next day', async () => {
    useWeekData({ availability: [
      { avail_id: 83, user_id: 4, full_name: 'Jose Reyes', period_start: WEEK, period_end: day(6), windows_json: [{ date: day(3), start: '22:00', end: '23:59' }, { date: day(4), start: '00:00', end: '06:00' }], status: 'submitted', version: 1 },
    ] });
    await openScheduler('admin', { view: 'week' });
    click($$('.scheduler-week-toolbar__tools .filter-chip').find((b) => /^Night/.test(text(b))));
    await settle();
    click($('.week-grid__add', cell('Jose Reyes', 3)));
    await settle();
    assert.equal(dialog(), null, 'Jose Reyes is available that night, so no question');
    const [call] = api.callsTo('POST', '/shifts');
    assert.equal(call.body.start_at, `${day(3)}T22:00`);
    assert.equal(call.body.end_at, `${day(4)}T06:00`);
  });

  test('adding a shift where the tanod is not available is refused and sends nothing (availability is fixed)', async () => {
    useWeekData();
    await openScheduler('admin', { view: 'week' });
    click($('.week-grid__add', cell('Maria Dela Cruz', 0)));
    await settle();
    assert.equal(dialog(), null, 'no "add anyway" question');
    assert.match(text(window.document.body), /not available/);
    assert.equal(api.callsTo('POST', '/shifts').length, 0);
  });

  test('a server refusal (12h/day cap) is shown and nothing else changes', async () => {
    useWeekData();
    api.on('POST', '/shifts', () => ({ status: 422, body: { error: { code: 'DAILY_HOURS_EXCEEDED', message: 'Daily scheduled hours exceed 12.' } } }));
    await openScheduler('admin', { view: 'week' });
    click($('.week-grid__add', cell('Jose Reyes', 2)));
    await settle();
    assert.match(text(window.document.body), /Daily scheduled hours exceed 12/);
  });

  test('Copy last week repeats last week\'s shifts where the tanod is available and skips the rest', async () => {
    useWeekData();
    await openScheduler('admin', { view: 'week' });
    click($('#scheduler-copy-week-btn'));
    await settle();
    assert.match(text(dialog()), /Copy 1 shift/);
    assert.match(text(dialog()), /1 skipped because the tanod is not available/);
    assert.equal(api.callsTo('POST', '/shifts').length, 0, 'nothing before confirmation');
    await confirm();
    const calls = api.callsTo('POST', '/shifts');
    assert.equal(calls.length, 1);
    assert.equal(calls[0].body.user_id, 5);
    assert.equal(calls[0].body.patrol_zone, 'Market');
    assert.equal(calls[0].body.start_at, `${day(2)}T06:00`);
    assert.equal(calls[0].body.source_availability_id, 82);
    assert.match(text(window.document.body), /Copied 1 shift from last week/);
  });

  test('dragging a chip to another tanod and day PATCHes the shift with its version, after confirming', async () => {
    useWeekData();
    await openScheduler('admin', { view: 'week' });
    assert.equal($('.shift-chip[data-shift-id="601"]').draggable, true);
    drop(cell('Maria Dela Cruz', 2), 601);
    await settle();
    assert.equal(api.callsTo('PATCH', '/shifts/:id').length, 0, 'nothing before confirmation');
    await confirm();
    const [call] = api.callsTo('PATCH', '/shifts/:id');
    assert.ok(call, 'PATCH /shifts/:id was not sent');
    assert.equal(call.body.user_id, 5);
    assert.equal(call.body.start_at, `${day(2)}T06:00`);
    assert.equal(call.body.end_at, `${day(2)}T14:00`);
    assert.equal(call.body.version, 1);
  });

  test('moving a published shift warns that it goes back to draft', async () => {
    useWeekData({ availability: [
      { avail_id: 81, user_id: 4, full_name: 'Jose Reyes', period_start: WEEK, period_end: day(6), windows_json: [{ date: day(0), start: '06:00', end: '23:59' }], status: 'submitted', version: 1 },
    ] });
    await openScheduler('admin', { view: 'week' });
    drop(cell('Jose Reyes', 0), 602);
    await settle();
    assert.match(text(dialog()), /back to draft/);
  });

  test('moving a shift to a tanod who is not available then is refused and sends nothing', async () => {
    useWeekData();
    await openScheduler('admin', { view: 'week' });
    drop(cell('Jose Reyes', 2), 602);
    await settle();
    assert.equal(dialog(), null);
    assert.match(text(window.document.body), /not available/);
    assert.equal(api.callsTo('PATCH', '/shifts/:id').length, 0);
  });

  test('a chip opens the Edit Shift dialog', async () => {
    useWeekData();
    await openScheduler('admin', { view: 'week' });
    click($('.shift-chip[data-shift-id="601"]'));
    await settle();
    assert.ok($('.personnel-modal'));
    assert.equal($('#scheduler-edit-tanod').value, '4');
  });

  test('Publish week publishes every draft of the shown week in one step after a plain confirm', async () => {
    useWeekData();
    await openScheduler('admin', { view: 'week' });
    const btn = $('#publish-week-btn');
    assert.match(text(btn), /^Publish week \(1\)$/);
    assert.equal($('#publish-week-paper-btn'), null);
    click(btn);
    await settle();
    assert.equal($('#confirm-dialog-field-signer', dialog()), null, 'no signer picker');
    assert.equal($('#confirm-dialog-field-signedOn', dialog()), null, 'no signed-on date');
    await confirm();
    const [pub] = api.callsTo('POST', '/shifts/publish');
    assert.ok(pub, 'POST /shifts/publish was sent');
    assert.deepEqual(pub.body.shift_ids, [601]);
    assert.equal(pub.body.recorded_from_paper, undefined);
  });

  test('Previous / Next week move the grid and This week comes back', async () => {
    useWeekData();
    await openScheduler('admin', { view: 'week' });
    const label = () => text($('.scheduler-week-toolbar__label'));
    const start = label();
    click(buttonByText(/previous week/i));
    await settle();
    assert.notEqual(label(), start);
    assert.ok($('.shift-chip[data-shift-id="603"]'), 'last week shows last week\'s shifts');
    click(buttonByText(/^this week$/i));
    await settle();
    assert.equal(label(), start);
  });

  test('the A4 print of the week is a grid with names, times and signature lines', async () => {
    useWeekData();
    const ctx = await openScheduler('admin', { view: 'week' });
    click(ctx.root.querySelector('#preview-schedule-print-btn'));
    await settle();
    const sheet = document.querySelector('#printable-week-roster-sheet');
    assert.ok(sheet, 'the weekly sheet is mounted');
    assert.match(text(sheet), /WEEKLY DUTY ROSTER/);
    assert.match(text(sheet), /Jose Reyes/);
    assert.match(text(sheet), /06:00–14:00/);
    assert.match(text(sheet), /Punong Barangay/);
    click(document.querySelector('#close-print-modal'));
  });

  test('if availability cannot be loaded the grid still shows the shifts and says so', async () => {
    useWeekData();
    api.on('GET', '/availability', () => ({ status: 500, body: { error: { code: 'SERVER_ERROR', message: 'Availability is down.' } } }));
    await openScheduler('admin', { view: 'week' });
    assert.ok($('.shift-chip[data-shift-id="601"]'));
    assert.match(text($('.page-content')), /availability could not be loaded/i);
    assert.equal($$('.shift-chip--warn').length, 0, 'no warnings without availability');
  });

  test('Punong Barangay sees the week read-only and publishes the week', async () => {
    useWeekData();
    await openScheduler('punong_barangay', { view: 'week' });
    assert.ok($('.week-grid'));
    assert.equal($$('.week-grid__add').length, 0, 'no adding');
    assert.equal($$('button.shift-chip').length, 0, 'chips are not editable');
    assert.equal($('#scheduler-copy-week-btn'), null);
    assert.ok($('#publish-week-btn'));
    assert.match(text($('.page-content')), /Jose Reyes/, 'names come from the availability rows');
  });
});
