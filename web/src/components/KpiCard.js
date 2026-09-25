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
 *   `description` (optional, 2026-09-05): a one-sentence definition shown
 *   in a small hover/focus card next to the label — see `Tooltip.js`.
 * @returns {HTMLElement}
 */
import { InfoTip } from './Tooltip.js';

export function KpiCard({
  label, value, emptyText = '—', icon, accent,
  delta, previousValue, trend, deltaLabel = 'vs previous period', sparkline, description,
  badgeChip, footerNote,
}) {
  const el = document.createElement('div');
  el.className = 'card kpi-card';

  const isEmpty = value === null || value === undefined;

  // Header row: icon badge on the left, delta or status chip on the right
  const header = document.createElement('div');
  header.className = 'kpi-card__header';
  if (icon) {
    header.innerHTML = `<span class="icon-badge icon-badge--kpi accent-${accent || 'blue'}">${icon(22)}</span>`;
  }

  const deltaEl = document.createElement('span');
  deltaEl.className = 'kpi-card__delta';

  if (badgeChip) {
    const chipEl = document.createElement('span');
    chipEl.className = `kpi-card__chip kpi-card__chip--${badgeChip.tone || 'neutral'}`;
    if (badgeChip.tone === 'live') {
      chipEl.innerHTML = `<span class="kpi-card__chip-dot"></span><span>${badgeChip.text}</span>`;
    } else {
      chipEl.textContent = badgeChip.text;
    }
    header.appendChild(chipEl);
  } else {
    header.appendChild(deltaEl);
  }
  el.appendChild(header);

  const valueEl = document.createElement('div');
  valueEl.className = 'kpi-card__value' + (isEmpty ? ' empty' : '');
  valueEl.textContent = isEmpty ? emptyText : String(value);

  const labelEl = document.createElement('div');
  labelEl.className = 'kpi-card__label';
  labelEl.append(label);
  if (description) labelEl.appendChild(InfoTip(description));

  el.append(valueEl, labelEl);

  if (footerNote) {
    const noteEl = document.createElement('div');
    noteEl.className = 'kpi-card__footer-note';
    noteEl.textContent = footerNote;
    el.appendChild(noteEl);
  }

  if (!isEmpty && Array.isArray(sparkline) && sparkline.length >= 2) {
    el.appendChild(buildSparkline(sparkline, accent));
  }

  const applyDelta = (d, previousValue) => {
    if (isEmpty || d === undefined || d === null) {
      deltaEl.textContent = '';
      deltaEl.className = 'kpi-card__delta';
      return;
    }
    const asPercent = typeof previousValue === 'number' && previousValue > 0
      ? Math.round((d / previousValue) * 100)
      : null;
    const sign = d > 0 ? '+' : d < 0 ? '−' : '±';
    const magnitude = Math.abs(asPercent ?? d);
    deltaEl.textContent = `${sign}${magnitude}${asPercent === null ? '' : '%'}`;
    deltaEl.title = `${sign}${Math.abs(d)} ${deltaLabel}`;

    let tone = 'neutral';
    if (d !== 0 && (trend === 'up-good' || trend === 'down-good')) {
      const isGood = trend === 'up-good' ? d > 0 : d < 0;
      tone = isGood ? 'positive' : 'negative';
    }
    deltaEl.className = `kpi-card__delta kpi-card__delta--${tone}`;
  };
  applyDelta(delta, previousValue);

  el.setDelta = applyDelta;

  return el;
}

/**
 * KpiHeroCard — Primary operational hero card combining total incident volume,
 * resolution rate progress bar, and 30-day activity trend sparkline.
 */
export function KpiHeroCard({
  label = 'Total Incidents',
  value,
  emptyText = '—',
  icon,
  accent = 'blue',
  delta,
  previousValue,
  deltaLabel = 'vs previous period',
  resolvedCount = 0,
  sparkline,
  description,
}) {
  const el = document.createElement('div');
  el.className = 'card kpi-card kpi-card--hero';

  const isEmpty = value === null || value === undefined;

  const header = document.createElement('div');
  header.className = 'kpi-card__header';
  if (icon) {
    header.innerHTML = `<span class="icon-badge icon-badge--kpi accent-${accent || 'blue'}">${icon(22)}</span>`;
  }
  const deltaEl = document.createElement('span');
  deltaEl.className = 'kpi-card__delta';
  header.appendChild(deltaEl);
  el.appendChild(header);

  const body = document.createElement('div');
  body.className = 'kpi-hero__body';

  const primaryGroup = document.createElement('div');
  primaryGroup.className = 'kpi-hero__primary';

  const valueEl = document.createElement('div');
  valueEl.className = 'kpi-card__value' + (isEmpty ? ' empty' : '');
  valueEl.textContent = isEmpty ? emptyText : String(value);

  const labelEl = document.createElement('div');
  labelEl.className = 'kpi-card__label';
  labelEl.append(label);
  if (description) labelEl.appendChild(InfoTip(description));
  primaryGroup.append(valueEl, labelEl);

  const resGroup = document.createElement('div');
  resGroup.className = 'kpi-hero__resolution';

  const totalNum = typeof value === 'number' ? value : parseInt(value, 10) || 0;
  const resNum = typeof resolvedCount === 'number' ? resolvedCount : parseInt(resolvedCount, 10) || 0;
  const ratePct = totalNum > 0 ? Math.round((resNum / totalNum) * 100) : 0;
  const pendingNum = Math.max(0, totalNum - resNum);

  const resHeader = document.createElement('div');
  resHeader.className = 'kpi-hero__res-header';
  resHeader.innerHTML = `
    <span class="kpi-hero__res-count">
      <svg width="0.875rem" height="0.875rem" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="9"/><polyline points="8 12 11 15 16 9"/></svg>
      <span>${resNum} Resolved</span>
    </span>
    <span class="kpi-hero__res-rate">${ratePct}% rate</span>
  `;

  const progBar = document.createElement('div');
  progBar.className = 'kpi-hero__progress-bar';
  progBar.innerHTML = `<div class="kpi-hero__progress-fill" style="width: ${ratePct}%"></div>`;

  const resSub = document.createElement('div');
  resSub.className = 'kpi-hero__res-sub';
  resSub.textContent = `${pendingNum} pending action or dispatch`;

  resGroup.append(resHeader, progBar, resSub);
  body.append(primaryGroup, resGroup);
  el.appendChild(body);

  if (!isEmpty && Array.isArray(sparkline) && sparkline.length >= 2) {
    el.appendChild(buildSparkline(sparkline, accent));
  }

  const applyDelta = (d, previousValue) => {
    if (isEmpty || d === undefined || d === null) {
      deltaEl.textContent = '';
      deltaEl.className = 'kpi-card__delta';
      return;
    }
    const asPercent = typeof previousValue === 'number' && previousValue > 0
      ? Math.round((d / previousValue) * 100)
      : null;
    const sign = d > 0 ? '+' : d < 0 ? '−' : '±';
    const magnitude = Math.abs(asPercent ?? d);
    deltaEl.textContent = `${sign}${magnitude}${asPercent === null ? '' : '%'}`;
    deltaEl.title = `${sign}${Math.abs(d)} ${deltaLabel}`;

    let tone = 'neutral';
    if (d !== 0) {
      tone = d > 0 ? 'neutral' : 'positive';
    }
    deltaEl.className = `kpi-card__delta kpi-card__delta--${tone}`;
  };
  applyDelta(delta, previousValue);

  const applyResolvedDelta = (d, prevResolved) => {
    if (d === undefined || d === null) return;
    const sign = d > 0 ? '+' : d < 0 ? '−' : '±';
    const asPercent = typeof prevResolved === 'number' && prevResolved > 0
      ? Math.round((d / prevResolved) * 100)
      : null;
    const mag = Math.abs(asPercent ?? d);
    let deltaPill = resHeader.querySelector('.kpi-hero__res-delta');
    if (!deltaPill) {
      deltaPill = document.createElement('span');
      deltaPill.className = 'kpi-hero__res-delta';
      resHeader.insertBefore(deltaPill, resHeader.querySelector('.kpi-hero__res-rate'));
    }
    deltaPill.textContent = `${sign}${mag}${asPercent === null ? '' : '%'}`;
    deltaPill.title = `${sign}${Math.abs(d)} resolved vs previous period`;
  };

  el.setDelta = applyDelta;
  el.setResolvedDelta = applyResolvedDelta;

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
  const pointCoords = values.map((v, i) => {
    const x = i * stepX;
    const y = height - ((v - min) / range) * (height - 8) - 4;
    return { x, y, v, i };
  });
  const points = pointCoords.map((p) => `${p.x.toFixed(2)},${p.y.toFixed(2)}`).join(' ');

  const circlesHtml = pointCoords
    .map((p) => `<circle cx="${p.x.toFixed(2)}" cy="${p.y.toFixed(2)}" r="3" class="kpi-card__sparkline-point"><title>Day ${p.i + 1}: ${p.v}</title></circle>`)
    .join('');

  const wrap = document.createElement('div');
  wrap.className = 'kpi-card__sparkline';
  wrap.innerHTML = `<svg viewBox="0 0 ${width} ${height}" preserveAspectRatio="none" role="img" aria-label="Trend sparkline"><polyline points="${points}" class="kpi-card__sparkline-line kpi-card__sparkline-line--${accent || 'blue'}" fill="none" />${circlesHtml}</svg>`;
  return wrap;
}
