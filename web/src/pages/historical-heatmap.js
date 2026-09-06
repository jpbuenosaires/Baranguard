/**
 * historical-heatmap.js — W5 Historical Heatmap (§9): "Historical only,
 * bounded date range, explicit non-predictive label." Roles: Admin,
 * Punong Barangay (read-only) — this screen has no write action, so both
 * roles just call the same `GET /reports/heatmap`.
 *
 * kebab-case filename per §4 (pages/routes convention).
 */

import { getReportsHeatmap, ApiClientError } from '../api/apiClient.js';
import { HeatmapMap } from '../components/HeatmapMap.js';
import { DateRangePicker } from '../components/DateRangePicker.js';

/**
 * Personnel > Heatmap tab. Was the standalone W5 Historical Heatmap page
 * (`renderHistoricalHeatmapPage`) before the 2026-09-05 Analytics merge
 * — see `pages/analytics.js` for the shared AppShell/PageHeader/tab
 * shell. Merged with W9 Statistical Reports because both share the
 * exact same role pair (Admin, Punong Barangay read-only) and the same
 * bounded-historical, no-write nature — unlike the Incident Management
 * merge this project's own DEVLOG explicitly declined for this same
 * screen, where the roles and live-vs-historical intent didn't match.
 *
 * @param {HTMLElement} container tab body to render into
 * @param {ReturnType<import('../components/PageHeader.js').PageHeader>} pageHeader
 * @param {{fullName:string, role:string}} user
 */
export function renderHeatmapTab(container, pageHeader, user) {
  // 2026-09-06 UI/UX audit: was a copy of the Admin Dashboard's ~120-line
  // picker. Now the shared component — which also removes a real bug this
  // copy carried: the Apply button had TWO click listeners (one here, one
  // added again further down), so every custom range fired load() twice.
  const rangePicker = DateRangePicker({
    value: '30',
    ariaLabel: 'Date range',
    onChange: ({ from, to }) => load(from, to),
  });

  if (pageHeader && pageHeader.actions) {
    pageHeader.actions.appendChild(rangePicker.el);
  }

  const wrapper = document.createElement('div');
  wrapper.className = 'flex-col grow';
  container.appendChild(wrapper);

  const disclosure = document.createElement('p');
  disclosure.className = 'note';
  disclosure.textContent = 'Historical incident patterns only — not a predictive or real-time view.';
  wrapper.appendChild(disclosure);

  const body = document.createElement('div');
  body.className = 'grow';
  wrapper.appendChild(body);

  let heatmap = null;

  const initial = rangePicker.getState();
  load(initial.from, initial.to);

  async function load(dateFrom, dateTo) {
    renderLoading(body);
    if (heatmap) {
      heatmap.destroy();
      heatmap = null;
    }
    try {
      const points = await getReportsHeatmap({ dateFrom, dateTo });
      if (points.length === 0) {
        renderEmpty(body);
      } else {
        renderPopulated(body, points);
      }
    } catch (err) {
      const message = err instanceof ApiClientError ? err.message : 'Something went wrong loading the heatmap.';
      renderError(body, message, () => load(dateFrom, dateTo));
    }
  }

  function renderPopulated(container, points) {
    container.innerHTML = '';
    const mapWrapper = document.createElement('div');
    mapWrapper.className = 'gis-page__map-wrapper';
    mapWrapper.classList.add('gis-page__map-wrapper--fill');
    container.appendChild(mapWrapper);
    heatmap = HeatmapMap(mapWrapper);
    heatmap.setPoints(points);
  }
}

function renderLoading(container) {
  container.innerHTML = '';
  const skeleton = document.createElement('div');
  skeleton.className = 'skeleton';
  skeleton.setAttribute('role', 'status');
  skeleton.setAttribute('aria-label', 'Loading heatmap');
  skeleton.classList.add('skeleton--fill');
  container.appendChild(skeleton);
}

function renderEmpty(container) {
  container.innerHTML = '';
  const block = document.createElement('div');
  block.className = 'card state-block';
  block.innerHTML = `
    <h3>No incidents in this range</h3>
    <p>No incidents with recorded coordinates were reported in the selected date range. Widen the range or check back once more incidents come in.</p>
  `;
  container.appendChild(block);
}

function renderError(container, message, onRetry) {
  container.innerHTML = '';
  const block = document.createElement('div');
  block.className = 'card state-block state-block--error';
  block.setAttribute('role', 'alert');
  const text = document.createElement('p');
  text.textContent = message;
  const retryButton = document.createElement('button');
  retryButton.className = 'primary';
  retryButton.textContent = 'Retry';
  retryButton.addEventListener('click', onRetry);
  block.append(text, retryButton);
  container.appendChild(block);
}
