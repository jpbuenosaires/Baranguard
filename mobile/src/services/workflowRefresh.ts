/**
 * workflowRefresh.ts — pulls the server's side of the 2026-10 tanod workflow
 * back into local state. Everything the Tanod WRITES goes up through
 * `syncService.ts`; this is the read direction:
 *
 *   - the school list  (`GET /schools`  -> `school_local`)  on login, app
 *     resume and sync passes, so the school picker works with no connection;
 *   - availability review status (`GET /availability` -> `availability_local`),
 *     which is how `accepted`/`revised` and the desk's note reach the phone;
 *   - an accomplishment month's report status + the server-suggested
 *     durations (`GET /accomplishment-reports`).
 *
 * Every function is best-effort and NEVER throws — offline, a 4xx or a missing
 * endpoint just means "keep whatever was cached" (same contract as
 * `sosFallbackContact.refreshSosFallbackContact`). Throttles keep a 60-second
 * on-duty sync tick from turning into a 60-second poll of these endpoints.
 *
 * Nothing here logs response contents.
 */

import { App as CapacitorApp } from '@capacitor/app';
import {
  getAccomplishmentReport,
  getMyAccomplishmentReports,
  getMyAvailability,
  getSchools,
  type AccomplishmentReportSummary,
} from './apiService';
import { applyServerAvailability, listAvailability } from './db/availabilityRepository';
import {
  applyServerEntryDurations,
  cacheReportSummary,
  getCachedReportSummary,
} from './db/accomplishmentRepository';
import { cacheSchools, getSchoolCacheAgeMs } from './db/schoolRepository';
import { loadSession } from './session';

const SCHOOL_REFRESH_MIN_AGE_MS = 30 * 60 * 1000;
const AVAILABILITY_REFRESH_MIN_GAP_MS = 5 * 60 * 1000;

let lastAvailabilityRefreshAt = 0;

/**
 * Refreshes `school_local`. `force` skips the age throttle (login/resume);
 * the periodic sync-pass call leaves it off. Returns true when the cache was
 * actually replaced.
 */
export async function refreshSchoolCache(options: { force?: boolean } = {}): Promise<boolean> {
  try {
    if (!options.force) {
      const age = await getSchoolCacheAgeMs();
      if (age !== null && age < SCHOOL_REFRESH_MIN_AGE_MS) return false;
    }
    await cacheSchools(await getSchools());
    return true;
  } catch {
    return false;
  }
}

/** Pulls the Tanod's own availability rows. `force` skips the gap throttle (opening the screen / pull-to-refresh). */
export async function refreshAvailabilityFromServer(options: { force?: boolean } = {}): Promise<boolean> {
  try {
    const now = Date.now();
    if (!options.force && now - lastAvailabilityRefreshAt < AVAILABILITY_REFRESH_MIN_GAP_MS) return false;
    const entries = await getMyAvailability();
    lastAvailabilityRefreshAt = now;
    await applyServerAvailability(entries);
    return true;
  } catch {
    return false;
  }
}

/**
 * Pulls one month's report status (cached for offline display) and, when it
 * exists, the per-entry suggested durations. Returns the report summary (fresh,
 * or the last cached one if the fetch failed), or null if none is known.
 */
export async function refreshAccomplishmentMonth(
  month: string
): Promise<{ report: AccomplishmentReportSummary | null; fresh: boolean }> {
  try {
    const reports = await getMyAccomplishmentReports(month);
    const found = reports.find((r) => r.month === month) ?? null;
    if (!found) return { report: await getCachedReportSummary(month), fresh: true };
    await cacheReportSummary(found);
    try {
      const detail = await getAccomplishmentReport(found.reportId);
      await applyServerEntryDurations(detail.entries);
      await cacheReportSummary(detail.report);
      return { report: detail.report, fresh: true };
    } catch {
      return { report: found, fresh: true };
    }
  } catch {
    return { report: await getCachedReportSummary(month), fresh: false };
  }
}

/**
 * The cheap, throttled refresh a sync pass runs after sending: the school
 * cache, and availability status only if the Tanod actually has submissions
 * that could have been reviewed. Never throws.
 */
export async function refreshWorkflowCaches(): Promise<void> {
  try {
    if (!(await loadSession())) return;
    await refreshSchoolCache();
    const rows = await listAvailability();
    if (rows.some((row) => row.synced === 1 && row.status !== 'accepted')) {
      await refreshAvailabilityFromServer();
    }
  } catch {
    // Local DB unavailable (web preview) or offline — nothing to refresh.
  }
}

let resumeListenerStarted = false;

/**
 * Re-fetches the school list every time the app returns to the foreground,
 * mirroring `startSosFallbackContactResumeRefresh()`. Skipped when signed out
 * (an unauthenticated call would only raise a spurious session-expired event).
 * Call once from `App.tsx`.
 */
export function startSchoolCacheResumeRefresh(): void {
  if (resumeListenerStarted) return;
  resumeListenerStarted = true;
  CapacitorApp.addListener('appStateChange', ({ isActive }) => {
    if (!isActive) return;
    void (async () => {
      if (await loadSession()) await refreshSchoolCache({ force: true });
    })();
  });
}
