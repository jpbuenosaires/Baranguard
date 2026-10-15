/**
 * liveMapPolicy.ts — pure decisions for the Live Map screen (Phase 4 M).
 * No React, no MapLibre, no network: everything here is unit tested.
 */

import { distanceMeters } from './geo';
import { formatIncidentCode } from './incidentCode';

/** Refetch nearby incidents early only when the phone moved further than this since the last fetch. */
export const NEARBY_MOVE_THRESHOLD_M = 100;
/** At or above this zoom every marker shows its full name label. */
export const LABEL_FULL_ZOOM = 16;

export interface LatLng {
  latitude: number;
  longitude: number;
}

/**
 * True when nearby incidents should be fetched right now because of a GPS
 * fix: there was no earlier fetch position, or the phone moved more than the
 * threshold. The fixed 30 s timer is independent of this.
 */
export function shouldRefetchOnMove(
  last: LatLng | null,
  current: LatLng | null,
  thresholdM: number = NEARBY_MOVE_THRESHOLD_M
): boolean {
  if (!current) return false;
  if (!last) return true;
  return distanceMeters(last.latitude, last.longitude, current.latitude, current.longitude) > thresholdM;
}

/** "just now", "3 min ago", "2 h ago", "4 d ago" from a real timestamp. Clock going backwards counts as just now. */
export function agoPhrase(thenMs: number, nowMs: number): string {
  const seconds = Math.max(0, Math.floor((nowMs - thenMs) / 1000));
  if (seconds < 60) return 'just now';
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes} min ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours} h ago`;
  return `${Math.floor(hours / 24)} d ago`;
}

export interface Freshness {
  /** Text for the HUD chip. */
  text: string;
  /** True when the last fetch failed, so the shown data is old. */
  offline: boolean;
}

/**
 * HUD freshness text. `lastOkAt` is the real time of the last fully
 * successful load (null if none yet); `failing` is true when the most recent
 * attempt failed.
 */
export function describeFreshness(lastOkAt: number | null, failing: boolean, nowMs: number): Freshness {
  if (lastOkAt === null) {
    return failing
      ? { text: 'Offline, no nearby data loaded yet', offline: true }
      : { text: 'Loading nearby data', offline: false };
  }
  const ago = agoPhrase(lastOkAt, nowMs);
  return failing
    ? { text: `Offline, showing last data from ${ago}`, offline: true }
    : { text: `Updated ${ago}`, offline: false };
}

/**
 * Combines the per-list success times into one: the data is only as fresh as
 * its oldest needed list. Incidents are only needed once there is a GPS fix.
 * Returns null when a needed list has never loaded.
 */
export function combinedLastOk(incidentsAt: number | null, tanodsAt: number | null, needIncidents: boolean): number | null {
  if (tanodsAt === null) return null;
  if (!needIncidents) return tanodsAt;
  if (incidentsAt === null) return null;
  return Math.min(incidentsAt, tanodsAt);
}

export type PinLabelMode = 'full' | 'short' | 'none';

export interface PinLabelInput {
  kind: 'tanod' | 'incident';
  zoom: number;
  selected: boolean;
  /** Always-important markers (assignment destination) behave like selected ones. */
  pinned?: boolean;
  fullText: string;
  /** Tanod initials. Incidents have none: their marker icon is the short form. */
  shortText?: string;
}

/** What text a marker shows: full when selected/pinned or zoomed in, else initials (tanods) or nothing (incidents). */
export function pinLabel(input: PinLabelInput): { mode: PinLabelMode; text: string } {
  if (input.selected || input.pinned || input.zoom >= LABEL_FULL_ZOOM) {
    return { mode: 'full', text: input.fullText };
  }
  if (input.kind === 'tanod' && input.shortText) {
    return { mode: 'short', text: input.shortText };
  }
  return { mode: 'none', text: '' };
}

/** "R. Gubaton" for "Rey Gubaton"; single names stay whole; empty becomes "Tanod". */
export function shortPersonLabel(fullName?: string | null): string {
  const trimmed = fullName ? String(fullName).trim() : '';
  if (!trimmed) return 'Tanod';
  const parts = trimmed.split(/\s+/);
  if (parts.length === 1) return parts[0];
  return `${parts[0][0]}. ${parts[parts.length - 1]}`;
}

/** Up to two capital letters: "Rey Gubaton" -> "RG". Empty name -> "T". */
export function tanodInitials(fullName?: string | null): string {
  const trimmed = fullName ? String(fullName).trim() : '';
  if (!trimmed) return 'T';
  const parts = trimmed.split(/\s+/);
  const first = parts[0][0];
  const last = parts.length > 1 ? parts[parts.length - 1][0] : '';
  return `${first}${last}`.toUpperCase();
}

export function tanodAriaLabel(t: {
  fullName: string;
  isStale: boolean;
  dispatchId: number | null;
  ageSeconds: number;
}): string {
  const name = shortPersonLabel(t.fullName);
  if (t.isStale) return `Tanod ${name}, location stale, last seen ${agoPhrase(0, t.ageSeconds * 1000)}`;
  if (t.dispatchId !== null) return `Tanod ${name}, active, on dispatch`;
  return `Tanod ${name}, active`;
}

export function incidentAriaLabel(i: { incidentId: number; priority: string; status: string }): string {
  const code = formatIncidentCode({ serverIncidentId: i.incidentId }) ?? `#${i.incidentId}`;
  return `Incident ${code}, ${i.priority} priority, ${i.status}`;
}
