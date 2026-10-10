// verify-sync-failure-class.mjs — pins how a failed dispatch-status sync result is classified
// (docs/OFFLINE_SYNC_CONFLICT_RULES.md gap 3). Run: node scripts/verify-sync-failure-class.mjs
// (Node >= 22.18, no install, no server). The reason strings below are copied from backend/ source.

const { classifyDispatchFailure } = await import('../src/services/syncFailureClass.ts');

let pass = 0, fail = 0;
const check = (name, ok) => { ok ? pass++ : fail++; console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}`); };

// [reason, expected, where the server produces it]
const cases = [
  ['client_event_id must be a UUID.', 'definitive', 'SyncController::processItem'],
  ['dispatch_id is required.', 'definitive', 'SyncController::applyItem'],
  ['status must be one of: en_route, arrived, completed.', 'definitive', 'applyStatusTransition'],
  ['Dispatch not found.', 'definitive', 'applyStatusTransition 404'],
  ['This role cannot perform this action.', 'definitive', 'applyStatusTransition 403 (not own dispatch)'],
  ['Resource not found.', 'definitive', 'AuthMiddleware::requireTenant'],
  ['Cannot transition from cancelled to en_route.', 'definitive', 'cancelled by Admin'],
  ['Cannot transition from completed to arrived.', 'definitive', 'already completed'],
  ['Cannot transition from assigned to arrived.', 'definitive', 'out of order'],
  ['Cannot transition from en_route to completed.', 'definitive', 'skipped a step'],
  ['Cannot transition from arrived to en_route.', 'definitive', 'step behind'],
  ['Cannot transition from assigned to completed.', 'definitive', 'skipped steps'],
  ['  Dispatch not found.  ', 'definitive', 'surrounding whitespace'],
  ['Internal error processing item.', 'transient', 'processItem catch-all (deadlock etc.)'],
  ['Item could not be stored (data integrity check failed).', 'transient', 'processItem SQLSTATE 23000'],
  ['Device signature verification failed.', 'transient', 'DeviceSignature::verifyOrReject'],
  ['', 'transient', 'empty reason'],
  ['   ', 'transient', 'blank reason'],
  [undefined, 'transient', 'missing reason'],
  [null, 'transient', 'null reason'],
  [42, 'transient', 'non-string reason'],
  ['Something new the server says', 'transient', 'unknown text'],
  ['dispatch not found.', 'transient', 'wrong case is not recognised'],
  ['Cannot transition from cancelled to en_route', 'transient', 'missing final period'],
  ['Cannot transition from Cancelled to en_route.', 'transient', 'unexpected case'],
  ['Cannot transition from to .', 'transient', 'empty states'],
  ['Cannot transition from a to b. Also internal error', 'transient', 'trailing text'],
  ['Dispatch not found. (retry later)', 'transient', 'extended text'],
];
for (const [reason, expected, where] of cases) {
  check(`${JSON.stringify(reason)} -> ${expected}  [${where}]`, classifyDispatchFailure(reason) === expected);
}
check('never throws on object input', (() => { try { return classifyDispatchFailure({}) === 'transient'; } catch { return false; } })());

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail === 0 ? 0 : 1);
