import '../harness/render.mjs';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  formatIncidentCode, formatShiftCode, formatDispatchCode, formatSosCode,
} from '../../src/services/tanodWorkflowUi.js';

test('incident code: the server display id wins', () => {
  assert.equal(formatIncidentCode(159, 'INC-2026-159'), 'INC-2026-159');
  assert.equal(formatIncidentCode({ incidentId: 5, displayId: 'INC-2026-005' }), 'INC-2026-005');
  assert.equal(formatIncidentCode({ incidentId: 5, incidentDisplayId: 'INC-2026-006' }), 'INC-2026-006');
});

test('incident code: without a display id the fallback is visibly unofficial', () => {
  assert.equal(formatIncidentCode(159), 'INC-#159');
  assert.equal(formatIncidentCode({ incidentId: 7 }), 'INC-#7');
  assert.equal(formatIncidentCode(3, null), 'INC-#3');
  assert.doesNotMatch(formatIncidentCode(12), /^INC-\d/);
});

test('codes: a missing or invalid id is an em dash, never a fake code', () => {
  for (const bad of [null, undefined, '', 0, -2, 'abc']) {
    assert.equal(formatIncidentCode(bad), '\u2014');
    assert.equal(formatShiftCode(bad), '\u2014');
    assert.equal(formatDispatchCode(bad), '\u2014');
    assert.equal(formatSosCode(bad), '\u2014');
  }
  assert.equal(formatShiftCode(12), 'SHF-0012');
});
