import { describePage } from '../harness/pageSuite.mjs';
import { describe, test, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { api, mountPage, settle, cleanup, text, click, type, buttonByText, $, $$, window } from '../harness/render.mjs';
import { renderPersonnelPage } from '../../src/pages/personnel.js';
import { getMyAuthority, clearAuthorityCache } from '../../src/services/tanodWorkflowUi.js';

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

async function openScheduler(role = 'admin') {
  const ctx = mountPage(renderPersonnelPage, { role });
  await settle();
  if (role === 'admin') {
    click(tab('Scheduler'));
    await settle();
  }
  return ctx;
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

  test('without approve_roster the Publish bar and draft checkboxes are hidden and a note says why', async () => {
    await openScheduler('admin');
    assert.equal($('#publish-shifts-btn'), null);
    assert.match(text($('.scheduler-publish-bar')), /You do not hold roster approval authority\./);
    // Admin/Secretary without the authority get the paper route instead.
    assert.ok($('#publish-shifts-paper-btn'), 'Recorded-from-paper control is offered');
  });

  test('Recorded from paper: picks a signer holding approve_roster (via directory) + date, then POSTs recorded_from_paper', async () => {
    await openScheduler('admin');
    const dialog = () => $('[role="alertdialog"]');
    $$('tbody input[type="checkbox"]')[0].click();
    await settle();
    click($('#publish-shifts-paper-btn'));
    await settle();
    assert.ok(dialog(), 'the paper dialog opens');
    const call = api.callsTo('GET', '/users/directory').find((c) => c.query?.purpose === 'signer');
    assert.equal(call.query.authority, 'approve_roster');
    assert.equal(api.callsTo('GET', '/users').filter((c) => c.query?.authority).length, 0);
    const options = $$('#confirm-dialog-field-signer option', dialog()).map((o) => text(o));
    assert.deepEqual(options, ['Teresa Magbanua (Punong Barangay)']);
    const future = new Date(Date.now() + 3 * 86400000).toISOString().slice(0, 10);
    type($('#confirm-dialog-field-signedOn', dialog()), future);
    click($$('button', dialog()).at(-1));
    await settle();
    assert.equal(api.callsTo('POST', '/shifts/publish').length, 0, 'a future signing date is refused client-side');
    const today = new Date(Date.now() + 8 * 3600000).toISOString().slice(0, 10);
    type($('#confirm-dialog-field-signedOn', dialog()), today);
    click($$('button', dialog()).at(-1));
    await settle();
    const [pub] = api.callsTo('POST', '/shifts/publish');
    assert.ok(pub, 'POST /shifts/publish was sent');
    assert.deepEqual(pub.body.recorded_from_paper, { signer_user_id: 3, signed_on: today });
    assert.match(text(window.document.body), /recorded from paper/i);
  });

  test('a published shift recorded on paper shows "Approved on paper <date>" with the recorder', async () => {
    api.on('GET', '/shifts', () => ({ status: 200, body: { items: [
      { shift_id: 520, user_id: 4, patrol_zone: 'Zone 1', start_at: '2026-10-20 00:00:00', end_at: '2026-10-20 08:00:00', version: 1, approval_status: 'published', pending_reapproval: 0, approved_by: 3, approved_at: '2026-10-06 01:00:00', source_availability_id: null, approval_mode: 'recorded_from_paper', paper_signed_on: '2026-10-05', paper_recorded_by_name: 'Liwayway Ferrer' },
      { shift_id: 521, user_id: 5, patrol_zone: 'Zone 2', start_at: '2026-10-21 00:00:00', end_at: '2026-10-21 08:00:00', version: 1, approval_status: 'published', pending_reapproval: 0, approved_by: 3, approved_at: '2026-10-06 01:00:00', source_availability_id: null, approval_mode: 'digital', paper_signed_on: null, paper_recorded_by_name: null },
    ], page: 1, limit: 100, total: 2 } }));
    await openScheduler('admin');
    const notes = $$('.text-tertiary').filter((n) => /Approved on paper/.test(text(n))).map((n) => text(n));
    assert.equal(notes.length, 1, 'only the paper-approved shift carries the label');
    assert.match(notes[0], /^Approved on paper Oct 5, 2026 \(recorded by Liwayway Ferrer\)$/);
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

  test('secretary gets the create-shift form and Edit Shift controls; Publish stays authority-gated', async () => {
    mountPage(renderPersonnelPage, { role: 'secretary' });
    await settle();
    assert.ok($('#scheduler-new-start'), 'the Secretary must be able to create shifts');
    assert.ok(buttonByText(/edit shift/i), 'the Secretary must be able to edit shifts');
    assert.equal($('#publish-shifts-btn'), null, 'publishing needs approve_roster, which this Secretary does not hold');
    assert.match(text($('.scheduler-publish-bar')), /You do not hold roster approval authority\./);
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
    assert.equal(api.callsTo('GET', '/shift-swap-requests').length, 1);
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

  test('the availability review panel shows for Secretary, not for Punong Barangay', async () => {
    mountPage(renderPersonnelPage, { role: 'secretary' });
    await settle();
    assert.match(text($('.page-content')), /Availability to review/);
    // One call feeds the review panel (status=submitted); the tanod picker
    // now comes from GET /users/directory, not from availability.
    assert.equal(api.callsTo('GET', '/availability').length, 1);
    assert.equal(api.callsTo('GET', '/availability').filter((c) => c.query?.status === 'submitted').length, 1);
    cleanup();
    mountPage(renderPersonnelPage, { role: 'punong_barangay' });
    await settle();
    assert.doesNotMatch(text($('.page-content')), /Availability to review/);
    assert.equal(api.callsTo('GET', '/availability').length, 0);
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

  test('the Users tab shows official titles and authorities, only for roles that may hold one', async () => {
    mountPage(renderPersonnelPage, { role: 'admin' });
    await settle();
    const body = text($('.page-content'));
    assert.match(body, /Chief Tanod/);
    assert.match(body, /Approve and publish duty roster/);
    const rows = $$('tbody tr');
    const tanodRow = rows.find((r) => /Jose Reyes/.test(text(r)));
    assert.equal(buttonByText(/approval authority/i, tanodRow), undefined, 'a Tanod can never hold an approval authority');
    const kapitanRow = rows.find((r) => /Teresa Magbanua/.test(text(r)));
    assert.ok(buttonByText(/approval authority/i, kapitanRow));
  });

  test('saving approval authority clears the cached authority lookup', async () => {
    mountPage(renderPersonnelPage, { role: 'admin' });
    await settle();
    clearAuthorityCache();
    await getMyAuthority({ userId: 2 });
    await getMyAuthority({ userId: 2 });
    const before = api.callsTo('GET', '/users/:id').length;
    const secretaryRow = $$('tbody tr').find((r) => /Liwayway Ferrer/.test(text(r)));
    click(buttonByText(/approval authority/i, secretaryRow));
    await settle();
    const dialog = $('[role="dialog"]');
    dialog.querySelector('form').dispatchEvent(new window.Event('submit', { bubbles: true, cancelable: true }));
    await settle();
    await getMyAuthority({ userId: 2 });
    assert.equal(api.callsTo('GET', '/users/:id').length, before + 1, 'the next lookup must refetch after a save');
    clearAuthorityCache();
  });

  test('editing approval authority PATCHes official_title + the five-value array with an Idempotency-Key', async () => {
    mountPage(renderPersonnelPage, { role: 'admin' });
    await settle();
    const secretaryRow = $$('tbody tr').find((r) => /Liwayway Ferrer/.test(text(r)));
    click(buttonByText(/approval authority/i, secretaryRow));
    await settle();
    const dialog = $('[role="dialog"]');
    assert.ok(dialog, 'the authority dialog did not open');
    const boxes = $$('input[type="checkbox"]', dialog);
    assert.equal(boxes.length, 5, 'exactly the five authorities from contract §2');
    assert.deepEqual(boxes.filter((b) => b.checked).map((b) => b.value), ['note_report'], 'pre-checked from the account');
    type($('#approval-official-title', dialog), 'Barangay Kagawad');
    const approveRoster = boxes.find((b) => b.value === 'approve_roster');
    approveRoster.checked = true;
    dialog.querySelector('form').dispatchEvent(new window.Event('submit', { bubbles: true, cancelable: true }));
    await settle();
    const [call] = api.callsTo('PATCH', '/users/:id');
    assert.ok(call, 'PATCH /users/:id was not sent');
    assert.equal(call.body.official_title, 'Barangay Kagawad');
    assert.deepEqual(call.body.approval_authority.sort(), ['approve_roster', 'note_report']);
    assert.match(call.headers['idempotency-key'] || '', UUID);
    assert.equal($('[role="dialog"]'), null, 'the dialog closes after saving');
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

  test('publishing: only drafts are selectable; Publish POSTs shift_ids with an Idempotency-Key and shows coverage warnings', async () => {
    grantRosterAuthority();
    await openScheduler('admin');
    const publish = $('#publish-shifts-btn');
    assert.equal(publish.disabled, true, 'nothing selected yet');
    assert.equal($$('tbody input[type="checkbox"]').length, 2, 'only the two draft shifts have a checkbox');
    click(buttonByText(/select all drafts/i));
    assert.equal($('#publish-shifts-btn').disabled, false);
    click($('#publish-shifts-btn'));
    await settle();
    const dialog = $('[role="alertdialog"], [role="dialog"]');
    assert.ok(dialog, 'publishing must be confirmed');
    assert.equal(api.callsTo('POST', '/shifts/publish').length, 0, 'nothing is sent before confirmation');
    click($$('button', dialog).filter((b) => !b.disabled).at(-1));
    await settle();
    const [call] = api.callsTo('POST', '/shifts/publish');
    assert.ok(call, 'POST /shifts/publish was not sent');
    assert.deepEqual(call.body.shift_ids.sort(), [502, 503]);
    assert.match(call.headers['idempotency-key'] || '', UUID);
    assert.match(text($('.scheduler-publish-warnings')), /2026-10-07.*no tanod is scheduled/i);
  });

  test('a publish refused for missing authority shows the server message and sends nothing else', async () => {
    grantRosterAuthority();
    api.on('POST', '/shifts/publish', () => ({ status: 403, body: { error: { code: 'FORBIDDEN', message: 'You are not designated to perform this action.' } } }));
    await openScheduler('admin');
    click(buttonByText(/select all drafts/i));
    click($('#publish-shifts-btn'));
    await settle();
    click($$('button', $('[role="alertdialog"], [role="dialog"]')).filter((b) => !b.disabled).at(-1));
    await settle();
    assert.match(text(window.document.body), /not designated to perform this action/);
    assert.equal($('.scheduler-publish-warnings'), null);
  });

  test('accepting an availability submission PATCHes status accepted with an Idempotency-Key', async () => {
    await openScheduler('admin');
    const panel = $('.availability-panel');
    assert.match(text(panel), /Jose Reyes/, 'the tanod name comes from the roster lookup');
    assert.match(text(panel), /2026-10-05 08:00–16:00/);
    type($('input[type="text"]', panel), 'Looks good');
    click(buttonByText(/^accept$/i, panel));
    await settle();
    const [call] = api.callsTo('PATCH', '/availability/:id');
    assert.ok(call, 'PATCH /availability/:id was not sent');
    assert.equal(call.body.status, 'accepted');
    assert.equal(call.body.review_note, 'Looks good');
    assert.match(call.headers['idempotency-key'] || '', UUID);
  });

  test('"Ask to revise" sends status revised', async () => {
    await openScheduler('admin');
    click(buttonByText(/ask to revise/i, $('.availability-panel')));
    await settle();
    assert.equal(api.callsTo('PATCH', '/availability/:id')[0].body.status, 'revised');
  });

  test('an empty availability queue says so and an availability failure does not blank the shift list', async () => {
    api.on('GET', '/availability', () => ({ status: 200, body: { items: [], page: 1, limit: 25, total: 0 } }));
    await openScheduler('admin');
    assert.match(text($('.availability-panel')), /No availability submissions are waiting/);
    cleanup();
    api.on('GET', '/availability', () => ({ status: 500, body: { error: { code: 'SERVER_ERROR', message: 'Availability is down.' } } }));
    await openScheduler('admin');
    assert.match(text($('.availability-panel')), /Availability is down/);
    assert.ok(buttonByText(/retry/i, $('.availability-panel')));
    assert.ok($$('.shift-approval-pill').length > 0, 'the shift list still renders');
  });

  test('Scheduler form dynamically shows proactive fatigue callout on preset or time change', async () => {
    const ctx = await openScheduler('admin');

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
    const ctx = await openScheduler('admin');

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

  test('Punong Barangay can publish drafts (the server checks approve_roster) but cannot edit them', async () => {
    await openScheduler('punong_barangay');
    assert.ok($('#publish-shifts-btn'));
    assert.equal(buttonByText(/edit shift/i), undefined);
    assert.match(text($('.page-content')), /Tanod #5/, 'an assigned shift shows its id when the roster is unavailable, not "Unassigned"');
  });
});
