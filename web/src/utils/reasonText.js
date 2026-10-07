/**
 * reasonText.js — shared client-side check for the free-text "reason"
 * fields the server requires (dispatch cancel reason, dispatch override
 * reason: 1-255 characters after trimming). The server validates again and
 * is the boundary (§2 Rule 6); this only saves a round trip and gives the
 * Admin the exact limit up front.
 */

export const REASON_MAX_LENGTH = 255;

/**
 * @param {string|null|undefined} value
 * @param {string} [what] noun used in the message, e.g. "cancellation reason"
 * @returns {string} the trimmed reason
 * @throws {Error} with a user-facing message when empty or too long
 */
export function requireReason(value, what = 'reason') {
  const trimmed = String(value ?? '').trim();
  if (trimmed.length === 0) throw new Error(`Enter a ${what} (required).`);
  if (trimmed.length > REASON_MAX_LENGTH) {
    throw new Error(`The ${what} must be ${REASON_MAX_LENGTH} characters or fewer (currently ${trimmed.length}).`);
  }
  return trimmed;
}
