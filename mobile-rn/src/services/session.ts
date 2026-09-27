/**
 * On-device auth session (§2 Rule 9 / REFERENCE rule 12).
 *
 * Stored in the Keystore-backed secret store — the old app kept the JWT in
 * plain SharedPreferences (DEVLOG 2026-09-27 (3), defect 5).
 *
 * - Sliding renewal keeps whichever token expires LATER, so an out-of-order
 *   response can never roll the session backwards.
 * - Nothing here revives an expired/revoked session; only login writes one.
 * - Local capture never consults this module: losing a session must never
 *   block writing to incident_local.
 */
import { secrets } from './storage';

const SESSION_KEY = 'baranguard.session';

export interface StoredSession {
  token: string;
  /** Unix seconds, from the JWT's own `exp` claim. */
  expiresAt: number;
  userId: number;
  barangayId: number;
  role: string;
  fullName: string;
}

let cached: StoredSession | null = null;

/**
 * Reads `exp` WITHOUT verifying the signature — the client has no secret.
 * Used only for local expiry/renewal ordering; the server makes every real
 * authorization decision.
 */
export function readTokenExpiry(token: string): number {
  const parts = token.split('.');
  if (parts.length !== 3) return 0;
  try {
    const base64 = parts[1].replace(/-/g, '+').replace(/_/g, '/');
    const padded = base64 + '='.repeat((4 - (base64.length % 4)) % 4);
    const payload = JSON.parse(atob(padded));
    return typeof payload.exp === 'number' ? payload.exp : 0;
  } catch {
    return 0;
  }
}

export async function loadSession(): Promise<StoredSession | null> {
  if (cached) return cached;
  const value = await secrets.get(SESSION_KEY);
  if (!value) return null;
  try {
    cached = JSON.parse(value) as StoredSession;
    return cached;
  } catch {
    await clearSession();
    return null;
  }
}

export async function saveSession(session: StoredSession): Promise<void> {
  cached = session;
  await secrets.set(SESSION_KEY, JSON.stringify(session));
}

/** Applies an `X-Renewed-Token`, keeping whichever token expires later. */
export async function storeRenewedToken(token: string): Promise<void> {
  const current = await loadSession();
  if (!current) return;
  const newExpiry = readTokenExpiry(token);
  if (newExpiry <= current.expiresAt) return;
  await saveSession({ ...current, token, expiresAt: newExpiry });
}

export async function clearSession(): Promise<void> {
  cached = null;
  await secrets.remove(SESSION_KEY);
}

/** A session exists AND hasn't expired locally. */
export async function hasLiveSession(): Promise<boolean> {
  const session = await loadSession();
  return session !== null && session.expiresAt * 1000 > Date.now();
}

/**
 * ANY session stored, expired or not — what the app shell gates on, so a
 * Tanod out of range past the token TTL still reaches their cached
 * dispatches/map/reports (decided 2026-09-19). The server still rejects the
 * stale token, and the first 401 clears it and returns to login.
 */
export async function hasStoredSession(): Promise<boolean> {
  return (await loadSession()) !== null;
}

let sessionExpiredListeners: (() => void)[] = [];

/** Registered once at the root to route back to login. Returns an unsubscribe. */
export function onSessionExpired(listener: () => void): () => void {
  sessionExpiredListeners.push(listener);
  return () => {
    sessionExpiredListeners = sessionExpiredListeners.filter((l) => l !== listener);
  };
}

export function emitSessionExpired(): void {
  for (const listener of sessionExpiredListeners) listener();
}
