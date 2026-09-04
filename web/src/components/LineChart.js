/**
 * LineChart — multi-series line chart for W2's trend[] (replaces the
 * earlier bar-only TrendChart; see that file's own note).
 *
 * Renders exactly the series it is given, in the order given, one point
 * per entry — the same "never invent a client-side data shape" rule the
 * old TrendChart followed. A series with no real data behind it is simply
 * not passed in; this component never synthesises one to fill the legend.
 *
 * Hand-rolled inline SVG, no charting library (§1's stack has no bundler,
 * and the existing DonutChart/HeatmapMap are hand-rolled for the same
 * reason). SVG rather than the old div-per-bar approach because a line
 * needs real coordinate geometry, gridlines and axis ticks, which divs
 * can't express without a pile of absolute positioning.
 *
 * Colours come from --chart-line-1/2, --chart-grid and --chart-axis-text,
 * read at render time via getComputedStyle rather than hardcoded, so the
 * chart follows a theme change like everything else (a literal hex here
 * would be invisible in one of the two themes — the exact class of bug
 * the token audit found across the app).
 *
 * @param {{
 *   points: Array<{label:string, values:number[]}>,
 *   series: Array<{name:string, colorVar:string}>,
 *   caption?: string,
 * }} props
 * @returns {HTMLElement}
 */

const VIEW_W = 720;
const VIEW_H = 240;
const PAD = { top: 14, right: 14, bottom: 30, left: 38 };

function readToken(name, fallback) {
  const v = getComputedStyle(document.documentElement).getPropertyValue(name).trim();
  return v || fallback;
}

/**
 * A "nice" axis maximum at or above `max`, so the top gridline is a round
 * number (5 / 10 / 25 / 50 / 100 …) rather than whatever the data
 * happened to peak at. Every tick this produces names a value the chart
 * actually reaches.
 */
function niceMax(max) {
  if (max <= 4) return 4;
  const pow = Math.pow(10, Math.floor(Math.log10(max)));
  for (const step of [1, 2, 2.5, 5, 10]) {
    const candidate = step * pow;
    if (candidate >= max) return candidate;
  }
  return 10 * pow;
}

export function LineChart({ points, series, caption }) {
  const host = document.createElement('div');

  if (!points || points.length === 0 || series.length === 0) {
    host.className = 'line-chart__empty';
    host.textContent = 'No data in this range.';
    return host;
  }

  host.className = 'line-chart';

  const gridColor = readToken('--chart-grid', '#E2E8F0');
  const axisColor = readToken('--chart-axis-text', '#64748B');
  const colors = series.map((s, i) => readToken(s.colorVar, i === 0 ? '#2563EB' : '#15803D'));

  const allValues = points.flatMap((p) => p.values);
  const yMax = niceMax(Math.max(1, ...allValues));

  const plotW = VIEW_W - PAD.left - PAD.right;
  const plotH = VIEW_H - PAD.top - PAD.bottom;
  // A single point has no span to divide, so it sits at the left edge
  // rather than dividing by zero.
  const stepX = points.length > 1 ? plotW / (points.length - 1) : 0;
  const x = (i) => PAD.left + i * stepX;
  const y = (v) => PAD.top + plotH - (v / yMax) * plotH;

  const svgNS = 'http://www.w3.org/2000/svg';
  const svg = document.createElementNS(svgNS, 'svg');
  svg.setAttribute('viewBox', `0 0 ${VIEW_W} ${VIEW_H}`);
  svg.setAttribute('preserveAspectRatio', 'none');
  svg.setAttribute('class', 'line-chart__svg');
  // The accessible equivalent is the data table below, so the drawing
  // itself is decorative to assistive tech rather than announced twice.
  svg.setAttribute('aria-hidden', 'true');

  // --- horizontal gridlines + y ticks -------------------------------------
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

  // --- x tick labels ------------------------------------------------------
  // Every label on a 30-day range would collide, so at most 6 are drawn —
  // always including the first and last, which are the two a reader
  // actually uses to orient the range.
  const maxLabels = 6;
  const labelStep = Math.max(1, Math.ceil(points.length / maxLabels));
  points.forEach((p, i) => {
    const isEdge = i === 0 || i === points.length - 1;
    if (!isEdge && i % labelStep !== 0) return;
    // Skip a regular tick that would sit on top of the final label.
    if (!isEdge && points.length - 1 - i < labelStep / 2) return;
    const text = document.createElementNS(svgNS, 'text');
    text.setAttribute('x', String(x(i)));
    text.setAttribute('y', String(VIEW_H - PAD.bottom + 18));
    text.setAttribute('text-anchor', i === 0 ? 'start' : i === points.length - 1 ? 'end' : 'middle');
    text.setAttribute('font-size', '11');
    text.setAttribute('fill', axisColor);
    text.textContent = p.label;
    svg.appendChild(text);
  });

  // --- series -------------------------------------------------------------
  series.forEach((s, si) => {
    const coords = points.map((p, i) => [x(i), y(p.values[si] ?? 0)]);

    // Soft area under the line, then the line itself. The fill is what
    // makes two overlapping series readable where they nearly coincide.
    const area = document.createElementNS(svgNS, 'path');
    const areaD = `M ${coords[0][0]} ${PAD.top + plotH} `
      + coords.map(([cx, cy]) => `L ${cx} ${cy}`).join(' ')
      + ` L ${coords[coords.length - 1][0]} ${PAD.top + plotH} Z`;
    area.setAttribute('d', areaD);
    area.setAttribute('fill', colors[si]);
    area.setAttribute('opacity', '0.10');
    svg.appendChild(area);

    const path = document.createElementNS(svgNS, 'path');
    path.setAttribute('d', `M ${coords.map(([cx, cy]) => `${cx} ${cy}`).join(' L ')}`);
    path.setAttribute('fill', 'none');
    path.setAttribute('stroke', colors[si]);
    path.setAttribute('stroke-width', '2.5');
    path.setAttribute('stroke-linejoin', 'round');
    path.setAttribute('stroke-linecap', 'round');
    // vector-effect keeps the stroke 2.5px on screen despite the
    // non-uniform scaling preserveAspectRatio="none" applies.
    path.setAttribute('vector-effect', 'non-scaling-stroke');
    svg.appendChild(path);

    // Point markers, but only when they won't collapse into a solid bar —
    // a 30-day range at this width has no room for 30 dots.
    if (points.length <= 14) {
      coords.forEach(([cx, cy], i) => {
        const dot = document.createElementNS(svgNS, 'circle');
        dot.setAttribute('cx', String(cx));
        dot.setAttribute('cy', String(cy));
        dot.setAttribute('r', '3.5');
        dot.setAttribute('fill', 'var(--color-surface)');
        dot.setAttribute('stroke', colors[si]);
        dot.setAttribute('stroke-width', '2');
        const title = document.createElementNS(svgNS, 'title');
        title.textContent = `${points[i].label} — ${s.name}: ${points[i].values[si] ?? 0}`;
        dot.appendChild(title);
        svg.appendChild(dot);
      });
    }
  });

  const plot = document.createElement('div');
  plot.className = 'line-chart__plot';
  plot.appendChild(svg);
  host.appendChild(plot);

  // --- legend -------------------------------------------------------------
  const legend = document.createElement('div');
  legend.className = 'line-chart__legend';
  series.forEach((s, si) => {
    const item = document.createElement('span');
    item.className = 'line-chart__legend-item';
    const swatch = document.createElement('span');
    swatch.className = 'line-chart__legend-swatch';
    swatch.style.background = colors[si];
    const name = document.createElement('span');
    name.textContent = s.name;
    item.append(swatch, name);
    legend.appendChild(item);
  });
  host.appendChild(legend);

  // --- accessible equivalent ----------------------------------------------
  // Same pattern the old TrendChart and DonutChart already use: the
  // visual chart is aria-hidden and a real data table carries the numbers.
  const table = document.createElement('table');
  table.className = 'sr-only';
  const head = series.map((s) => `<th scope="col">${s.name}</th>`).join('');
  const body = points.map((p) => (
    `<tr><td>${p.label}</td>${p.values.map((v) => `<td>${v}</td>`).join('')}</tr>`
  )).join('');
  table.innerHTML = `<caption>${caption ?? 'Trend'}</caption>`
    + `<thead><tr><th scope="col">Date</th>${head}</tr></thead><tbody>${body}</tbody>`;
  host.appendChild(table);

  return host;
}
