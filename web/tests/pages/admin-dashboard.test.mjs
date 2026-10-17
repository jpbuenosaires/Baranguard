import { describePage } from '../harness/pageSuite.mjs';
import { describe, test, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { mountPage, settle, cleanup, text, click, buttonByText } from '../harness/render.mjs';
import { api } from '../harness/fakeApi.mjs';
import { renderAdminDashboardPage } from '../../src/pages/admin-dashboard.js';

describePage({
  name: 'Admin Dashboard (W2)',
  render: renderAdminDashboardPage,
  roles: ['admin', 'punong_barangay'],
  heading: 'Dashboard',
  expectText: ['Total Incidents', '20.3 min', 'Maria Dela Cruz'],
  // The attention banner re-reads live counts every 15 s (audit A-06).
  polls: true,
});

describe('Admin Dashboard behaviour', () => {
  afterEach(() => cleanup());

  test('KPIs come from GET /reports/summary, not invented numbers', async () => {
    mountPage(renderAdminDashboardPage, { role: 'admin' });
    await settle();
    const body = text();
    assert.match(body, /4\s*Total Incidents/, 'total incidents should be the fixture count (4)');
    assert.match(body, /20\.3 min\s*Avg\. Response Time/);
  });

  test('a null average response time shows an empty marker, not 0 or "null"', async () => {
    mountPage(renderAdminDashboardPage, { role: 'admin', scenario: 'empty' });
    await settle();
    assert.doesNotMatch(text(), /0 min\s*Avg\. Response Time/, 'no arrivals must not be shown as a 0-minute response');
  });

  test('the attention banner links to the Dispatch Center', async () => {
    const ctx = mountPage(renderAdminDashboardPage, { role: 'admin' });
    await settle();
    assert.match(text(), /SOS alert/i);
    click(buttonByText(/go to dispatch center/i, ctx.root));
    assert.deepEqual(ctx.navigations.at(-1), { page: 'dispatch', param: undefined });
  });

  test('a recent incident opens its detail page', async () => {
    const ctx = mountPage(renderAdminDashboardPage, { role: 'admin' });
    await settle();
    click(buttonByText(/^#901$/, ctx.root));
    assert.deepEqual(ctx.navigations.at(-1), { page: 'incident-detail', param: 901 });
  });

  test('Punong Barangay is never offered a shortcut into an Admin-only screen', async () => {
    const ADMIN_ONLY = new Set(['dispatch', 'sms-log', 'audit-log', 'service-health', 'map-packages', 'incident-management']);
    const ctx = mountPage(renderAdminDashboardPage, { role: 'punong_barangay' });
    await settle();
    const leaks = [];
    for (const label of [/go to dispatch center/i, /^dispatch center$/i, /message a resident/i, /log an incident/i]) {
      const button = buttonByText(label, ctx.root);
      if (!button) continue;
      const before = ctx.navigations.length;
      click(button);
      const target = ctx.navigations[before]?.page;
      if (target && ADMIN_ONLY.has(target)) leaks.push(`${label} -> ${target}`);
    }
    assert.deepEqual(leaks, [], 'buttons that route a read-only role to a screen main.js will refuse it');
  });

  test('no invented response-time target; the metric says what it measures and on how many incidents (N-01/N-02/P-03)', async () => {
    mountPage(renderAdminDashboardPage, { role: 'admin' });
    await settle();
    const body = text();
    assert.doesNotMatch(body, /Target\s*</i, 'no document defines a response target');
    assert.doesNotMatch(body, /dispatch to arrival/i, 'the clock starts at the report, not at dispatch');
    // fixture trend: 30 days, arrivals = 1 except every 4th day -> 22
    assert.match(body, /Based on 22 incidents with a Tanod arrival/);
  });

  test('the attention banner counts reopened incidents and ignores the date range (A-06)', async () => {
    api.on('GET', '/incidents', ({ query }) => {
      const rows = query.status === 'reopened'
        ? [{ incident_id: 990, barangay_id: 1, incident_type: 'theft', priority: 'normal', status: 'reopened', created_at: '2026-01-01 00:00:00' }]
        : [];
      return { status: 200, body: { items: rows, page: 1, limit: Number(query.limit || 25), total: rows.length } };
    });
    api.on('GET', '/tanod-sos', () => ({ status: 200, body: { items: [] } }));
    mountPage(renderAdminDashboardPage, { role: 'admin' });
    await settle();
    assert.match(text(), /1 reopened incident/);
  });

  test('a quiet date range does not hide the live banner or approvals (A-07/P-08)', async () => {
    api.on('GET', '/reports/summary', () => ({ status: 200, body: {
      total_incidents: 0, resolved_count: 0, avg_response_time_minutes: null, response_sample_size: 0, active_tanods: 0,
      by_incident_type: { theft: 0 }, by_status: { pending: 0, dispatched: 0, resolved: 0 },
      trend: [{ date: '2026-10-01', count: 0, resolved: 0, arrivals: 0 }], by_hour: Array(24).fill(0),
      response_time_trend: [{ date: '2026-10-01', avg_minutes: null, sample_size: 0 }],
    } }));
    mountPage(renderAdminDashboardPage, { role: 'admin' });
    await settle();
    const body = text();
    assert.doesNotMatch(body, /hasn't logged any incidents/, 'the barangay HAS incidents on record, so this is not a fresh deployment');
    assert.match(body, /No incidents were reported in the selected date range/);
    assert.match(body, /SOS alert/i, 'open SOS alerts must still show on a quiet range');
    assert.match(body, /Pending Approvals/);
  });

  test('Punong Barangay banner names who acts and offers the Live Map, not Dispatch (P-18)', async () => {
    const ctx = mountPage(renderAdminDashboardPage, { role: 'punong_barangay' });
    await settle();
    assert.match(text(), /Chief Tanod \(Admin\) handles dispatch/);
    click(buttonByText(/open the live map/i, ctx.root));
    assert.deepEqual(ctx.navigations.at(-1), { page: 'gis', param: undefined });
  });
});
