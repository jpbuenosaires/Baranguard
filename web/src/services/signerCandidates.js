/**
 * signerCandidates.js — who can be named as the signer when an approval is
 * recorded from a paper signature ("Record approval from paper").
 *
 * The server only accepts an active, same-barangay user who holds the needed
 * authority (`approve_report` for an Accomplishment Report, `approve_annex_d`
 * for Annex D) and who is not the preparer; this list is UX only and the
 * server re-checks all of it.
 *
 * `GET /users` (the only list that carries `approval_authority`) is
 * Admin-only. An Admin therefore gets every eligible official. A Secretary
 * cannot read that list, so the only candidate that can be verified from the
 * client is the Secretary's own account, and only when it holds the authority
 * (the Kagawad-as-secretary case). `limited` is true then, so the dialog can
 * say so honestly instead of implying nobody else holds the authority.
 * DOC NOTE for the orchestrator: a role-limited signer list for the
 * Secretary (id, name, title of users holding the authority) is a pending
 * contract decision; nothing here assumes such an endpoint exists.
 */

import { getUsersDetailed } from './shellWorkflowApi.js';
import { getMyAuthority } from './tanodWorkflowUi.js';

/**
 * @param {{userId:number, fullName:string, role:string}} user
 * @param {string} authority  'approve_report' | 'approve_annex_d'
 * @param {number|null} excludeUserId  the preparer (never a valid signer)
 * @returns {Promise<{candidates:Array<{userId:number, label:string}>, limited:boolean}>}
 */
export async function loadSignerCandidates(user, authority, excludeUserId) {
  if (user.role === 'admin') {
    const res = await getUsersDetailed({ limit: 100 });
    const candidates = res.items
      .filter((u) => Number(u.isActive) === 1 && Number(u.isSuspended) !== 1)
      .filter((u) => u.approvalAuthority.includes(authority))
      .filter((u) => u.userId !== excludeUserId)
      .map((u) => ({ userId: u.userId, label: u.officialTitle ? `${u.fullName} (${u.officialTitle})` : u.fullName }));
    return { candidates, limited: false };
  }
  const mine = await getMyAuthority(user);
  const candidates = (!mine.failed && mine.authority.has(authority) && user.userId !== excludeUserId)
    ? [{ userId: user.userId, label: mine.officialTitle ? `${user.fullName} (${mine.officialTitle}) — you` : `${user.fullName} — you` }]
    : [];
  return { candidates, limited: true };
}
