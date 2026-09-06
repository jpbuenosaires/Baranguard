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

function todayIso() {
  return new Date().toISOString().slice(0, 10);
}
function daysAgoIso(n) {
  const d = new Date();
  d.setDate(d.getDate() - n);
  return d.toISOString().slice(0, 10);
}

function shortDate(iso) {
  if (!iso) return '';
  const [, m, d] = iso.split('-');
  const months = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
  return `${months[Number(m) - 1]} ${Number(d)}`;
}

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
  const PRESET_DAYS_AGO = { 7: 6, 30: 29, 90: 89 };

  const fromInput = document.createElement('input');
  fromInput.type = 'date';
  fromInput.value = daysAgoIso(29);
  fromInput.className = 'date-range-popover__input';

  const toInput = document.createElement('input');
  toInput.type = 'date';
  toInput.value = todayIso();
  toInput.className = 'date-range-popover__input';

  const rangeWrapper = document.createElement('div');
  rangeWrapper.className = 'date-range-picker-wrapper';

  const rangeSelect = document.createElement('select');
  rangeSelect.className = 'input--auto range-select';
  rangeSelect.setAttribute('aria-label', 'Date range');
  for (const [value, label] of [['7', 'Last 7 days'], ['30', 'Last 30 days'], ['90', 'Last 90 days'], ['custom', 'Custom range...']]) {
    const option = document.createElement('option');
    option.value = value;
    option.textContent = label;
    rangeSelect.appendChild(option);
  }
  rangeSelect.value = '30';
  let previousSelectValue = '30';

  const popover = document.createElement('div');
  popover.className = 'date-range-popover';
  popover.hidden = true;
  popover.setAttribute('role', 'dialog');
  popover.setAttribute('aria-label', 'Custom date range');

  const popoverTitle = document.createElement('div');
  popoverTitle.className = 'date-range-popover__title';
  popoverTitle.textContent = 'Custom Date Range';

  const gridFields = document.createElement('div');
  gridFields.className = 'date-range-popover__grid';

  const fromField = document.createElement('div');
  fromField.className = 'date-range-popover__field';
  const fromLabel = document.createElement('label');
  fromLabel.className = 'date-range-popover__label';
  fromLabel.textContent = 'From';
  fromField.append(fromLabel, fromInput);

  const toField = document.createElement('div');
  toField.className = 'date-range-popover__field';
  const toLabel = document.createElement('label');
  toLabel.className = 'date-range-popover__label';
  toLabel.textContent = 'To';
  toField.append(toLabel, toInput);

  gridFields.append(fromField, toField);

  const rangeError = document.createElement('span');
  rangeError.className = 'app-inline-error';
  rangeError.hidden = true;
  rangeError.setAttribute('role', 'alert');

  const actions = document.createElement('div');
  actions.className = 'date-range-popover__actions';

  const cancelButton = document.createElement('button');
  cancelButton.type = 'button';
  cancelButton.className = 'ghost';
  cancelButton.textContent = 'Cancel';

  const applyButton = document.createElement('button');
  applyButton.type = 'button';
  applyButton.className = 'primary';
  applyButton.textContent = 'Apply Range';

  actions.append(cancelButton, applyButton);
  popover.append(popoverTitle, gridFields, rangeError, actions);
  rangeWrapper.append(rangeSelect, popover);

  const validateRange = () => {
    const invalid = Boolean(fromInput.value && toInput.value && fromInput.value > toInput.value);
    applyButton.disabled = invalid;
    rangeError.hidden = !invalid;
    rangeError.textContent = invalid ? 'From date must be on or before To date.' : '';
  };
  fromInput.addEventListener('change', validateRange);
  toInput.addEventListener('change', validateRange);

  const openPopover = () => {
    popover.hidden = false;
    validateRange();
    fromInput.focus();
  };

  const closePopover = (restorePrevious = false) => {
    popover.hidden = true;
    rangeError.hidden = true;
    if (restorePrevious) {
      rangeSelect.value = previousSelectValue;
    }
  };

  cancelButton.addEventListener('click', () => closePopover(true));
  document.addEventListener('click', (e) => {
    if (!popover.hidden && !rangeWrapper.contains(e.target)) closePopover(true);
  });
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape' && !popover.hidden) closePopover(true);
  });

  applyButton.addEventListener('click', () => {
    if (fromInput.value && toInput.value && fromInput.value > toInput.value) return;
    previousSelectValue = 'custom';
    const customOption = rangeSelect.querySelector('option[value="custom"]');
    if (customOption) {
      customOption.textContent = `Custom (${shortDate(fromInput.value)} – ${shortDate(toInput.value)})`;
    }
    rangeSelect.value = 'custom';
    closePopover(false);
    load(fromInput.value, toInput.value);
  });

  rangeSelect.addEventListener('change', () => {
    if (rangeSelect.value === 'custom') {
      openPopover();
      return;
    }
    closePopover(false);
    previousSelectValue = rangeSelect.value;
    fromInput.value = daysAgoIso(PRESET_DAYS_AGO[rangeSelect.value]);
    toInput.value = todayIso();
    load(fromInput.value, toInput.value);
  });

  if (pageHeader && pageHeader.actions) {
    pageHeader.actions.appendChild(rangeWrapper);
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
