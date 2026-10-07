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

describe('Paper signature badges (Accomplishment Report)', () => {
  afterEach(() => { cleanup(); clearAuthorityCache(); });

  for (const role of ['admin', 'secretary', 'punong_barangay']) {
    test(`${role} sees "Paper signature pending" on an approved report with no paper date`, async () => {
      await openAccomplishment(role, accomplishment());
      assert.match(text(panel()), /Paper signature pending/);
      assert.doesNotMatch(text(panel()), /Signed on paper/);
    });
  }

  test('once a paper date is recorded the badge reads "Signed on paper <date>" and the recorder is named', async () => {
    await openAccomplishment('punong_barangay', accomplishment({
      paper_pending: false, paper_signed_on: '2026-09-30', paper_recorded_by_name: 'Liwayway Ferrer', paper_recorded_at: '2026-10-04 02:00:00',
    }));
    assert.match(text(panel()), /Signed on paper Sep 30, 2026/);
    assert.match(text(panel()), /Recorded by Liwayway Ferrer/);
    assert.doesNotMatch(text(panel()), /Paper signature pending/);
  });

  test('an approval recorded from paper is labelled', async () => {
    await openAccomplishment('admin', accomplishment({ approval_mode: 'recorded_from_paper', paper_pending: false, paper_signed_on: '2026-09-29' }));
    assert.match(text(panel()), /Approval recorded from paper/);
  });

  test('an unapproved report (prepared) shows no paper panel at all', async () => {
    mountPage(renderAccomplishmentReportsPage, { role: 'admin', param: { reportId: 71 } });
    await settle();
    assert.equal(panel(), null);
  });

  test('a noted report shows the panel but explains scans wait for approval and does not fetch scans', async () => {
    mountPage(renderAccomplishmentReportsPage, { role: 'admin', param: { reportId: 72 } });
    await settle();
    assert.ok(panel());
    assert.match(text(panel()), /A scan can be attached once this report is approved/);
    assert.equal(api.callsTo('GET', '/document-scans').length, 0);
  });
});

describe('Record paper signature date', () => {
  afterEach(() => { cleanup(); clearAuthorityCache(); });

  for (const role of ['admin', 'secretary']) {
    test(`${role} can record the date: validated, then POST .../paper-signature with an Idempotency-Key`, async () => {
      await openAccomplishment(role, accomplishment());
      click(buttonByText(/^Record paper signature date$/, panel()));
      assert.ok(dialog(), 'a dialog must open');
      assert.equal($('#confirm-dialog-input', dialog()).type, 'date');
      click(confirmButton());
      await settle();
      assert.match(dialogError(), /date/i);
      type($('#confirm-dialog-input', dialog()), tomorrow());
      click(confirmButton());
      await settle();
      assert.match(dialogError(), /future/i);
      assert.equal(api.callsTo('POST', '/accomplishment-reports/:id/paper-signature').length, 0, 'an invalid date must not be sent');
      type($('#confirm-dialog-input', dialog()), today());
      click(confirmButton());
      await settle();
      const [call] = api.callsTo('POST', '/accomplishment-reports/:id/paper-signature');
      assert.ok(call, 'POST was not sent');
      assert.equal(call.path, '/accomplishment-reports/73/paper-signature');
      assert.deepEqual(call.body, { paper_signed_on: today() });
      assert.match(call.headers['idempotency-key'] || '', UUID);
      assert.equal(dialog(), null);
      // The detail was reloaded after the change.
      assert.ok(api.callsTo('GET', '/accomplishment-reports/:id').length >= 2);
    });
  }

  test('a server refusal shows inline and keeps the dialog open', async () => {
    api.on('POST', '/accomplishment-reports/:id/paper-signature', () => ({ status: 409, body: { error: { code: 'INVALID_STATE', message: 'Only an approved report can take a paper signature.' } } }));
    await openAccomplishment('admin', accomplishment());
    click(buttonByText(/^Record paper signature date$/, panel()));
    type($('#confirm-dialog-input', dialog()), today());
    click(confirmButton());
    await settle();
    assert.ok(dialog());
    assert.match(dialogError(), /Only an approved report/);
  });

  test('Punong Barangay gets the badge but no controls', async () => {
    await openAccomplishment('punong_barangay', accomplishment());
    assert.equal(buttonByText(/Record paper signature date|Record approval from paper/, panel()), undefined);
    assert.equal($('input[type="file"]', panel()), null);
  });

  test('the date control is not offered on a report that is not approved yet', async () => {
    mountPage(renderAccomplishmentReportsPage, { role: 'admin', param: { reportId: 72 } });
    await settle();
    assert.equal(buttonByText(/^Record paper signature date$/, panel()), undefined);
  });
});

describe('Record approval from paper (Accomplishment Report)', () => {
  afterEach(() => { cleanup(); clearAuthorityCache(); });

  test('offered on a NOTED report only, and not on prepared or approved ones', async () => {
    mountPage(renderAccomplishmentReportsPage, { role: 'admin', param: { reportId: 72 } });
    await settle();
    assert.ok(buttonByText(/^Record approval from paper$/, panel()));
    cleanup();
    await openAccomplishment('admin', accomplishment());
    assert.equal(buttonByText(/^Record approval from paper$/, panel()), undefined);
  });

  test('Admin picks a signer from users holding approve_report (never the preparer or a non-holder) and a date', async () => {
    mountPage(renderAccomplishmentReportsPage, { role: 'admin', param: { reportId: 72 } });
    await settle();
    click(buttonByText(/^Record approval from paper$/, panel()));
    await settle();
    assert.ok(dialog(), 'the record dialog did not open');
    const options = $$('#confirm-dialog-field-signer option', dialog()).map((o) => text(o));
    assert.deepEqual(options, ['Teresa Magbanua (Punong Barangay)'], 'only the active holder of approve_report; the admin and secretary do not hold it');
    assert.equal(api.callsTo('GET', '/users').length >= 1, true, 'an Admin may read the user list');
    // blank date refused
    click(confirmButton());
    await settle();
    assert.match(dialogError(), /date/i);
    assert.equal(api.callsTo('POST', '/accomplishment-reports/:id/record-paper-approval').length, 0);
    type($('#confirm-dialog-field-signedOn', dialog()), today());
    click(confirmButton());
    await settle();
    const [call] = api.callsTo('POST', '/accomplishment-reports/:id/record-paper-approval');
    assert.ok(call, 'POST record-paper-approval was not sent');
    assert.equal(call.path, '/accomplishment-reports/72/record-paper-approval');
    assert.deepEqual(call.body, { signer_user_id: 3, signed_on: today() });
    assert.match(call.headers['idempotency-key'] || '', UUID);
    assert.equal(dialog(), null);
  });

  test('a preparer-must-differ refusal from the server is shown in plain language and the dialog stays open', async () => {
    api.on('POST', '/accomplishment-reports/:id/record-paper-approval', () => ({ status: 409, body: { error: { code: 'CONFLICT', message: 'The preparer cannot approve their own report.' } } }));
    mountPage(renderAccomplishmentReportsPage, { role: 'admin', param: { reportId: 72 } });
    await settle();
    click(buttonByText(/^Record approval from paper$/, panel()));
    await settle();
    type($('#confirm-dialog-field-signedOn', dialog()), today());
    click(confirmButton());
    await settle();
    assert.ok(dialog());
    assert.match(dialogError(), /cannot also note or approve/);
  });

  test('a Secretary who cannot list officials and holds no approval authority gets an honest message and no dialog (and never calls GET /users)', async () => {
    mountPage(renderAccomplishmentReportsPage, { role: 'secretary', param: { reportId: 72 } });
    await settle();
    // (The page itself already tries GET /users for display names and tolerates the Admin-only refusal.)
    const usersCallsBefore = api.callsTo('GET', '/users').length;
    click(buttonByText(/^Record approval from paper$/, panel()));
    await settle();
    assert.equal(dialog(), null);
    assert.match(text(window.document.body), /cannot list other officials/i);
    assert.equal(api.callsTo('GET', '/users').length, usersCallsBefore, 'the signer lookup must not call the Admin-only user list for a Secretary');
  });

  test('a Secretary who holds approve_report can record with their own account as the signer', async () => {
    api.on('GET', '/users/:id', ({ params }) => ({ status: 200, body: { user_id: Number(params.id), full_name: 'Liwayway Ferrer', role: 'secretary', official_title: 'Kagawad', approval_authority: ['note_report', 'approve_report'], is_active: 1, is_suspended: 0 } }));
    mountPage(renderAccomplishmentReportsPage, { role: 'secretary', param: { reportId: 72 } });
    await settle();
    click(buttonByText(/^Record approval from paper$/, panel()));
    await settle();
    const options = $$('#confirm-dialog-field-signer option', dialog()).map((o) => text(o));
    assert.deepEqual(options, ['Liwayway Ferrer (Kagawad) — you']);
    type($('#confirm-dialog-field-signedOn', dialog()), today());
    click(confirmButton());
    await settle();
    assert.deepEqual(api.callsTo('POST', '/accomplishment-reports/:id/record-paper-approval')[0].body, { signer_user_id: 2, signed_on: today() });
  });
});

describe('Scanned copies', () => {
  afterEach(() => { cleanup(); clearAuthorityCache(); });

  const scan = (extra = {}) => ({ scan_id: 12, entity_type: 'accomplishment_report', entity_id: 73, mime_type: 'application/pdf', size_bytes: 204800, sha256: 'b'.repeat(64), uploaded_by: 2, uploaded_at: '2026-10-05 01:00:00', ...extra });

  test('on an approved report the scan list is fetched for that exact entity; empty state and the upload copy are shown', async () => {
    await openAccomplishment('admin', accomplishment());
    const [call] = api.callsTo('GET', '/document-scans');
    assert.deepEqual({ t: call.query.entity_type, i: call.query.entity_id }, { t: 'accomplishment_report', i: '73' });
    assert.match(text(panel()), /No scan has been attached yet/);
    assert.match(text(panel()), /PDF, JPG or PNG, max 10 MB\. Do not include student names\./);
    assert.equal(fileInput().accept.includes('.pdf'), true);
  });

  test('listed scans show type, size and date, expose no file path, and download through an authenticated blob fetch', async () => {
    api.on('GET', '/document-scans', () => ({ status: 200, body: { items: [scan({ stored_path: 'C:/secret/path.pdf' })], page: 1, limit: 25, total: 1 } }));
    await openAccomplishment('punong_barangay', accomplishment());
    assert.match(text(panel()), /PDF · 200 KB · uploaded/);
    assert.doesNotMatch(panel().innerHTML, /secret|stored_path|C:\//);
    assert.equal($('input[type="file"]', panel()), null, 'Punong Barangay may list and download but not upload');
    click(buttonByText(/^Download$/, panel()));
    await settle();
    const [call] = api.callsTo('GET', '/document-scans/:id/download');
    assert.ok(call, 'download was not requested');
    assert.equal(call.path, '/document-scans/12/download');
    assert.match(call.headers.authorization || '', /^Bearer /);
  });

  test('a scan-list failure shows an error with Retry that recovers', async () => {
    api.fail('GET', '/document-scans', 500, 'SERVER_ERROR', 'Scans are down.');
    await openAccomplishment('admin', accomplishment());
    assert.match(text(panel()), /Scans are down/);
    api.on('GET', '/document-scans', () => ({ status: 200, body: { items: [scan()], page: 1, limit: 25, total: 1 } }));
    click(buttonByText(/^Retry$/, panel()));
    await settle();
    assert.match(text(panel()), /PDF · 200 KB/);
  });

  test('upload: nothing chosen, a wrong type and an oversized file are refused client-side with no request', async () => {
    await openAccomplishment('secretary', accomplishment());
    await submitUpload();
    assert.match(text($('.tw-form-error', panel())), /Choose a file first/);
    chooseFile(new window.File(['x'], 'notes.docx', { type: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document' }));
    await submitUpload();
    assert.match(text($('.tw-form-error', panel())), /Only PDF, JPG or PNG/);
    chooseFile(new window.File([new Uint8Array(SCAN_MAX_BYTES + 1)], 'big.pdf', { type: 'application/pdf' }));
    await submitUpload();
    assert.match(text($('.tw-form-error', panel())), /larger than 10 MB/);
    assert.equal(api.callsTo('POST', '/document-scans').length, 0);
  });

  for (const role of ['admin', 'secretary']) {
    test(`${role} uploads a PDF as multipart (entity_type, entity_id, file) and the list reloads`, async () => {
      await openAccomplishment(role, accomplishment());
      chooseFile(new window.File(['%PDF-1.4 test'], 'signed.pdf', { type: 'application/pdf' }));
      await submitUpload();
      const [call] = api.callsTo('POST', '/document-scans');
      assert.ok(call, 'POST /document-scans was not sent');
      assert.ok(call.body instanceof window.FormData, 'the body must be multipart FormData');
      assert.equal(call.body.get('entity_type'), 'accomplishment_report');
      assert.equal(call.body.get('entity_id'), '73');
      assert.equal(call.body.get('file').name, 'signed.pdf');
      assert.equal(call.headers['content-type'], undefined, 'the multipart boundary must be left to the browser');
      assert.equal(api.callsTo('GET', '/document-scans').length, 2, 'the list is re-fetched after an upload');
    });
  }

  test('a server rejection of the upload (e.g. bad magic bytes) shows inline and re-enables the button', async () => {
    api.on('POST', '/document-scans', () => ({ status: 422, body: { error: { code: 'VALIDATION_ERROR', message: 'The file is not a valid PDF, JPEG or PNG.' } } }));
    await openAccomplishment('admin', accomplishment());
    chooseFile(new window.File(['not really a pdf'], 'fake.pdf', { type: 'application/pdf' }));
    await submitUpload();
    assert.match(text($('.tw-form-error', panel())), /not a valid PDF/);
    assert.equal(buttonByText(/^Upload scan$/, panel()).disabled, false);
  });
});

describe('Paper signature and scans on Annex D', () => {
  afterEach(() => { cleanup(); clearAuthorityCache(); });

  test('a draft Annex D shows no paper panel', async () => {
    mountPage(renderSchoolZonesPage, { role: 'admin', param: { tab: 'term', reportId: 81 } });
    await settle();
    assert.equal(panel(), null);
  });

  test('a PREPARED Annex D offers Record approval from paper, listing approve_annex_d holders, and posts to the ssz route', async () => {
    await openTerm('admin', termReport());
    click(buttonByText(/^Record approval from paper$/, panel()));
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
    assert.equal(buttonByText(/Record paper signature date|Record approval from paper/, panel()), undefined);
    assert.equal(fileInput(), null);
  });
});
