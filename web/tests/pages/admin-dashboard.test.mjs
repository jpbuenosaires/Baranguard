import { describePage } from '../harness/pageSuite.mjs';
import { describe, test, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { mountPage, settle, cleanup, text, click, buttonByText } from '../harness/render.mjs';
import { renderAdminDashboardPage } from '../../src/pages/admin-dashboard.js';

describePage({
  name: 'Admin Dashboard (W2)',
  render: renderAdminDashboardPage,
  roles: ['admin', 'punong_barangay'],
  heading: 'Admin Dashboard',
  expectText: ['Total Incidents', '20.3 min', 'Maria Dela Cruz'],
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
    assert.deepEqual(ctx.navigations.at(-1), { page: 'blotter-detail', param: 901 });
  });

  test('Punong Barangay is never offered a shortcut into an Admin-only screen', async () => {
    const ADMIN_ONLY = new Set(['dispatch', 'sms-log', 'audit-log', 'service-health', 'map-packages', 'incident-management', 'citizen-inbox']);
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
});
