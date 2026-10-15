/** Pure layout and text rules for the single Live Map status line (freshness + basemap). */
import type { BasemapChip } from './liveMapHud';
import type { DrawerMode } from './mapFilters';

export const DEFAULT_PEEK_PX = 76;
export const MIN_PEEK_PX = 52;
export const SELECTED_DRAWER_PX = 215;
export const DRAWER_EXPANDED_VH = 0.65;
/** Bottom edge of the filter rail (top 52px, about 58px tall) plus a gap. */
export const RAIL_CLEARANCE_PX = 120;
export const STATUS_LINE_HEIGHT_PX = 48;
const GAP_PX = 8;

/** Collapsed drawer height that fits its summary text; the default until it is measured. */
export function clampPeekHeight(measuredPx: number | null): number {
  if (measuredPx === null || !Number.isFinite(measuredPx)) return DEFAULT_PEEK_PX;
  return Math.min(DEFAULT_PEEK_PX, Math.max(MIN_PEEK_PX, Math.ceil(measuredPx)));
}

/** How much of the drawer shows above the screen's bottom edge. */
export function visibleDrawerHeight(mode: DrawerMode, peekPx: number, viewportH: number): number {
  if (mode === 'expanded') return Math.round(viewportH * DRAWER_EXPANDED_VH);
  if (mode === 'selected') return SELECTED_DRAWER_PX;
  return peekPx;
}

export interface StatusLinePlacement {
  /** CSS bottom offset in px. */
  bottomPx: number;
  /** False when the line would collide with the filter rail. */
  fits: boolean;
}

export function statusLinePlacement(mode: DrawerMode, peekPx: number, viewportH: number): StatusLinePlacement {
  const bottomPx = visibleDrawerHeight(mode, peekPx, viewportH) + GAP_PX;
  const topPx = viewportH - bottomPx - STATUS_LINE_HEIGHT_PX;
  return { bottomPx, fits: topPx >= RAIL_CLEARANCE_PX };
}

export interface StatusLine {
  text: string;
  tone: 'neutral' | 'warning';
}

/** One line such as "Updated 14:05 · Online map"; warning when either part is degraded. */
export function combineStatus(freshness: { text: string; offline: boolean }, basemap: BasemapChip): StatusLine {
  return {
    text: `${freshness.text} · ${basemap.label}`,
    tone: freshness.offline || basemap.tone === 'warning' ? 'warning' : 'neutral',
  };
}
