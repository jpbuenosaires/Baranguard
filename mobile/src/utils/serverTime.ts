/**
 * The API stores and returns UTC timestamps. Some endpoints send the raw database form
 * ("2026-10-15 04:47:01", no zone), which `new Date()` would read as the phone's LOCAL time
 * (8 hours wrong in Manila). This turns that form into an ISO string with `Z`, anywhere in a
 * parsed JSON payload. Values that already carry a zone, and plain dates, are left alone.
 */
const ZONELESS_DATETIME = /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}(\.\d+)?$/;

export function toUtcIso(value: string): string {
  return ZONELESS_DATETIME.test(value) ? `${value.replace(' ', 'T')}Z` : value;
}

export function normalizeServerTimestamps<T>(payload: T): T {
  if (typeof payload === 'string') return toUtcIso(payload) as unknown as T;
  if (Array.isArray(payload)) return payload.map((v) => normalizeServerTimestamps(v)) as unknown as T;
  if (payload && typeof payload === 'object') {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(payload as Record<string, unknown>)) out[k] = normalizeServerTimestamps(v);
    return out as T;
  }
  return payload;
}
