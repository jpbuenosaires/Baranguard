/**
 * sosFallbackContact.ts — caches G1's SOS fallback backup contact number
 * locally (Mobile Improvement Plan Phase 4.3).
 *
 * WHY THIS EXISTS AS A CACHE, NOT A LIVE FETCH: the moment this number is
 * actually needed is the exact moment `GET /tanod-sos/fallback-contact`
 * would ALSO fail — the whole point of this fallback tier is that the
 * workstation is confirmed unreachable. So the number has to already be
 * on the device before the emergency happens. `refreshSosFallbackContact()`
 * is called opportunistically while online — at login (`login.tsx`) and
 * on every app resume (`startSosFallbackContactResumeRefresh()` below,
 * wired from `App.tsx`). It is NOT refreshed on Live Map mount (an older
 * version of this comment wrongly claimed so).
 * `getCachedSosFallbackContact()` is what `home.tsx`'s SOS handler
 * actually reads from, entirely offline.
 */

import { App as CapacitorApp } from '@capacitor/app';
import { Preferences } from '@capacitor/preferences';
import { getSosFallbackContact } from './apiService';
import { loadSession } from './session';

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

let resumeListenerStarted = false;

/**
 * Re-runs the refresh every time the app returns to the foreground, so a
 * backup number an Admin changes mid-session reaches the cache without
 * waiting for the next login. Skipped when signed out — the call is
 * authenticated, and an unauthenticated attempt would only raise a spurious
 * session-expired event. Call once from `App.tsx`.
 */
export function startSosFallbackContactResumeRefresh(): void {
  if (resumeListenerStarted) return;
  resumeListenerStarted = true;
  CapacitorApp.addListener('appStateChange', ({ isActive }) => {
    if (!isActive) return;
    void (async () => {
      if (await loadSession()) await refreshSosFallbackContact();
    })();
  });
}

/** The last-refreshed backup contact number, or null if none is configured/cached yet. */
export async function getCachedSosFallbackContact(): Promise<string | null> {
  const { value } = await Preferences.get({ key: CACHE_KEY });
  return value && value.trim() !== '' ? value : null;
}
