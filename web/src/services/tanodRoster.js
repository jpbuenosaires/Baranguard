/**
 * tanodRoster.js — "which tanods can I name here?" for the roster screens
 * (Scheduler's create/edit shift controls and the Swap requests tab).
 *
 * Both Admin and Secretary read `GET /users/directory?purpose=tanod`: a thin,
 * same-barangay feed of active, non-suspended tanods ({user_id, full_name,
 * official_title}). It replaces the earlier Secretary workaround that derived
 * names from availability submissions. Any other role gets an empty roster
 * (the screens never offer these controls to them).
 *
 * A failure resolves to an empty roster rather than throwing: the screens
 * still work, they just have nobody to pick from and say so.
 */

import { getUsersDirectory } from './shellWorkflowApi.js';

/**
 * `purpose` defaults to 'tanod' (swap requests: tanods only). The Scheduler's
 * create/edit shift picker passes 'roster' so the Chief Tanod (an Admin
 * account) can be named too; labelling uses officialTitle, not a role key.
 * @param {{role:string}} user
 * @param {{purpose?:'tanod'|'roster'}} [opts]
 * @returns {Promise<Array<{userId:number, fullName:string, officialTitle:string|null}>>}
 */
export async function loadTanodRoster(user, { purpose = 'tanod' } = {}) {
  if (user.role !== 'admin' && user.role !== 'secretary') return [];
  try {
    const items = await getUsersDirectory({ purpose });
    return items.map((u) => ({ userId: u.userId, fullName: u.fullName, officialTitle: u.officialTitle ?? null }));
  } catch {
    return [];
  }
}
