/**
 * manilaTime.js is the one place the dashboard formats an instant (Rule 11).
 * These checks run with the PROCESS time zone set to Los Angeles, so any
 * accidental use of the browser/process zone would print the wrong hour.
 */
import '../harness/render.mjs';
import { describe, test, before } from 'node:test';
import assert from 'node:assert/strict';
import {
  formatManilaDateTime, formatManilaDate, formatManilaTime, formatManilaTimeSeconds, manilaDateKey,
} from '../../src/utils/manilaTime.js';

describe('manilaTime with a non-Manila process time zone', () => {
  before(() => { process.env.TZ = 'America/Los_Angeles'; });

  test('the process zone really is different from Manila', () => {
    // 18:30 UTC on 9 Oct is 11:30 in Los Angeles (UTC-7) but 02:30 on 10 Oct in Manila.
    const d = new Date('2026-10-09T18:30:00Z');
    assert.equal(d.getDate(), 9);
    assert.equal(d.getHours(), 11);
  });

  test('date and time are Manila wall-clock, 12-hour with am/pm', () => {
    assert.match(formatManilaDateTime('2026-10-09T18:30:00Z'), /Oct 10, 2026, 2:30 am/i);
    assert.match(formatManilaDate('2026-10-09T18:30:00Z'), /Oct 10, 2026/);
    assert.match(formatManilaTime('2026-10-09T18:30:00Z'), /^2:30 am$/i);
    assert.match(formatManilaTimeSeconds('2026-10-09T18:30:09Z'), /^2:30:09 am$/i);
  });

  test('the day key is the Manila calendar day, not the local one', () => {
    assert.equal(manilaDateKey('2026-10-09T18:30:00Z'), '2026-10-10');
    assert.equal(manilaDateKey('2026-10-09T15:59:59Z'), '2026-10-09');
    assert.equal(manilaDateKey('2026-10-09T16:00:00Z'), '2026-10-10');
  });

  test('unusable input gives the fallback, never "Invalid Date"', () => {
    assert.equal(formatManilaDateTime(null), 'Not recorded');
    assert.equal(formatManilaTime('not a date'), 'Not recorded');
    assert.equal(formatManilaDate('', 'n/a'), 'n/a');
    assert.equal(manilaDateKey(undefined), null);
  });
});
