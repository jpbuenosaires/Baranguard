/**
 * session.ts — on-device auth session storage (§2 Rule 9).
 *
 * Stored via @capacitor/preferences, which is Android SharedPreferences
 * under the hood: app-private, and not reachable from any script running
 * inside the WebView the way `localStorage` would be. A 15-minute JWT is
 * short-lived but still a credential, so it gets the same app-private
 * treatment §9 M3 already requires for voice/photo evidence.
 *
 * Rule 9 specifics honored here:
 *   - "Sliding renewal may extend a still-valid session; the server emits
 *     the newest token with a non-decreasing expiry, and the client must
 *     keep the token with the latest expiry." → `storeRenewedToken()`
 *     refuses to replace a stored token with one that expires EARLIER,
 *     so an out-of-order response can never roll the session backwards.
 *   - "An expired/revoked session is never revived." → nothing here
 *     re-creates a session; only a fresh login writes one.
 *   - "offline mobile capture is unaffected" by session expiry → this
 *     module is deliberately not consulted by the local-capture path.
 *     Losing a session must never block writing to incident_local.
 */

import { Preferences } from '@capacitor/preferences';

const SESSION_KEY = 'baranguard.session';

export interface StoredSession {
  token: string;
  /** Unix seconds, decoded from the JWT's own `exp` claim. */
  expiresAt: number;
  userId: number;
  barangayId: number;
  role: string;
  fullName: string;
}

let cached: StoredSession | null = null;

/**
 * Reads the `exp` claim without verifying the signature — the client
 * cannot verify (it has no secret) and must not pretend to. This is used
 * only to decide local expiry/renewal ordering; every actual
 * authorization decision is the server's (§2 Rule 6: "Client-side hiding
 * is UX only").
 */
export function readTokenExpiry(token: string): number {
  const parts = token.split('.');
  if (parts.length !== 3) return 0;
  try {
    const payload = JSON.parse(atob(parts[1].replace(/-/g, '+').replace(/_/g, '/')));
    return typeof payload.exp === 'number' ? payload.exp : 0;
  } catch {
    return 0;
  }
}

export async function loadSession(): Promise<StoredSession | null> {
  if (cached) return cached;
  const { value } = await Preferences.get({ key: SESSION_KEY });
  if (!value) return null;
  try {
    cached = JSON.parse(value) as StoredSession;
    return cached;
  } catch {
    // Corrupt payload — treat as "no session" rather than throwing the
    // user into an unrecoverable state.
    await clearSession();
    return null;
  }
}

export async function saveSession(session: StoredSession): Promise<void> {
  cached = session;
  await Preferences.set({ key: SESSION_KEY, value: JSON.stringify(session) });
}

/**
 * Applies a sliding-renewal token from an `X-Renewed-Token` response
 * header. Keeps whichever token expires LATER, per Rule 9.
 */
export async function storeRenewedToken(token: string): Promise<void> {
  const current = await loadSession();
  if (!current) return; // No session to extend; a renewal alone never creates one.
  const newExpiry = readTokenExpiry(token);
  if (newExpiry <= current.expiresAt) return; // Never move the expiry backwards.
  await saveSession({ ...current, token, expiresAt: newExpiry });
}

export async function clearSession(): Promise<void> {
  cached = null;
  await Preferences.remove({ key: SESSION_KEY });
}

/** True only if a session exists AND has not already expired locally. */
export async function hasLiveSession(): Promise<boolean> {
  const session = await loadSession();
  if (!session) return false;
  return session.expiresAt * 1000 > Date.now();
}
