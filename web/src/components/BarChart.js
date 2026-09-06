/**
 * BarChart — single-series vertical bar chart, built for W9 Analytics'
 * "incidents by hour of day" (Phase 9 of the mockup-driven UI round 2 —
 * see .claude/plans/clever-wishing-hummingbird.md). Hand-rolled inline
 * SVG, no charting library, following `LineChart.js`'s established
 * pattern exactly (§1's stack has no bundler to pull one in with).
 *
 * Hover tooltips are native SVG `<title>` elements on each bar — the same
 * mechanism `LineChart.js`'s point markers and `DonutChart.js`'s legend
 * items already use, rather than a separate hand-positioned tooltip
 * component. A dedicated `ChartTooltip` component was in the original
 * plan; reusing the pattern already proven twice in this codebase gets
 * the same real hover information (exact value per bar) without a new,
 * fourth component doing the same job a native browser feature already
 * does for free.
 *
 * @param {{
 *   bars: Array<{label:string, value:number}>,
 *   colorVar?: string,
 *   caption?: string,
 * }} props
 * @returns {HTMLElement}
 */

const VIEW_W = 720;
const VIEW_H = 220;
const PAD = { top: 14, right: 10, bottom: 32, left: 34 };

function readToken(name, fallback) {
  const v = getComputedStyle(document.documentElement).getPropertyValue(name).trim();
  return v || fallback;
}

function niceMax(max) {
  if (max <= 4) return 4;
  const pow = Math.pow(10, Math.floor(Math.log10(max)));
  for (const step of [1, 2, 2.5, 5, 10]) {
    const candidate = step * pow;
    if (candidate >= max) return candidate;
  }
  return 10 * pow;
}

export function BarChart({ bars, colorVar = '--chart-line-1', caption }) {
  const host = document.createElement('div');

  if (!bars || bars.length === 0) {
    host.className = 'bar-chart__empty';
    host.textContent = 'No data in this range.';
    return host;
  }

  host.className = 'bar-chart';

  const gridColor = readToken('--chart-grid', '#E2E8F0');
  const axisColor = readToken('--chart-axis-text', '#64748B');
  const barColor = readToken(colorVar, '#2563EB');

  const yMax = niceMax(Math.max(1, ...bars.map((b) => b.value)));
  const plotW = VIEW_W - PAD.left - PAD.right;
  const plotH = VIEW_H - PAD.top - PAD.bottom;
  const slot = plotW / bars.length;
  const barWidth = Math.max(2, slot * 0.6);
  const y = (v) => PAD.top + plotH - (v / yMax) * plotH;

  const svgNS = 'http://www.w3.org/2000/svg';
  const svg = document.createElementNS(svgNS, 'svg');
  svg.setAttribute('viewBox', `0 0 ${VIEW_W} ${VIEW_H}`);
  svg.setAttribute('preserveAspectRatio', 'none');
  svg.setAttribute('class', 'bar-chart__svg');
  // The accessible equivalent is the data table below.
  svg.setAttribute('aria-hidden', 'true');

  const TICKS = 4;
  const yAxis = document.createElement('div');
  yAxis.className = 'bar-chart__y-axis';
  for (let t = 0; t <= TICKS; t += 1) {
    const value = (yMax / TICKS) * t;
    const yy = y(value);
    const line = document.createElementNS(svgNS, 'line');
    line.setAttribute('x1', String(PAD.left));
    line.setAttribute('x2', String(VIEW_W - PAD.right));
    line.setAttribute('y1', String(yy));
    line.setAttribute('y2', String(yy));
    line.setAttribute('stroke', gridColor);
    line.setAttribute('stroke-width', '1');
    line.setAttribute('vector-effect', 'non-scaling-stroke');
    if (t > 0) line.setAttribute('stroke-dasharray', '3 4');
    svg.appendChild(line);

    const yLabel = document.createElement('span');
    yLabel.className = 'bar-chart__y-label';
    yLabel.style.top = `${(yy / VIEW_H) * 100}%`;
    yLabel.textContent = String(Math.round(value));
    yAxis.appendChild(yLabel);
  }

  // At most 8 x-axis labels — 24 hourly bars all labelled would collide.
  const maxLabels = 8;
  const labelStep = Math.max(1, Math.ceil(bars.length / maxLabels));
  const xAxis = document.createElement('div');
  xAxis.className = 'bar-chart__x-axis';

  bars.forEach((bar, i) => {
    const cx = PAD.left + i * slot + slot / 2;
    const barHeight = (bar.value / yMax) * plotH;
    const rect = document.createElementNS(svgNS, 'rect');
    rect.setAttribute('x', String(cx - barWidth / 2));
    rect.setAttribute('y', String(PAD.top + plotH - barHeight));
    rect.setAttribute('width', String(barWidth));
    rect.setAttribute('height', String(Math.max(0, barHeight)));
    rect.setAttribute('fill', barColor);
    rect.setAttribute('rx', '2');
    const title = document.createElementNS(svgNS, 'title');
    title.textContent = `${bar.label}: ${bar.value}`;
    rect.appendChild(title);
    svg.appendChild(rect);

    if (i % labelStep === 0 || i === bars.length - 1) {
      const xLabel = document.createElement('span');
      xLabel.className = 'bar-chart__x-label';
      xLabel.style.left = `${(cx / VIEW_W) * 100}%`;
      xLabel.textContent = bar.label;
      xAxis.appendChild(xLabel);
    }
  });

  const plot = document.createElement('div');
  plot.className = 'bar-chart__plot';
  plot.append(svg, yAxis, xAxis);
  host.appendChild(plot);

  // `.sr-only` goes on a wrapper div, not the `<table>` — see LineChart.js's
  // matching fix for why a `<table>` itself ignores an explicit
  // width/height smaller than its content (a real bug this exact pattern
  // caused: a 24-row table rendering at ~605px instead of 1px, inflating
  // the page's scrollable area even though it was visually clipped).
  const tableWrap = document.createElement('div');
  tableWrap.className = 'sr-only';
  const table = document.createElement('table');
  table.innerHTML = `<caption>${caption ?? 'Bar chart'}</caption>`
    + `<thead><tr><th scope="col">Label</th><th scope="col">Value</th></tr></thead>`
    + `<tbody>${bars.map((b) => `<tr><td>${b.label}</td><td>${b.value}</td></tr>`).join('')}</tbody>`;
  tableWrap.appendChild(table);
  host.appendChild(tableWrap);

  return host;
}
