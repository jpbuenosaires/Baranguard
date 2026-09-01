/**
 * KpiCard — one KPI tile for W2 Admin Dashboard (§9). PascalCase per §4
 * component-file convention. No framework: this is a plain function that
 * returns a DOM node, not a class/JSX component.
 *
 * @param {{label:string, value:number|string|null, emptyText?:string}} props
 *   `value === null` renders the empty state text instead of a number —
 *   used for avg_response_time_minutes when no incident in range reached
 *   `arrived` (a real 0 and "no data" must look different to the user,
 *   same reasoning as the API contract itself).
 * @returns {HTMLElement}
 */
export function KpiCard({ label, value, emptyText = '—' }) {
  const el = document.createElement('div');
  el.className = 'card';

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
