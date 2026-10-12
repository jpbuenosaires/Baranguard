import { describePage } from '../harness/pageSuite.mjs';
import { describe, test, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { assertNoInjectedMarkup, api, mountPage, settle, cleanup, text, click, type, $, $$, buttonByText } from '../harness/render.mjs';
import { renderAccomplishmentReportsPage } from '../../src/pages/accomplishment-reports.js';
import { clearAuthorityCache } from '../../src/services/tanodWorkflowUi.js';

describePage({
  name: 'Accomplishment Reports (list)',
  render: renderAccomplishmentReportsPage,
  roles: ['admin', 'secretary', 'punong_barangay'],
  heading: 'Accomplishment Reports',
  expectText: ['September 2026'],
});

describe('Accomplishment Reports behaviour', () => {
  afterEach(() => { cleanup(); clearAuthorityCache(); });

  test('detail view renders untrusted entry text as text, never markup', async () => {
    mountPage(renderAccomplishmentReportsPage, { role: 'admin', param: { reportId: 71 }, scenario: 'xss' });
    await settle();
    assertNoInjectedMarkup();
  });

  test('the status filter asks the server for exactly that status', async () => {
    mountPage(renderAccomplishmentReportsPage, { role: 'admin' });
    await settle();
    type($('#tw-acc-status'), 'noted');
    await settle();
    assert.ok(api.calls.some((c) => c.path === '/accomplishment-reports' && c.query.status === 'noted'));
  });

  test('no in-app Note or Approve buttons and no paper panel on a prepared report', async () => {
    mountPage(renderAccomplishmentReportsPage, { role: 'admin', param: { reportId: 71 } });
    await settle();
    assert.ok(!buttonByText(/^Note this report$/), 'the separate note step is gone');
    assert.ok(!buttonByText(/^Approve this report$/));
    assert.ok(!buttonByText(/^Record signed paper$/), 'the paper panel was removed from this screen');
    assert.ok(buttonByText(/^Return to tanod$/), 'admin holds note_report, so Return stays');
  });

  test('a Punong Barangay is not offered in-app approval and is told the paper is awaited', async () => {
    mountPage(renderAccomplishmentReportsPage, { role: 'punong_barangay', param: { reportId: 72 } });
    await settle();
    assert.ok(!buttonByText(/^Approve this report$/));
    assert.ok(!buttonByText(/^Record signed paper$/), 'recording the paper is Admin/Secretary work');
    assert.ok(buttonByText(/^Return to tanod$/), 'the PB holds approve_report and can still return it');
  });

  test('a viewer without the authority gets no action buttons', async () => {
    api.on('GET', '/users/:id', () => ({ status: 200, body: { user_id: 3, full_name: 'X', role: 'punong_barangay', official_title: null, approval_authority: [] } }));
    mountPage(renderAccomplishmentReportsPage, { role: 'punong_barangay', param: { reportId: 72 } });
    await settle();
    assert.ok(!buttonByText(/^Approve this report$/));
    assert.ok(!buttonByText(/^Return to tanod$/));
  });

  test('a flagged duration is marked in the entries table', async () => {
    mountPage(renderAccomplishmentReportsPage, { role: 'admin', param: { reportId: 71 } });
    await settle();
    assert.ok($('.tw-row--flagged'), 'the flagged entry row is highlighted');
    assert.match(text($('.page-content')), /Check/);
  });

  test('without Return authority the viewer is told the signed paper is awaited', async () => {
    api.on('GET', '/users/:id', () => ({ status: 200, body: { user_id: 3, full_name: 'X', role: 'punong_barangay', official_title: null, approval_authority: [] } }));
    mountPage(renderAccomplishmentReportsPage, { role: 'punong_barangay', param: { reportId: 72 } });
    await settle();
    assert.match(text($('.page-content')), /Waiting for the signed paper/);
  });

  test('Preview & print opens the Accomplishment Report form with 31 day rows', async () => {
    mountPage(renderAccomplishmentReportsPage, { role: 'admin', param: { reportId: 71 } });
    await settle();
    click(buttonByText(/Preview/));
    await settle();
    const sheet = document.querySelector('#printable-accomplishment-report');
    assert.ok(sheet, 'print sheet mounted');
    assert.equal(sheet.querySelectorAll('.tw-acc-form__log tbody tr').length, 31);
    assert.match(text(sheet), /Prepared By:.*Noted By:.*Approved By:/);
    click(document.querySelector('#close-print-modal'));
  });
});
