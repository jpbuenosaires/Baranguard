import { describePage } from '../harness/pageSuite.mjs';
import { describe, test, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { api, mountPage, settle, cleanup, text, click, type, buttonByText, $, $$ } from '../harness/render.mjs';
import { renderBlotterDetailPage } from '../../src/pages/blotter-detail.js';

// 2026-09-27 tab merge (DEVLOG (38)): the finalize/amend panel, Lupon
// packet, and lifecycle actions all moved off the default (Incident) tab
// onto a separate "Blotter" tab, and the old standalone AI Review page
// is now a "Redaction" tab on this same page — same idiom
// settings.test.mjs's `openSection()` already uses for its own in-page
// sections. The tab bar itself only exists once the page has finished
// its initial load (renderShell()'s own doc explains why) — pageSuite.mjs's
// generic loading/error-state tests call `openDataView` during states
// where there is genuinely no tab bar yet, so this is a no-op then
// rather than a failed click() assertion.
const openTab = (label) => async (ctx) => {
  const btn = buttonByText(new RegExp(`^${label}$`, 'i'), ctx.root);
  if (btn) click(btn);
};

describePage({
  name: 'Incident detail (W7, dispatched incident)',
  render: renderBlotterDetailPage,
  roles: ['admin', 'secretary', 'punong_barangay'],
  param: 902,
  heading: /^Incident Record — INC-2026-902/,
  expectText: ['Medical Emergency'],
});

describePage({
  name: 'Incident detail (W7, finalized blotter)',
  render: renderBlotterDetailPage,
  roles: ['admin', 'secretary', 'punong_barangay'],
  param: 903,
  heading: /^Blotter Entry — BLT-2026-051/,
  expectText: ['Verbal altercation, settled amicably.'],
  openDataView: openTab('Blotter'),
});

describe('Incident detail behaviour', () => {
  afterEach(() => cleanup());

  test('the Secretary can reveal the raw intake narrative', async () => {
    const ctx = mountPage(renderBlotterDetailPage, { role: 'secretary', param: 903 });
    await settle();
    const toggle = buttonByText(/view raw intake/i, ctx.root);
    assert.ok(toggle, 'Secretary should have a View Raw Intake control');
    click(toggle);
    await settle();
    assert.match(text(ctx.root), /RAW-NARRATIVE-903/);
  });

  for (const role of ['admin', 'punong_barangay']) {
    test(`${role} never sees the raw narrative or a way to ask for it (Rule 1)`, async () => {
      const ctx = mountPage(renderBlotterDetailPage, { role, param: 903 });
      await settle();
      assert.equal(buttonByText(/raw intake|original narrative/i, ctx.root), undefined);
      assert.doesNotMatch(text(), /RAW-NARRATIVE/);
    });

    test(`${role} gets no finalize/amend controls (Secretary-only, §3)`, async () => {
      const ctx = mountPage(renderBlotterDetailPage, { role, param: 903 });
      await settle();
      assert.equal(buttonByText(/save amendment|finalize/i, ctx.root), undefined);
      assert.equal($('#blotter-amend-case-status', ctx.root), null);
    });
  }

  test('case status can only move forward (no "active" or "resolved" in the amend picker)', async () => {
    const ctx = mountPage(renderBlotterDetailPage, { role: 'secretary', param: 903 });
    await settle();
    await openTab('Blotter')(ctx);
    await settle();
    click(buttonByText(/amend this entry/i, ctx.root));
    const options = [...$('#blotter-amend-case-status').options].map((o) => o.value).filter(Boolean);
    assert.deepEqual(options.sort(), ['settled', 'under_investigation']);
  });

  test('an amendment needs a reason and posts to /blotter/amend', async () => {
    const ctx = mountPage(renderBlotterDetailPage, { role: 'secretary', param: 903 });
    await settle();
    await openTab('Blotter')(ctx);
    await settle();
    click(buttonByText(/amend this entry/i, ctx.root));
    const form = $('#blotter-amend-case-status').closest('form') ?? ctx.root;
    const reason = $$('textarea, input[type="text"]', form).find((el) => /reason/i.test(`${el.id} ${el.name} ${el.getAttribute('aria-label') || ''} ${el.labels?.[0]?.textContent || ''} ${el.placeholder}`));
    assert.ok(reason, 'no reason field on the amendment form');
    type(reason, 'Respondent name misspelled at intake.');
    click(buttonByText(/save amendment/i, ctx.root));
    await settle();
    const dialog = $('[role="alertdialog"]');
    if (dialog) { click($$('button', dialog).at(-1)); await settle(); }
    const [call] = api.callsTo('POST', '/incidents/:id/blotter/amend');
    assert.ok(call, 'POST /incidents/903/blotter/amend was not sent');
    assert.equal(call.body.reason, 'Respondent name misspelled at intake.');
  });

  test('without an approved redaction, the Secretary is sent to the Redaction tab first', async () => {
    const ctx = mountPage(renderBlotterDetailPage, { role: 'secretary', param: 901 });
    await settle();
    await openTab('Blotter')(ctx);
    await settle();
    assert.match(text(ctx.root), /Approve the AI redaction first/i);
    click(buttonByText(/review ai redaction/i, ctx.root));
    await settle();
    // A tab switch, not a page navigate() — this used to assert
    // ctx.navigations landed on a separate 'ai-review' route; there is no
    // such route anymore (2026-09-27 tab merge, DEVLOG (38)), so the real
    // assertion is that the Redaction tab is now the active one and its
    // own content (the raw-narrative panel) is on screen.
    assert.equal(ctx.navigations.length, 0, 'switching tabs must not be a page navigate()');
    assert.match(text(ctx.root), /Original Reported Narrative/i);
  });

  test('finalizing goes through a check-your-entry step before anything is sent', async () => {
    api.on('GET', '/incidents/:id', ({ params }) => ({ status: 200, body: {
      incident_id: Number(params.id), barangay_id: 1, reported_by: 4, incident_type: 'theft', priority: 'normal', status: 'pending', source: 'web',
      latitude: null, longitude: null, created_at: '2026-09-20 01:00:00', synced_at: null, location_description: null, display_id: 'INC-2026-778',
      raw_narrative: 'RAW', redacted_narrative: '[PERSON] reported a stolen bicycle.', redaction_approved_at: '2026-09-21 01:00:00', redaction_approved_by: 2,
      complainant_name: 'Ana Cruz', respondent_name: null, complainant_contact_number: null, dispatches: [],
    } }));
    const ctx = mountPage(renderBlotterDetailPage, { role: 'secretary', param: 778 });
    await settle();
    await openTab('Blotter')(ctx);
    await settle();
    const summary = $('#blotter-finalize-summary', ctx.root);
    assert.ok(summary, 'no finalize summary field');
    type(summary, '');
    click(buttonByText(/continue to check entry/i, ctx.root));
    await settle();
    assert.match(text(ctx.root), /There is a problem/);
    assert.equal(summary.getAttribute('aria-invalid'), 'true');

    type(summary, 'A bicycle was reported stolen near the plaza.');
    click(buttonByText(/continue to check entry/i, ctx.root));
    await settle();
    assert.match(text(ctx.root), /Check the entry before finalizing/);
    assert.match(text(ctx.root), /Ana Cruz/);
    assert.equal(api.callsTo('POST', '/incidents/:id/finalize').length, 0, 'nothing may be sent before the Secretary confirms');

    click(buttonByText(/^finalize blotter entry$/i, ctx.root));
    await settle();
    const [call] = api.callsTo('POST', '/incidents/:id/finalize');
    assert.ok(call, 'finalize was not sent');
    assert.equal(call.body.narrative_summary, 'A bicycle was reported stolen near the plaza.');
    assert.equal(call.body.complainant_name, 'Ana Cruz');
  });

  test('the amendment form stays collapsed until "Amend this entry"', async () => {
    const ctx = mountPage(renderBlotterDetailPage, { role: 'secretary', param: 903 });
    await settle();
    await openTab('Blotter')(ctx);
    await settle();
    const form = $('#blotter-amend-form', ctx.root);
    assert.ok(form?.hidden, 'amend form should start collapsed');
    click(buttonByText(/amend this entry/i, ctx.root));
    assert.equal(form.hidden, false);
  });

  test('a missing blotter record (404) is normal, not an error', async () => {
    const ctx = mountPage(renderBlotterDetailPage, { role: 'secretary', param: 901 });
    await settle();
    assert.equal($('.state-block--error', ctx.root), null);
  });

  test('evidence is listed without ever exposing a file path', async () => {
    const ctx = mountPage(renderBlotterDetailPage, { role: 'secretary', param: 902 });
    await settle();
    assert.match(text(ctx.root), /scene\.jpg|photo/i);
    assert.doesNotMatch(ctx.root.innerHTML, /storage[\\/]|[A-Z]:\\|\/var\//, 'a filesystem path leaked into the page');
  });

  test('Back returns each role to a screen it can actually open', async () => {
    for (const [role, allowed] of [['secretary', ['incident-management', 'citizen-inbox']], ['admin', ['incident-management', 'dashboard', 'dispatch']], ['punong_barangay', ['dashboard', 'analytics']]]) {
      const ctx = mountPage(renderBlotterDetailPage, { role, param: 902 });
      await settle();
      const back = buttonByText(/back/i, ctx.root);
      if (back) {
        click(back);
        const target = ctx.navigations.at(-1)?.page;
        assert.ok(allowed.includes(target), `${role} Back went to "${target}"`);
      }
      cleanup();
    }
  });

  test('case hero renders clean tokenized ID badges and status/priority pills for unfinalized incident', async () => {
    const ctx = mountPage(renderBlotterDetailPage, { role: 'admin', param: 902 });
    await settle();

    const idBadge = $('.blotter-id-badge', ctx.root);
    assert.ok(idBadge, 'incident ID badge missing');
    assert.match(text(idBadge), /INC-2026-902/);

    const incidentBadge = $('.blotter-id-badge--incident', ctx.root);
    assert.equal(incidentBadge, null, 'should not render duplicate incident system ID badge');

    const pills = $$('.status-pill', ctx.root);
    assert.ok(pills.length >= 2, 'expected status and priority pills');
    assert.ok(pills.some((p) => /DISPATCHED/i.test(text(p))));
    assert.ok(pills.some((p) => /CRITICAL PRIORITY/i.test(text(p))));
  });

  test('case hero renders blotter and originating incident badges when finalized', async () => {
    const ctx = mountPage(renderBlotterDetailPage, { role: 'admin', param: 903 });
    await settle();

    const blotterBadge = $('.blotter-id-badge', ctx.root);
    assert.ok(blotterBadge, 'blotter ID badge missing');
    assert.match(text(blotterBadge), /BLT-2026-051/);

    const incidentBadge = $('.blotter-id-badge--incident', ctx.root);
    assert.ok(incidentBadge, 'originating incident reference badge missing');
    assert.match(text(incidentBadge), /Ref: (INC-2026-903|#903)/);
  });
});

