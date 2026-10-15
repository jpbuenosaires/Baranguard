/**
 * workflowForm.ts - pure helpers for the Phase 4 workflow screens
 * (accomplishment duration inputs, availability quick-fill). No I/O.
 */

/** Digits only, clamped to 0..max; empty stays empty so the field can be cleared. */
export function clampWholeNumber(raw: string, max: number): string {
  const digits = raw.replace(/\D/g, '');
  if (digits === '') return '';
  return String(Math.min(Number(digits), max));
}

export const clampHours = (raw: string): string => clampWholeNumber(raw, 24);
export const clampMinutes = (raw: string): string => clampWholeNumber(raw, 59);

/** "Total 8 h 30 min"; null when nothing is entered yet. */
export function formatDurationTotal(hours: string, minutes: string): string | null {
  const h = Number(hours) || 0;
  const m = Number(minutes) || 0;
  if (h === 0 && m === 0) return null;
  if (m === 0) return `Total ${h} h`;
  if (h === 0) return `Total ${m} min`;
  return `Total ${h} h ${m} min`;
}

/** Quick-fill helpers for availability periods. */
export interface DayWindowLike {
  from: string;
  to: string;
}

/** True for Monday..Friday of an ISO date (YYYY-MM-DD), computed without timezone drift. */
export function isWeekday(date: string): boolean {
  const [y, m, d] = date.split('-').map(Number);
  const dow = new Date(Date.UTC(y, m - 1, d)).getUTCDay();
  return dow >= 1 && dow <= 5;
}

/** Same windows on every date. Each date gets its own copy. */
export function fillAllDays<T extends DayWindowLike>(dates: string[], windows: T[]): Record<string, T[]> {
  const out: Record<string, T[]> = {};
  for (const d of dates) out[d] = windows.map((w) => ({ ...w }));
  return out;
}

/** Windows on Monday-Friday only; weekends are emptied. */
export function fillWeekdays<T extends DayWindowLike>(dates: string[], windows: T[]): Record<string, T[]> {
  const out: Record<string, T[]> = {};
  for (const d of dates) out[d] = isWeekday(d) ? windows.map((w) => ({ ...w })) : [];
  return out;
}

/** "06:00-14:00, 18:00-22:00" or "Not available". */
export function summarizeWindows(windows: DayWindowLike[]): string {
  const filled = windows.filter((w) => w.from && w.to);
  if (filled.length === 0) return 'Not available';
  return filled.map((w) => `${w.from}-${w.to}`).join(', ');
}

export type AccomplishmentField = 'date' | 'text' | 'duration' | 'times' | 'general';

/** Which form field an accomplishment validation message belongs to, so it shows inline under that field. */
export function routeAccomplishmentProblem(message: string): AccomplishmentField {
  const m = message.toLowerCase();
  if (m.includes('duration')) return 'duration';
  if (m.includes('date') || m.includes('days back') || m.includes('future')) return 'date';
  if (m.includes('describe') || m.includes('characters')) return 'text';
  if (m.includes('start') || m.includes('hh:mm')) return 'times';
  return 'general';
}
