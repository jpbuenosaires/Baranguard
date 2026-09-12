/**
 * DispatchAction.js — the Tanod-picker-dialog + `POST /dispatch` flow,
 * extracted from `dispatch-center.js`'s Pending Incidents queue so
 * `incident-management.js`'s detail pane can trigger the exact same
 * dispatch (§9 W3) instead of growing a second, drifting copy of it.
 *
 * Admin-only by construction: `createDispatch` -> `POST /dispatch` 403s
 * for any other role server-side (`DispatchController::create`), so this
 * is only ever wired up behind an `user.role === 'admin'` check by its
 * callers — it does not re-check the role itself, same as
 * `createDispatch` in apiClient.js doesn't either.
 */

import { createDispatch, getGpsLive, ApiClientError } from '../api/apiClient.js';
import { promptSelect } from './ConfirmDialog.js';
import { showToast } from './Toast.js';

const PRIORITY_LABELS = { normal: 'Normal', high: 'High', critical: 'Critical' };

/** Metres between two WGS84 points. Haversine — good to well under a metre
 *  at barangay scale, and the picker only ever shows a rounded value. */
function metresBetween(lat1, lon1, lat2, lon2) {
  const R = 6371000;
  const toRad = (d) => (d * Math.PI) / 180;
  const dLat = toRad(lat2 - lat1);
  const dLon = toRad(lon2 - lon1);
  const a = Math.sin(dLat / 2) ** 2
    + Math.cos(toRad(lat1)) * Math.cos(toRad(lat2)) * Math.sin(dLon / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(a));
}

function formatDistance(m) {
  return m < 1000 ? `${Math.round(m / 10) * 10} m` : `${(m / 1000).toFixed(1)} km`;
}

/** Scales so a genuinely old fix reads as "6d", not "8400 min". */
function formatFixAge(seconds) {
  if (!Number.isFinite(seconds)) return 'stale';
  const mins = Math.round(seconds / 60);
  if (mins < 60) return `${mins} min old`;
  const hours = Math.round(mins / 60);
  if (hours < 24) return `${hours}h old`;
  return `${Math.round(hours / 24)}d old`;
}

/**
 * Orders the picker nearest-first and labels each option with a REAL
 * measured distance, or says plainly that there isn't one.
 *
 * DECISION SUPPORT ONLY — this changes the order options are presented
 * in and nothing else. The Admin still chooses, `POST /dispatch` still
 * enforces its own rules, and no automatic assignment happens anywhere.
 *
 * HONESTY RULES, because a wrong distance is worse than no distance
 * (§2 Rule 6):
 *   - A Tanod with no live fix is never given a guessed position. They
 *     sort last, labelled "location unknown", and stay selectable — an
 *     Admin who knows where their people are must not be blocked by a
 *     handset that hasn't pinged.
 *   - A STALE fix (the server's own `is_stale`, not a threshold invented
 *     here) still shows its distance, but says how old it is, because
 *     "400 m away as of 20 minutes ago" and "400 m away now" are
 *     different facts.
 *   - If the incident itself has no coordinates, or live GPS can't be
 *     read at all, the picker silently falls back to the original
 *     unranked list rather than showing a half-ranked one.
 *
 * @param {Array<{userId:number, fullName:string}>} eligibleTanods
 * @param {Array<object>|null} positions  `getGpsLive()` rows, or null
 * @param {{latitude:*, longitude:*}} incident
 * @returns {{options:Array<{value:number,label:string}>, ranked:boolean}}
 */
function rankByProximity(eligibleTanods, positions, incident) {
  const iLat = Number(incident?.latitude);
  const iLon = Number(incident?.longitude);
  if (!Array.isArray(positions) || !positions.length || !Number.isFinite(iLat) || !Number.isFinite(iLon)) {
    return { options: eligibleTanods.map((t) => ({ value: t.userId, label: t.fullName })), ranked: false };
  }

  const byUser = new Map();
  for (const p of positions) {
    const lat = Number(p.latitude);
    const lon = Number(p.longitude);
    if (Number.isFinite(lat) && Number.isFinite(lon)) byUser.set(p.userId, { ...p, lat, lon });
  }

  const ranked = eligibleTanods.map((t) => {
    const fix = byUser.get(t.userId);
    if (!fix) return { tanod: t, metres: null, stale: false };
    return {
      tanod: t,
      metres: metresBetween(iLat, iLon, fix.lat, fix.lon),
      stale: Boolean(fix.isStale),
      ageSeconds: Number(fix.ageSeconds),
    };
  });

  // Known fixes first (nearest first), then stale-but-known, then unknown.
  ranked.sort((a, b) => {
    if (a.metres === null && b.metres === null) return a.tanod.fullName.localeCompare(b.tanod.fullName);
    if (a.metres === null) return 1;
    if (b.metres === null) return -1;
    if (a.stale !== b.stale) return a.stale ? 1 : -1;
    return a.metres - b.metres;
  });

  const options = ranked.map((r) => {
    if (r.metres === null) return { value: r.tanod.userId, label: `${r.tanod.fullName} — location unknown` };
    if (r.stale) {
      return { value: r.tanod.userId, label: `${r.tanod.fullName} — ${formatDistance(r.metres)} away (last fix ${formatFixAge(r.ageSeconds)})` };
    }
    return { value: r.tanod.userId, label: `${r.tanod.fullName} — ${formatDistance(r.metres)} away` };
  });

  // "Ranked" means at least one real distance is on screen — if every
  // eligible Tanod is location-unknown the list is only re-alphabetised,
  // and claiming it is ordered by proximity would be a lie.
  return { options, ranked: ranked.some((r) => r.metres !== null) };
}

/**
 * @param {{incidentId:number, priority:string, barangayId?:number, latitude?:*, longitude?:*}} incident
 * @param {string} incidentTypeLabel - already-resolved display label (caller owns INCIDENT_TYPE_LABELS)
 * @param {Array<{userId:number, fullName:string}>} eligibleTanods - same-barangay, active, on-duty
 * @param {Array<object>} [tanodPositions] - `getGpsLive()` rows a caller already holds; fetched here if omitted
 * @returns {Promise<boolean>} true if a dispatch was created; false if cancelled or failed (toast already shown)
 */
export async function promptDispatchTanod({ incident, incidentTypeLabel, eligibleTanods, tanodPositions }) {
  if (eligibleTanods.length === 0) return false;

  // Callers that already poll live GPS (dispatch-center) pass theirs in
  // rather than paying for a second identical call; the rest get one
  // best-effort fetch, whose failure costs only the ranking.
  let positions = Array.isArray(tanodPositions) ? tanodPositions : null;
  if (positions === null && incident?.barangayId != null) {
    positions = await getGpsLive(incident.barangayId).catch(() => null);
  }

  const { options, ranked } = rankByProximity(eligibleTanods, positions, incident);

  const tanodId = await promptSelect({
    title: `Assign incident #${incident.incidentId}`,
    description: `${incidentTypeLabel} · ${PRIORITY_LABELS[incident.priority] || incident.priority} priority. The assigned Tanod is notified immediately.`
      + (ranked ? ' Ordered nearest first from each Tanod’s last known position — you still choose.' : ''),
    label: 'On-duty Tanod',
    options,
    confirmLabel: 'Assign',
  });
  if (tanodId === null) return false;

  try {
    await createDispatch({
      incidentId: incident.incidentId,
      tanodId: Number(tanodId),
      requestId: crypto.randomUUID(),
    });
    const tanodName = eligibleTanods.find((t) => String(t.userId) === String(tanodId))?.fullName || 'Tanod';
    showToast(`Dispatch assigned to ${tanodName}`, { variant: 'success' });
    return true;
  } catch (err) {
    const message = err instanceof ApiClientError ? err.message : 'Could not create the dispatch.';
    showToast(message, { variant: 'error' });
    return false;
  }
}
