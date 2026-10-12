/**
 * rosterWindow.js - date-window helpers for the roster screens (Scheduler,
 * Swap requests, Approvals). `GET /shifts` is ordered oldest-first and capped
 * at 100 rows per page, so an unbounded request hides the shifts being
 * planned once a barangay has more than 100 (audit 2026-10-09 F-09 / R-02).
 * Every roster screen therefore asks for an explicit Manila-date window
 * (`from` / `to`, both inclusive, supported by the server) and walks the
 * pages of that window.
 */

const PAGE_LIMIT = 100;
const MAX_PAGES = 10;

function pad(n) {
  return String(n).padStart(2, '0');
}

/** `YYYY-MM-DD` shifted by whole days, calendar maths in UTC (no DST in Manila). */
export function addDays(date, days) {
  const [y, m, d] = date.split('-').map(Number);
  const t = new Date(Date.UTC(y, m - 1, d + days));
  return `${t.getUTCFullYear()}-${pad(t.getUTCMonth() + 1)}-${pad(t.getUTCDate())}`;
}

/**
 * Walks every page of a list endpoint (up to MAX_PAGES x 100 rows).
 * `fetchPage({page, limit})` returns `{items, total}`.
 * @returns {Promise<{items:Array, total:number, truncated:boolean}>}
 */
export async function fetchAllPages(fetchPage) {
  const items = [];
  let total = 0;
  for (let page = 1; page <= MAX_PAGES; page++) {
    const res = await fetchPage({ page, limit: PAGE_LIMIT });
    items.push(...res.items);
    total = res.total ?? items.length;
    if (items.length >= total || res.items.length === 0) break;
  }
  return { items, total, truncated: items.length < total };
}
