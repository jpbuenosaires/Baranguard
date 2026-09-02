/**
 * KpiCard — one KPI tile for W2 Admin Dashboard (§9). PascalCase per §4
 * component-file convention. No framework: this is a plain function that
 * returns a DOM node, not a class/JSX component.
 *
 * The Figma export's AdminDashboard.tsx gives every KPI card its own
 * colored icon badge (Bell/blue, CheckCircle/green, Clock/orange,
 * Users/teal) rather than a plain text tile — `icon`/`accent` reproduce
 * that; both are optional so a caller can still render a bare KPI card.
 *
 * @param {{label:string, value:number|string|null, emptyText?:string, icon?:(size:number)=>string, accent?:'blue'|'green'|'orange'|'teal', delta?:number|null, deltaLabel?:string}} props
 *   `value === null` renders the empty state text instead of a number —
 *   used for avg_response_time_minutes when no incident in range reached
 *   `arrived` (a real 0 and "no data" must look different to the user,
 *   same reasoning as the API contract itself).
 *   `delta` (optional): a caller-computed difference vs. a prior period
 *   (e.g. previous equal-length date range) — rendered as a small "+2"/
 *   "-1"/"±0" line under the value. Deliberately unstyled as good/bad
 *   (no green/red) since a KPI like "Total Incidents" going up isn't
 *   inherently positive or negative. Omit `delta` entirely (not `null`)
 *   for a KPI with no meaningful period-over-period comparison, e.g. a
 *   live snapshot like Tanods On Duty.
 * @returns {HTMLElement}
 */
export function KpiCard({ label, value, emptyText = '—', icon, accent, delta, deltaLabel = 'vs previous period' }) {
  const el = document.createElement('div');
  el.className = 'card kpi-card';

  if (icon) {
    const header = document.createElement('div');
    header.className = 'kpi-card__header';
    header.innerHTML = `<span class="icon-badge icon-badge--kpi accent-${accent || 'blue'}">${icon(22)}</span>`;
    el.appendChild(header);
  }

  const labelEl = document.createElement('div');
  labelEl.className = 'label kpi-card__label';
  labelEl.textContent = label;

  const valueEl = document.createElement('div');
  const isEmpty = value === null || value === undefined;
  valueEl.className = 'kpi-card__value' + (isEmpty ? ' empty' : '');
  valueEl.textContent = isEmpty ? emptyText : String(value);

  el.append(labelEl, valueEl);

  if (!isEmpty && delta !== undefined && delta !== null) {
    const deltaEl = document.createElement('div');
    deltaEl.className = 'kpi-card__delta';
    const sign = delta > 0 ? '+' : delta < 0 ? '' : '±';
    deltaEl.textContent = `${sign}${delta} ${deltaLabel}`;
    el.appendChild(deltaEl);
  }

  return el;
}
