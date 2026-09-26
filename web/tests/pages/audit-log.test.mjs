import { describePage } from '../harness/pageSuite.mjs';
import { describe, test, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { api, mountPage, settle, cleanup, text, type, click, $ } from '../harness/render.mjs';
import { renderAuditLogPage } from '../../src/pages/audit-log.js';

describePage({
  name: 'Audit Log (W17)',
  render: renderAuditLogPage,
  roles: ['admin'],
  heading: 'Audit Log',
  expectText: ['Total Events Recorded'],
});

describe('Audit Log behaviour', () => {
  afterEach(() => cleanup());

  test('category counts come from the loaded events', async () => {
    mountPage(renderAuditLogPage, { role: 'admin' });
    await settle();
    const body = text($('.page-content'));
    assert.match(body, /3\s*Total Events Recorded/);
    assert.match(body, /1\s*Auth & Access Events/, 'login_failure is an auth event');
  });

  test('filtering by action asks the server for exactly that action', async () => {
    mountPage(renderAuditLogPage, { role: 'admin' });
    await settle();
    type($('select[aria-label="Filter by specific action"]'), 'dispatch_created');
    await settle();
    assert.ok(api.calls.some((c) => c.path === '/audit-log' && c.query.action === 'dispatch_created'));
  });

  test('the default view is the last 7 days (§9 W17)', async () => {
    mountPage(renderAuditLogPage, { role: 'admin' });
    await settle();
    assert.equal($('select[aria-label="Filter by date range"]').value, '7');
  });

  test('Preview & Print Excerpt opens the A4 compliance audit sheet', async () => {
    const ctx = mountPage(renderAuditLogPage, { role: 'admin' });
    await settle();
    const previewBtn = ctx.root.querySelector('#preview-audit-print-btn');
    assert.ok(previewBtn, 'Preview & Print Excerpt button should be present in header');
    click(previewBtn);
    await settle();

    const sheet = document.querySelector('#printable-audit-sheet');
    assert.ok(sheet, 'Printable audit sheet should be mounted');
    assert.ok(document.body.classList.contains('has-print-modal'), 'body should have has-print-modal while preview is open');
    assert.match(text(sheet), /Immutable System Audit Trail Excerpt/i);

    const closeBtn = document.querySelector('#close-print-modal');
    click(closeBtn);
    assert.ok(!document.body.classList.contains('has-print-modal'), 'closing modal should remove has-print-modal');
  });
});

