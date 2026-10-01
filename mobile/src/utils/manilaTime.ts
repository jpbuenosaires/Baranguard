/**
 * manilaTime.ts — Asia/Manila calendar helpers for the tanod workflow screens
 * (availability, accomplishments, school check-in).
 *
 * REFERENCE.md §2 Rule 11: timestamps are stored UTC, but operational dates
 * ("which day did I work", "today", "this period") are Manila dates, and the
 * server buckets them at a fixed +08:00. A Tanod's phone is nearly always
 * already on Manila time, but a device with a travelling/wrong timezone must
 * not silently shift a work_date by a day, so every "today" below is derived
 * from the instant itself using the fixed +08:00 offset — never from the
 * device's local `getDate()`.
 *
 * Dates are plain `YYYY-MM-DD` strings throughout (never `Date` objects that
 * could be re-interpreted in another zone); arithmetic goes through UTC
 * midnight of that string and back.
 */

const MANILA_OFFSET_MS = 8 * 60 * 60 * 1000;
const DAY_MS = 24 * 60 * 60 * 1000;

function pad(n: number): string {
  return String(n).padStart(2, '0');
}

/** `YYYY-MM-DD` for the Manila calendar day containing `instant`. */
export function manilaDateOf(instant: Date): string {
  const shifted = new Date(instant.getTime() + MANILA_OFFSET_MS);
  return `${shifted.getUTCFullYear()}-${pad(shifted.getUTCMonth() + 1)}-${pad(shifted.getUTCDate())}`;
}

/** Today's Manila date. */
export function manilaToday(now: Date = new Date()): string {
  return manilaDateOf(now);
}

function dateStringToUtcMs(date: string): number {
  const [y, m, d] = date.split('-').map(Number);
  return Date.UTC(y, m - 1, d);
}

function utcMsToDateString(ms: number): string {
  const d = new Date(ms);
  return `${d.getUTCFullYear()}-${pad(d.getUTCMonth() + 1)}-${pad(d.getUTCDate())}`;
}

/** `date` shifted by a whole number of days. */
export function addDays(date: string, days: number): string {
  return utcMsToDateString(dateStringToUtcMs(date) + days * DAY_MS);
}

/** Whole days from `from` to `to` (negative when `to` is earlier). */
export function daysBetween(from: string, to: string): number {
  return Math.round((dateStringToUtcMs(to) - dateStringToUtcMs(from)) / DAY_MS);
}

/** Inclusive list of dates `start..end`. Returns `[]` when `end` is before `start`. */
export function eachDate(start: string, end: string): string[] {
  const out: string[] = [];
  const count = daysBetween(start, end);
  for (let i = 0; i <= count; i += 1) out.push(addDays(start, i));
  return out;
}

/** `YYYY-MM` of a `YYYY-MM-DD` date. */
export function monthOf(date: string): string {
  return date.slice(0, 7);
}

/** The month before/after `month` (`YYYY-MM`). */
export function shiftMonth(month: string, delta: number): string {
  const [y, m] = month.split('-').map(Number);
  const index = y * 12 + (m - 1) + delta;
  return `${Math.floor(index / 12)}-${pad((index % 12) + 1)}`;
}

/** "October 2026" style label for a `YYYY-MM`. */
export function formatMonthLabel(month: string): string {
  const [y, m] = month.split('-').map(Number);
  return new Date(Date.UTC(y, m - 1, 1)).toLocaleDateString('en-PH', {
    month: 'long',
    year: 'numeric',
    timeZone: 'UTC',
  });
}

/** "Mon, Oct 5" style label for a `YYYY-MM-DD` (rendered in UTC so the day never shifts). */
export function formatDayLabel(date: string): string {
  return new Date(dateStringToUtcMs(date)).toLocaleDateString('en-PH', {
    weekday: 'short',
    month: 'short',
    day: 'numeric',
    timeZone: 'UTC',
  });
}

/** "Oct 5 – Oct 11" for a period. */
export function formatPeriodLabel(start: string, end: string): string {
  const fmt = (d: string) =>
    new Date(dateStringToUtcMs(d)).toLocaleDateString('en-PH', { month: 'short', day: 'numeric', timeZone: 'UTC' });
  return start === end ? fmt(start) : `${fmt(start)} – ${fmt(end)}`;
}

/**
 * Minutes from `start` to `end` (`HH:MM`). An `end` earlier than `start` means the entry ran past
 * midnight into the next day (+1440). `null` when either is missing/invalid, or when they are equal
 * (ambiguous: 0 or 24h — the caller keeps whatever duration the Tanod typed).
 */
export function minutesBetweenTimes(start: string | null | undefined, end: string | null | undefined): number | null {
  const parse = (t: string | null | undefined): number | null => {
    if (!t) return null;
    const match = /^(\d{1,2}):(\d{2})/.exec(t);
    if (!match) return null;
    const h = Number(match[1]);
    const m = Number(match[2]);
    if (h > 23 || m > 59) return null;
    return h * 60 + m;
  };
  const a = parse(start);
  const b = parse(end);
  if (a === null || b === null || a === b) return null;
  return b > a ? b - a : b + 1440 - a;
}

/** "2h 30m" / "45m" for a minute count. */
export function formatMinutes(total: number): string {
  const h = Math.floor(total / 60);
  const m = total % 60;
  if (h === 0) return `${m}m`;
  return m === 0 ? `${h}h` : `${h}h ${m}m`;
}

/** Time of day in Manila for an ISO instant, e.g. "08:15 AM". */
export function formatManilaTime(iso: string): string {
  return new Date(iso).toLocaleTimeString('en-PH', {
    hour: '2-digit',
    minute: '2-digit',
    timeZone: 'Asia/Manila',
  });
}

/** Date + time in Manila for an ISO instant. */
export function formatManilaDateTime(iso: string): string {
  return new Date(iso).toLocaleString('en-PH', {
    month: 'short',
    day: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
    timeZone: 'Asia/Manila',
  });
}
