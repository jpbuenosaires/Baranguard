/**
 * shiftCache.ts — offline copy of My Shifts + swap requests so a Tanod can still read their own
 * published roster without data. Read cache only (swap requests stay online-only).
 *
 * shortcut: Capacitor Preferences (plain SharedPreferences), not encrypted SQLite — it holds only
 * schedule times and patrol zone names, no narrative/names/coordinates. Move to a `shift_local`
 * table when services/db gains one. Keyed by user id so a shared phone never shows someone else's roster.
 */
import { Preferences } from '@capacitor/preferences';
import type { ShiftEntry, ShiftSwapRequestEntry } from './apiService';
import { loadSession } from './session';

const KEY = 'my_shifts_cache_v1';

export interface CachedShifts {
  shifts: ShiftEntry[];
  swapRequests: ShiftSwapRequestEntry[];
  savedAt: string;
}

export async function saveShiftCache(shifts: ShiftEntry[], swapRequests: ShiftSwapRequestEntry[]): Promise<void> {
  try {
    const session = await loadSession();
    if (!session) return;
    await Preferences.set({ key: KEY, value: JSON.stringify({ userId: session.userId, shifts, swapRequests, savedAt: new Date().toISOString() }) });
  } catch {
    // Cache is best-effort.
  }
}

export async function loadShiftCache(): Promise<CachedShifts | null> {
  try {
    const session = await loadSession();
    const { value } = await Preferences.get({ key: KEY });
    if (!session || !value) return null;
    const parsed = JSON.parse(value) as CachedShifts & { userId: number };
    if (parsed.userId !== session.userId || !Array.isArray(parsed.shifts)) return null;
    return { shifts: parsed.shifts, swapRequests: parsed.swapRequests ?? [], savedAt: parsed.savedAt };
  } catch {
    return null;
  }
}
