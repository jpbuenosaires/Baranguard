/** Small shared constants/formatters for the Chief Tanod console (kept out of the component file for fast refresh). */

import { formatManilaDateTime } from '../utils/manilaTime';

export const NEEDS_CONNECTION = 'Needs a connection';
export const MAX_REASON = 255;

/** Server timestamps are UTC; MariaDB-style "YYYY-MM-DD HH:MM:SS" carries no zone, so say so before parsing. */
export function formatServerTime(value: string | null | undefined): string {
  if (!value) return '—';
  const iso = /[zZ]|[+-]\d{2}:?\d{2}$/.test(value) ? value : `${value.replace(' ', 'T')}Z`;
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? value : formatManilaDateTime(d.toISOString());
}

export function humanize(value: string | null | undefined): string {
  return value ? value.replace(/_/g, ' ') : '—';
}

export function isActiveDispatchStatus(status: string): boolean {
  return status === 'assigned' || status === 'en_route' || status === 'arrived';
}

// ---------------------------------------------------------------------------
// List helpers (Phase 4): client-side filtering and capping for the console.

export const LIST_PAGE_SIZE = 20;
export const LIVE_OFFER_STATUSES = ['open', 'escalated'];

export interface IncidentFilterable {
  displayId: string | null;
  incidentId: number;
  incidentType: string | null;
  status: string | null;
  locationDescription?: string | null;
}

export const INCIDENT_STATUS_FILTERS: ReadonlyArray<{ value: string; label: string }> = [
  { value: 'all', label: 'All' },
  { value: 'pending', label: 'Pending' },
  { value: 'dispatched', label: 'Dispatched' },
  { value: 'resolved', label: 'Resolved' },
  { value: 'other', label: 'Other' },
];

const MAIN_STATUSES = ['pending', 'dispatched', 'resolved'];

/** Search matches the INC code, the numeric id, the (humanized) type or the location text; status 'other' = anything not pending/dispatched/resolved. */
export function filterIncidents<T extends IncidentFilterable>(items: T[], query: string, status: string): T[] {
  const q = query.trim().toLowerCase();
  return items.filter((i) => {
    if (status === 'other') {
      if (MAIN_STATUSES.includes(i.status ?? '')) return false;
    } else if (status !== 'all' && i.status !== status) return false;
    if (!q) return true;
    const hay = [i.displayId ?? '', `inc-${i.incidentId}`, String(i.incidentId), humanize(i.incidentType), i.locationDescription ?? ''].join(' ').toLowerCase();
    return hay.includes(q);
  });
}

/** First `limit` items unless expanded. */
export function capList<T>(items: T[], expanded: boolean, limit = LIST_PAGE_SIZE): T[] {
  return expanded ? items : items.slice(0, limit);
}

/** Live offers only unless the earlier ones are requested. */
export function visibleOffers<T extends { status: string }>(offers: T[], showEarlier: boolean): T[] {
  return showEarlier ? offers : offers.filter((o) => LIVE_OFFER_STATUSES.includes(o.status));
}

export function formatUpdatedAt(d: Date | null): string {
  if (!d) return '';
  return `Updated ${formatServerTime(d.toISOString())}`;
}

// ---------------------------------------------------------------------------
// SOS helpers (Phase 4)

/** Newest first by raised time; unparsable times sort last. Does not mutate. */
export function sortNewestFirst<T extends { triggeredAt: string }>(items: T[]): T[] {
  const t = (v: string) => {
    const n = new Date(/[zZ]|[+-]\d{2}:?\d{2}$/.test(v) ? v : `${v.replace(' ', 'T')}Z`).getTime();
    return Number.isNaN(n) ? -Infinity : n;
  };
  return [...items].sort((a, b) => t(b.triggeredAt) - t(a.triggeredAt));
}

/** Honest location wording: live, last known (with the fix's OWN time) or no fix. */
export function sosLocationText(source: string | null, recordedAt: string | null): string {
  if (source === 'live') return 'Live GPS fix';
  if (source === 'last_known') {
    return recordedAt ? `Last known position, fix from ${formatServerTime(recordedAt)} (not live)` : 'Last known position (not live)';
  }
  return 'No location available';
}

// ---------------------------------------------------------------------------
// Assign picker

export interface PickerOption {
  userId: number;
  label: string;
  assigned: boolean;
}

/** Already-assigned tanods stay in the list but are marked and disabled; assigned ones sort last. */
export function buildAssignOptions(
  directory: Array<{ userId: number; fullName: string; officialTitle: string | null }>,
  assignedIds: ReadonlySet<number>
): PickerOption[] {
  const rows = directory.map((u) => {
    const assigned = assignedIds.has(u.userId);
    const base = u.officialTitle ? `${u.fullName} (${u.officialTitle})` : u.fullName;
    return { userId: u.userId, label: assigned ? `${base} - already assigned` : base, assigned };
  });
  return [...rows.filter((r) => !r.assigned), ...rows.filter((r) => r.assigned)];
}

// ---------------------------------------------------------------------------
// Offers

/** One-line state for an offer: live ones say when the round ends. */
export function offerStateText(o: { status: string; round: number; expiresAt: string }): string {
  const live = LIVE_OFFER_STATUSES.includes(o.status);
  return live ? `Round ${o.round}, ends ${formatServerTime(o.expiresAt)}` : `Round ${o.round}, ${humanize(o.status)}`;
}

/** Live offers first, then newest first by creation time. */
export function sortOffers<T extends { status: string; createdAt: string }>(offers: T[]): T[] {
  return [...offers].sort((a, b) => {
    const la = LIVE_OFFER_STATUSES.includes(a.status) ? 0 : 1;
    const lb = LIVE_OFFER_STATUSES.includes(b.status) ? 0 : 1;
    if (la !== lb) return la - lb;
    return b.createdAt.localeCompare(a.createdAt);
  });
}
