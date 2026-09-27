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
import { StatStrip } from '../components/StatStrip.js';

const TYPE_LABELS = {
  theft: 'Theft',
  assault: 'Assault',
  vandalism: 'Vandalism',
  disturbance: 'Disturbance',
  noise_complaint: 'Noise Complaint',
  domestic_dispute: 'Domestic Dispute',
  trespassing: 'Trespassing',
  fire: 'Fire',
  medical_emergency: 'Medical Emergency',
  flooding: 'Flooding',
  other: 'Other',
};

function formatIncidentType(raw) {
  if (!raw) return 'Other';
  return TYPE_LABELS[raw] || raw.replace(/_/g, ' ').replace(/\b\w/g, (c) => c.toUpperCase());
}

/**
 * Analytics > Heatmap tab.
 *
 * @param {HTMLElement} container tab body to render into
 * @param {ReturnType<import('../components/PageHeader.js').PageHeader>} pageHeader
 * @param {{fullName:string, role:string}} user
 */
export function renderHeatmapTab(container, pageHeader, user) {
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

  const banner = document.createElement('div');
  banner.className = 'heatmap-compliance-banner';
  const bannerIcon = document.createElement('span');
  bannerIcon.className = 'heatmap-compliance-banner__icon';
  bannerIcon.setAttribute('aria-hidden', 'true');
  bannerIcon.innerHTML = `<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><circle cx="12" cy="12" r="10"/><polyline points="12 6 12 12 16 14"/></svg>`;
  const disclosure = document.createElement('p');
  disclosure.className = 'note';
  disclosure.textContent = 'Historical incident patterns only — not a predictive or real-time view.';
  banner.append(bannerIcon, disclosure);
  wrapper.appendChild(banner);

  const body = document.createElement('div');
  body.className = 'grow';
  wrapper.appendChild(body);

  let heatmap = null;
  let activeCategory = 'all';

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
        activeCategory = 'all';
        renderPopulated(body, points, dateFrom, dateTo);
      }
    } catch (err) {
      const message = err instanceof ApiClientError ? err.message : 'Something went wrong loading the heatmap.';
      renderError(body, message, () => load(dateFrom, dateTo));
    }
  }

  function renderPopulated(target, points, dateFrom, dateTo) {
    target.innerHTML = '';

    // Tally categories, high/critical priority, and resolved counts
    const byType = new Map();
    let highCriticalCount = 0;
    let resolvedCount = 0;

    for (const pt of points) {
      const typeKey = pt.incidentType || 'other';
      byType.set(typeKey, (byType.get(typeKey) || 0) + 1);
      if (pt.priority === 'critical' || pt.priority === 'high') {
        highCriticalCount += 1;
      }
      if (pt.status === 'resolved') {
        resolvedCount += 1;
      }
    }

    const sortedTypes = [...byType.entries()].sort((a, b) => b[1] - a[1]);
    const topEntry = sortedTypes[0];
    const topCategoryLabel = topEntry ? `${formatIncidentType(topEntry[0])} (${topEntry[1]})` : '—';

    // Top KPI strip container so we can update "Visible on Map" when filtering
    const stripHolder = document.createElement('div');
    target.appendChild(stripHolder);

    function renderStats(visibleCount) {
      stripHolder.innerHTML = '';
      stripHolder.appendChild(
        StatStrip({
          items: [
            { label: 'Mapped Incidents', value: points.length, tone: 'default' },
            { label: 'Visible on Map', value: visibleCount, tone: 'info' },
            { label: 'Top Hotspot Category', value: topCategoryLabel, tone: 'warning' },
            { label: 'High / Critical Priority', value: highCriticalCount, tone: highCriticalCount > 0 ? 'critical' : 'default' },
          ],
        }),
      );
    }

    renderStats(points.length);

    // Category filter chip bar
    const toolbar = document.createElement('div');
    toolbar.className = 'heatmap-toolbar';

    const filterBar = document.createElement('div');
    filterBar.className = 'heatmap-filter-bar';
    filterBar.setAttribute('role', 'group');
    filterBar.setAttribute('aria-label', 'Filter heatmap by incident category');

    const filterLabel = document.createElement('span');
    filterLabel.className = 'heatmap-filter-bar__label';
    filterLabel.textContent = 'Filter Category:';
    filterBar.appendChild(filterLabel);

    const chipsWrap = document.createElement('div');
    chipsWrap.className = 'heatmap-filter-chips';
    filterBar.appendChild(chipsWrap);
    toolbar.appendChild(filterBar);
    target.appendChild(toolbar);

    // Main workspace: Left/Center Map + Right Hotspot Breakdown Card
    const workspace = document.createElement('div');
    workspace.className = 'heatmap-workspace';

    const mapPanel = document.createElement('div');
    mapPanel.className = 'heatmap-map-panel';

    const mapWrapper = document.createElement('div');
    mapWrapper.className = 'gis-page__map-wrapper';
    mapWrapper.classList.add('gis-page__map-wrapper--fill');
    mapPanel.appendChild(mapWrapper);

    // Density Legend Bar below the map
    const legendBar = document.createElement('div');
    legendBar.className = 'heatmap-legend-bar';
    legendBar.innerHTML = `
      <span class="heatmap-legend-bar__title">Spatial Concentration Scale</span>
      <div class="heatmap-legend-bar__scale">
        <span>Low (Isolated)</span>
        <span class="heatmap-legend-bar__gradient" aria-hidden="true"></span>
        <span>High (Hotspot Cluster)</span>
      </div>
      <span class="heatmap-legend-bar__meta">Plotting GPS-verified incidents (${points.length} total in range)</span>
    `;
    mapPanel.appendChild(legendBar);

    // Side Hotspot Breakdown panel
    const breakdownCard = document.createElement('aside');
    breakdownCard.className = 'card heatmap-breakdown-card';

    const bdTitle = document.createElement('h3');
    bdTitle.className = 'heatmap-breakdown-card__title';
    bdTitle.textContent = 'Hotspot Category Breakdown';

    const bdSub = document.createElement('p');
    bdSub.className = 'heatmap-breakdown-card__subtitle';
    bdSub.textContent = dateFrom && dateTo ? `Window: ${dateFrom} to ${dateTo}` : 'Selected historical window';

    const bdList = document.createElement('div');
    bdList.className = 'heatmap-breakdown-list';

    for (const [typeKey, count] of sortedTypes) {
      const pct = Math.round((count / points.length) * 100);
      const row = document.createElement('div');
      row.className = 'heatmap-breakdown-row';

      const head = document.createElement('div');
      head.className = 'heatmap-breakdown-row__head';

      const nameEl = document.createElement('span');
      nameEl.className = 'heatmap-breakdown-row__name';
      nameEl.textContent = formatIncidentType(typeKey);

      const statEl = document.createElement('span');
      statEl.className = 'heatmap-breakdown-row__stat';
      statEl.textContent = `${count} (${pct}%)`;

      head.append(nameEl, statEl);

      const track = document.createElement('div');
      track.className = 'heatmap-breakdown-row__track';
      const fill = document.createElement('div');
      fill.className = 'heatmap-breakdown-row__fill';
      fill.style.width = `${Math.max(pct, 4)}%`;
      track.appendChild(fill);

      row.append(head, track);
      bdList.appendChild(row);
    }

    const bdSummary = document.createElement('div');
    bdSummary.className = 'heatmap-breakdown-summary';

    const resolvedPct = Math.round((resolvedCount / points.length) * 100);
    const summaryItems = [
      { val: `${resolvedCount} (${resolvedPct}%)`, lbl: 'Resolved Cases' },
      { val: String(highCriticalCount), lbl: 'High / Critical' },
    ];
    for (const item of summaryItems) {
      const box = document.createElement('div');
      box.className = 'heatmap-breakdown-summary__item';
      const v = document.createElement('span');
      v.className = 'heatmap-breakdown-summary__val';
      v.textContent = item.val;
      const l = document.createElement('span');
      l.className = 'heatmap-breakdown-summary__lbl';
      l.textContent = item.lbl;
      box.append(v, l);
      bdSummary.appendChild(box);
    }

    breakdownCard.append(bdTitle, bdSub, bdList, bdSummary);
    workspace.append(mapPanel, breakdownCard);
    target.appendChild(workspace);

    heatmap = HeatmapMap(mapWrapper);
    heatmap.setPoints(points);

    function renderFilterChips() {
      chipsWrap.innerHTML = '';
      const options = [
        { key: 'all', label: 'All Categories', count: points.length },
        ...sortedTypes.map(([k, c]) => ({ key: k, label: formatIncidentType(k), count: c })),
      ];

      for (const opt of options) {
        const btn = document.createElement('button');
        btn.type = 'button';
        btn.className = 'heatmap-chip';
        if (activeCategory === opt.key) {
          btn.classList.add('heatmap-chip--active');
        }
        btn.setAttribute('aria-pressed', activeCategory === opt.key ? 'true' : 'false');

        const labelSpan = document.createElement('span');
        labelSpan.textContent = opt.label;

        const countSpan = document.createElement('span');
        countSpan.className = 'heatmap-chip__count';
        countSpan.textContent = String(opt.count);

        btn.append(labelSpan, countSpan);
        btn.addEventListener('click', () => {
          activeCategory = opt.key;
          const filtered = activeCategory === 'all'
            ? points
            : points.filter((p) => (p.incidentType || 'other') === activeCategory);
          renderFilterChips();
          renderStats(filtered.length);
          if (heatmap) {
            heatmap.setPoints(filtered);
          }
        });
        chipsWrap.appendChild(btn);
      }
    }

    renderFilterChips();
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
