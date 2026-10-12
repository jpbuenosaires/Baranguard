/**
 * Wave 1, item 6: paper-signature controls, badges and scanned copies on the
 * Accomplishment Report detail and the Annex D (term report) detail.
 */
import { describe, test, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { api, window, mountPage, settle, cleanup, text, click, type, buttonByText, $, $$ } from '../harness/render.mjs';
import { renderAccomplishmentReportsPage } from '../../src/pages/accomplishment-reports.js';
import { renderSchoolZonesPage } from '../../src/pages/school-zones.js';
import { clearAuthorityCache } from '../../src/services/tanodWorkflowUi.js';
import { SCAN_MAX_BYTES } from '../../src/components/PaperApprovalPanel.js';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const dialog = () => $('[role="alertdialog"]');
const confirmButton = () => $$('button', dialog()).at(-1);
const dialogError = () => text($('.confirm-dialog__error', dialog()));
const panel = () => $('.tw-paper-panel');
const today = () => new Date(Date.now() + 8 * 3600 * 1000).toISOString().slice(0, 10);
const tomorrow = () => new Date(Date.now() + 8 * 3600 * 1000 + 86400000).toISOString().slice(0, 10);

function accomplishment(overrides = {}) {
  return {
    report_id: 73, barangay_id: 1, user_id: 4, full_name: 'Jose Reyes', month: '2026-09', status: 'approved',
    entry_count: 0, total_minutes: 0, flagged_entries: 0, total_minutes_confirmed: 0,
    prepared_at: '2026-10-01 00:00:00', noted_by: 2, noted_at: '2026-10-02 00:00:00', approved_by: 3, approved_at: '2026-10-03 00:00:00',
    return_reason: null, version: 4, entries: [],
    approval_mode: 'digital', paper_signed_on: null, paper_recorded_by_name: null, paper_recorded_at: null, paper_pending: true,
    ...overrides,
  };
}
function termReport(overrides = {}) {
  return {
    report_id: 82, barangay_id: 1, term_label: 'Term 4 S.Y. 2025-2026', term_start: '2026-03-02', term_end: '2026-04-10', status: 'prepared',
    total_tanods: 3, total_schools: 2, total_deployment_days: 20, total_incidents: 0, incidents_barangay_only: 0, incidents_pnp: 0, incidents_bfp: 0,
    incidents_higher_lgu: 0, incidents_doh: 0, incidents_dpwh: 0, incidents_other_agencies: 0, other_institutions: null, remarks: null,
    prepared_by: 1, prepared_at: '2026-10-01 00:00:00', approved_by: null, approved_at: null,
    mayor_office_received_by: null, mayor_office_received_at: null, dilg_received_by: null, dilg_date_received: null, version: 2,
    approval_mode: 'digital', paper_signed_on: null, paper_recorded_by_name: null, paper_recorded_at: null, paper_pending: false,
    ...overrides,
  };
}
const serveAccomplishment = (row) => api.on('GET', '/accomplishment-reports/:id', () => ({ status: 200, body: row }));
const serveTerm = (row) => api.on('GET', '/ssz-term-reports/:id', () => ({ status: 200, body: row }));
async function openAccomplishment(role, row) {
  serveAccomplishment(row);
  const ctx = mountPage(renderAccomplishmentReportsPage, { role, param: { reportId: row.report_id } });
  await settle();
  return ctx;
}
async function openTerm(role, row) {
  serveTerm(row);
  const ctx = mountPage(renderSchoolZonesPage, { role, param: { tab: 'term', reportId: row.report_id } });
  await settle();
  return ctx;
}
const fileInput = () => $('input[type="file"]', panel());
function chooseFile(file) {
  Object.defineProperty(fileInput(), 'files', { value: [file], configurable: true });
}
const submitUpload = async () => {
  $('.tw-scan-upload', panel()).dispatchEvent(new window.Event('submit', { bubbles: true, cancelable: true }));
  await settle();
};

describe('Accomplishment Report detail', () => {
  test('shows no paper signature or scan panel', async () => {
    await openAccomplishment('admin', accomplishment({ status: 'prepared', approved_by: null, approved_at: null }));
    assert.equal(panel(), null);
  });
});


describe('Paper signature and scans on Annex D', () => {
  afterEach(() => { cleanup(); clearAuthorityCache(); });

  test('paper-only: a DRAFT Annex D has no Prepare button; Record signed paper asks for the preparer, the signer and the date', async () => {
    await openTerm('secretary', termReport({ report_id: 81, status: 'draft', prepared_by: null, prepared_at: null, version: 1 }));
    assert.equal(buttonByText(/^Prepare report$/), undefined, 'in-app Prepare is retired (the server answers 410)');
    assert.match(text(panel()), /Print this report and have it signed/);
    assert.equal(api.callsTo('GET', '/document-scans').length, 0, 'no scans before approval');
    click(buttonByText(/^Record signed paper$/, panel()));
    await settle();
    const dirCalls = api.callsTo('GET', '/users/directory').filter((c) => c.query?.purpose === 'signer').map((c) => c.query.authority).sort();
    assert.deepEqual(dirCalls, ['approve_annex_d', 'prepare_annex_d']);
    assert.deepEqual($$('#confirm-dialog-field-preparer option', dialog()).map((o) => text(o)), ['Ramon Elcano (Chief Tanod)']);
    assert.deepEqual($$('#confirm-dialog-field-signer option', dialog()).map((o) => text(o)), ['Teresa Magbanua (Punong Barangay)']);
    type($('#confirm-dialog-field-signedOn', dialog()), today());
    click(confirmButton());
    await settle();
    const [call] = api.callsTo('POST', '/ssz-term-reports/:id/record-paper-approval');
    assert.ok(call);
    assert.equal(call.path, '/ssz-term-reports/81/record-paper-approval');
    assert.deepEqual(call.body, { preparer_user_id: 1, signer_user_id: 3, signed_on: today() });
    assert.match(call.headers['idempotency-key'] || '', UUID);
    assert.equal(api.callsTo('POST', '/ssz-term-reports/:id/prepare').length, 0);
  });

  test('a draft Annex D: the same person as preparer and signer is refused client-side', async () => {
    api.on('GET', '/users/directory', () => ({ status: 200, body: { items: [{ user_id: 3, full_name: 'Teresa Magbanua', official_title: 'Punong Barangay' }] } }));
    await openTerm('admin', termReport({ report_id: 81, status: 'draft', prepared_by: null, prepared_at: null, version: 1 }));
    click(buttonByText(/^Record signed paper$/, panel()));
    await settle();
    type($('#confirm-dialog-field-signedOn', dialog()), today());
    click(confirmButton());
    await settle();
    assert.match(dialogError(), /preparer and the signer must be different/);
    assert.equal(api.callsTo('POST', '/ssz-term-reports/:id/record-paper-approval').length, 0);
  });

  test('Punong Barangay gets no controls on a draft Annex D', async () => {
    await openTerm('punong_barangay', termReport({ report_id: 81, status: 'draft', prepared_by: null, prepared_at: null, version: 1 }));
    assert.equal(buttonByText(/^Record signed paper$|^Prepare report$/), undefined);
    assert.match(text($('.page-content')), /have it prepared and signed on paper/);
  });

  test('a PREPARED Annex D offers Record signed paper, listing approve_annex_d holders, and posts to the ssz route', async () => {
    await openTerm('admin', termReport());
    click(buttonByText(/^Record signed paper$/, panel()));
    await settle();
    assert.deepEqual($$('#confirm-dialog-field-signer option', dialog()).map((o) => text(o)), ['Teresa Magbanua (Punong Barangay)']);
    type($('#confirm-dialog-field-signedOn', dialog()), today());
    click(confirmButton());
    await settle();
    const [call] = api.callsTo('POST', '/ssz-term-reports/:id/record-paper-approval');
    assert.ok(call);
    assert.equal(call.path, '/ssz-term-reports/82/record-paper-approval');
    assert.deepEqual(call.body, { signer_user_id: 3, signed_on: today() });
    assert.match(call.headers['idempotency-key'] || '', UUID);
  });

  test('an approved Annex D shows the pending badge and records the paper date via the ssz route', async () => {
    await openTerm('secretary', termReport({ status: 'approved', paper_pending: true, approved_by: 3, approved_at: '2026-10-02 00:00:00' }));
    assert.match(text(panel()), /Paper signature pending/);
    click(buttonByText(/^Record paper signature date$/, panel()));
    type($('#confirm-dialog-input', dialog()), today());
    click(confirmButton());
    await settle();
    const [call] = api.callsTo('POST', '/ssz-term-reports/:id/paper-signature');
    assert.ok(call);
    assert.deepEqual(call.body, { paper_signed_on: today() });
    // scans are loaded for the term report entity
    assert.equal(api.callsTo('GET', '/document-scans')[0].query.entity_type, 'ssz_term_report');
  });

  test('a submitted Annex D still lists scans and allows upload, but no paper-date control (server allows it only when approved)', async () => {
    await openTerm('admin', termReport({ status: 'submitted', paper_pending: false, paper_signed_on: '2026-10-03' }));
    assert.match(text(panel()), /Signed on paper Oct 3, 2026/);
    assert.equal(buttonByText(/^Record paper signature date$/, panel()), undefined);
    assert.ok(fileInput(), 'scans can still be attached after submission');
    assert.match(text(panel()), /Do not include student names/);
  });

  test('Punong Barangay sees the Annex D badge only', async () => {
    await openTerm('punong_barangay', termReport({ status: 'approved', paper_pending: true }));
    assert.match(text(panel()), /Paper signature pending/);
    assert.equal(buttonByText(/Record paper signature date|Record signed paper/, panel()), undefined);
    assert.equal(fileInput(), null);
  });
});
