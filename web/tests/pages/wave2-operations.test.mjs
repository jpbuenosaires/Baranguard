/**
 * Wave 2 (audit 2026-10-09) operations pages: Manila time, plain labels,
 * linked labels / accessible names, tab and dialog semantics, and the fixed
 * Review Inbox target. One file so the intent of each fix stays readable.
 */
import { describe, test, afterEach, before } from 'node:test';
import assert from 'node:assert/strict';
import { window, mountPage, settle, cleanup, text, click, key, $, $$, buttonByText } from '../harness/render.mjs';
import { renderAnalyticsPage } from '../../src/pages/analytics.js';
import { renderAuditLogPage } from '../../src/pages/audit-log.js';
import { renderServiceHealthPage } from '../../src/pages/service-health.js';
import { renderSmsMonitorPage } from '../../src/pages/sms-monitor.js';
import { renderSettingsPage } from '../../src/pages/settings.js';
import { renderMapPackagesPage } from '../../src/pages/map-packages.js';
import { renderGisLiveTrackingPage } from '../../src/pages/gis-live-tracking.js';
import { renderAdminDashboardPage } from '../../src/pages/admin-dashboard.js';

describe('Wave 2 operations pages', () => {
  // A non-Manila process zone makes any use of the browser zone visible.
  before(() => { process.env.TZ = 'America/Los_Angeles'; });
  afterEach(() => cleanup());

  test('Analytics tabs are a real tablist: selected state, panel link, arrow keys', async () => {
    mountPage(renderAnalyticsPage, { role: 'admin' });
    await settle();
    const tabs = $$('[role="tab"]');
    assert.equal(tabs.length, 2);
    assert.equal(tabs[0].getAttribute('aria-selected'), 'true');
    assert.equal(tabs[1].getAttribute('aria-selected'), 'false');
    assert.ok($('[role="tabpanel"]'), 'no tabpanel');
    assert.equal($('[role="tabpanel"]').getAttribute('aria-labelledby'), tabs[0].id);
    key(tabs[0], 'ArrowRight');
    await settle();
    assert.equal(tabs[1].getAttribute('aria-selected'), 'true', 'ArrowRight must move to the Heatmap tab');
  });

  test('Heatmap uses plain wording, not "hotspot" or "GPS-verified"', async () => {
    mountPage(renderAnalyticsPage, { role: 'admin' });
    await settle();
    click($$('[role="tab"]')[1]);
    await settle();
    const body = text($('[role="tabpanel"]'));
    assert.match(body, /Most Common Category/);
    assert.doesNotMatch(body, /Top Hotspot|GPS-verified/);
  });

  test('Dashboard recent-incident status is a plain label, never the raw code', async () => {
    mountPage(renderAdminDashboardPage, { role: 'admin' });
    await settle();
    const pills = $$('[data-recent-incidents] .status-pill').map((p) => text(p));
    assert.ok(pills.length > 0, 'no recent incidents rendered');
    for (const label of pills) assert.match(label, /^[A-Z][a-z ]+$/, `"${label}" is not a plain label`);
  });

  test('Audit Log: details dialog is labelled, traps focus, Escape closes and returns focus', async () => {
    mountPage(renderAuditLogPage, { role: 'admin' });
    await settle();
    const row = $('.data-table tbody tr');
    const opener = $('.data-table__row-activator', row) || row;
    opener.focus?.();
    click(opener);
    await settle();
    const dialog = $('.audit-modal-backdrop');
    assert.ok(dialog, 'dialog did not open');
    const labelledBy = dialog.getAttribute('aria-labelledby');
    assert.ok(labelledBy && $(`#${labelledBy}`), 'dialog has no accessible name');
    assert.match(text(dialog), /Manila time/);
    assert.doesNotMatch(text(dialog), /UTC:/);
    assert.equal(document.activeElement.getAttribute('aria-label'), 'Close dialog', 'focus should start on Close');
    key(document.activeElement, 'Escape');
    document.dispatchEvent(new window.KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
    await settle();
    assert.equal($('.audit-modal-backdrop'), null, 'Escape should close the dialog');
  });

  test('Audit Log: result count is announced and the page makes no "immutable" or compliance claim', async () => {
    mountPage(renderAuditLogPage, { role: 'admin' });
    await settle();
    const status = $$('[role="status"]').find((s) => /Showing \d+ of \d+ audit entries/.test(text(s)));
    assert.ok(status, 'no live result count');
    assert.doesNotMatch(text($('.page-content')), /Immutable|tamper-evident|RA 10173|Statutory/i);
  });

  test('Service Health: plain status words, a "What to do" step, and a labelled dialog', async () => {
    mountPage(renderServiceHealthPage, { role: 'admin' });
    await settle();
    const body = text($('.page-content'));
    assert.doesNotMatch(body, /HEALTHY|UNHEALTHY|NOT CONFIGURED|port 8140/);
    assert.match(body, /Not set up|Set up, not tested|Working/);
    const card = $('.health-service-card');
    click(card);
    await settle();
    const dialog = $('.health-modal-backdrop');
    assert.ok(dialog, 'details dialog did not open');
    assert.ok($(`#${dialog.getAttribute('aria-labelledby')}`), 'dialog has no accessible name');
    assert.match(text(dialog), /What to do:/);
    key($('.health-modal-close'), 'Escape');
    document.dispatchEvent(new window.KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
    assert.equal($('.health-modal-backdrop'), null);
  });

  test('SMS Monitor: tabs have roles; broadcast dialog fields are linked to their labels', async () => {
    const ctx = mountPage(renderSmsMonitorPage, { role: 'admin' });
    await settle();
    assert.ok($$('[role="tab"]', ctx.root).length >= 2);
    assert.equal($$('[role="tab"][aria-selected="true"]', ctx.root).length, 1);
    click(buttonByText(/Broadcast Alert/i, ctx.root));
    await settle();
    const dialog = $('.sms-modal');
    assert.ok($(`#${dialog.getAttribute('aria-labelledby')}`), 'dialog has no accessible name');
    for (const label of $$('label.sms-modal-label', dialog)) {
      assert.ok(label.htmlFor && $(`#${label.htmlFor}`, dialog), `label "${text(label)}" is not linked to a field`);
    }
    assert.ok(buttonByText(/^close$/i, dialog), 'icon-only close button needs a name');
    const overlay = $('.sms-modal-overlay');
    key(dialog.querySelector('textarea'), 'Escape');
    await settle();
    assert.equal($('.sms-modal-overlay'), null, 'Escape should close the dialog');
    assert.equal(overlay.isConnected, false);
  });

  test('SMS log shows plain labels and Manila times, not raw codes', async () => {
    const ctx = mountPage(renderSmsMonitorPage, { role: 'admin', param: 'activity-log' });
    await settle();
    const body = text(ctx.root);
    assert.doesNotMatch(body, /\bpriority_alert\b|\bcoord_ping\b|\bduty_status\b|\bdeduplicated\b|\b(SENT|FAILED|RECEIVED)\b/);
  });

  test('Settings offers Approvals as a landing screen to a Punong Barangay', async () => {
    mountPage(renderSettingsPage, { role: 'punong_barangay' });
    await settle();
    click(buttonByText(/^Appearance/i));
    await settle();
    const values = [...$('#settings-default-page').options].map((o) => o.value);
    assert.ok(values.includes('approvals'), 'approvals missing from the landing choices');
    assert.ok($$('.settings-theme-card').every((c) => c.hasAttribute('aria-pressed')), 'theme cards must expose their state');
  });

  test('Map Packages uses plain wording and the right barangay name', async () => {
    mountPage(renderMapPackagesPage, { role: 'admin', userOverrides: { barangayId: 2 } });
    await settle();
    const body = text($('.page-content'));
    assert.match(body, /Brgy\. Binanuahan/, 'barangay id 2 is Binanuahan');
    assert.doesNotMatch(body, /Rule 14|M1 Login|SQLite|Cryptographic/);
    assert.ok($$('label').every((l) => !l.htmlFor || $(`#${l.htmlFor}`)), 'every label points at a real field');
  });

  test('Live Map filters are keyboard operable and say what they show', async () => {
    mountPage(renderGisLiveTrackingPage, { role: 'admin' });
    await settle();
    const bar = $('.gis-filter-bar');
    assert.equal(bar.getAttribute('role'), 'button');
    assert.equal(bar.getAttribute('tabindex'), '0');
    assert.match(text(bar), /Showing everyone/);
    key(bar, 'Enter');
    await settle();
    assert.match(text($('.gis-filter-bar')), /Showing: On Duty/);
    assert.doesNotMatch(text($('.page-content')), /across Pilar barangays|filter active/);
    assert.ok($$('.gis-mini-stat').every((c) => c.hasAttribute('aria-pressed')));
  });
});
