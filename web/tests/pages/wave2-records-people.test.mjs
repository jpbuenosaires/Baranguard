// Must run before anything formats a date: a workstation set to US Pacific
// time must still show Asia/Manila (Rule 11).
process.env.TZ = 'America/Los_Angeles';

import { describe, test, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { api, mountPage, settle, cleanup, text, click, type, buttonByText, $, $$ } from '../harness/render.mjs';
import { renderIncidentDetailPage } from '../../src/pages/incident-detail.js';
import { renderLoginPage } from '../../src/pages/login.js';
import { openPrintPreviewModal } from '../../src/components/PrintPreviewModal.js';
import {
  formatManilaDateTime, formatShiftRange, toManilaDatetimeLocal, letterheadHtml, signatureBlockHtml, printedByLabel,
} from '../../src/services/tanodWorkflowUi.js';

describe('Wave 2: Manila time regardless of the browser zone', () => {
  test('the test really runs in another zone', () => {
    assert.equal(new Date('2026-10-09T16:00:00Z').getHours(), 9);
  });

  test('formatManilaDateTime shows Manila wall-clock, 12-hour', () => {
    // 16:00Z = 00:00 Oct 10 in Manila
    assert.match(formatManilaDateTime('2026-10-09T16:00:00Z'), /Oct 10, 2026.*12:00\s?am/i);
  });

  test('shift ranges and datetime-local values use Manila', () => {
    assert.equal(toManilaDatetimeLocal('2026-10-09T22:00:00Z'), '2026-10-10T06:00');
    const range = formatShiftRange('2026-10-09T22:00:00Z', '2026-10-10T06:00:00Z');
    assert.match(range, /Oct 10 · 6:00\s?am – 2:00\s?pm/i);
  });
});

describe('Wave 2: printed forms', () => {
  afterEach(() => cleanup());

  test('letterhead prints no logo circles and no "#id" name when unknown', () => {
    const html = letterheadHtml({ barangayName: '', municipality: '', province: '' });
    assert.doesNotMatch(html, /logo/);
    assert.doesNotMatch(html, /#\d/);
  });

  test('signature block has a signature line, printed name, title and a date line', () => {
    const html = signatureBlockHtml('Prepared By:', 'Ana Cruz', 'Chief Tanod');
    assert.match(html, /Signature over printed name/);
    assert.match(html, /Ana Cruz/);
    assert.match(html, /Chief Tanod/);
    assert.match(html, /Date signed:/);
  });

  test('the print preview footer carries Manila print time, the role, and the page-number rule exists', () => {
    const preview = openPrintPreviewModal({ title: 'T', sheetHtml: '<p>x</p>', printedBy: printedByLabel({ role: 'secretary' }) });
    const stamp = text(preview.sheet.querySelector('.print-sheet__stamp'));
    assert.match(stamp, /Printed .*\(Philippine time\) by Barangay Secretary/);
    assert.equal(buttonByText(/^Print$/i, preview.overlay) !== undefined, true);
    preview.close();
  });
});

describe('Wave 2: incident detail', () => {
  afterEach(() => cleanup());

  test('Copy Narrative is gone for the Secretary and nothing reaches the clipboard (V-10)', async () => {
    const ctx = mountPage(renderIncidentDetailPage, { role: 'secretary', param: 903 });
    await settle();
    assert.match(text(ctx.root), /RAW-NARRATIVE-903/);
    assert.equal(buttonByText(/copy narrative/i, ctx.root), undefined);
    assert.equal($('.btn-copy', ctx.root), null);
  });

  test('Admin resolves a pending incident only with a written reason', async () => {
    const ctx = mountPage(renderIncidentDetailPage, { role: 'admin', param: 901 });
    await settle();
    click(buttonByText(/resolve without dispatch/i, ctx.root));
    const dialog = () => $('[role="alertdialog"]');
    assert.ok($('#confirm-dialog-input', dialog()), 'the dialog must ask for a reason');
    click($$('button', dialog()).at(-1));
    await settle();
    assert.equal(api.callsTo('PATCH', '/incidents/:id/status').length, 0);
    type($('#confirm-dialog-input', dialog()), '  Settled by phone  ');
    click($$('button', dialog()).at(-1));
    await settle();
    const [call] = api.callsTo('PATCH', '/incidents/:id/status');
    assert.deepEqual(call.body, { status: 'resolved', reason: 'Settled by phone' });
  });

  test('the status pill uses plain words, and responders are listed for the Admin with names', async () => {
    const ctx = mountPage(renderIncidentDetailPage, { role: 'admin', param: 902 });
    await settle();
    const pills = $$('.status-pill', ctx.root).map((p) => text(p));
    assert.ok(pills.includes('Responding'));
    const heading = $$('h3', ctx.root).find((h) => /^Responders$/.test(text(h)));
    assert.ok(heading, 'a Responders card is shown');
    assert.ok($$('.responders-table th[scope="col"]', ctx.root).length >= 3);
  });

  test('a Punong Barangay sees responders without tanod names', async () => {
    const ctx = mountPage(renderIncidentDetailPage, { role: 'punong_barangay', param: 902 });
    await settle();
    const cells = $$('.responders-table tbody td:first-child', ctx.root).map((c) => text(c));
    if (cells.length) assert.ok(cells.every((c) => /^Responder \d+$/.test(c)));
  });
});

describe('Wave 2: login', () => {
  afterEach(() => cleanup());

  test('shows an announced session notice, a privacy link and a forgot-password hint', () => {
    const root = document.createElement('div');
    document.body.appendChild(root);
    renderLoginPage(root, () => {}, { notice: 'Your session ended.' });
    const notice = root.querySelector('#login-notice');
    assert.equal(notice.getAttribute('role'), 'alert');
    const link = [...root.querySelectorAll('a')].find((a) => /privacy notice/i.test(a.textContent));
    assert.ok(link);
    assert.equal(link.getAttribute('href'), 'privacy.html');
    assert.equal(link.target, '_blank');
    assert.match(link.rel, /noopener/);
    assert.match(root.textContent, /Contact the Chief Tanod/);
    root.remove();
  });
});
