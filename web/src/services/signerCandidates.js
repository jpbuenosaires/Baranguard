/**
 * signerCandidates.js — who can be named as the signer when an approval is
 * recorded from a paper signature ("Record approval from paper", and the
 * roster's "Recorded from paper" publish).
 *
 * Reads `GET /users/directory?purpose=signer&authority=<authority>` for both
 * Admin and Secretary: active, same-barangay officials holding the authority.
 * The server still re-checks everything (including that the signer is not the
 * preparer); this list is UX only. `excludeUserId` drops the preparer.
 */

import { getUsersDirectory } from './shellWorkflowApi.js';

/**
 * @param {object} _user  (kept for call-site symmetry)
 * @param {string} authority  e.g. 'approve_report' | 'approve_annex_d' | 'approve_roster'
 * @param {number|null} excludeUserId  the preparer (never a valid signer)
 * @returns {Promise<{candidates:Array<{userId:number, label:string}>}>}
 */
export async function loadSignerCandidates(_user, authority, excludeUserId) {
  const items = await getUsersDirectory({ purpose: 'signer', authority });
  const candidates = items
    .filter((u) => u.userId !== excludeUserId)
    .map((u) => ({ userId: u.userId, label: u.officialTitle ? `${u.fullName} (${u.officialTitle})` : u.fullName }));
  return { candidates };
}
