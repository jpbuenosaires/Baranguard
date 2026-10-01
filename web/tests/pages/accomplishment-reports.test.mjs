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

  test('Note is offered only to a holder of note_report, on a prepared report', async () => {
    mountPage(renderAccomplishmentReportsPage, { role: 'admin', param: { reportId: 71 } });
    await settle();
    assert.ok(buttonByText(/^Note this report$/), 'admin holds note_report and report 71 is prepared');
    assert.ok(!buttonByText(/^Approve this report$/));
  });

  test('Approve is offered to a holder of approve_report on a noted report, not Note', async () => {
    mountPage(renderAccomplishmentReportsPage, { role: 'punong_barangay', param: { reportId: 72 } });
    await settle();
    assert.ok(buttonByText(/^Approve this report$/));
    assert.ok(!buttonByText(/^Note this report$/));
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

  test('the preparer-must-differ 409 is shown as plain language', async () => {
    api.on('POST', '/accomplishment-reports/:id/note', () => ({ status: 409, body: { error: { code: 'CONFLICT', message: 'The preparer cannot also approve their own document.' } } }));
    mountPage(renderAccomplishmentReportsPage, { role: 'admin', param: { reportId: 71 } });
    await settle();
    click(buttonByText(/^Note this report$/));
    await settle();
    click(buttonByText(/^Note report$/));
    await settle();
    assert.match(text(document.body), /person who prepared this record cannot also note or approve it/i);
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
