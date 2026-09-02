/**
 * TrendChart — bar chart for W2's trend[] series (§9: "the chart never
 * invents a client-side data shape" — it renders exactly the
 * {date, count} rows GET /reports/summary returns, in the order given,
 * one bar per entry). Hand-rolled with plain divs; no charting library
 * (§1 stack has no framework/bundler, and one bar chart doesn't justify
 * adding an external dependency).
 *
 * @param {{trend: Array<{date:string, count:number}>}} props
 * @returns {HTMLElement}
 */
export function TrendChart({ trend }) {
  const host = document.createElement('div');

  if (!trend || trend.length === 0) {
    host.className = 'trend-chart__empty-row';
    return host;
  }

  const max = Math.max(1, ...trend.map((row) => row.count));

  const wrapper = document.createElement('div');
  wrapper.className = 'trend-chart';
  wrapper.setAttribute('role', 'img');
  wrapper.setAttribute(
    'aria-label',
    `Incident trend from ${trend[0].date} to ${trend[trend.length - 1].date}: ${trend.map((r) => `${r.date} ${r.count}`).join(', ')}`
  );
  for (const row of trend) {
    const bar = document.createElement('div');
    bar.className = 'trend-chart__bar';
    const heightPct = row.count === 0 ? 0.5 : (row.count / max) * 100;
    bar.style.height = `${heightPct}%`;
    bar.title = `${row.date}: ${row.count} incident${row.count === 1 ? '' : 's'}`;
    wrapper.appendChild(bar);
  }

  // §chart Accessibility Notes: "Visible data table plus concise trend
  // summary" as the a11y fallback for a bar/line chart — kept as a
  // screen-reader-only table (not visible) so the visual chart stays
  // exactly as designed, per this pass's "same visual language" scope.
  const table = document.createElement('table');
  table.className = 'sr-only';
  table.innerHTML = `<caption>Incident trend by day</caption><thead><tr><th scope="col">Date</th><th scope="col">Incidents</th></tr></thead><tbody>${
    trend.map((row) => `<tr><td>${row.date}</td><td>${row.count}</td></tr>`).join('')
  }</tbody>`;

  host.append(wrapper, table);
  return host;
}
