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
import { formatManilaDate } from '../utils/manilaTime.js';

// The 11 real incident types (REFERENCE section 4); same labels as the
// Dashboard and Reports so one type never reads two ways.
const TYPE_LABELS = {
  theft: 'Theft',
  physical_injury: 'Physical Injury',
  disturbance: 'Disturbance',
  domestic_dispute: 'Domestic Dispute',
  vandalism: 'Vandalism',
  traffic_incident: 'Traffic Incident',
  fire: 'Fire',
  medical_emergency: 'Medical Emergency',
  missing_person: 'Missing Person',
  animal_complaint: 'Animal Complaint',
  other: 'Other',
};

const TYPE_COLOR_TOKENS = {
  theft: 'var(--cat-theft, #2563EB)',
  physical_injury: 'var(--cat-injury, #E11D48)',
  disturbance: 'var(--cat-disturbance, #D97706)',
  domestic_dispute: 'var(--cat-dispute, #DC2626)',
  vandalism: 'var(--cat-vandalism, #0D9488)',
  traffic_incident: 'var(--cat-traffic, #EA580C)',
  fire: 'var(--cat-fire, #B91C1C)',
  medical_emergency: 'var(--cat-medical, #DB2777)',
  missing_person: 'var(--cat-missing, #7C3AED)',
  animal_complaint: 'var(--cat-animal, #16A34A)',
  other: 'var(--cat-other, #64748B)',
};

/** Below this many plotted incidents the colour scale is too coarse to read as a trend. */
const SMALL_SAMPLE = 10;

/** "2026-10-09" (a Manila calendar day) -> "Oct 9, 2026". */
function dayLabel(iso) {
  return /^\d{4}-\d{2}-\d{2}$/.test(String(iso || '')) ? formatManilaDate(`${iso}T00:00:00+08:00`) : '';
}

function formatIncidentType(raw) {
  if (!raw) return 'Other';
  return TYPE_LABELS[raw] || 'Other';
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
            { label: 'Incidents with a location', value: points.length, tone: 'default' },
            { label: 'Visible on Map', value: visibleCount, tone: 'info' },
            { label: 'Most Common Category', value: topCategoryLabel, tone: 'warning' },
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
      <span class="heatmap-legend-bar__title">How closely incidents are grouped</span>
      <div class="heatmap-legend-bar__scale">
        <span>Fewer incidents</span>
        <span class="heatmap-legend-bar__gradient" aria-hidden="true"></span>
        <span>Many incidents close together</span>
      </div>
      <span class="heatmap-legend-bar__meta">Showing the ${points.length} incident${points.length === 1 ? '' : 's'} in this range that have a recorded location.${points.length < SMALL_SAMPLE ? ' With so few incidents the colours exaggerate small clusters; read them with care.' : ''}</span>
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
    bdSub.textContent = dateFrom && dateTo ? `Window: ${dayLabel(dateFrom)} to ${dayLabel(dateTo)}` : 'Selected historical window';

    const bdList = document.createElement('div');
    bdList.className = 'heatmap-breakdown-list';
    bdList.setAttribute('role', 'region');
    bdList.setAttribute('aria-label', 'Incident categories ranked by occurrence');

    function renderBreakdownRows() {
      bdList.innerHTML = '';
      for (const [typeKey, count] of sortedTypes) {
        const pct = Math.round((count / points.length) * 100);
        const row = document.createElement('div');
        row.className = 'heatmap-breakdown-row';
        row.setAttribute('role', 'button');
        row.setAttribute('tabindex', '0');
        row.setAttribute('data-category', typeKey);
        row.title = `Click to filter map by ${formatIncidentType(typeKey)}`;

        const isRowActive = activeCategory === typeKey;
        const isDimmed = activeCategory !== 'all' && !isRowActive;
        if (isRowActive) row.classList.add('heatmap-breakdown-row--active');
        if (isDimmed) row.classList.add('heatmap-breakdown-row--dimmed');

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
        track.setAttribute('role', 'progressbar');
        track.setAttribute('aria-valuenow', pct);
        track.setAttribute('aria-valuemin', '0');
        track.setAttribute('aria-valuemax', '100');
        track.setAttribute('aria-label', `${formatIncidentType(typeKey)}: ${count} incidents (${pct}%)`);

        const fill = document.createElement('div');
        fill.className = 'heatmap-breakdown-row__fill';
        fill.style.width = `${Math.max(pct, 4)}%`;
        fill.style.background = TYPE_COLOR_TOKENS[typeKey] || 'var(--color-primary)';
        track.appendChild(fill);

        row.append(head, track);

        const toggleFromRow = () => {
          applyCategoryFilter(activeCategory === typeKey ? 'all' : typeKey);
        };
        row.addEventListener('click', toggleFromRow);
        row.addEventListener('keydown', (e) => {
          if (e.key === 'Enter' || e.key === ' ') {
            e.preventDefault();
            toggleFromRow();
          }
        });

        bdList.appendChild(row);
      }
    }

    renderBreakdownRows();

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

    function applyCategoryFilter(catKey) {
      activeCategory = catKey;
      const filtered = activeCategory === 'all'
        ? points
        : points.filter((p) => (p.incidentType || 'other') === activeCategory);
      renderFilterChips();
      renderStats(filtered.length);
      renderBreakdownRows();
      if (heatmap) {
        heatmap.setPoints(filtered);
      }
    }

    function renderFilterChips() {
      chipsWrap.innerHTML = '';
      const options = [
        { key: 'all', label: 'All Categories', count: points.length },
        ...sortedTypes.map(([k, c]) => ({ key: k, label: formatIncidentType(k), count: c })),
      ];

      for (let i = 0; i < options.length; i++) {
        const opt = options[i];
        const btn = document.createElement('button');
        btn.type = 'button';
        btn.className = 'heatmap-chip';
        const isSelected = activeCategory === opt.key;
        if (isSelected) {
          btn.classList.add('heatmap-chip--active');
        }
        btn.setAttribute('aria-pressed', isSelected ? 'true' : 'false');
        btn.setAttribute('data-category', opt.key);

        if (opt.key !== 'all') {
          const dot = document.createElement('span');
          dot.className = 'heatmap-chip__dot';
          dot.style.background = TYPE_COLOR_TOKENS[opt.key] || 'var(--color-primary)';
          dot.setAttribute('aria-hidden', 'true');
          btn.appendChild(dot);
        }

        const labelSpan = document.createElement('span');
        labelSpan.textContent = opt.label;

        const countSpan = document.createElement('span');
        countSpan.className = 'heatmap-chip__count';
        countSpan.textContent = String(opt.count);

        btn.append(labelSpan, countSpan);

        // Arrow key roving navigation across category chips
        btn.addEventListener('keydown', (e) => {
          if (e.key === 'ArrowRight' || e.key === 'ArrowLeft') {
            e.preventDefault();
            const nextIdx = (i + (e.key === 'ArrowRight' ? 1 : options.length - 1)) % options.length;
            const nextBtn = chipsWrap.children[nextIdx];
            if (nextBtn) {
              nextBtn.focus();
              nextBtn.click();
            }
          }
        });

        btn.addEventListener('click', () => {
          applyCategoryFilter(opt.key);
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
