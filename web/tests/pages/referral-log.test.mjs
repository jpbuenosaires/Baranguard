import { describePage } from '../harness/pageSuite.mjs';
import { describe, test, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { api, mountPage, settle, cleanup, text, click, type, $, $$ } from '../harness/render.mjs';
import { renderReferralLogPage } from '../../src/pages/referral-log.js';

describePage({
  name: 'Referral Log',
  render: renderReferralLogPage,
  roles: ['admin', 'secretary', 'punong_barangay'],
  heading: 'Referral Log',
  expectText: ['EMS-0042'],
});

describe('Referral Log behaviour', () => {
  afterEach(() => cleanup());

  test('the destination filter is sent to the server', async () => {
    mountPage(renderReferralLogPage, { role: 'secretary' });
    await settle();
    type($('#tw-ref-dest'), 'pnp');
    await settle();
    assert.ok(api.calls.some((c) => c.path === '/referrals' && c.query.referred_to === 'pnp'));
  });

  test('only aggregate fields are rendered, and a row opens the incident', async () => {
    const ctx = mountPage(renderReferralLogPage, { role: 'punong_barangay' });
    await settle();
    const body = text($('.page-content'));
    assert.doesNotMatch(body, /Pilar Rescue Unit/, 'contact_name must never be shown in the log');
    click($('.data-table tbody tr'));
    assert.equal(ctx.navigations.at(-1).page, 'incident-detail');
  });
});
