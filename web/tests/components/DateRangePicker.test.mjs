import { window, cleanup, text, click, type, key, $ } from '../harness/render.mjs';
import { describe, test, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { DateRangePicker, manilaTodayIso, manilaDaysAgoIso } from '../../src/components/DateRangePicker.js';

afterEach(() => cleanup());

function mount(props = {}) {
  const changes = [];
  const picker = DateRangePicker({ onChange: (s) => changes.push(s), ...props });
  window.document.getElementById('app').appendChild(picker.el);
  return { picker, changes, select: $('select', picker.el), popover: $('.date-range-popover', picker.el) };
}

function withNow(iso, fn) {
  const real = Date.now;
  Date.now = () => new Date(iso).getTime();
  try { return fn(); } finally { Date.now = real; }
}

describe('Asia/Manila day boundaries (§2 Rule 11)', () => {
  test('between 00:00 and 08:00 Manila it is already "tomorrow" relative to UTC', () => {
    // 2026-09-22 20:00 UTC == 2026-09-23 04:00 in Manila.
    withNow('2026-09-22T20:00:00Z', () => {
      assert.equal(manilaTodayIso(), '2026-09-23');
      assert.equal(manilaDaysAgoIso(6), '2026-09-17');
    });
  });

  test('just before Manila midnight is still today', () => {
    withNow('2026-09-23T15:59:59Z', () => assert.equal(manilaTodayIso(), '2026-09-23'));
  });
});

describe('DateRangePicker', () => {
  test('is labelled, defaults to 30 days, and only offers "All time" when asked', () => {
    const { select } = mount({ ariaLabel: 'Report range' });
    assert.equal(select.getAttribute('aria-label'), 'Report range');
    assert.equal(select.value, '30');
    assert.deepEqual([...select.options].map((o) => o.value), ['7', '30', '90', 'custom']);
    const withAll = mount({ allowAllTime: true });
    assert.ok([...withAll.select.options].some((o) => o.value === 'all'));
  });

  test('"Last 7 days" is today plus the six days before, in Manila time', () => {
    const { select, changes } = mount();
    type(select, '7');
    assert.deepEqual(changes.at(-1), { mode: '7', from: manilaDaysAgoIso(6), to: manilaTodayIso() });
  });

  test('"All time" sends no date bounds at all', () => {
    const { select, changes } = mount({ allowAllTime: true });
    type(select, 'all');
    assert.deepEqual(changes.at(-1), { mode: 'all', from: null, to: null });
  });

  test('custom range opens a labelled dialog, rejects From after To, and applies a valid range', () => {
    const { select, popover, changes, picker } = mount();
    type(select, 'custom');
    assert.equal(popover.hidden, false);
    assert.equal(popover.getAttribute('role'), 'dialog');
    const [fromInput, toInput] = popover.querySelectorAll('input[type="date"]');
    assert.ok($(`label[for="${fromInput.id}"]`), 'From has no label');
    type(fromInput, '2026-09-20');
    type(toInput, '2026-09-10');
    const apply = [...popover.querySelectorAll('button')].find((b) => b.textContent === 'Apply Range');
    assert.equal(apply.disabled, true);
    assert.equal(text($('[role="alert"]', popover)), 'From date must be on or before To date.');
    type(toInput, '2026-09-25');
    click(apply);
    assert.deepEqual(changes.at(-1), { mode: 'custom', from: '2026-09-20', to: '2026-09-25' });
    assert.match(select.selectedOptions[0].textContent, /Custom \(Sep 20 – Sep 25\)/);
    assert.deepEqual(picker.getState(), { mode: 'custom', from: '2026-09-20', to: '2026-09-25' });
  });

  test('Cancel or Escape closes the dialog and restores the previous choice without firing onChange', () => {
    const { select, popover, changes } = mount({ value: '90' });
    type(select, 'custom');
    key(window.document, 'Escape');
    assert.equal(popover.hidden, true);
    assert.equal(select.value, '90');
    assert.equal(changes.length, 0);
  });

  test('reconcile() points the control at the window the server chose, without firing onChange', () => {
    const { picker, select, changes } = mount();
    picker.reconcile(manilaDaysAgoIso(6), manilaTodayIso());
    assert.equal(select.value, '7');
    picker.reconcile('2026-01-01', '2026-01-10');
    assert.equal(select.value, 'custom');
    assert.equal(changes.length, 0);
  });
});
