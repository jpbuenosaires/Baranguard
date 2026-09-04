/**
 * historical-heatmap.js — W5 Historical Heatmap (§9): "Historical only,
 * bounded date range, explicit non-predictive label." Roles: Admin,
 * Punong Barangay (read-only) — this screen has no write action, so both
 * roles just call the same `GET /reports/heatmap`.
 *
 * kebab-case filename per §4 (pages/routes convention).
 */

import { getReportsHeatmap, logout, ApiClientError } from '../api/apiClient.js';
import { HeatmapMap } from '../components/HeatmapMap.js';
import { AppShell } from '../components/AppShell.js';
import { PageHeader } from '../components/PageHeader.js';
import { icons } from '../components/icons.js';

function todayIso() {
  return new Date().toISOString().slice(0, 10);
}
function daysAgoIso(n) {
  const d = new Date();
  d.setDate(d.getDate() - n);
  return d.toISOString().slice(0, 10);
}

/**
 * @param {HTMLElement} root
 * @param {{fullName:string, role:string}} user
 * @param {() => void} onLoggedOut
 * @param {(page: string) => void} navigate
 */
export function renderHistoricalHeatmapPage(root, user, onLoggedOut, navigate) {
  root.innerHTML = '';

  const shell = AppShell(user, 'heatmap', navigate, async () => {
    shell.logoutButton.disabled = true;
    await logout();
    onLoggedOut();
  });
  const { header, content } = shell;
  root.appendChild(shell.el);

  // Was a raw `<h2 style="...">` written straight into the content area —
  // the one screen this project's own PageHeader migration missed (see
  // DEVLOG.md). Matches every other screen now: fixed header bar above
  // the scrolling content, no inline style, tokens carry the dark-mode
  // retrofit automatically.
  const pageHeader = PageHeader({ title: 'Historical Heatmap', subtitle: 'Historical incident patterns only — not a predictive or real-time view.', icon: icons.flame });
  header.appendChild(pageHeader.el);

  const wrapper = document.createElement('div');
  wrapper.className = 'flex-col grow';
  content.appendChild(wrapper);

  const controls = document.createElement('div');
  controls.className = 'filter-bar';
  const fromInput = document.createElement('input');
  fromInput.type = 'date';
  fromInput.value = daysAgoIso(29);
  fromInput.classList.add('input--auto');
  const toInput = document.createElement('input');
  toInput.type = 'date';
  toInput.value = todayIso();
  toInput.classList.add('input--auto');
  const applyButton = document.createElement('button');
  applyButton.className = 'primary';
  applyButton.textContent = 'Apply';
  controls.append(
    Object.assign(document.createElement('span'), { className: 'label', textContent: 'From' }),
    fromInput,
    Object.assign(document.createElement('span'), { className: 'label', textContent: 'To' }),
    toInput,
    applyButton
  );

  const body = document.createElement('div');
  body.className = 'grow';

  // The "historical only, not predictive" disclosure now lives in the
  // PageHeader subtitle above (§9's own requirement, still met) rather
  // than a second, duplicate note in the content area.
  wrapper.append(controls, body);

  let heatmap = null;

  applyButton.addEventListener('click', () => load(fromInput.value, toInput.value));
  load(fromInput.value, toInput.value);

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
