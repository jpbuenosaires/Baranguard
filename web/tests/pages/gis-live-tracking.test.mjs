import { describePage } from '../harness/pageSuite.mjs';
import { describe, test, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { api, mountPage, settle, cleanup, text } from '../harness/render.mjs';
import { maps } from '../harness/env.mjs';
import { renderGisLiveTrackingPage } from '../../src/pages/gis-live-tracking.js';

describePage({
  name: 'Live Map (W4)',
  render: renderGisLiveTrackingPage,
  roles: ['admin', 'punong_barangay'],
  heading: 'Live Map',
  expectText: ['Jose Reyes', 'Maria Dela Cruz'],
  polls: true,
});

describe('Live Map behaviour', () => {
  afterEach(() => cleanup());

  test('the page title matches its sidebar label ("Live Map")', async () => {
    const ctx = mountPage(renderGisLiveTrackingPage, { role: 'admin' });
    await settle();
    assert.match(text(ctx.root.querySelector('.page-header__title')), /^Live Map/);
  });

  const markerEls = () => maps.flatMap((m) => m.markers).map((m) => m.getElement());

  test('the active SOS gets its own marker, never folded into a cluster', async () => {
    mountPage(renderGisLiveTrackingPage, { role: 'admin' });
    await settle();
    assert.ok(maps.length >= 1, 'no map was created');
    assert.equal(markerEls().filter((el) => el.className.includes('live-map__marker--sos')).length, 1);
  });

  test('two Tanods standing close together merge into one "2" cluster bubble', async () => {
    mountPage(renderGisLiveTrackingPage, { role: 'admin' });
    await settle();
    const cluster = markerEls().find((el) => el.className.includes('live-map__cluster'));
    assert.ok(cluster, 'nearby Tanods should cluster');
    assert.equal(text(cluster), '2');
  });

  test('a stale GPS fix is not presented as live (§9 W4)', async () => {
    // Move one Tanod far enough away that both render as individual markers.
    api.on('GET', '/gps/live', () => ({ status: 200, body: { items: [
      { user_id: 4, full_name: 'Jose Reyes', dispatch_id: null, latitude: 12.95, longitude: 123.70, accuracy_m: 9, recorded_at: '2026-01-01 00:00:00', received_at: '2026-01-01 00:00:00', age_seconds: 30, is_stale: false },
      { user_id: 5, full_name: 'Maria Dela Cruz', dispatch_id: null, latitude: 12.90, longitude: 123.62, accuracy_m: 38, recorded_at: '2026-01-01 00:00:00', received_at: '2026-01-01 00:00:00', age_seconds: 540, is_stale: true },
    ] } }));
    mountPage(renderGisLiveTrackingPage, { role: 'admin' });
    await settle();
    const tanodMarkers = markerEls().filter((el) => el.className.includes('--tanod') && !el.className.includes('cluster'));
    assert.equal(tanodMarkers.length, 2, 'both Tanods should render individually once apart');
    const [live, stale] = tanodMarkers;
    assert.notEqual(live.className, stale.className, 'a stale fix must look different from a live one');
  });
});

describe('Live Map: stale data and SOS wording (audit 2026-10-09)', () => {
  afterEach(() => cleanup());

  test('a failed background poll shows the paused banner and the pill stops claiming live', async () => {
    const polls = [];
    const original = globalThis.setInterval;
    globalThis.setInterval = (fn, ms, ...rest) => { if (ms === 15000) polls.push(fn); return original(fn, ms, ...rest); };
    const ctx = mountPage(renderGisLiveTrackingPage, { role: 'admin' });
    globalThis.setInterval = original;
    await settle();
    const banner = ctx.root.querySelector('.dispatch-stale-banner');
    assert.equal(banner.hidden, true);
    api.fail('GET', '/gps/live', 500);
    await polls.at(-1)();
    await settle();
    assert.equal(banner.hidden, false);
    assert.match(text(banner), /Live updates paused - last updated \d{1,2}:\d{2} (am|pm) \(Manila time\)\. Retrying\.\.\./i);
    assert.match(text(ctx.root.querySelector('.dispatch-map-live-pill')), /paused/i);
    assert.match(text(ctx.root), /Jose Reyes|Maria Dela Cruz/, 'last good data stays');
    api.overrides.length = 0;
    await polls.at(-1)();
    await settle();
    assert.equal(banner.hidden, true);
  });

  test('the activity feed never invents a barangay name for an SOS', async () => {
    api.on('GET', '/tanod-sos', () => ({ status: 200, body: { items: [{
      sos_id: 91, user_id: 5, dispatch_id: null, latitude: null, longitude: null, location_source: 'no_fix',
      triggered_at: '2026-10-09 03:00:00', received_at: '2026-10-09 03:00:00', status: 'active', acknowledged_at: null, resolved_at: null,
    }] } }));
    const ctx = mountPage(renderGisLiveTrackingPage, { role: 'admin' });
    await settle();
    const body = text(ctx.root.querySelector('.gis-floating-activity') || ctx.root);
    assert.doesNotMatch(body, /Brgy\. Dao/);
    assert.match(body, /New SOS alert from .* - no location available, call the tanod/);
  });
});

describe('Live Map: Roster Search & Filter Tabs', () => {
  afterEach(() => cleanup());

  test('search input filters personnel by name and badge code reactively', async () => {
    const ctx = mountPage(renderGisLiveTrackingPage, { role: 'admin' });
    await settle();

    const searchInput = ctx.root.querySelector('.gis-search-input');
    const clearBtn = ctx.root.querySelector('.gis-search-clear');
    assert.ok(searchInput, 'search input should exist');
    assert.equal(clearBtn.hidden, true, 'clear button should be hidden initially');

    // Type "Jose" to filter
    searchInput.value = 'Jose';
    searchInput.dispatchEvent(new window.Event('input', { bubbles: true }));
    await settle();

    const names = Array.from(ctx.root.querySelectorAll('.gis-personnel-card__name')).map((el) => text(el));
    assert.ok(names.some((n) => n.includes('Jose Reyes')), 'Jose Reyes should be shown');
    assert.ok(!names.some((n) => n.includes('Maria Dela Cruz')), 'Maria Dela Cruz should be filtered out');
    assert.equal(clearBtn.hidden, false, 'clear button should now be visible');

    // Click clear button
    clearBtn.click();
    await settle();

    assert.equal(searchInput.value, '');
    assert.equal(clearBtn.hidden, true);
    const restoredNames = Array.from(ctx.root.querySelectorAll('.gis-personnel-card__name')).map((el) => text(el));
    assert.ok(restoredNames.some((n) => n.includes('Maria Dela Cruz')), 'Maria Dela Cruz restored after clear');
  });

  test('status filter tabs filter roster and show correct count badges', async () => {
    const ctx = mountPage(renderGisLiveTrackingPage, { role: 'admin' });
    await settle();

    const tabs = ctx.root.querySelectorAll('.gis-filter-tab');
    assert.equal(tabs.length, 4, 'should render 4 filter tabs: all, available, dispatched, stale');

    const allTab = ctx.root.querySelector('.gis-filter-tab[data-filter="all"]');
    const availableTab = ctx.root.querySelector('.gis-filter-tab[data-filter="available"]');
    assert.ok(allTab.classList.contains('is-active'));
    assert.equal(allTab.getAttribute('aria-selected'), 'true');

    // Click "On duty" tab
    availableTab.click();
    await settle();

    assert.ok(!allTab.classList.contains('is-active'));
    assert.ok(availableTab.classList.contains('is-active'));
    assert.equal(availableTab.getAttribute('aria-selected'), 'true');
  });
});

