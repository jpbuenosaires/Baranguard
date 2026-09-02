/**
 * StatStrip — the inline count row the Figma reference puts directly
 * under (or beside) a page title: a big coloured number with a small
 * grey label, repeated a few times. Used on Dispatch Center
 * ("12 Online · 3 Dispatched · 2 Pending"), User Management
 * ("8 Total Users · 6 Active · …") and the Blotter/SMS screens.
 *
 * Every value passed in must come from real data — this component just
 * lays out whatever counts the caller computed; it never invents totals.
 *
 * @param {{items: Array<{label:string, value:number|string, tone?:'default'|'success'|'warning'|'critical'|'info'}>}} props
 * @returns {HTMLElement}
 */
export function StatStrip({ items }) {
  const el = document.createElement('div');
  el.className = 'stat-strip';

  for (const item of items) {
    const cell = document.createElement('div');
    cell.className = 'stat-strip__item';

    const value = document.createElement('span');
    value.className = 'stat-strip__value' + (item.tone && item.tone !== 'default' ? ` tone-${item.tone}` : '');
    value.textContent = String(item.value);

    const label = document.createElement('span');
    label.className = 'stat-strip__label';
    label.textContent = item.label;

    cell.append(value, label);
    el.appendChild(cell);
  }

  return el;
}
