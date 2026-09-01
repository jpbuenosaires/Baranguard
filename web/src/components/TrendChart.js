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
  const wrapper = document.createElement('div');

  if (!trend || trend.length === 0) {
    wrapper.className = 'trend-chart__empty-row';
    return wrapper;
  }

  const max = Math.max(1, ...trend.map((row) => row.count));

  wrapper.className = 'trend-chart';
  for (const row of trend) {
    const bar = document.createElement('div');
    bar.className = 'trend-chart__bar';
    const heightPct = row.count === 0 ? 0.5 : (row.count / max) * 100;
    bar.style.height = `${heightPct}%`;
    bar.title = `${row.date}: ${row.count} incident${row.count === 1 ? '' : 's'}`;
    wrapper.appendChild(bar);
  }

  return wrapper;
}
