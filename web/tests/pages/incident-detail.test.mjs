import { describePage } from '../harness/pageSuite.mjs';
import { describe, test, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { api, window, mountPage, settle, cleanup, text, click, type, buttonByText, $, $$ } from '../harness/render.mjs';
import { renderIncidentDetailPage } from '../../src/pages/incident-detail.js';

// The Electronic Blotter and the AI redaction pipeline were removed
// (migration 0029), so this page is now a single incident view: dossier,
// narrative, evidence, timeline, the Admin resolve control and the
// Secretary's lifecycle actions.

describePage({
  name: 'Incident detail (W7, dispatched incident)',
  render: renderIncidentDetailPage,
  roles: ['admin', 'secretary', 'punong_barangay'],
  param: 902,
  heading: /^Incident Record — INC-2026-902/,
  expectText: ['Medical Emergency'],
});

describePage({
  name: 'Incident detail (W7, resolved incident)',
  render: renderIncidentDetailPage,
  roles: ['admin', 'secretary', 'punong_barangay'],
  param: 903,
  heading: /^Incident Record — INC-2026-903/,
  expectText: ['Case Closed & Resolved'],
});

describe('Incident detail behaviour', () => {
  afterEach(() => cleanup());

  test('the Secretary sees the raw narrative (Rule 1: Secretary-only)', async () => {
    const ctx = mountPage(renderIncidentDetailPage, { role: 'secretary', param: 903 });
    await settle();
    assert.match(text(ctx.root), /RAW-NARRATIVE-903/);
  });

  for (const role of ['admin', 'punong_barangay']) {
    test(`${role} never sees the raw narrative (Rule 1)`, async () => {
      const ctx = mountPage(renderIncidentDetailPage, { role, param: 903 });
      await settle();
      assert.doesNotMatch(text(), /RAW-NARRATIVE/);
      assert.match(text(ctx.root), /restricted to the Barangay Secretary/i);
    });

    test(`${role} gets no lifecycle controls (Secretary-only, §3)`, async () => {
      const ctx = mountPage(renderIncidentDetailPage, { role, param: 902 });
      await settle();
      assert.equal(buttonByText(/mark as duplicate|mark invalid|cancel this incident|reopen/i, ctx.root), undefined);
    });
  }

  test('no blotter, Lupon or AI controls exist on the page for any role', async () => {
    for (const role of ['admin', 'secretary', 'punong_barangay']) {
      const ctx = mountPage(renderIncidentDetailPage, { role, param: 902 });
      await settle();
      assert.doesNotMatch(text(ctx.root), /blotter|lupon|redaction|AI draft/i, `${role} still sees blotter/AI wording`);
      cleanup();
    }
  });

  test('a Secretary can mark a pending incident cancelled from the lifecycle card', async () => {
    const ctx = mountPage(renderIncidentDetailPage, { role: 'secretary', param: 901 });
    await settle();
    const btn = buttonByText(/cancel this incident/i, ctx.root);
    assert.ok(btn, 'lifecycle card should offer "Cancel this incident"');
    click(btn);
    await settle();
    const dialog = $('[role="alertdialog"]');
    assert.ok(dialog, 'expected a confirmation dialog');
    click($$('button', dialog).at(-1));
    await settle();
    const [call] = api.callsTo('PATCH', '/incidents/:id/lifecycle');
    assert.ok(call, 'PATCH /incidents/901/lifecycle was not sent');
    assert.equal(call.body.status, 'cancelled');
  });

  test('evidence is listed without ever exposing a file path', async () => {
    const ctx = mountPage(renderIncidentDetailPage, { role: 'secretary', param: 902 });
    await settle();
    assert.match(text(ctx.root), /scene\.jpg|photo/i);
    assert.doesNotMatch(ctx.root.innerHTML, /storage[\/]|[A-Z]:\|\/var\//, 'a filesystem path leaked into the page');
  });

  test('Back returns each role to a screen it can actually open', async () => {
    for (const [role, allowed] of [['secretary', ['incident-management', 'citizen-inbox']], ['admin', ['incident-management', 'dashboard', 'dispatch']], ['punong_barangay', ['dashboard', 'analytics']]]) {
      const ctx = mountPage(renderIncidentDetailPage, { role, param: 902 });
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

  test('the dossier shows the report channel from the server (SMS for 902, Walk-in for 904)', async () => {
    let ctx = mountPage(renderIncidentDetailPage, { role: 'admin', param: 902 });
    await settle();
    const tile = $$('.meta-tile', ctx.root).find((t) => /Report channel/i.test(text(t)));
    assert.ok(tile, 'Report channel tile missing');
    assert.match(text(tile), /SMS/);
    cleanup();
    ctx = mountPage(renderIncidentDetailPage, { role: 'secretary', param: 904 });
    await settle();
    assert.match(text($$('.meta-tile', ctx.root).find((t) => /Report channel/i.test(text(t)))), /Walk-in/);
  });

  test('Related incident card: shows the link both ways and each link opens that incident', async () => {
    let ctx = mountPage(renderIncidentDetailPage, { role: 'admin', param: 902 });
    await settle();
    let card = $('.case-card--related', ctx.root);
    assert.ok(card, 'Related incident card missing');
    assert.match(text(card), /Related to\s*INC-2026-903/);
    click(buttonByText(/INC-2026-903/, card));
    assert.deepEqual(ctx.navigations.at(-1), { page: 'incident-detail', param: 903 });
    cleanup();
    ctx = mountPage(renderIncidentDetailPage, { role: 'admin', param: 903 });
    await settle();
    card = $('.case-card--related', ctx.root);
    assert.match(text(card), /Referenced by\s*INC-2026-902/);
    assert.match(text(card), /No related incident/);
  });

  for (const role of ['admin', 'secretary']) {
    test(`${role} can link an incident: PATCH /incidents/:id/related with an Idempotency-Key`, async () => {
      const ctx = mountPage(renderIncidentDetailPage, { role, param: 901 });
      await settle();
      const card = $('.case-card--related', ctx.root);
      type($('input', card), '902');
      card.querySelector('form').dispatchEvent(new window.Event('submit', { bubbles: true, cancelable: true }));
      await settle();
      const [call] = api.callsTo('PATCH', '/incidents/:id/related');
      assert.ok(call, 'PATCH /incidents/:id/related was not sent');
      assert.equal(call.path, '/incidents/901/related');
      assert.deepEqual(call.body, { related_incident_id: 902 });
      assert.match(call.headers['idempotency-key'] || '', /^[0-9a-f-]{36}$/i);
      assert.equal(api.callsTo('PATCH', '/incidents/:id/lifecycle').length, 0, 'linking must not touch the lifecycle');
    });
  }

  test('linking validates the number client-side: blank, non-numeric and self are refused without a request', async () => {
    const ctx = mountPage(renderIncidentDetailPage, { role: 'secretary', param: 901 });
    await settle();
    const card = $('.case-card--related', ctx.root);
    const submit = () => card.querySelector('form').dispatchEvent(new window.Event('submit', { bubbles: true, cancelable: true }));
    submit();
    assert.match(text($('.login-form__error', card)), /whole number/);
    type($('input', card), '901');
    submit();
    assert.match(text($('.login-form__error', card)), /itself/);
    assert.equal(api.callsTo('PATCH', '/incidents/:id/related').length, 0);
  });

  test('a server refusal (unknown or other-barangay incident) shows inline and keeps what was typed', async () => {
    const ctx = mountPage(renderIncidentDetailPage, { role: 'admin', param: 901 });
    await settle();
    const card = $('.case-card--related', ctx.root);
    type($('input', card), '99999');
    card.querySelector('form').dispatchEvent(new window.Event('submit', { bubbles: true, cancelable: true }));
    await settle();
    assert.match(text($('.login-form__error', card)), /not found/i);
    assert.equal($('input', card).value, '99999');
  });

  test('Remove link is confirmed, then sends related_incident_id null', async () => {
    const ctx = mountPage(renderIncidentDetailPage, { role: 'secretary', param: 902 });
    await settle();
    click(buttonByText(/remove link/i, $('.case-card--related', ctx.root)));
    const dialog = $('[role="alertdialog"]');
    assert.ok(dialog, 'removal must be confirmed');
    assert.equal(api.callsTo('PATCH', '/incidents/:id/related').length, 0);
    click($$('button', dialog).at(-1));
    await settle();
    assert.deepEqual(api.callsTo('PATCH', '/incidents/:id/related')[0].body, { related_incident_id: null });
  });

  test('Punong Barangay sees the links but has no way to change them', async () => {
    const ctx = mountPage(renderIncidentDetailPage, { role: 'punong_barangay', param: 902 });
    await settle();
    const card = $('.case-card--related', ctx.root);
    assert.match(text(card), /INC-2026-903/);
    assert.equal($('input', card), null);
    assert.equal(buttonByText(/link incident|change link|remove link/i, card), undefined);
  });

  test('the Secretary duplicate action stays separate from the related link', async () => {
    const ctx = mountPage(renderIncidentDetailPage, { role: 'secretary', param: 901 });
    await settle();
    assert.ok(buttonByText(/mark as duplicate/i, ctx.root), 'the lifecycle duplicate action must still exist');
    assert.ok($('.case-card--related', ctx.root));
  });

  test('the incident hero renders one clean ID badge plus status and priority pills', async () => {
    const ctx = mountPage(renderIncidentDetailPage, { role: 'admin', param: 902 });
    await settle();

    const idBadge = $('.incident-id-badge', ctx.root);
    assert.ok(idBadge, 'incident ID badge missing');
    assert.match(text(idBadge), /INC-2026-902/);
    assert.equal($$('.incident-id-badge', ctx.root).length, 1, 'expected exactly one ID badge');

    const pills = $$('.status-pill', ctx.root);
    assert.ok(pills.length >= 2, 'expected status and priority pills');
    assert.ok(pills.some((p) => /DISPATCHED/i.test(text(p))));
    assert.ok(pills.some((p) => /CRITICAL PRIORITY/i.test(text(p))));
  });
});
