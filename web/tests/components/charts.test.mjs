import { window, cleanup, text, $, $$ } from '../harness/render.mjs';
import { describe, test, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { LineChart } from '../../src/components/LineChart.js';
import { BarChart } from '../../src/components/BarChart.js';
import { DonutChart } from '../../src/components/DonutChart.js';
import { XSS } from '../harness/fixtures.mjs';

afterEach(() => cleanup());
const mount = (el) => { window.document.getElementById('app').appendChild(el); return el; };
const noBrokenGeometry = (el) => assert.doesNotMatch(el.innerHTML, /NaN|undefined|Infinity/, 'chart geometry contains NaN/undefined/Infinity');

describe('LineChart', () => {
  const series = [{ name: 'Reported', colorVar: '--chart-line-1' }, { name: 'Resolved', colorVar: '--chart-line-2' }];

  test('draws one line per series with a legend, and no broken geometry', () => {
    const el = mount(LineChart({ series, points: [{ label: 'Sep 1', values: [2, 1] }, { label: 'Sep 2', values: [4, 0] }, { label: 'Sep 3', values: [1, 1] }] }));
    assert.ok($('svg', el));
    assert.match(text(el), /Reported/);
    assert.match(text(el), /Resolved/);
    noBrokenGeometry(el);
  });

  test('a null value is a genuine gap, not a fabricated 0', () => {
    const pts = (mid) => [5, 6, mid, 6, 5].map((v, i) => ({ label: `d${i}`, values: [v] }));
    const withGap = mount(LineChart({ series: [series[0]], points: pts(null) }));
    const noGap = mount(LineChart({ series: [series[0]], points: pts(0) }));
    noBrokenGeometry(withGap);
    assert.ok($$('path', withGap).length > $$('path', noGap).length, 'the gap should split the line into two runs, not bridge it at 0');
    assert.match(text(withGap), /No data/, 'the accessible data table must say "No data" for the gap');
    assert.doesNotMatch(text($('table', withGap) ?? withGap), /d2\s*0\b/, 'the gap day must not be reported as 0');
  });

  test('handles all-zero and single-point data without NaN', () => {
    noBrokenGeometry(mount(LineChart({ series: [series[0]], points: [{ label: 'a', values: [0] }, { label: 'b', values: [0] }] })));
    noBrokenGeometry(mount(LineChart({ series: [series[0]], points: [{ label: 'only', values: [3] }] })));
  });
});

describe('BarChart', () => {
  test('no bars renders an honest empty message', () => {
    assert.equal(text(mount(BarChart({ bars: [] }))), 'No data in this range.');
  });

  test('one bar per entry with the exact value in its tooltip', () => {
    const el = mount(BarChart({ bars: Array.from({ length: 24 }, (_, h) => ({ label: `${h}:00`, value: h % 3 })) }));
    const titles = $$('title', el).map((t) => t.textContent);
    assert.equal(titles.length, 24);
    assert.ok(titles.some((t) => /\b2\b/.test(t)));
    noBrokenGeometry(el);
  });

});

describe('chart labels', () => {
  for (const [name, build] of [
    ['BarChart', () => BarChart({ bars: [{ label: XSS, value: 1 }] })],
    ['DonutChart', () => DonutChart({ rows: [{ key: 'x', label: XSS, count: 1, color: 'red' }] })],
    ['LineChart', () => LineChart({ series: [{ name: 'S', colorVar: '--chart-line-1' }], points: [{ label: XSS, values: [1] }, { label: 'b', values: [2] }] })],
  ]) {
    test(`${name} treats labels as text`, () => {
      mount(build());
      assert.equal($$('[data-xss-canary]').length, 0);
    });
  }
});

describe('DonutChart', () => {
  test('a zero total is an empty state, not a 0% ring', () => {
    assert.equal(text(mount(DonutChart({ rows: [{ key: 'theft', label: 'Theft', count: 0, color: 'red' }] }))), 'No data in this range.');
  });

  test('describes the breakdown for screen readers, skipping zero rows but never inventing categories', () => {
    const el = mount(DonutChart({ rows: [
      { key: 'theft', label: 'Theft', count: 3, color: 'var(--chart-1)' },
      { key: 'fire', label: 'Fire', count: 1, color: 'var(--chart-2)' },
      { key: 'other', label: 'Other', count: 0, color: 'var(--chart-3)' },
    ] }));
    const ring = $('[role="img"]', el);
    assert.equal(ring.getAttribute('aria-label'), 'Breakdown: Theft 75%, Fire 25%');
    assert.match(text(el), /Other/, 'a zero-count category still appears in the legend');
  });
});
