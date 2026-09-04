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
 * @param {{label:string, value:number|string|null, emptyText?:string, icon?:(size:number)=>string, accent?:'blue'|'green'|'orange'|'teal', delta?:number|null, deltaLabel?:string, sparkline?:number[]}} props
 *   `value === null` renders the empty state text instead of a number —
 *   used for avg_response_time_minutes when no incident in range reached
 *   `arrived` (a real 0 and "no data" must look different to the user,
 *   same reasoning as the API contract itself).
 *   `delta` (optional): a caller-computed difference vs. a prior period
 *   (e.g. previous equal-length date range), shown top-right of the card.
 *   `previousValue` (optional) turns it into a percentage; without it the
 *   raw difference is shown, because a prior period of zero has no
 *   meaningful percentage. Omit `delta` entirely (not `null`) for a KPI
 *   with no meaningful period-over-period comparison, e.g. a live
 *   snapshot like Tanods On Duty.
 *   `trend` (optional): `'up-good'` or `'down-good'` — which DIRECTION is
 *   good for this particular metric, used to colour the delta. Omit it for
 *   a metric with no inherent good direction and the delta stays neutral.
 *   The supplied reference tints "+12% Total Incidents" green; more
 *   incidents is not good news, and colouring it so would encode a
 *   judgement the data doesn't support — hence per-metric rather than a
 *   blanket green-up/red-down rule.
 *   `sparkline` (optional, §4.4 of the UI/UX review): a raw per-day count
 *   series, oldest first — rendered as a small inline SVG polyline under
 *   the value. Omit it (not an empty array) for a KPI with no matching
 *   real series behind it: `admin-dashboard.js`'s `summary.trend` counts
 *   incidents CREATED per day, which genuinely describes "Total
 *   Incidents" but does NOT describe "Resolved" (a day's resolved count
 *   isn't what that series measures) — so only Total Incidents gets one,
 *   never a sparkline built from data that doesn't actually match the
 *   number it's attached to.
 * @returns {HTMLElement}
 */
export function KpiCard({
  label, value, emptyText = '—', icon, accent,
  delta, previousValue, trend, deltaLabel = 'vs previous period', sparkline,
}) {
  const el = document.createElement('div');
  el.className = 'card kpi-card';

  const isEmpty = value === null || value === undefined;

  // Header row: icon badge on the left, delta on the right — the card
  // convention from the supplied reference. Always built (even without an
  // icon) so the delta has a stable place to land when it arrives a
  // request later than the rest of the card.
  const header = document.createElement('div');
  header.className = 'kpi-card__header';
  if (icon) {
    header.innerHTML = `<span class="icon-badge icon-badge--kpi accent-${accent || 'blue'}">${icon(22)}</span>`;
  }
  const deltaEl = document.createElement('span');
  deltaEl.className = 'kpi-card__delta';
  header.appendChild(deltaEl);
  el.appendChild(header);

  const valueEl = document.createElement('div');
  valueEl.className = 'kpi-card__value' + (isEmpty ? ' empty' : '');
  valueEl.textContent = isEmpty ? emptyText : String(value);

  const labelEl = document.createElement('div');
  labelEl.className = 'kpi-card__label';
  labelEl.textContent = label;

  // Value above label, per the reference — the figure is what the eye
  // should land on first, the label is its caption.
  el.append(valueEl, labelEl);

  if (!isEmpty && Array.isArray(sparkline) && sparkline.length >= 2) {
    el.appendChild(buildSparkline(sparkline, accent));
  }

  const applyDelta = (d, previousValue) => {
    if (isEmpty || d === undefined || d === null) {
      deltaEl.textContent = '';
      deltaEl.className = 'kpi-card__delta';
      return;
    }
    // Percentage where a prior figure is known, absolute otherwise. A
    // prior period of zero has no percentage (division by zero is not
    // "+100%"), so those fall back to the raw difference.
    const asPercent = typeof previousValue === 'number' && previousValue > 0
      ? Math.round((d / previousValue) * 100)
      : null;
    const sign = d > 0 ? '+' : d < 0 ? '−' : '±';
    const magnitude = Math.abs(asPercent ?? d);
    deltaEl.textContent = `${sign}${magnitude}${asPercent === null ? '' : '%'}`;
    deltaEl.title = `${sign}${Math.abs(d)} ${deltaLabel}`;

    // Colour by the metric's OWN good direction, not blanket green-up.
    // The reference tints "+12% Total Incidents" green; more incidents is
    // not good news, and colouring it so would encode a judgement the
    // data doesn't support. `trend` is passed by the caller as
    // 'up-good' | 'down-good' | omitted for genuinely neutral metrics.
    let tone = 'neutral';
    if (d !== 0 && (trend === 'up-good' || trend === 'down-good')) {
      const isGood = trend === 'up-good' ? d > 0 : d < 0;
      tone = isGood ? 'positive' : 'negative';
    }
    deltaEl.className = `kpi-card__delta kpi-card__delta--${tone}`;
  };
  applyDelta(delta, previousValue);

  // audit W2: the dashboard used to REPLACE this whole card once the
  // previous-period request resolved, which made both delta-bearing cards
  // visibly blink after the page had already settled. Exposing a mutator
  // lets the caller fill the delta in place on the node that is already
  // on screen.
  el.setDelta = applyDelta;

  return el;
}


/**
 * §4.4 — a minimal inline SVG polyline, no charting library (same
 * hand-rolled approach TrendChart.js/DonutChart.js already use). Values
 * are normalized to the SVG's own 0-100 viewBox range, not to real
 * pixels, so the line always fills the box regardless of the actual
 * count magnitude.
 */
function buildSparkline(values, accent) {
  const width = 100;
  const height = 28;
  const max = Math.max(...values);
  const min = Math.min(...values);
  const range = max - min || 1; // avoid divide-by-zero on a flat series.
  const stepX = width / (values.length - 1);
  const points = values
    .map((v, i) => {
      const x = i * stepX;
      const y = height - ((v - min) / range) * height;
      return `${x.toFixed(2)},${y.toFixed(2)}`;
    })
    .join(' ');

  const wrap = document.createElement('div');
  wrap.className = 'kpi-card__sparkline';
  // aria-hidden — the real number is already announced by the value
  // element above; a sparkline is a supplementary visual trend cue, not
  // information that exists nowhere else.
  wrap.innerHTML = `<svg viewBox="0 0 ${width} ${height}" preserveAspectRatio="none" aria-hidden="true"><polyline points="${points}" class="kpi-card__sparkline-line kpi-card__sparkline-line--${accent || 'blue'}" fill="none" /></svg>`;
  return wrap;
}
