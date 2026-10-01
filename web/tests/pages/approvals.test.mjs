import { describePage } from '../harness/pageSuite.mjs';
import { describe, test, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { api, mountPage, settle, cleanup, text, click, $, $$ } from '../harness/render.mjs';
import { renderApprovalsPage } from '../../src/pages/approvals.js';
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

  test('shows only the queues the viewer holds the authority for (admin: review + Annex D prepare)', async () => {
    const ctx = mountPage(renderApprovalsPage, { role: 'admin' });
    await settle();
    const titles = groupTitles(ctx.root);
    assert.ok(titles.includes('Availability to review'));
    assert.ok(titles.includes('Accomplishment reports to note'));
    assert.ok(titles.includes('Annex D to prepare'));
    assert.ok(!titles.includes('Shifts awaiting publish'), 'admin holds no approve_roster authority');
    assert.ok(!titles.includes('Accomplishment reports to approve'));
    assert.ok(!titles.includes('Annex D to approve'));
  });

  test('Punong Barangay sees the approve queues but no availability review', async () => {
    const ctx = mountPage(renderApprovalsPage, { role: 'punong_barangay' });
    await settle();
    const titles = groupTitles(ctx.root);
    assert.ok(titles.includes('Shifts awaiting publish'));
    assert.ok(titles.includes('Accomplishment reports to approve'));
    assert.ok(titles.includes('Annex D to approve'));
    assert.ok(!titles.includes('Availability to review'), 'availability review is an Admin/Secretary job');
    assert.ok(!titles.includes('Annex D to prepare'));
  });

  test('queue counts come from the server and rows deep-link to the right screen', async () => {
    const ctx = mountPage(renderApprovalsPage, { role: 'punong_barangay' });
    await settle();
    const group = $('.tw-approvals__group[data-group="approve"]', ctx.root);
    assert.ok(group, 'approve group present');
    assert.match(text($('.tw-count-badge', group)), /^1$/);
    click($('.tw-queue__open', group));
    assert.deepEqual(ctx.navigations.at(-1), { page: 'accomplishment-reports', param: { reportId: 72 } });

    const annex = $('.tw-approvals__group[data-group="annex-approve"]', ctx.root);
    click($('.tw-queue__open', annex));
    assert.equal(ctx.navigations.at(-1).page, 'school-zones');
    assert.equal(ctx.navigations.at(-1).param.tab, 'term');
  });

  test('a viewer with no authority gets an honest empty state, not a blank page', async () => {
    api.on('GET', '/users/:id', () => ({ status: 200, body: { user_id: 3, full_name: 'X', role: 'punong_barangay', official_title: null, approval_authority: [] } }));
    const ctx = mountPage(renderApprovalsPage, { role: 'punong_barangay' });
    await settle();
    assert.deepEqual(groupTitles(ctx.root), []);
    assert.match(text($('.page-content', ctx.root)), /Nothing for you to approve/);
  });

  test('an Admin/Secretary-only queue is role gated even without any authority', async () => {
    api.on('GET', '/users/:id', () => ({ status: 200, body: { user_id: 2, full_name: 'X', role: 'secretary', official_title: null, approval_authority: [] } }));
    const ctx = mountPage(renderApprovalsPage, { role: 'secretary' });
    await settle();
    assert.deepEqual(groupTitles(ctx.root), ['Availability to review']);
  });
});
