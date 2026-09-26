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
});
