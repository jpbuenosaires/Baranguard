import { describePage } from '../harness/pageSuite.mjs';
import { describe, test, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { api, mountPage, settle, cleanup, text, click, type, $, $$, buttonByText, signIn } from '../harness/render.mjs';
import { renderSchoolZonesPage } from '../../src/pages/school-zones.js';
import { clearAuthorityCache, actionErrorMessage, letterheadHtml } from '../../src/services/tanodWorkflowUi.js';
import { createIncidentReferral } from '../../src/services/shellWorkflowApi.js';
import { ApiClientError } from '../../src/api/apiClient.js';
import { ReferralsCard } from '../../src/components/IncidentCaseCards.js';

const ROLES = ['admin', 'secretary', 'punong_barangay'];

describePage({ name: 'Safer School Zones (Schools)', render: renderSchoolZonesPage, roles: ROLES, param: { tab: 'schools' }, heading: 'Safer School Zones', expectText: ['Dao Elementary School'] });
describePage({ name: 'Safer School Zones (Incidents)', render: renderSchoolZonesPage, roles: ROLES, param: { tab: 'incidents' }, heading: 'Safer School Zones' });
describePage({ name: 'Safer School Zones (Term Report)', render: renderSchoolZonesPage, roles: ROLES, param: { tab: 'term' }, heading: 'Safer School Zones', expectText: ['Saved term reports'] });

describe('Safer School Zones behaviour', () => {
  afterEach(() => { cleanup(); clearAuthorityCache(); });

  test('Admin/Secretary can add a school; Punong Barangay cannot', async () => {
    mountPage(renderSchoolZonesPage, { role: 'secretary', param: { tab: 'schools' } });
    await settle();
    assert.ok(buttonByText(/Add school/));
    cleanup();
    mountPage(renderSchoolZonesPage, { role: 'punong_barangay', param: { tab: 'schools' } });
    await settle();
    assert.ok(!buttonByText(/Add school/));
    assert.ok(!buttonByText(/^Edit$/));
  });

  test('the school form offers all eight levels and rejects an incomplete entry', async () => {
    mountPage(renderSchoolZonesPage, { role: 'admin', param: { tab: 'schools' } });
    await settle();
    click(buttonByText(/Add school/));
    await settle();
    const levelSelect = $$('select').find((s) => [...s.options].some((o) => o.value === 'sned'));
    assert.equal(levelSelect.options.length - 1, 8, 'eight levels plus the placeholder');
    click(buttonByText(/^Add school$/, $('.tw-form-card')));
    await settle();
    assert.match(text($('.tw-form-error')), /required/i);
    assert.equal(api.callsTo('POST', '/schools').length, 0, 'nothing is sent for an incomplete form');
  });

  test('the Annex B preview lists only active schools', async () => {
    mountPage(renderSchoolZonesPage, { role: 'admin', param: { tab: 'schools' } });
    await settle();
    click(buttonByText(/Annex B/));
    await settle();
    const sheet = document.querySelector('#printable-annex-b');
    assert.ok(sheet);
    assert.match(text(sheet), /Dao Elementary School/);
    assert.doesNotMatch(text(sheet), /Old Daycare Center/);
    click(document.querySelector('#close-print-modal'));
  });

  test('live term counts load only once both dates are chosen', async () => {
    mountPage(renderSchoolZonesPage, { role: 'admin', param: { tab: 'term' } });
    await settle();
    assert.equal(api.callsTo('GET', '/reports/school-term').length, 0);
    const dates = $$('input[type="date"]');
    type(dates[0], '2026-08-24');
    type(dates[1], '2026-10-30');
    await settle();
    const call = api.callsTo('GET', '/reports/school-term')[0];
    assert.ok(call, 'live counts requested');
    assert.equal(call.query.term_start, '2026-08-24');
    assert.equal(call.query.term_end, '2026-10-30');
  });

  test('a draft term report offers Prepare to a prepare_annex_d holder', async () => {
    mountPage(renderSchoolZonesPage, { role: 'admin', param: { tab: 'term', reportId: 81 } });
    await settle();
    assert.ok(buttonByText(/^Prepare report$/));
    assert.ok(!buttonByText(/^Approve report$/));
  });

  test('a prepared report offers Approve only to an approve_annex_d holder who did not prepare it', async () => {
    mountPage(renderSchoolZonesPage, { role: 'punong_barangay', param: { tab: 'term', reportId: 82 } });
    await settle();
    assert.ok(buttonByText(/^Approve report$/));
    cleanup();
    clearAuthorityCache();
    mountPage(renderSchoolZonesPage, { role: 'admin', param: { tab: 'term', reportId: 82 } });
    await settle();
    assert.ok(!buttonByText(/^Approve report$/), 'admin lacks approve_annex_d (and prepared it)');
  });

  test('the Annex D preview carries the term label from the report and no hardcoded deadline', async () => {
    mountPage(renderSchoolZonesPage, { role: 'admin', param: { tab: 'term', reportId: 81 } });
    await settle();
    click(buttonByText(/Annex D/));
    await settle();
    const sheet = document.querySelector('#printable-annex-d');
    assert.ok(sheet);
    const body = text(sheet);
    assert.match(body, /TERM 1 S\.Y\. 2026-2027/);
    assert.match(body, /Prepared by:/);
    assert.match(body, /Received by:/);
    assert.match(body, /applicable deadline prescribed under DILG Memorandum Circular/);
    click(document.querySelector('#close-print-modal'));
  });
});

describe('2026-10 review fixes', () => {
  afterEach(() => { cleanup(); clearAuthorityCache(); });

  test('a referral "When" value is sent as Asia/Manila wall time converted to UTC', async () => {
    signIn('secretary');
    await createIncidentReferral(902, { referredTo: 'pnp', referredAt: '2026-10-01T09:30' }, crypto.randomUUID());
    const [call] = api.callsTo('POST', '/incidents/:id/referrals');
    assert.ok(call);
    assert.equal(call.body.referred_at, '2026-10-01T01:30:00.000Z');
  });

  test('only the real segregation 409 gets the friendly preparer message', () => {
    const real = new ApiClientError(409, 'CONFLICT', 'The preparer cannot also approve their own document.');
    assert.match(actionErrorMessage(real), /cannot also note or approve/);
    const other = new ApiClientError(409, 'CONFLICT', 'The report was prepared by someone else and changed since you opened it.');
    assert.equal(actionErrorMessage(other), 'The report was prepared by someone else and changed since you opened it.');
  });

  test('the printed letterhead carries three empty logo slots', () => {
    const html = letterheadHtml({ barangayName: 'Dao', municipality: 'Pilar', province: 'Sorsogon' });
    assert.equal((html.match(/tw-print__logo/g) || []).length, 3);
    assert.match(html, /Barangay logo/);
    assert.match(html, /Municipal logo/);
    assert.match(html, /Bagong Pilipinas logo/);
  });

  test('referral time is shown in Asia/Manila, not the viewer zone', async () => {
    signIn('secretary');
    api.on('GET', '/incidents/:id/referrals', () => ({
      status: 200,
      body: { items: [{ referral_id: 1, incident_id: 902, barangay_id: 1, referred_to: 'pnp', other_text: null, contact_name: null, referred_at: '2026-10-01T00:30:00Z', reference_no: null, created_by: 1, created_at: '2026-10-01T00:30:00Z' }] },
    }));
    const card = ReferralsCard({ incidentId: 902, canAdd: false });
    window.document.body.appendChild(card);
    await settle();
    assert.match(text(card), /8:30/);
  });

  test('the Annex D signature block prints the names and official titles from the report', async () => {
    api.on('GET', '/ssz-term-reports/:id', ({ params }) => ({
      status: 200,
      body: {
        report_id: Number(params.id), barangay_id: 1, term_label: 'Term 1 S.Y. 2026-2027', term_start: '2026-08-24', term_end: '2026-10-30', status: 'prepared',
        total_tanods: 3, total_schools: 2, total_deployment_days: 12, total_incidents: 0, incidents_barangay_only: 0, incidents_pnp: 0, incidents_bfp: 0,
        incidents_higher_lgu: 0, incidents_doh: 0, incidents_dpwh: 0, incidents_other_agencies: 0, other_institutions: null, remarks: null,
        prepared_by: 1, prepared_by_name: 'Cesar Dimaano', prepared_by_title: 'Chief Tanod', prepared_at: null,
        approved_by: 3, approved_by_name: 'Teresa Magbanua', approved_by_title: 'Punong Barangay', approved_at: null,
        mayor_office_received_by: null, mayor_office_received_at: null, dilg_received_by: null, dilg_date_received: null, version: 2,
      },
    }));
    mountPage(renderSchoolZonesPage, { role: 'admin', param: { tab: 'term', reportId: 82 } });
    await settle();
    click(buttonByText(/Annex D/));
    await settle();
    const sheet = document.querySelector('#printable-annex-d');
    assert.ok(sheet);
    const lines = $$('.tw-print__sigline', sheet).map((n) => text(n));
    assert.ok(lines.includes('Cesar Dimaano'));
    assert.ok(lines.includes('Teresa Magbanua'));
    const titles = $$('.tw-print__sigtitle', sheet).map((n) => text(n));
    assert.deepEqual(titles, ['Chief Tanod', 'Punong Barangay']);
    click(document.querySelector('#close-print-modal'));
  });
});
