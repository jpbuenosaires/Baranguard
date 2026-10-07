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
