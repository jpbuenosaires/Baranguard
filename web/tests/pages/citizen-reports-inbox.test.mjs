import { describePage } from '../harness/pageSuite.mjs';
import { describe, test, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { api, mountPage, settle, cleanup, text, click, buttonByText, $, $$ } from '../harness/render.mjs';
import { renderCitizenReportsInboxPage } from '../../src/pages/citizen-reports-inbox.js';

describePage({
  name: 'Citizen Reports inbox (W16)',
  render: renderCitizenReportsInboxPage,
  roles: ['admin', 'secretary'],
  heading: 'Citizen Reports',
  expectText: ['Loud videoke past midnight'],
});

describe('Citizen Reports inbox behaviour', () => {
  afterEach(() => cleanup());

  test('filter chips count pending vs converted reports from real data', async () => {
    mountPage(renderCitizenReportsInboxPage, { role: 'secretary' });
    await settle();
    assert.ok(buttonByText(/^All\s*3$/), 'All should count 3');
    assert.ok(buttonByText(/^Pending Review\s*2$/), 'two reports have no incident yet');
    assert.ok(buttonByText(/^Converted\s*1$/), 'one report was converted');
  });

  test('Pending Review hides already-converted reports', async () => {
    mountPage(renderCitizenReportsInboxPage, { role: 'admin' });
    await settle();
    click(buttonByText(/^Pending Review/));
    await settle();
    assert.doesNotMatch(text($('.page-content')), /Stray dogs near the school gate/);
  });

  test('converting a report sends the chosen type and priority, then marks it converted', async () => {
    const ctx = mountPage(renderCitizenReportsInboxPage, { role: 'admin' });
    await settle();
    click(buttonByText(/^#301$/, ctx.root));
    await settle();
    const select = $('#triage-incident-type');
    assert.ok(select, 'no incident-type picker in the triage card');
    select.value = 'fire';
    click($$('.citizen-priority-pill').find((p) => p.dataset.priority === 'high'));
    click($('.btn-convert-incident'));
    await settle();
    const [call] = api.callsTo('POST', '/citizen-reports/:id/convert');
    assert.ok(call, 'POST /citizen-reports/:id/convert was not sent');
    assert.equal(call.path, '/citizen-reports/301/convert');
    assert.deepEqual(call.body, { incident_type: 'fire', priority: 'high' });
    assert.match(text(ctx.root), /Converted \(INC-905\)|Incident #905/);
  });

  test('a report with no location does not claim one', async () => {
    const ctx = mountPage(renderCitizenReportsInboxPage, { role: 'admin' });
    await settle();
    click(buttonByText(/^#302$/, ctx.root));
    await settle();
    assert.doesNotMatch(text(ctx.root), /\b0(\.0+)?\s*,\s*0(\.0+)?\b/, 'a missing location must not be shown as 0,0');
  });
});
