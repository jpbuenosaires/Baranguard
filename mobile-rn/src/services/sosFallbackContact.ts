/**
 * Caches G1's SOS fallback backup contact number locally.
 *
 * WHY A CACHE, NOT A LIVE FETCH: the moment this number is actually needed
 * is the exact moment `GET /tanod-sos/fallback-contact` would ALSO fail —
 * the whole point of this fallback tier is that the workstation is
 * confirmed unreachable. `refreshSosFallbackContact()` runs opportunistically
 * while online, only at login. Only login calls this — a mid-session change
 * to the backup number reaching the cache faster is a separate feature
 * decision, not something to silently add here.
 */
import { getSosFallbackContact } from './apiService';
import { prefs } from './storage';

const CACHE_KEY = 'baranguard.sosFallbackContact';

/** Best-effort refresh. Never throws — offline/not-configured keeps whatever was cached before. */
export async function refreshSosFallbackContact(): Promise<void> {
  try {
    const number = await getSosFallbackContact();
    await prefs.set(CACHE_KEY, number ?? '');
  } catch {
    // Keep the existing cached value (or lack of one).
  }
}

/** The last-refreshed backup contact number, or null if none is configured/cached yet. */
export async function getCachedSosFallbackContact(): Promise<string | null> {
  const value = await prefs.get(CACHE_KEY);
  return value && value.trim() !== '' ? value : null;
}
