/**
 * sosFallbackContact.ts — caches G1's SOS fallback backup contact number
 * locally (Mobile Improvement Plan Phase 4.3).
 *
 * WHY THIS EXISTS AS A CACHE, NOT A LIVE FETCH: the moment this number is
 * actually needed is the exact moment `GET /tanod-sos/fallback-contact`
 * would ALSO fail — the whole point of this fallback tier is that the
 * workstation is confirmed unreachable. So the number has to already be
 * on the device before the emergency happens. `refreshSosFallbackContact()`
 * is called opportunistically while online — ONLY at login (`login.tsx`).
 * Corrected 2026-09-24: this comment previously also claimed "Live Map's
 * own mount" refreshes it too, mirroring `ensureMapPackageDownloaded()`'s
 * pattern — found stale during M13 device testing (grepped every call
 * site, only login.tsx calls this). No Live Map refresh was ever wired
 * up; if a mid-session change to the backup number should reach the
 * cache faster than "wait for next login," that is a real, separate
 * feature decision, not something this fix silently adds.
 * `getCachedSosFallbackContact()` is what `home.tsx`'s SOS handler
 * actually reads from, entirely offline.
 */

import { Preferences } from '@capacitor/preferences';
import { getSosFallbackContact } from './apiService';

const CACHE_KEY = 'baranguard.sosFallbackContact';

/** Best-effort refresh from the server. Never throws — offline or not-yet-configured both just mean "keep whatever was cached before". */
export async function refreshSosFallbackContact(): Promise<void> {
  try {
    const number = await getSosFallbackContact();
    await Preferences.set({ key: CACHE_KEY, value: number ?? '' });
  } catch {
    // Keep the existing cached value (or lack of one).
  }
}

/** The last-refreshed backup contact number, or null if none is configured/cached yet. */
export async function getCachedSosFallbackContact(): Promise<string | null> {
  const { value } = await Preferences.get({ key: CACHE_KEY });
  return value && value.trim() !== '' ? value : null;
}
