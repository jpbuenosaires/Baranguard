/**
 * Annex D (term report) workflow: draft -> prepared -> submitted. Everything
 * is printed and signed on paper outside the app, so the detail view has no
 * paper-signature panel, scan controls or approval step.
 */
import { describe, test, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { api, mountPage, settle, cleanup, text, click, buttonByText, $ } from '../harness/render.mjs';
import { renderAccomplishmentReportsPage } from '../../src/pages/accomplishment-reports.js';
import { renderSchoolZonesPage } from '../../src/pages/school-zones.js';
import { clearAuthorityCache } from '../../src/services/tanodWorkflowUi.js';


function termReport(overrides = {}) {
  return {
    report_id: 82, barangay_id: 1, term_label: 'Term 4 S.Y. 2025-2026', term_start: '2026-03-02', term_end: '2026-04-10', status: 'prepared',
    total_tanods: 3, total_schools: 2, total_deployment_days: 20, total_incidents: 0, incidents_barangay_only: 0, incidents_pnp: 0, incidents_bfp: 0,
    incidents_higher_lgu: 0, incidents_doh: 0, incidents_dpwh: 0, incidents_other_agencies: 0, other_institutions: null, remarks: null,
    prepared_by: 1, prepared_at: '2026-10-01 00:00:00',
    mayor_office_received_by: null, mayor_office_received_at: null, dilg_received_by: null, dilg_date_received: null, version: 2,
    ...overrides,
  };
}
async function openTerm(role, row) {
  api.on('GET', '/ssz-term-reports/:id', () => ({ status: 200, body: row }));
  const ctx = mountPage(renderSchoolZonesPage, { role, param: { tab: 'term', reportId: row.report_id } });
  await settle();
  return ctx;
}
const noPaperUi = () => {
  assert.equal($('.tw-paper-panel'), null, 'no paper panel');
  assert.equal($('.tw-scan-upload'), null, 'no scan upload');
  assert.ok(!buttonByText(/Record signed paper|Record paper signature date|Upload scan/));
  assert.equal(api.callsTo('GET', '/document-scans').length, 0, 'scans are not fetched');
  assert.doesNotMatch(text($('.page-content')), /Paper signature|Signed on paper|Approved/);
};

describe('Accomplishment Report detail', () => {
  afterEach(() => { cleanup(); clearAuthorityCache(); });
  test('shows no paper signature or scan panel', async () => {
    mountPage(renderAccomplishmentReportsPage, { role: 'admin', param: { reportId: 71 } });
    await settle();
    noPaperUi();
  });
});

describe('Annex D workflow (draft -> prepared -> submitted)', () => {
  afterEach(() => { cleanup(); clearAuthorityCache(); });

  test('a DRAFT shows Mark as prepared, which posts to /prepare and nothing else', async () => {
    await openTerm('admin', termReport({ report_id: 81, status: 'draft', prepared_by: null, prepared_at: null }));
    noPaperUi();
    assert.equal(buttonByText(/^Mark as submitted$/), undefined, 'a draft cannot be submitted');
    click(buttonByText(/^Mark as prepared$/));
    await settle();
    const [call] = api.callsTo('POST', '/ssz-term-reports/:id/prepare');
    assert.ok(call, 'prepare was called');
    assert.equal(call.path, '/ssz-term-reports/81/prepare');
    assert.equal(api.callsTo('POST', '/ssz-term-reports/:id/approve').length, 0);
  });

  test('a PREPARED report offers Mark as submitted (enabled) and no approve step', async () => {
    await openTerm('admin', termReport());
    noPaperUi();
    assert.equal(buttonByText(/^Mark as prepared$/), undefined);
    const submit = buttonByText(/^Mark as submitted$/);
    assert.ok(submit, 'submit is available once prepared');
    assert.equal(submit.disabled, false);
    assert.ok(buttonByText(/Preview & print Annex D/), 'Print stays');
  });

  test('a SUBMITTED report has no further actions', async () => {
    await openTerm('admin', termReport({ status: 'submitted', mayor_office_received_by: 'Clerk', mayor_office_received_at: '2026-10-05' }));
    noPaperUi();
    assert.equal(buttonByText(/^Mark as submitted$/), undefined);
    assert.equal(buttonByText(/^Mark as prepared$/), undefined);
    assert.match(text($('.page-content')), /has been submitted/);
  });

  test('a Punong Barangay can read but not move the report along', async () => {
    await openTerm('punong_barangay', termReport());
    noPaperUi();
    assert.equal(buttonByText(/^Mark as submitted$/), undefined);
  });

  test('the Annex D print keeps its signature captions with blank lines', async () => {
    await openTerm('admin', termReport());
    click(buttonByText(/Preview & print Annex D/));
    await settle();
    const sheet = document.querySelector('#printable-annex-d');
    assert.ok(sheet, 'print sheet mounted');
    assert.match(text(sheet), /Prepared by:.*Approved by:/);
    assert.equal($('.tw-print__signame', sheet), null, 'no pulled-in signer names');
    click(document.querySelector('#close-print-modal'));
  });
});
