import { describePage } from '../harness/pageSuite.mjs';
import { describe, test, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { api, mountPage, settle, cleanup, text, click, type, buttonByText, $, $$ } from '../harness/render.mjs';
import { renderBlotterDetailPage } from '../../src/pages/blotter-detail.js';

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
    mountPage(renderBlotterDetailPage, { role: 'secretary', param: 903 });
    await settle();
    const options = [...$('#blotter-amend-case-status').options].map((o) => o.value).filter(Boolean);
    assert.deepEqual(options.sort(), ['settled', 'under_investigation']);
  });

  test('an amendment needs a reason and posts to /blotter/amend', async () => {
    const ctx = mountPage(renderBlotterDetailPage, { role: 'secretary', param: 903 });
    await settle();
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

  test('without an approved redaction, the Secretary is sent to AI Review first', async () => {
    const ctx = mountPage(renderBlotterDetailPage, { role: 'secretary', param: 901 });
    await settle();
    assert.match(text(ctx.root), /AI Redaction Approval Required/i);
    click(buttonByText(/review ai redaction/i, ctx.root));
    assert.deepEqual(ctx.navigations.at(-1), { page: 'ai-review', param: 901 });
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

