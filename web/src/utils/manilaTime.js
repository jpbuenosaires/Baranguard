/**
 * manilaTime.js — the ONE place the dashboard formats an instant for display.
 *
 * Operational times are Asia/Manila (REFERENCE Rule 11). The browser's own
 * time zone must never decide what a barangay official reads: a laptop set to
 * another zone would show a dispatch at the wrong hour. Every function here
 * pins `timeZone: 'Asia/Manila'` and uses the 12-hour clock with am/pm, which
 * is how barangay staff read time.
 *
 * Inputs may be a Date, an ISO string (the API client already revives UTC
 * timestamps into Dates), or an epoch number. Anything unusable returns the
 * `fallback` (default 'Not recorded') instead of 'Invalid Date'.
 */

const ZONE = 'Asia/Manila';

function toDate(value) {
  if (value === null || value === undefined || value === '') return null;
  const d = value instanceof Date ? value : new Date(value);
  return Number.isNaN(d.getTime()) ? null : d;
}

function fmt(value, options, fallback) {
  const d = toDate(value);
  if (!d) return fallback;
  return new Intl.DateTimeFormat('en-PH', { timeZone: ZONE, ...options }).format(d);
}

/** "Oct 9, 2026, 2:05 pm" */
export function formatManilaDateTime(value, fallback = 'Not recorded') {
  return fmt(value, { dateStyle: 'medium', timeStyle: 'short', hour12: true }, fallback);
}

/** "Oct 9, 2026" */
export function formatManilaDate(value, fallback = 'Not recorded') {
  return fmt(value, { dateStyle: 'medium' }, fallback);
}

/** "2:05 pm" */
export function formatManilaTime(value, fallback = 'Not recorded') {
  return fmt(value, { hour: 'numeric', minute: '2-digit', hour12: true }, fallback);
}

/** "2:05:09 pm" — for the live clock and "last updated" stamps. */
export function formatManilaTimeSeconds(value, fallback = 'Not recorded') {
  return fmt(value, { hour: 'numeric', minute: '2-digit', second: '2-digit', hour12: true }, fallback);
}

/** YYYY-MM-DD for the Manila calendar day of an instant (for date inputs and grouping). */
export function manilaDateKey(value) {
  const d = toDate(value);
  if (!d) return null;
  const parts = new Intl.DateTimeFormat('en-CA', { timeZone: ZONE, year: 'numeric', month: '2-digit', day: '2-digit' }).formatToParts(d);
  const get = (t) => parts.find((p) => p.type === t).value;
  return `${get('year')}-${get('month')}-${get('day')}`;
}
