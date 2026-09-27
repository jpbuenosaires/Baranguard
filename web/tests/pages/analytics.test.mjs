import { describePage } from '../harness/pageSuite.mjs';
import { describe, test, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { api, mountPage, settle, cleanup, text, click, $$ } from '../harness/render.mjs';
import { maps } from '../harness/env.mjs';
import { renderAnalyticsPage } from '../../src/pages/analytics.js';

describePage({
  name: 'Analytics',
  render: renderAnalyticsPage,
  roles: ['admin', 'punong_barangay'],
  heading: 'Analytics',
  expectText: ['Total Incidents', 'Incidents by Hour of Day'],
});

const tab = (label) => $$('.page-tab').find((b) => new RegExp(label, 'i').test(text(b)));

describe('Analytics behaviour', () => {
  afterEach(() => cleanup());

  for (const role of ['admin', 'punong_barangay']) {
    test(`${role} gets both tabs: Reports, Heatmap`, async () => {
      mountPage(renderAnalyticsPage, { role });
      await settle();
      for (const label of ['Reports', 'Heatmap']) assert.ok(tab(label), `missing "${label}" tab`);
      assert.ok(!tab('Threat'), 'Threat Analyzer tab should be gone (migration 0027)');
    });
  }

  test('the Heatmap tab plots GET /reports/heatmap points', async () => {
    mountPage(renderAnalyticsPage, { role: 'admin' });
    await settle();
    click(tab('Heatmap'));
    await settle();
    assert.ok(api.callsTo('GET', '/reports/heatmap').length >= 1, 'heatmap data was never requested');
    const source = maps.flatMap((m) => [...m.sources.values()]).find((s) => s.data?.type === 'FeatureCollection');
    assert.ok(source, 'no GeoJSON source was added to the heatmap');
    assert.equal(source.data.features.length, 3, 'the 3 incidents with coordinates should be plotted; the one without must be skipped');
  });

  test('Preview & Print opens the Statistical Report A4 print preview sheet', async () => {
    const ctx = mountPage(renderAnalyticsPage, { role: 'admin' });
    await settle();
    const previewBtn = ctx.root.querySelector('#preview-report-print-btn');
    assert.ok(previewBtn, 'Preview & Print button should be rendered on the Reports tab');
    click(previewBtn);
    await settle();

    const sheet = document.querySelector('#printable-report-sheet');
    assert.ok(sheet, 'Printable statistical report A4 sheet should be mounted');
    assert.ok(document.body.classList.contains('has-print-modal'), 'body should have has-print-modal while preview is open');
    assert.match(text(sheet), /BARANGAY INCIDENT & PEACEKEEPING STATISTICAL REPORT/i);

    const closeBtn = document.querySelector('#close-print-modal');
    click(closeBtn);
    assert.ok(!document.body.classList.contains('has-print-modal'), 'closing modal should remove has-print-modal');
  });

  test('the Heatmap tab renders KPI StatStrip, category filter chips, and filters plotted points live', async () => {
    const ctx = mountPage(renderAnalyticsPage, { role: 'admin' });
    await settle();
    click(tab('Heatmap'));
    await settle();

    assert.match(text(ctx.root), /Mapped Incidents/i);
    assert.match(text(ctx.root), /Hotspot Category Breakdown/i);

    const chips = $$('.heatmap-chip', ctx.root);
    assert.ok(chips.length >= 2, 'should render All Categories chip plus incident category chips');
    const theftChip = chips.find((c) => /Theft/i.test(text(c)));
    assert.ok(theftChip, 'should render a Theft category filter chip');
    click(theftChip);
    await settle();

    const source = maps.flatMap((m) => [...m.sources.values()]).find((s) => s.data?.type === 'FeatureCollection');
    assert.equal(source.data.features.length, 1, 'clicking Theft chip should filter plotted GeoJSON features to 1');
  });
});


