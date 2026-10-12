import { describePage } from '../harness/pageSuite.mjs';
import { describe, test, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { api, mountPage, settle, cleanup, text, click, $, $$, signIn } from '../harness/render.mjs';
import { renderApprovalsPage } from '../../src/pages/approvals.js';
import { getPendingApprovalCounts } from '../../src/services/shellWorkflowApi.js';
import { clearAuthorityCache } from '../../src/services/tanodWorkflowUi.js';

describePage({
  name: 'Approvals',
  render: renderApprovalsPage,
  roles: ['admin', 'secretary', 'punong_barangay'],
  heading: 'Approvals',
});

describe('Approvals behaviour', () => {
  afterEach(() => { cleanup(); clearAuthorityCache(); });

  const groupTitles = (root) => $$('.tw-approvals__group .tw-card__title', root).map((n) => text(n));

  test('an admin sees shifts, prepared reports and Annex D, and no signed-paper tracking queues', async () => {
    const ctx = mountPage(renderApprovalsPage, { role: 'admin' });
    await settle();
    const titles = groupTitles(ctx.root);
    assert.ok(!titles.includes('Availability to review'), 'availability is not reviewed (2026-10-12)');
    assert.ok(titles.includes('Shifts awaiting publish'));
    assert.ok(titles.includes('Accomplishment reports prepared'));
    assert.ok(titles.includes('Annex D to prepare'));
    assert.ok(!titles.includes('Accomplishment reports waiting for the signed paper'), 'signatures are not tracked in the app');
    assert.ok(!titles.includes('Annex D waiting for the signed paper'), 'signatures are not tracked in the app');
    assert.ok(!titles.includes('Accomplishment reports to note'));
    assert.ok(!titles.includes('Accomplishment reports to approve'));
    assert.ok(!titles.includes('Annex D to approve'));
  });

  test('Punong Barangay sees only roster publishing, no report queues and no availability review', async () => {
    const ctx = mountPage(renderApprovalsPage, { role: 'punong_barangay' });
    await settle();
    assert.deepEqual(groupTitles(ctx.root), ['Shifts awaiting publish']);
  });

  test('queue counts come from the server and rows deep-link to the right screen', async () => {
    const ctx = mountPage(renderApprovalsPage, { role: 'admin' });
    await settle();
    const group = $('.tw-approvals__group[data-group="reports-prepared"]', ctx.root);
    assert.ok(group, 'prepared reports group present');
    assert.match(text($('.tw-count-badge', group)), /^1$/, 'only the prepared report (71); 72 is returned');
    const opens = $$('.tw-queue__open', group);
    click(opens[0]);
    assert.deepEqual(ctx.navigations.at(-1), { page: 'accomplishment-reports', param: { reportId: 71 } });
    assert.deepEqual(api.callsTo('GET', '/accomplishment-reports').map((c) => c.query.status), ['prepared']);

    const annex = $('.tw-approvals__group[data-group="annex-d"]', ctx.root);
    assert.match(text($('.tw-count-badge', annex)), /^2$/, 'the draft (81) and the prepared (82) Annex D');
    click($('.tw-queue__open', annex));
    assert.equal(ctx.navigations.at(-1).page, 'school-zones');
    assert.equal(ctx.navigations.at(-1).param.tab, 'term');
  });

  test('a viewer with no authority gets an honest empty state, not a blank page', async () => {
    api.on('GET', '/users/:id', () => ({ status: 200, body: { user_id: 3, full_name: 'X', role: 'punong_barangay', official_title: null, approval_authority: [] } }));
    const ctx = mountPage(renderApprovalsPage, { role: 'punong_barangay' });
    await settle();
    assert.deepEqual(groupTitles(ctx.root), []);
    assert.match(text($('.page-content', ctx.root)), /Nothing waiting for you/);
  });

  test('availability is never an approval queue and is not fetched here (2026-10-12)', async () => {
    const ctx = mountPage(renderApprovalsPage, { role: 'admin' });
    await settle();
    assert.equal($('.tw-approvals__group[data-group="availability"]', ctx.root), null);
    assert.equal(api.callsTo('GET', '/availability').length, 0);
  });

  test('an Admin/Secretary-only queue is role gated even without any authority', async () => {
    api.on('GET', '/users/:id', () => ({ status: 200, body: { user_id: 2, full_name: 'X', role: 'secretary', official_title: null, approval_authority: [] } }));
    const ctx = mountPage(renderApprovalsPage, { role: 'secretary' });
    await settle();
    assert.deepEqual(groupTitles(ctx.root), [
      'Shifts awaiting publish',
      'Accomplishment reports prepared',
      'Annex D to prepare',
    ]);
  });

  test('dashboard widget counts: prepared reports, Annex D to prepare or submit, and draft shifts', async () => {
    signIn('admin');
    const admin = await getPendingApprovalCounts(['note_report', 'prepare_annex_d'], 'admin');
    assert.deepEqual(admin.map((c) => c.key).sort(), ['annex-d', 'reports-prepared', 'roster']);
    assert.equal(admin.find((c) => c.key === 'annex-d').count, 2);
    const ssz = api.callsTo('GET', '/ssz-term-reports').map((c) => c.query.status).sort();
    assert.deepEqual(ssz, ['draft', 'prepared']);
    const pb = await getPendingApprovalCounts(['approve_report', 'approve_roster', 'approve_annex_d'], 'punong_barangay');
    assert.deepEqual(pb.map((c) => c.key), ['roster'], 'the PB only sees roster publishing');
  });
});
