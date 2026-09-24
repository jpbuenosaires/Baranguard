import { describePage } from '../harness/pageSuite.mjs';
import { describe, test, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { api, mountPage, settle, cleanup, text, click, buttonByText, $ } from '../harness/render.mjs';
import { renderMapPackagesPage } from '../../src/pages/map-packages.js';

describePage({
  name: 'Map Packages (W18)',
  render: renderMapPackagesPage,
  roles: ['admin'],
  heading: 'Map Packages',
  expectText: ['v2026.09.1'],
});

describe('Map Packages behaviour', () => {
  afterEach(() => cleanup());

  test('the published checksum is shown so Tanods can verify their download', async () => {
    mountPage(renderMapPackagesPage, { role: 'admin' });
    await settle();
    assert.ok(text().includes('c'.repeat(16)), 'SHA-256 should be visible');
  });

  test('no published package (404) is an empty state, not an error', async () => {
    mountPage(renderMapPackagesPage, { role: 'admin', scenario: 'empty' });
    await settle();
    assert.equal($('.state-block--error'), null);
    assert.match(text($('.page-content')), /none active|no .*package|not .*published/i);
  });

  test('publishing without a file is refused before any upload', async () => {
    const ctx = mountPage(renderMapPackagesPage, { role: 'admin' });
    await settle();
    click(buttonByText(/publish to barangay tanods/i, ctx.root));
    await settle();
    assert.equal(api.callsTo('POST', '/map-packages').length, 0);
  });
});
