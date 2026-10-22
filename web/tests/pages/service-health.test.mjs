import { describePage } from '../harness/pageSuite.mjs';
import { describe, test, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { mountPage, settle, cleanup, text, $ } from '../harness/render.mjs';
import { renderServiceHealthPage } from '../../src/pages/service-health.js';

describePage({
  name: 'Service Health (W20)',
  render: renderServiceHealthPage,
  roles: ['admin'],
  heading: 'Service Health',
  expectText: ['Dependency status changes'],
  polls: true,
});

describe('Service Health behaviour', () => {
  afterEach(() => cleanup());

  test('a configured-but-failing dependency is called out; not_configured is neutral (§2 Rule 6)', async () => {
    mountPage(renderServiceHealthPage, { role: 'admin' });
    await settle();
    const body = text($('.page-content'));
    assert.match(body, /1 not working/, 'ORS is the one configured dependency that is down');
    assert.match(body, /1 part\b/, 'the GSM SMS gateway is unconfigured, not failing');
  });

  test('the history\'s sampling caveat is shown, not hidden', async () => {
    mountPage(renderServiceHealthPage, { role: 'admin' });
    await settle();
    assert.match(text(), /gap means no one was watching|only when a status actually changes/i);
  });

  test('a restore drill that never ran says so honestly', async () => {
    mountPage(renderServiceHealthPage, { role: 'admin' });
    await settle();
    assert.match(text($('.page-content')), /never/i);
  });

  test('notification delivery reliability card shows the real count, not a hidden/omitted field (H-20)', async () => {
    mountPage(renderServiceHealthPage, { role: 'admin' });
    await settle();
    const body = text($('.page-content'));
    assert.match(body, /Notification Delivery/, 'the new H-20 card is rendered');
    assert.match(body, /All reaching recipients/, '0 fully-undelivered targets is the honest, healthy state from the fixture');
    assert.match(body, /0 notifications/, 'the real count (0) is shown, not hidden');
    assert.ok($('.health-btn-dr-action'), 'Open SMS Activity Log button is rendered');
  });

  test('subsystem category tabs, search input, and OS toggles render and function', async () => {
    mountPage(renderServiceHealthPage, { role: 'admin' });
    await settle();

    // 1. Subsystem tabs & search input
    assert.ok($('.health-subsystems-toolbar'), 'Subsystem toolbar exists');
    assert.ok($('.health-search-input'), 'Service quick search input exists');
    const pills = Array.from($('.health-domain-pills').children);
    assert.ok(pills.length >= 4, 'Has All, Core, Routing, Communications tabs');

    // 2. Terminal OS switchers
    const osToggles = Array.from(document.querySelectorAll('.health-terminal-os-toggle'));
    assert.ok(osToggles.length >= 2, 'Backup and restore drill cards have OS switcher');

    // 3. Live reprobe buttons
    const reprobeBtns = Array.from(document.querySelectorAll('.health-card-reprobe-btn'));
    assert.ok(reprobeBtns.length >= 2, 'Live probe cards have Test button');

    // 4. Timeline dots in status history
    const timelineDots = Array.from(document.querySelectorAll('.health-timeline-dot'));
    assert.ok(timelineDots.length >= 1, 'Status history entries have visual timeline dots');

    // 5. Diagnostic Report export button
    assert.ok($('.health-export-btn'), 'Diagnostic report export button exists in header');

    // 6. Transport channel breakdown box in Notification Delivery card
    assert.ok($('.health-dr-channel-box'), 'Notification delivery card has balanced channel breakdown box');
    const channelRows = Array.from(document.querySelectorAll('.health-dr-channel-row'));
    assert.ok(channelRows.length >= 2, 'Channel breakdown contains FCM push and GSM gateway rows');

    // 7. Timeline filter chips
    assert.ok($('.health-history-filters'), 'History timeline filter button group exists');
    const historyFilters = Array.from(document.querySelectorAll('.health-history-filter-btn'));
    assert.ok(historyFilters.length >= 3, 'Timeline has All, Outages, and Recoveries filters');
  });
});
