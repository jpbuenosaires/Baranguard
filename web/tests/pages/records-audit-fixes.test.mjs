import { describe, test, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { api, window, mountPage, settle, cleanup, text, click, type, buttonByText, $, $$ } from '../harness/render.mjs';
import { renderIncidentManagementPage } from '../../src/pages/incident-management.js';
import { renderIncidentDetailPage } from '../../src/pages/incident-detail.js';
import { renderSchoolZonesPage } from '../../src/pages/school-zones.js';
import { clearAuthorityCache } from '../../src/services/tanodWorkflowUi.js';

// Audit 2026-10-09, Secretary / Admin / Punong Barangay findings S-01..S-09,
// S-14, S-16, S-19, S-21, A-09, A-10, P-09: invented content, the 90-day
// narrative purge, official printouts, the walk-in form.

const FORBIDDEN_FABRICATIONS = /Juan dela Cruz|Under Investigation|Barangay Center|Barangay Desk Secretary|Purok 3, near market/;

function withListOverride(mutate) {
  const original = api.routes.find((r) => r.method === 'GET' && r.path === '/incidents');
  api.on('GET', '/incidents', (req) => {
    const res = original.handler(req);
    const body = res.body ?? res;
    return { status: 200, body: { ...body, items: (body.items ?? []).map(mutate) } };
  });
}

function withDetailOverride(id, mutate) {
  const original = api.routes.find((r) => r.method === 'GET' && r.path === '/incidents/:id');
  api.on('GET', '/incidents/:id', (req) => {
    const res = original.handler(req);
    const body = res.body ?? res;
    return Number(req.params.id) === id ? { status: 200, body: mutate({ ...body }) } : res;
  });
}

describe('Incident Management: no invented content', () => {
  afterEach(() => cleanup());

  test('"Reported - By" never shows a made-up name or a bare user id', async () => {
    const ctx = mountPage(renderIncidentManagementPage, { role: 'admin' });
    await settle();
    click(buttonByText(/^INC-2026-902/, ctx.root));
    await settle();
    const pane = text($('.incident-right-panel'));
    assert.doesNotMatch(pane, FORBIDDEN_FABRICATIONS);
    // The Admin now reads the party details (Rule 1 amended 2026-10-13), so "By" is the complainant's name.
    assert.match(pane, /By: Juan Santos/);
    assert.doesNotMatch(pane, /By: \d+/);
  });

  test('"Reported - By" falls back to the channel when the server sends no complainant name', async () => {
    withDetailOverride(902, (b) => ({ ...b, complainant_name: null }));
    const ctx = mountPage(renderIncidentManagementPage, { role: 'admin' });
    await settle();
    click(buttonByText(/^INC-2026-902/, ctx.root));
    await settle();
    const pane = text($('.incident-right-panel'));
    assert.match(pane, /Channel: SMS/);
    assert.doesNotMatch(pane, /By: \d+/);
  });

  test('an incident with no location text says so instead of inventing a purok', async () => {
    const ctx = mountPage(renderIncidentManagementPage, { role: 'admin' });
    await settle();
    click(buttonByText(/^INC-2026-904/, ctx.root));
    await settle();
    assert.match(text($('.incident-right-panel')), /No location description recorded/);
    assert.doesNotMatch(text($('.incident-right-panel')), /Purok 3, near market/);
  });

  test('when the barangay lookup fails the fallback uses the fixed ids (Binanuahan=2, Marifosque=3) and never guesses "Dao"', async () => {
    api.fail('GET', '/barangays', 500);
    withListOverride((i) => {
      if (i.incident_id === 901) return { ...i, barangay_id: 2 };
      if (i.incident_id === 902) return { ...i, barangay_id: 3 };
      if (i.incident_id === 903) return { ...i, barangay_id: 4 };
      if (i.incident_id === 904) return { ...i, barangay_id: 9 };
      return i;
    });
    const ctx = mountPage(renderIncidentManagementPage, { role: 'admin' });
    await settle();
    const rowText = (id) => text(buttonByText(new RegExp(`^INC-2026-${id}`), ctx.root).closest('tr'));
    assert.match(rowText(901), /Brgy\. Binanuahan/);
    assert.match(rowText(902), /Brgy\. Marifosque/);
    assert.match(rowText(903), /Brgy\. Banuyo/);
    assert.match(rowText(904), /Barangay #9/);
    assert.doesNotMatch(rowText(904), /Dao/);
  });
});

describe('Incident Management: walk-in form', () => {
  afterEach(() => cleanup());

  async function openForm(role) {
    const ctx = mountPage(renderIncidentManagementPage, { role });
    await settle();
    click(buttonByText(/new incident/i, ctx.root));
    await settle();
    return ctx;
  }

  test('every field label is linked to its control', async () => {
    await openForm('secretary');
    const form = $('.incident-form-pane form');
    const labels = $$('label', form);
    assert.ok(labels.length >= 8);
    for (const label of labels) {
      assert.ok(label.htmlFor, `label "${text(label)}" has no for=`);
      const control = form.querySelector(`#${label.htmlFor}`);
      assert.ok(control, `label "${text(label)}" points at a missing control`);
    }
  });

  test('the Secretary can enter the respondent, contact number and school; they are sent as the API expects', async () => {
    await openForm('secretary');
    type($('#incident-new-complainant'), 'Maria Reyes');
    type($('#incident-new-respondent'), 'Pedro Santos');
    type($('#incident-new-contact'), '09171234567');
    const school = $('#incident-new-school');
    assert.ok([...school.options].some((o) => /Dao Elementary School/.test(text(o))), 'schools are offered');
    school.value = [...school.options].find((o) => /Dao Elementary School/.test(text(o))).value;
    type($('.incident-form-textarea'), 'Walk-in complaint about a fence dispute.');
    $('.incident-form-pane form').dispatchEvent(new window.Event('submit', { bubbles: true, cancelable: true }));
    await settle();
    const [call] = api.callsTo('POST', '/incidents');
    assert.ok(call, 'POST /incidents was not sent');
    assert.equal(call.body.respondent_name, 'Pedro Santos');
    assert.equal(call.body.complainant_contact_number, '09171234567');
    // The school link goes through the existing PATCH, with its own key.
    const [patch] = api.callsTo('PATCH', '/incidents/:id');
    assert.ok(patch, 'the school link was not saved');
    assert.equal(patch.path, '/incidents/905');
    assert.ok(Number.isInteger(patch.body.school_id));
    // The Secretary is told the new incident number.
    assert.match(text(window.document.body), /INC-2026-905 logged/);
  });

  test('the Admin is not offered the Secretary-only party fields', async () => {
    await openForm('admin');
    assert.equal($('#incident-new-respondent'), null);
    assert.equal($('#incident-new-contact'), null);
    assert.ok($('#incident-new-school'), 'the school link is available to the Admin too');
  });
});

describe('Incident detail: honest wording', () => {
  afterEach(() => cleanup());

  test('Punong Barangay sees "Restricted to the Barangay Secretary...", never "Under Investigation"; Admin reads the details', async () => {
    for (const role of ['punong_barangay']) {
      const ctx = mountPage(renderIncidentDetailPage, { role, param: 903 });
      await settle();
      const body = text(ctx.root);
      assert.doesNotMatch(body, FORBIDDEN_FABRICATIONS, `${role} still sees invented wording`);
      assert.match(body, /Restricted to the Barangay Secretary/, `${role}`);
      cleanup();
    }
  });

  test('the Admin sees the confidential details, with no "Restricted" wording and no invented text', async () => {
    const ctx = mountPage(renderIncidentDetailPage, { role: 'admin', param: 903 });
    await settle();
    const body = text(ctx.root);
    assert.doesNotMatch(body, FORBIDDEN_FABRICATIONS);
    assert.match(body, /RAW-NARRATIVE-903/);
    assert.doesNotMatch(body, /Restricted to the Barangay Secretary/);
  });

  test('the Secretary sees "Not recorded" for a missing respondent, plus honest location and officer fallbacks', async () => {
    const ctx = mountPage(renderIncidentDetailPage, { role: 'secretary', param: 904 });
    await settle();
    const body = text(ctx.root);
    assert.doesNotMatch(body, FORBIDDEN_FABRICATIONS);
    assert.match(body, /Respondent\s*Not recorded/);
    assert.match(body, /No location recorded/);
    assert.match(body, /Recording Officer\s*Not recorded/);
  });

  test('a Secretary opening an incident older than 90 days with no narrative is told it was removed by retention', async () => {
    withDetailOverride(903, (b) => ({ ...b, raw_narrative: null, created_at: '2026-01-02 08:00:00' }));
    const ctx = mountPage(renderIncidentDetailPage, { role: 'secretary', param: 903 });
    await settle();
    assert.match(text(ctx.root), /The confidential narrative was removed after the 90-day retention period/);
    assert.doesNotMatch(text(ctx.root), /No narrative recorded yet/);
  });

  test('a recent incident with no narrative says it was not recorded, not that it was removed', async () => {
    withDetailOverride(901, (b) => ({ ...b, raw_narrative: null }));
    const ctx = mountPage(renderIncidentDetailPage, { role: 'secretary', param: 901 });
    await settle();
    assert.match(text(ctx.root), /No narrative recorded\./);
    assert.doesNotMatch(text(ctx.root), /removed after the 90-day/);
  });

  test('the resolved card no longer claims permanent statutory retention', async () => {
    const ctx = mountPage(renderIncidentDetailPage, { role: 'secretary', param: 903 });
    await settle();
    assert.match(text(ctx.root), /Case Closed & Resolved/);
    assert.doesNotMatch(text(ctx.root), /Permanent statutory retention|Section 394/);
  });

  test('a 403 on evidence reads "Not available for your role", not "No digital evidence recorded"', async () => {
    api.fail('GET', '/incidents/:id/evidence', 403, 'FORBIDDEN', 'Your role may not view this.');
    const ctx = mountPage(renderIncidentDetailPage, { role: 'punong_barangay', param: 902 });
    await settle();
    assert.match(text(ctx.root), /Digital evidence: Not available for your role/);
    assert.doesNotMatch(text(ctx.root), /No digital evidence attachments recorded/);
  });

  test('a genuine empty evidence list still says nothing is recorded', async () => {
    const ctx = mountPage(renderIncidentDetailPage, { role: 'secretary', param: 901 });
    await settle();
    assert.match(text(ctx.root), /No digital evidence attachments recorded/);
  });

  test('marking a duplicate takes the display id, shows the target, then saves its numeric id', async () => {
    const ctx = mountPage(renderIncidentDetailPage, { role: 'secretary', param: 901 });
    await settle();
    click(buttonByText(/mark as duplicate/i, ctx.root));
    await settle();
    let dialog = $('[role="alertdialog"]');
    assert.ok(dialog);
    type($('input', dialog), 'INC-2026-902');
    click($$('button', dialog).at(-1));
    await settle();
    dialog = $('[role="alertdialog"]');
    assert.ok(dialog, 'a preview confirmation must follow the lookup');
    assert.match(text(dialog), /INC-2026-902: medical emergency, logged/);
    assert.equal(api.callsTo('PATCH', '/incidents/:id/lifecycle').length, 0, 'nothing saved before the preview is confirmed');
    click($$('button', dialog).at(-1));
    await settle();
    const [call] = api.callsTo('PATCH', '/incidents/:id/lifecycle');
    assert.ok(call);
    assert.equal(call.body.status, 'duplicate');
    assert.equal(call.body.duplicate_of_incident_id, 902);
  });

  test('marking a duplicate of an unknown number shows an error and saves nothing', async () => {
    const ctx = mountPage(renderIncidentDetailPage, { role: 'secretary', param: 901 });
    await settle();
    click(buttonByText(/mark as duplicate/i, ctx.root));
    await settle();
    const dialog = $('[role="alertdialog"]');
    type($('input', dialog), 'INC-2026-99999');
    click($$('button', dialog).at(-1));
    await settle();
    assert.match(text($('.confirm-dialog__error')), /No incident .* was found/);
    assert.equal(api.callsTo('PATCH', '/incidents/:id/lifecycle').length, 0);
  });
});

describe('Official printouts (Annex B, C-1, D)', () => {
  afterEach(() => { cleanup(); clearAuthorityCache(); });

  async function openC1() {
    mountPage(renderSchoolZonesPage, { role: 'secretary', param: { tab: 'incidents' } });
    await settle();
  }

  test('Annex C-1 labels the time as "Reported" and prints blank status notes instead of the system status', async () => {
    await openC1();
    click(buttonByText(/Annex C-1/));
    await settle();
    const sheet = document.querySelector('#printable-annex-c1');
    assert.ok(sheet, 'the preview should open');
    const body = text(sheet);
    assert.match(body, /Reported: /);
    assert.doesNotMatch(body, /Referral data could not be loaded/);
    // Incident 902 is dispatched with empty status notes: the internal word must not be printed.
    const cells = $$('tbody tr', sheet)[0].querySelectorAll('td');
    assert.equal(text(cells[7]), '', 'status notes cell must be blank, not "Dispatched"');
    assert.match(body, /Incidents logged: all dates on file\. 1 incident listed\./);
    click(document.querySelector('#close-print-modal'));
  });

  test('a failed referral lookup blocks the C-1 print instead of leaving "referred to" blank', async () => {
    api.fail('GET', '/incidents/:id/referrals', 500);
    await openC1();
    assert.match(text(document.body), /Referral data could not be loaded - do not file this copy/);
    click(buttonByText(/Annex C-1/));
    await settle();
    assert.equal(document.querySelector('#printable-annex-c1'), null, 'no preview may open with unchecked referrals');
    assert.match(text(document.body), /Referral data could not be loaded for 1 incident/);
  });

  test('a failed letterhead lookup prints a clear warning, not "Barangay #1" with empty slots', async () => {
    api.fail('GET', '/barangays', 500);
    mountPage(renderSchoolZonesPage, { role: 'admin', param: { tab: 'schools' } });
    await settle();
    click(buttonByText(/Annex B/));
    await settle();
    const sheet = document.querySelector('#printable-annex-b');
    assert.ok(sheet);
    assert.match(text(sheet), /LETTERHEAD NOT LOADED/);
    assert.doesNotMatch(text(sheet), /Barangay #1/);
    assert.equal($$('.tw-print__logo', sheet).length, 0);
    click(document.querySelector('#close-print-modal'));
  });

  test('a draft Annex D prints marked DRAFT - NOT FOR SUBMISSION', async () => {
    mountPage(renderSchoolZonesPage, { role: 'admin', param: { tab: 'term', reportId: 81 } });
    await settle();
    click(buttonByText(/Annex D/));
    await settle();
    const sheet = document.querySelector('#printable-annex-d');
    assert.ok(sheet);
    assert.match(text(sheet), /DRAFT - NOT FOR SUBMISSION \(status: Draft\)/i);
    assert.match(text(sheet), /Report status when printed: Draft/i);
    click(document.querySelector('#close-print-modal'));
  });

  test('only a draft Annex D is marked; a prepared one (ready to sign) is not', async () => {
    const stub = (status) => api.on('GET', '/ssz-term-reports/:id', ({ params }) => ({
      status: 200,
      body: {
        report_id: Number(params.id), barangay_id: 1, term_label: 'Term 1 S.Y. 2026-2027', term_start: '2026-08-24', term_end: '2026-10-30', status,
        total_tanods: 3, total_schools: 2, total_deployment_days: 12, total_incidents: 0, incidents_barangay_only: 0, incidents_pnp: 0, incidents_bfp: 0,
        incidents_higher_lgu: 0, incidents_doh: 0, incidents_dpwh: 0, incidents_other_agencies: 0, other_institutions: null, remarks: null,
        prepared_by: 1, prepared_by_name: 'A', prepared_by_title: 'Chief Tanod', prepared_at: null,
        mayor_office_received_by: null, mayor_office_received_at: null, dilg_received_by: null, dilg_date_received: null, version: 2,
      },
    }));
    stub('draft');
    mountPage(renderSchoolZonesPage, { role: 'admin', param: { tab: 'term', reportId: 82 } });
    await settle();
    click(buttonByText(/Annex D/));
    await settle();
    assert.match(text(document.querySelector('#printable-annex-d')), /DRAFT - NOT FOR SUBMISSION/);
    click(document.querySelector('#close-print-modal'));
    cleanup();
    clearAuthorityCache();
    stub('prepared');
    mountPage(renderSchoolZonesPage, { role: 'admin', param: { tab: 'term', reportId: 82 } });
    await settle();
    click(buttonByText(/Annex D/));
    await settle();
    assert.doesNotMatch(text(document.querySelector('#printable-annex-d')), /DRAFT - NOT FOR SUBMISSION/);
    click(document.querySelector('#close-print-modal'));
  });
});
