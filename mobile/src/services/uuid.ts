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
  const c: Crypto = crypto;
  if (typeof c.randomUUID === 'function') return c.randomUUID();
  // WebView < Chrome 92: the server requires a real v4 UUID, so build one from getRandomValues.
  const b = c.getRandomValues(new Uint8Array(16));
  b[6] = (b[6] & 0x0f) | 0x40;
  b[8] = (b[8] & 0x3f) | 0x80;
  const h = Array.from(b, (x) => x.toString(16).padStart(2, '0')).join('');
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-${h.slice(12, 16)}-${h.slice(16, 20)}-${h.slice(20)}`;
}
