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

  let cursor = 0;
  const stops = [];
  for (const row of rows) {
    if (row.count === 0) continue;
    const startPct = (cursor / total) * 100;
    cursor += row.count;
    const endPct = (cursor / total) * 100;
    stops.push(`${row.color} ${startPct}% ${endPct}%`);
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

  const legend = document.createElement('div');
  legend.className = 'donut-chart__legend';
  for (const row of rows) {
    if (row.count === 0) continue;
    const pct = Math.round((row.count / total) * 100);
    const item = document.createElement('div');
    item.className = 'donut-chart__legend-item';
    // Dot + stacked label-over-value, matching the reference layout: the
    // percentage is the figure people actually read off a donut, so it
    // takes the emphasis and the category name becomes the caption above
    // it. The raw count stays in the title (and in the data table below)
    // rather than being dropped — a percentage alone hides how small the
    // sample is on a quiet week.
    item.title = `${row.label}: ${row.count} of ${total}`;
    item.innerHTML = `<span class="donut-chart__swatch" style="background:${row.color}"></span>`
      + `<span class="donut-chart__legend-text">`
      + `<span class="donut-chart__legend-label">${row.label}</span>`
      + `<span class="donut-chart__legend-value">${pct}%<span class="donut-chart__legend-count">${row.count}</span></span>`
      + `</span>`;
    // §4.5: hovering a legend item dims the rest of the ring (a filter on
    // the whole conic-gradient — slicing out just the other segments
    // would need per-segment DOM elements this component doesn't have)
    // and swaps the center hole to that category's own count/%.
    item.addEventListener('mouseenter', () => {
      ring.classList.add('has-highlight');
      holeTotal.textContent = String(row.count);
      holeLabel.textContent = `${row.label} (${pct}%)`;
      item.classList.add('is-active');
    });
    item.addEventListener('mouseleave', () => {
      item.classList.remove('is-active');
      showTotal();
    });
    legend.appendChild(item);
  }

  // Screen-reader-only data table — same accessible-fallback pattern as
  // TrendChart.js (§8: "any chart/graphic that conveys data has a
  // text/data-table equivalent, not color/shape alone").
  const table = document.createElement('table');
  table.className = 'sr-only';
  table.innerHTML = `<caption>Breakdown</caption><thead><tr><th scope="col">Category</th><th scope="col">Count</th></tr></thead><tbody>${
    rows.map((r) => `<tr><td>${r.label}</td><td>${r.count}</td></tr>`).join('')
  }</tbody>`;

  host.append(ring, legend, table);
  return host;
}
