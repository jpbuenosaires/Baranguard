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
 * @param {{label:string, value:number|string|null, emptyText?:string, icon?:(size:number)=>string, accent?:'blue'|'green'|'orange'|'teal'}} props
 *   `value === null` renders the empty state text instead of a number —
 *   used for avg_response_time_minutes when no incident in range reached
 *   `arrived` (a real 0 and "no data" must look different to the user,
 *   same reasoning as the API contract itself).
 * @returns {HTMLElement}
 */
export function KpiCard({ label, value, emptyText = '—', icon, accent }) {
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
  return el;
}
