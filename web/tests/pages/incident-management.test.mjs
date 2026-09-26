import { describePage } from '../harness/pageSuite.mjs';
import { describe, test, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { api, mountPage, settle, wait, cleanup, text, click, type, buttonByText, $, $$ } from '../harness/render.mjs';
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

  test('the incident list never exposes the raw narrative, even to a Secretary', async () => {
    mountPage(renderIncidentManagementPage, { role: 'secretary' });
    await settle();
    assert.doesNotMatch(text($('.data-table')), /RAW-NARRATIVE/);
  });
});
