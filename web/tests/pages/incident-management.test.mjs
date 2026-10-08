import { describePage } from '../harness/pageSuite.mjs';
import { describe, test, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { api, window, mountPage, settle, wait, cleanup, text, click, type, buttonByText, $, $$ } from '../harness/render.mjs';
import { renderIncidentManagementPage } from '../../src/pages/incident-management.js';

// backend/migrations/0001_baseline_schema.sql, widened by 0025
// (H-16/M-03 lifecycle states -- IncidentsController::INCIDENT_STATUSES)
const SCHEMA_PRIORITIES = ['normal', 'high', 'critical'];
const SCHEMA_STATUSES = ['pending', 'dispatched', 'resolved', 'duplicate', 'invalid', 'cancelled', 'reopened'];

describePage({
  name: 'Incident Management',
  render: renderIncidentManagementPage,
  roles: ['admin', 'secretary'],
  heading: 'Incident Management',
  expectText: ['INC-2026-901', 'INC-2026-904', 'Purok 3, near the market'],
});

describe('Incident Management behaviour', () => {
  afterEach(() => cleanup());

  test('filter options only offer values that exist in the schema', async () => {
    mountPage(renderIncidentManagementPage, { role: 'admin' });
    await settle();
    const priority = $('select[aria-label="Filter by priority"]');
    const status = $('select[aria-label="Filter by status"]');
    const bogus = [
      ...[...priority.options].map((o) => o.value).filter((v) => v && !SCHEMA_PRIORITIES.includes(v)).map((v) => `priority "${v}"`),
      ...[...status.options].map((o) => o.value).filter((v) => v && !SCHEMA_STATUSES.includes(v)).map((v) => `status "${v}"`),
    ];
    assert.deepEqual(bogus, [], 'a filter option that can never match a row is a control that does nothing (§2 Rule 6)');
  });

  test('choosing a priority filter asks the server, not a client-side guess', async () => {
    mountPage(renderIncidentManagementPage, { role: 'admin' });
    await settle();
    type($('select[aria-label="Filter by priority"]'), 'critical');
    await settle();
    assert.ok(api.calls.some((c) => c.path === '/incidents' && c.query.priority === 'critical'), 'no GET /incidents?priority=critical');
  });

  test('search is sent to the server as q=', async () => {
    mountPage(renderIncidentManagementPage, { role: 'admin' });
    await settle();
    type($('.incident-search-input'), '902');
    await wait(600);
    assert.ok(api.calls.some((c) => c.path === '/incidents' && c.query.q === '902'), 'search did not reach GET /incidents?q=');
  });

  test('selecting a row opens that incident in the detail pane', async () => {
    const ctx = mountPage(renderIncidentManagementPage, { role: 'admin' });
    await settle();
    click(buttonByText(/^INC-2026-902/, ctx.root));
    await settle();
    assert.ok(api.callsTo('GET', '/incidents/902').length >= 1, 'the detail pane did not load the incident');
    assert.match(text(ctx.root), /INC-2026-902/);

    const statBadge = $('.incident-detail-badge--dispatched', ctx.root);
    assert.ok(statBadge, 'detail pane status badge with dispatched modifier class missing');
    assert.match(text(statBadge), /Responding/);
    assert.ok($('svg', statBadge), 'detail pane status badge icon missing');
  });

  test('an initial incident id (from Citizen Reports) opens straight to that incident', async () => {
    mountPage(renderIncidentManagementPage, { role: 'secretary', param: 903 });
    await settle();
    assert.ok(api.callsTo('GET', '/incidents/903').length >= 1);
  });

  test('Admin cannot see the raw narrative; the server never sends it to them', async () => {
    const ctx = mountPage(renderIncidentManagementPage, { role: 'admin' });
    await settle();
    click(buttonByText(/^INC-2026-901/, ctx.root));
    await settle();
    assert.doesNotMatch(text(), /RAW-NARRATIVE-901/);

    const statBadge = $('.incident-detail-badge--pending', ctx.root);
    assert.ok(statBadge, 'detail pane status badge with pending modifier class missing');
    assert.match(text(statBadge), /Active/);
    assert.ok($('svg', statBadge), 'detail pane status badge icon missing');
  });

  for (const role of ['admin', 'secretary']) {
    test(`${role}: the Log an Incident form has a Report channel select, defaulting to Walk-in`, async () => {
      const ctx = mountPage(renderIncidentManagementPage, { role });
      await settle();
      click(buttonByText(/new incident/i, ctx.root));
      await settle();
      const select = $('#incident-report-channel');
      assert.ok(select, 'Report channel select missing');
      assert.deepEqual([...select.options].map((o) => text(o)), ['Tanod alerted', 'Walk-in', 'SMS', 'Other']);
      assert.deepEqual([...select.options].map((o) => o.value), ['tanod_alerted', 'walk_in', 'sms', 'other']);
      assert.equal(select.value, 'walk_in');
      assert.equal(text($(`label[for="incident-report-channel"]`)), 'Report channel');
    });

    test(`${role}: submitting sends the default report_channel walk_in`, async () => {
      const ctx = mountPage(renderIncidentManagementPage, { role });
      await settle();
      click(buttonByText(/new incident/i, ctx.root));
      await settle();
      type($('.incident-form-textarea'), 'Caller reported a noisy gathering.');
      $('.incident-form-pane form').dispatchEvent(new window.Event('submit', { bubbles: true, cancelable: true }));
      await settle();
      const [call] = api.callsTo('POST', '/incidents');
      assert.ok(call, 'POST /incidents was not sent');
      assert.equal(call.body.report_channel, 'walk_in');
      assert.match(call.headers['idempotency-key'] || '', /^[0-9a-f-]{36}$/i);
    });
  }

  test('a different report channel is sent as chosen', async () => {
    const ctx = mountPage(renderIncidentManagementPage, { role: 'secretary' });
    await settle();
    click(buttonByText(/new incident/i, ctx.root));
    await settle();
    type($('#incident-report-channel'), 'sms');
    type($('.incident-form-textarea'), 'Text message from a resident.');
    $('.incident-form-pane form').dispatchEvent(new window.Event('submit', { bubbles: true, cancelable: true }));
    await settle();
    assert.equal(api.callsTo('POST', '/incidents')[0].body.report_channel, 'sms');
  });

  test('the incident list never exposes the raw narrative, even to a Secretary', async () => {
    mountPage(renderIncidentManagementPage, { role: 'secretary' });
    await settle();
    assert.doesNotMatch(text($('.data-table')), /RAW-NARRATIVE/);
  });
  test('Resolve/dispatch controls are Admin-only; the Secretary sees a read-only note instead', async () => {
    for (const [role, id] of [['secretary', 902], ['secretary', 901]]) {
      const ctx = mountPage(renderIncidentManagementPage, { role });
      await settle();
      click(buttonByText(new RegExp(`^INC-2026-${id}`), ctx.root));
      await settle();
      assert.equal(buttonByText(/resolve incident/i, ctx.root), undefined, 'no Resolve button for the Secretary');
      assert.equal(buttonByText(/dispatch tanod|assign additional responder/i, ctx.root), undefined);
      assert.match(text(ctx.root), id === 902 ? /Resolving is done by the Admin/ : /Dispatching is done by the Admin/);
      cleanup();
    }
    const ctx = mountPage(renderIncidentManagementPage, { role: 'admin' });
    await settle();
    click(buttonByText(/^INC-2026-902/, ctx.root));
    await settle();
    assert.ok(buttonByText(/resolve incident/i, ctx.root), 'Admin still gets Resolve');
  });
});
