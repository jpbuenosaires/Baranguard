/**
 * syncFailureClass.ts — decides whether a `failed` result from
 * `POST /sync/batch` for a DISPATCH STATUS item is a definitive refusal by the
 * server's rules, or a transient/unknown failure worth retrying.
 *
 * PURE ON PURPOSE: no Capacitor, no SQLite, no imports. It is exercised in plain
 * Node by `mobile/scripts/verify-sync-failure-class.mjs`.
 *
 * WHY THIS EXISTS (docs/OFFLINE_SYNC_CONFLICT_RULES.md gap 3): the server answers
 * `failed` both when its rules refuse a status change and when something broke
 * inside it (`SyncController::processItem` masks every non-ApiError throwable as
 * 'Internal error processing item.'). The result carries only free-text `reason`,
 * no code, so the client has to recognise the refusals by their exact text.
 *
 * DERIVED FROM THE SERVER (backend/, read 2026-10-10), the only throws reachable
 * for `payload_type = 'dispatch_status'`:
 *   SyncController::processItem
 *     'client_event_id must be a UUID.'                       -> definitive
 *     'Internal error processing item.'                       -> TRANSIENT (any non-ApiError, e.g. deadlock)
 *     'Item could not be stored (data integrity check ...).'  -> TRANSIENT (SQLSTATE 23000 whose original row was not found)
 *   SyncController::applyItem
 *     'dispatch_id is required.'                              -> definitive
 *   DispatchController::applyStatusTransition
 *     'status must be one of: en_route, arrived, completed.'  -> definitive
 *     'Dispatch not found.'                                   -> definitive
 *     'This role cannot perform this action.'                 -> definitive (not this Tanod's dispatch)
 *     'Cannot transition from <a> to <b>.'                    -> definitive (cancelled / already advanced / out of order)
 *   AuthMiddleware::requireTenant
 *     'Resource not found.'                                   -> definitive (other barangay)
 *   DeviceSignature::verifyOrReject
 *     'Device signature verification failed.'                 -> TRANSIENT (bad/rotating key or clock; may succeed later; still capped)
 * Anything else (new server text, empty, missing, odd case) is TRANSIENT: an
 * unrecognised reason must never cost a Tanod a correct status, and the attempt
 * cap still bounds the retries.
 *
 * KEEP IN SYNC with those server strings. A reworded server message degrades
 * safely: it is treated as transient, retried up to the cap, then handled as
 * definitive.
 */

export type SyncFailureClass = 'definitive' | 'transient';

/** Exact server reasons that mean "the rules refuse this item"; retrying cannot help. */
const DEFINITIVE_REASONS: ReadonlySet<string> = new Set([
  'client_event_id must be a UUID.',
  'dispatch_id is required.',
  'status must be one of: en_route, arrived, completed.',
  'Dispatch not found.',
  'This role cannot perform this action.',
  'Resource not found.',
]);

/** `DispatchController::applyStatusTransition` — "Cannot transition from {current} to {new}." */
const INVALID_TRANSITION = /^Cannot transition from [a-z_]+ to [a-z_]+\.$/;

/** Classifies the `reason` of a `failed` dispatch-status result. Never throws. */
export function classifyDispatchFailure(reason: string | null | undefined): SyncFailureClass {
  if (typeof reason !== 'string') return 'transient';
  const text = reason.trim();
  if (text === '') return 'transient';
  if (DEFINITIVE_REASONS.has(text) || INVALID_TRANSITION.test(text)) return 'definitive';
  return 'transient';
}
