/**
 * tanodRoster.js — "which tanods can I name here?" for the roster screens
 * (Scheduler's create/edit shift controls and the Swap requests tab).
 *
 * `GET /users` is Admin-only, so an Admin gets the real account list. A
 * Secretary (who may now create/edit shifts and resolve swaps) has no
 * user-list endpoint; the only same-barangay tanod names a Secretary can
 * already read come from availability submissions (`GET /availability`
 * returns the submitting tanod's id and name). So for a Secretary the roster
 * is the DISTINCT tanods that have submitted availability. This is a real
 * server-provided set, not an invented one — but it only contains tanods who
 * have submitted at least once. DOC NOTE for the orchestrator: if Secretaries
 * need to schedule a tanod who never submitted availability, a role-limited
 * `GET /users?role=tanod` (id + name only) for the Secretary is a pending
 * contract decision; nothing here assumes it exists.
 *
 * A failure to read availability resolves to an empty roster rather than
 * throwing: the screens that use this still work, they just have nobody to
 * pick from and say so.
 */

import { getUsers } from '../api/apiClient.js';
import { getAvailability } from './shellWorkflowApi.js';

/**
 * @param {{role:string}} user
 * @returns {Promise<Array<{userId:number, fullName:string}>>}
 */
export async function loadTanodRoster(user) {
  if (user.role === 'admin') {
    const res = await getUsers({ role: 'tanod', limit: 100 });
    return res.items;
  }
  if (user.role !== 'secretary') return [];
  try {
    const res = await getAvailability({ limit: 100 });
    const byId = new Map();
    for (const item of res.items) {
      if (item.userId == null || byId.has(item.userId)) continue;
      byId.set(item.userId, { userId: item.userId, fullName: item.userName ?? `Tanod #${item.userId}` });
    }
    return [...byId.values()].sort((a, b) => a.fullName.localeCompare(b.fullName));
  } catch {
    return [];
  }
}
