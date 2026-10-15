/**
 * liveMapHud.ts — pure helpers for the Live Map HUD: freshness line (Manila
 * clock), basemap chip text and marker-label thinning. No React, no MapLibre.
 * Complements liveMapPolicy.ts.
 */

import type { Freshness } from './liveMapPolicy';

/** Data older than this counts as stale even when the last request did not fail. */
export const DATA_STALE_AFTER_MS = 90_000;

/** "14:05" in Asia/Manila (fixed +08:00, no DST) for a real timestamp. */
export function formatManilaTime(ms: number): string {
  const d = new Date(ms + 8 * 3600_000);
  const hh = String(d.getUTCHours()).padStart(2, '0');
  const mm = String(d.getUTCMinutes()).padStart(2, '0');
  return `${hh}:${mm}`;
}

export function isDataStale(lastOkAt: number | null, failing: boolean, nowMs: number): boolean {
  if (lastOkAt === null) return failing;
  return failing || nowMs - lastOkAt > DATA_STALE_AFTER_MS;
}

/**
 * HUD line: "Updated 14:05" while fresh; "Offline - showing last known (14:05)"
 * when the data is old or the last request failed; honest states before the
 * first load.
 */
export function freshnessLine(lastOkAt: number | null, failing: boolean, nowMs: number): Freshness {
  if (lastOkAt === null) {
    return failing
      ? { text: 'Offline - no nearby data loaded yet', offline: true }
      : { text: 'Loading nearby data', offline: false };
  }
  const at = formatManilaTime(lastOkAt);
  return isDataStale(lastOkAt, failing, nowMs)
    ? { text: `Offline - showing last known (${at})`, offline: true }
    : { text: `Updated ${at}`, offline: false };
}

export type BasemapKind = 'loading' | 'offline' | 'online' | 'unavailable';

export interface BasemapChip {
  label: string;
  tone: 'neutral' | 'success' | 'warning';
}

/** Which basemap is really in use. `deviceOnline` is navigator.onLine. */
export function basemapChip(status: { kind: BasemapKind; version?: string }, deviceOnline: boolean): BasemapChip {
  switch (status.kind) {
    case 'offline':
      return { label: status.version ? `Offline map ${status.version}` : 'Offline map', tone: 'success' };
    case 'online':
      return deviceOnline
        ? { label: 'Online map', tone: 'neutral' }
        : { label: 'No map tiles, no signal', tone: 'warning' };
    case 'unavailable':
      return { label: 'No map', tone: 'warning' };
    default:
      return { label: 'Loading map', tone: 'neutral' };
  }
}

export interface LabelCandidate {
  id: string;
  /** Marker centre in screen pixels. */
  x: number;
  y: number;
  /** Label text; empty means this marker shows no label at all. */
  text: string;
  /** SOS, the user's own marker, selected or pinned: placed first, never dropped. */
  always?: boolean;
  /** Lower number wins when two labels overlap. */
  rank?: number;
}

const LABEL_CHAR_PX = 7;
const LABEL_PAD_PX = 14;
const LABEL_HEIGHT_PX = 18;
const LABEL_OFFSET_Y = 24;

function labelRect(c: LabelCandidate) {
  const w = c.text.length * LABEL_CHAR_PX + LABEL_PAD_PX;
  return { l: c.x - w / 2, r: c.x + w / 2, t: c.y + LABEL_OFFSET_Y, b: c.y + LABEL_OFFSET_Y + LABEL_HEIGHT_PX };
}

/**
 * Ids whose label may be drawn. Always-labelled markers go first and are kept
 * even if they overlap each other; the rest are kept greedily by rank (then
 * input order) only if their box clears every label already placed.
 */
export function thinLabels(candidates: LabelCandidate[]): Set<string> {
  const keep = new Set<string>();
  const placed: ReturnType<typeof labelRect>[] = [];
  const withText = candidates.map((c, i) => ({ c, i })).filter(({ c }) => c.text !== '');
  const order = [...withText].sort((a, b) => {
    const aa = a.c.always ? 0 : 1;
    const bb = b.c.always ? 0 : 1;
    if (aa !== bb) return aa - bb;
    const ra = a.c.rank ?? 10;
    const rb = b.c.rank ?? 10;
    return ra !== rb ? ra - rb : a.i - b.i;
  });
  for (const { c } of order) {
    const r = labelRect(c);
    const clear = !placed.some((p) => r.l < p.r && r.r > p.l && r.t < p.b && r.b > p.t);
    if (c.always || clear) {
      keep.add(c.id);
      placed.push(r);
    }
  }
  return keep;
}
