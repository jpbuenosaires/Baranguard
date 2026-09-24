import { window, cleanup, text, click, $, $$ } from '../harness/render.mjs';
import { browserCalls } from '../harness/env.mjs';
import { describe, test, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { DataTable, exportRowsToCsv, ExportCsvButton } from '../../src/components/DataTable.js';
import { escapeHtml } from '../../src/utils/escapeHtml.js';

afterEach(() => cleanup());
const mount = (el) => { window.document.getElementById('app').appendChild(el); return el; };

const rows = [
  { id: 1, name: 'Theft', count: 5 },
  { id: 2, name: 'Fire', count: 12 },
  { id: 3, name: 'Assault', count: 1 },
];
const columns = [
  { key: 'name', label: 'Type', sortable: true, sortValue: (r) => r.name, csvValue: (r) => r.name },
  { key: 'count', label: 'Count', align: 'right', sortable: true, sortValue: (r) => r.count, csvValue: (r) => r.count },
];
const base = { columns, rows, rowKey: (r) => r.id, renderCell: (r, k) => escapeHtml(r[k]), caption: 'Incident types' };
const bodyText = (el) => $$('tbody tr', el).map((tr) => text(tr.cells[0]));

describe('DataTable', () => {
  test('a real <table> with scope="col" headers, caption and right-aligned numbers', () => {
    const el = mount(DataTable(base));
    assert.ok($('table.data-table caption', el));
    assert.deepEqual($$('th', el).map((th) => th.scope), ['col', 'col']);
    assert.ok($$('th', el)[1].classList.contains('is-right'));
    assert.deepEqual(bodyText(el), ['Theft', 'Fire', 'Assault']);
  });

  test('announces how many rows are showing', () => {
    const el = mount(DataTable(base));
    assert.equal(text($('[role="status"]', el)), '3 rows in Incident types.');
  });

  test('sorting toggles asc/desc, sets aria-sort on the header cell, and never mutates the caller\'s array', () => {
    const original = [...rows];
    const el = mount(DataTable(base));
    const countHeader = $$('th', el)[1];
    assert.equal(countHeader.getAttribute('aria-sort'), 'none', 'a sortable column is identifiable before first click');
    click($('button', countHeader));
    assert.deepEqual(bodyText(el), ['Assault', 'Theft', 'Fire']);
    assert.equal(countHeader.getAttribute('aria-sort'), 'ascending');
    click($('button', countHeader));
    assert.deepEqual(bodyText(el), ['Fire', 'Theft', 'Assault']);
    assert.equal(countHeader.getAttribute('aria-sort'), 'descending');
    assert.deepEqual(rows, original);
  });

  test('sorting is suppressed while server-paginated (sorting one page would be a lie)', () => {
    const el = mount(DataTable({ ...base, page: 1, totalItems: 30, pageSize: 3, onPageChange: () => {} }));
    assert.equal($$('th button', el).length, 0);
  });

  test('pagination shows the real range and disables the ends', () => {
    const pages = [];
    const el = mount(DataTable({ ...base, page: 1, totalItems: 7, pageSize: 3, onPageChange: (p) => pages.push(p) }));
    assert.equal(text($('.data-table__pagination-indicator', el)), 'Showing 1-3 of 7 · Page 1 of 3');
    const [prev, next] = $$('.data-table__pagination button', el);
    assert.equal(prev.disabled, true);
    click(next);
    assert.deepEqual(pages, [2]);
  });

  test('last page end-range is clamped, and zero results say so', () => {
    const last = mount(DataTable({ ...base, page: 3, totalItems: 7, pageSize: 3, onPageChange: () => {} }));
    assert.equal(text($('.data-table__pagination-indicator', last)), 'Showing 7-7 of 7 · Page 3 of 3');
    const none = mount(DataTable({ ...base, rows: [], page: 1, totalItems: 0, pageSize: 3, onPageChange: () => {} }));
    assert.equal(text($('.data-table__pagination-indicator', none)), 'No results');
  });

  test('empty rows show the opt-in empty message in a full-width cell', () => {
    const el = mount(DataTable({ ...base, rows: [], emptyMessage: 'No incidents yet.' }));
    const cell = $('td.data-table__empty', el);
    assert.equal(cell.colSpan, 2);
    assert.equal(text(cell), 'No incidents yet.');
  });

  test('clickable rows get a real button activator (keyboard/AT) and fire once per click', () => {
    const clicked = [];
    const el = mount(DataTable({ ...base, onRowClick: (r) => clicked.push(r.id), selectedKey: 2 }));
    const activator = $('tbody tr .data-table__row-activator', el);
    assert.equal(activator.tagName, 'BUTTON');
    click(activator);
    assert.deepEqual(clicked, [1], 'the activator must not also trigger the row handler');
    assert.ok($$('tbody tr', el)[1].classList.contains('is-selected'));
  });
});

describe('CSV export', () => {
  test('quotes commas, quotes and newlines per RFC 4180 and uses CRLF', async () => {
    let written = '';
    const OriginalBlob = globalThis.Blob;
    globalThis.Blob = class extends OriginalBlob { constructor(parts, opts) { super(parts, opts); written = parts.join(''); } };
    try {
      const n = exportRowsToCsv([{ label: 'Note', csvValue: (r) => r.note }], [{ note: 'a, "b"\nc' }, { note: null }], 'export');
      assert.equal(n, 2);
      assert.equal(written, 'Note\r\n"a, ""b""\nc"\r\n');
      assert.deepEqual(browserCalls.downloads.at(-1), { href: 'blob:http://localhost/fake', download: 'export.csv' });
    } finally {
      globalThis.Blob = OriginalBlob;
    }
  });

  test('nothing is written for zero rows', () => {
    assert.equal(exportRowsToCsv(columns, [], 'x'), 0);
    assert.equal(browserCalls.downloads.length, 0);
  });

  test('cells that Excel would run as formulas are neutralised (CSV injection)', () => {
    let written = '';
    const OriginalBlob = globalThis.Blob;
    globalThis.Blob = class extends OriginalBlob { constructor(parts, opts) { super(parts, opts); written = parts.join(''); } };
    try {
      exportRowsToCsv([{ label: 'Description', csvValue: (r) => r.d }], [{ d: '=HYPERLINK("http://evil","x")' }, { d: '@SUM(A1)' }, { d: -5 }], 'x');
      const lines = written.split('\r\n');
      assert.doesNotMatch(lines[1], /^"?=/);
      assert.doesNotMatch(lines[2], /^"?@/);
      assert.equal(lines[3], '-5', 'a real negative number must stay a number');
    } finally {
      globalThis.Blob = OriginalBlob;
    }
  });

  test('the export button says when it will write only part of the data', () => {
    const partial = ExportCsvButton({ rows: rows.slice(0, 2), totalItems: 30, onExport: () => {} });
    assert.equal(partial.textContent, 'Export CSV (2 of 30)');
    assert.match(partial.title, /not all 30/);
    const full = ExportCsvButton({ rows, totalItems: 3, onExport: () => {} });
    assert.equal(full.textContent, 'Export CSV (3)');
    assert.equal(ExportCsvButton({ rows: [], onExport: () => {} }).disabled, true);
  });
});
