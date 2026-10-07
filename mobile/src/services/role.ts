/**
 * role.ts — which console this install shows (decision 15C, 2026-10-07).
 *
 * The server derives role from the account; the stored session just carries
 * it. UX only (Rule 2/6): an Admin device session is also scope-limited
 * server-side (backend SessionPolicy::ADMIN_DEVICE_ALLOWLIST), so hiding
 * Tanod screens here is never the security boundary.
 */

import { loadSession } from './session';

export type AppRole = 'tanod' | 'admin';

/** Roles the mobile app accepts at login. Secretary / Punong Barangay stay web-only. */
export function isMobileRole(role: string): role is AppRole {
  return role === 'tanod' || role === 'admin';
}

/** The stored session's role, or null when signed out / an unsupported role. */
export async function getSessionRole(): Promise<AppRole | null> {
  const session = await loadSession();
  return session && isMobileRole(session.role) ? session.role : null;
}

/** True only for a stored Tanod session. Background Tanod-only work (offline sync, school cache) gates on this. */
export async function isTanodSession(): Promise<boolean> {
  return (await getSessionRole()) === 'tanod';
}
