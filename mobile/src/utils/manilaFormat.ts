/** Asia/Manila (fixed +08:00, no DST) date and time text, independent of the phone's timezone. */

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

/** "Oct 13, 9:35 PM" for an ISO timestamp; '' when it cannot be parsed. */
export function formatManilaDateTime(iso: string | null | undefined): string {
  if (!iso) return '';
  const ms = new Date(iso).getTime();
  if (Number.isNaN(ms)) return '';
  const d = new Date(ms + 8 * 3600_000);
  const h24 = d.getUTCHours();
  const h12 = h24 % 12 === 0 ? 12 : h24 % 12;
  const mm = String(d.getUTCMinutes()).padStart(2, '0');
  return `${MONTHS[d.getUTCMonth()]} ${d.getUTCDate()}, ${h12}:${mm} ${h24 < 12 ? 'AM' : 'PM'}`;
}

/** "Updated 14:05" line for the dispatches list; null before the first successful load. */
export function updatedLine(lastLoadedMs: number | null): string | null {
  if (lastLoadedMs === null) return null;
  const d = new Date(lastLoadedMs + 8 * 3600_000);
  const hh = String(d.getUTCHours()).padStart(2, '0');
  const mm = String(d.getUTCMinutes()).padStart(2, '0');
  return `Updated ${hh}:${mm}`;
}
