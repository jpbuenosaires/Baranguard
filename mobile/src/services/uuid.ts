/**
 * uuid.ts — shared client-side UUID generator.
 *
 * `incidentRepository.ts` and `deviceIdentity.ts` each already carry a
 * private copy of this exact function (predates this file). Left
 * untouched — same precedent as `backend/lib/Audit.php`'s own doc
 * comment: existing, already-tested copies are not rewritten for
 * tidiness. This shared version exists so the THIRD and FOURTH callers
 * (M2's duty-toggle client_event_id, evidenceRepository.ts's evidence
 * local_id) don't each grow a fifth/sixth copy.
 */
export function uuid(): string {
  return typeof crypto !== 'undefined' && 'randomUUID' in crypto
    ? crypto.randomUUID()
    : `${Date.now().toString(16)}-${Math.random().toString(16).slice(2)}`;
}
