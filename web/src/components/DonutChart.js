/**
 * DonutChart — donut/pie rendering for a category breakdown (§8 "Adopted
 * UI reference": "a donut/pie rendering of by_incident_type is an
 * acceptable visual upgrade of the existing breakdown card, same data, no
 * API change"). Pure CSS `conic-gradient` on a ring div — no charting
 * library (§1 stack has no bundler/npm install step, same reasoning as
 * TrendChart.js's hand-rolled bars).
 *
 * Renders exactly the {label, count, color}[] rows it's given — never
 * invents categories or drops zero-count ones, same "never invent a
 * client-side data shape" rule TrendChart.js follows for trend[].
 *
 * @param {{rows: Array<{key:string, label:string, count:number, color:string}>}} props
 * @returns {HTMLElement}
 */
export function DonutChart({ rows }) {
  const host = document.createElement('div');
  const total = rows.reduce((sum, r) => sum + r.count, 0);

  if (total === 0) {
    host.className = 'donut-chart__empty';
    host.textContent = 'No data in this range.';
    return host;
  }

  host.className = 'donut-chart';

  const ring = document.createElement('div');
  ring.className = 'donut-chart__ring';
  ring.setAttribute('role', 'img');
  ring.setAttribute(
    'aria-label',
    `Breakdown: ${rows.filter((r) => r.count > 0).map((r) => `${r.label} ${Math.round((r.count / total) * 100)}%`).join(', ')}`
  );

  // Each segment's [startFrac, endFrac) of the full circle (0..1, matching
  // the conic-gradient's own 0%..100% winding: 0 = 12 o'clock, clockwise) —
  // kept alongside the gradient stops so the ring's own mousemove handler
  // below can work out which row is under the cursor without re-deriving
  // the same math from the rendered background.
  let cursor = 0;
  const stops = [];
  const segments = [];
  for (const row of rows) {
    if (row.count === 0) continue;
    const startFrac = cursor / total;
    cursor += row.count;
    const endFrac = cursor / total;
    stops.push(`${row.color} ${startFrac * 100}% ${endFrac * 100}%`);
    segments.push({ row, startFrac, endFrac });
  }
  ring.style.background = `conic-gradient(${stops.join(', ')})`;

  const holeTotal = document.createElement('span');
  holeTotal.className = 'donut-chart__total';
  holeTotal.textContent = String(total);
  const holeLabel = document.createElement('span');
  holeLabel.className = 'donut-chart__total-label';
  holeLabel.textContent = 'total';
  const hole = document.createElement('div');
  hole.className = 'donut-chart__hole';
  hole.append(holeTotal, holeLabel);
  ring.appendChild(hole);
  // Restores the total view — shared by every legend item's mouseleave
  // and by the ring's own mouseleave (covers a fast mouse pass that skips
  // a discrete legend-item boundary).
  const showTotal = () => {
    ring.classList.remove('has-highlight');
    holeTotal.textContent = String(total);
    holeLabel.textContent = 'total';
  };
  ring.addEventListener('mouseleave', showTotal);

  // Single floating tooltip, moved/relabelled per hovered segment rather
  // than one per row — the ring itself has no per-segment DOM (one
  // conic-gradient), so its own mousemove handler below needs a tooltip it
  // can reposition freely, unlike the legend items' CSS-anchored ones.
  const ringTip = document.createElement('div');
  ringTip.className = 'donut-chart__ring-tip';
  ringTip.hidden = true;
  ring.appendChild(ringTip);

  const legendItemByKey = new Map();
  const legend = document.createElement('div');
  legend.className = 'donut-chart__legend';
  for (const row of rows) {
    if (row.count === 0) continue;
    const pct = Math.round((row.count / total) * 100);
    // A real <button>, not a <div> — the tooltip panel below is only
    // reachable by keyboard (Tab + :focus-within) if the trigger is
    // focusable, same reasoning as Tooltip.js's InfoTip trigger.
    const item = document.createElement('button');
    item.type = 'button';
    item.className = 'donut-chart__legend-item';
    // Label only, per the 2026-09-06 UX pass — the percentage and raw
    // count moved into the hover/focus tooltip panel (below) so a quiet
    // week's small numbers don't visually compete with the category name,
    // and so this list can run two-up without each row needing room for a
    // figure as well as a label.
    item.innerHTML = `<span class="donut-chart__swatch" style="background:${row.color}"></span>`
      + `<span class="donut-chart__legend-label">${row.label}</span>`
      + `<span class="donut-chart__legend-tip" role="tooltip">${pct}% <span class="donut-chart__legend-tip-count">(${row.count} of ${total})</span></span>`;
    // §4.5: hovering/focusing a legend item dims the rest of the ring (a
    // filter on the whole conic-gradient — slicing out just the other
    // segments would need per-segment DOM elements this component
    // doesn't have) and swaps the center hole to that category's own
    // count/%. Keyboard focus gets the identical behavior via
    // focus/blur, not just mouseenter/mouseleave.
    const activate = () => {
      ring.classList.add('has-highlight');
      holeTotal.textContent = String(row.count);
      holeLabel.textContent = `${row.label} (${pct}%)`;
      item.classList.add('is-active');
    };
    const deactivate = () => {
      item.classList.remove('is-active');
      showTotal();
    };
    item.addEventListener('mouseenter', activate);
    item.addEventListener('mouseleave', deactivate);
    item.addEventListener('focus', activate);
    item.addEventListener('blur', deactivate);
    legend.appendChild(item);
    legendItemByKey.set(row.key, item);
  }

  // Hovering the ring's colored arc itself (not just its legend row) shows
  // the same percentage/count, following the cursor — added 2026-09-06 so
  // "hover the graph" works on the visual the user is actually pointing at,
  // not only the list beside it. Angle math: conic-gradient's 0% starts at
  // 12 o'clock and winds clockwise, so `atan2(dx, -dy)` (not the usual
  // `atan2(dy, dx)`) gives that same 0..2π convention directly.
  const HOLE_RADIUS_RATIO = 0.68; // matches .donut-chart__hole's CSS inset, both breakpoints
  ring.addEventListener('mousemove', (event) => {
    const rect = ring.getBoundingClientRect();
    const radius = rect.width / 2;
    const dx = event.clientX - (rect.left + radius);
    const dy = event.clientY - (rect.top + radius);
    const distFrac = Math.sqrt(dx * dx + dy * dy) / radius;
    if (distFrac < HOLE_RADIUS_RATIO || distFrac > 1) {
      ringTip.hidden = true;
      return;
    }
    const angleFrac = (Math.atan2(dx, -dy) / (2 * Math.PI) + 1) % 1;
    const hit = segments.find((s) => angleFrac >= s.startFrac && angleFrac < s.endFrac);
    if (!hit) {
      ringTip.hidden = true;
      return;
    }
    const pct = Math.round((hit.row.count / total) * 100);
    ringTip.textContent = `${hit.row.label}: ${pct}% (${hit.row.count})`;
    ringTip.style.left = `${event.clientX - rect.left}px`;
    ringTip.style.top = `${event.clientY - rect.top}px`;
    ringTip.hidden = false;
    for (const [key, el] of legendItemByKey) el.classList.toggle('is-active', key === hit.row.key);
    ring.classList.add('has-highlight');
    holeTotal.textContent = String(hit.row.count);
    holeLabel.textContent = `${hit.row.label} (${pct}%)`;
  });
  ring.addEventListener('mouseleave', () => {
    ringTip.hidden = true;
    for (const el of legendItemByKey.values()) el.classList.remove('is-active');
  });

  // Screen-reader-only data table — same accessible-fallback pattern as
  // TrendChart.js (§8: "any chart/graphic that conveys data has a
  // text/data-table equivalent, not color/shape alone").
  //
  // `.sr-only` goes on a wrapper div, not the `<table>` — a `<table>`
  // ignores an explicit width/height smaller than its content (default
  // `table-layout: auto`), so it still lays out at its full natural size
  // even while visually clipped, which was inflating the page's
  // scrollable area (confirmed: a 11-row table here rendering at ~300px
  // instead of 1px). A `<div>` has no such quirk and correctly clips an
  // oversized child via its own `overflow: hidden`.
  const tableWrap = document.createElement('div');
  tableWrap.className = 'sr-only';
  const table = document.createElement('table');
  table.innerHTML = `<caption>Breakdown</caption><thead><tr><th scope="col">Category</th><th scope="col">Count</th></tr></thead><tbody>${
    rows.map((r) => `<tr><td>${r.label}</td><td>${r.count}</td></tr>`).join('')
  }</tbody>`;
  tableWrap.appendChild(table);

  host.append(ring, legend, tableWrap);
  return host;
}
