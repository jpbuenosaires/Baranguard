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
const PAD = { top: 14, right: 10, bottom: 26, left: 34 };

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
    if (t > 0) line.setAttribute('stroke-dasharray', '3 4');
    svg.appendChild(line);

    const text = document.createElementNS(svgNS, 'text');
    text.setAttribute('x', String(PAD.left - 8));
    text.setAttribute('y', String(yy + 4));
    text.setAttribute('text-anchor', 'end');
    text.setAttribute('font-size', '11');
    text.setAttribute('fill', axisColor);
    text.textContent = String(Math.round(value));
    svg.appendChild(text);
  }

  // At most 8 x-axis labels — 24 hourly bars all labelled would collide.
  const maxLabels = 8;
  const labelStep = Math.max(1, Math.ceil(bars.length / maxLabels));

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
      const text = document.createElementNS(svgNS, 'text');
      text.setAttribute('x', String(cx));
      text.setAttribute('y', String(VIEW_H - PAD.bottom + 16));
      text.setAttribute('text-anchor', 'middle');
      text.setAttribute('font-size', '10');
      text.setAttribute('fill', axisColor);
      text.textContent = bar.label;
      svg.appendChild(text);
    }
  });

  const plot = document.createElement('div');
  plot.className = 'bar-chart__plot';
  plot.appendChild(svg);
  host.appendChild(plot);

  const table = document.createElement('table');
  table.className = 'sr-only';
  table.innerHTML = `<caption>${caption ?? 'Bar chart'}</caption>`
    + `<thead><tr><th scope="col">Label</th><th scope="col">Value</th></tr></thead>`
    + `<tbody>${bars.map((b) => `<tr><td>${b.label}</td><td>${b.value}</td></tr>`).join('')}</tbody>`;
  host.appendChild(table);

  return host;
}
