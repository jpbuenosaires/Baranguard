import { describePage } from '../harness/pageSuite.mjs';
import { describe, test, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { api, mountPage, settle, wait, cleanup, text, click, buttonByText, $$ } from '../harness/render.mjs';
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
    test(`${role} gets all three tabs: Reports, Heatmap, Threat Analyzer`, async () => {
      mountPage(renderAnalyticsPage, { role });
      await settle();
      for (const label of ['Reports', 'Heatmap', 'Threat']) assert.ok(tab(label), `missing "${label}" tab`);
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

  test('the Threat Analyzer says it describes the record, not a forecast', async () => {
    mountPage(renderAnalyticsPage, { role: 'punong_barangay' });
    await settle();
    click(tab('Threat'));
    await settle();
    assert.match(text(), /not a (predictive )?forecast/i);
  });

  test('Threat Analyzer queues a job and shows the model output as plain text', async () => {
    mountPage(renderAnalyticsPage, { role: 'admin', scenario: 'xss' });
    await settle();
    click(tab('Threat'));
    await settle();
    click(buttonByText(/^generate$/i));
    await settle();
    assert.equal(api.callsTo('POST', '/ai-tools/threat-analysis').length, 1);
    await wait(3200); // AiToolPanel polls every 3s
    assert.ok(api.callsTo('GET', '/ai-tools/jobs/:id').length >= 1, 'the queued job was never polled');
    assert.match(text(), /Theft reports rose in Purok 3/);
    assert.equal(document.querySelectorAll('[data-xss-canary]').length, 0, 'model output must be rendered with textContent');
  });
});
