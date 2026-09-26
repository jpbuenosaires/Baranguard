/**
 * transparency.js — Public Transparency Report (code-review findings
 * H-13/L-03, 2026-09-24: "publish it properly" — this endpoint existed
 * server-side with no web page and no product decision behind it; the
 * decision made was to publish it as a real, supported public feature).
 *
 * Roles: Public — no session, no AppShell. Reachable via `#/transparency`
 * hash fragment on index.html, same zero-config pattern as `#/citizen-
 * report` (W19) in main.js.
 *
 * Every value rendered here comes straight from `GET /public/transparency`
 * (see PublicReportsController.php's own extensive privacy doc — counts
 * only, monthly buckets, small categories pooled). This page adds no new
 * data of its own; it is a display layer over an already-privacy-reviewed
 * response. Server data is rendered via `textContent` only, never
 * `innerHTML`, per §6's blanket rule.
 */

import { getPublicTransparency, getBarangays, ApiClientError } from '../api/apiClient.js';
import { icons } from '../components/icons.js';
import { openPrintPreviewModal } from '../components/PrintPreviewModal.js';
import { escapeHtml } from '../utils/escapeHtml.js';

/** @param {HTMLElement} root */
export function renderTransparencyPage(root) {
  root.innerHTML = '';

  const page = document.createElement('div');
  page.className = 'citizen-portal-page';

  const card = document.createElement('div');
  card.className = 'citizen-portal-card';

  page.appendChild(card);
  root.appendChild(page);

  loadBarangays();

  async function loadBarangays() {
    renderLoading();
    try {
      const barangays = await getBarangays();
      if (barangays.length === 0) {
        renderError('No barangays are configured.');
        return;
      }
      renderPicker(barangays);
    } catch (err) {
      renderError(err instanceof ApiClientError ? err.message : 'Could not load the barangay list.');
    }
  }

  function renderLoading() {
    card.innerHTML = '';
    const block = document.createElement('div');
    block.className = 'state-block';
    block.setAttribute('role', 'status');
    block.setAttribute('aria-label', 'Loading');
    block.appendChild(skeletonLine('40%'));
    block.appendChild(skeletonBlock());
    card.appendChild(block);
  }

  function renderError(message) {
    card.innerHTML = '';
    const block = document.createElement('div');
    block.className = 'state-block state-block--error';
    block.setAttribute('role', 'alert');
    const text = document.createElement('p');
    text.textContent = message;
    const retryButton = document.createElement('button');
    retryButton.className = 'primary';
    retryButton.textContent = 'Retry';
    retryButton.addEventListener('click', loadBarangays);
    block.append(text, retryButton);
    card.appendChild(block);
  }

  function renderPicker(barangays) {
    card.innerHTML = '';

    const header = document.createElement('div');
    header.className = 'citizen-portal-header';
    const brand = document.createElement('div');
    brand.className = 'citizen-portal-brand';
    const badge = document.createElement('img');
    badge.className = 'citizen-portal-badge';
    badge.src = 'assets/logo.svg';
    badge.alt = '';
    badge.setAttribute('aria-hidden', 'true');
    const wordmark = document.createElement('span');
    wordmark.className = 'citizen-portal-wordmark';
    wordmark.textContent = 'BARANGUARD';
    brand.append(badge, wordmark);
    const title = document.createElement('h1');
    title.className = 'citizen-portal-title';
    title.textContent = 'Public Transparency Report';
    const subtitle = document.createElement('p');
    subtitle.className = 'citizen-portal-subtitle';
    subtitle.textContent = 'Aggregate, anonymized counts of incidents recorded by your barangay watch. No names, locations, or case details are ever shown here.';
    header.append(brand, title, subtitle);

    const pickerLabel = document.createElement('label');
    pickerLabel.className = 'label';
    pickerLabel.htmlFor = 'transparency-barangay';
    pickerLabel.textContent = 'Select your barangay';

    const picker = document.createElement('select');
    picker.id = 'transparency-barangay';
    for (const b of barangays) {
      const option = document.createElement('option');
      option.value = String(b.barangayId);
      option.textContent = b.name;
      picker.appendChild(option);
    }

    const reportContainer = document.createElement('div');
    reportContainer.className = 'transparency-report-body';

    card.append(header, pickerLabel, picker, reportContainer);

    const getSelectedBarangayName = () => picker.options[picker.selectedIndex]?.text || 'Barangay Watch';
    picker.addEventListener('change', () => loadReport(Number(picker.value), reportContainer, getSelectedBarangayName()));
    loadReport(Number(picker.value), reportContainer, getSelectedBarangayName());
  }

  async function loadReport(barangayId, container, barangayName) {
    container.innerHTML = '';
    const loading = document.createElement('div');
    loading.className = 'state-block';
    loading.setAttribute('role', 'status');
    loading.appendChild(skeletonBlock());
    container.appendChild(loading);

    try {
      const report = await getPublicTransparency(barangayId);
      renderReport(container, report, barangayName);
    } catch (err) {
      container.innerHTML = '';
      const block = document.createElement('div');
      block.className = 'state-block state-block--error';
      block.setAttribute('role', 'alert');
      const text = document.createElement('p');
      if (err instanceof ApiClientError && err.code === 'RATE_LIMITED') {
        text.textContent = 'Too many requests. Please wait a few minutes and try again.';
      } else {
        text.textContent = err instanceof ApiClientError ? err.message : 'Could not load the transparency report.';
      }
      const retryButton = document.createElement('button');
      retryButton.className = 'primary';
      retryButton.textContent = 'Retry';
      retryButton.addEventListener('click', () => loadReport(barangayId, container, barangayName));
      block.append(text, retryButton);
      container.appendChild(block);
    }
  }

  function renderReport(container, report, barangayName) {
    container.innerHTML = '';

    const topBar = document.createElement('div');
    topBar.className = 'row-between';
    topBar.style.flexWrap = 'wrap';
    topBar.style.gap = 'var(--spacing-sm)';

    const periodNote = document.createElement('p');
    periodNote.className = 'note';
    periodNote.style.margin = '0';
    periodNote.textContent = `Covers the last ${report.periodMonths} months, as of ${report.generatedAt} UTC.`;

    const printBtn = document.createElement('button');
    printBtn.type = 'button';
    printBtn.id = 'print-transparency-btn';
    printBtn.className = 'ghost';
    printBtn.innerHTML = `${icons.printer(15)} <span>Print Summary</span>`;
    printBtn.addEventListener('click', () => {
      openTransparencyPrintModal(report, barangayName);
    });

    topBar.append(periodNote, printBtn);
    container.appendChild(topBar);

    const statGrid = document.createElement('div');
    statGrid.className = 'stat-card-grid';
    statGrid.append(
      statCard(String(report.totalIncidents), 'Total Incidents'),
      statCard(String(report.resolvedIncidents), 'Resolved'),
      statCard(report.resolutionRatePercent === null ? '—' : `${report.resolutionRatePercent}%`, 'Resolution Rate')
    );
    container.appendChild(statGrid);

    if (report.byType.length > 0) {
      const typeHeading = document.createElement('h3');
      typeHeading.textContent = 'By Category';
      container.appendChild(typeHeading);

      const typeList = document.createElement('ul');
      typeList.className = 'transparency-type-list';
      for (const row of report.byType) {
        const li = document.createElement('li');
        const label = document.createElement('span');
        label.textContent = row.label;
        const value = document.createElement('span');
        value.textContent = String(row.incidents);
        li.append(label, value);
        typeList.appendChild(li);
      }
      container.appendChild(typeList);
    }

    if (report.byMonth.length > 0) {
      const monthHeading = document.createElement('h3');
      monthHeading.textContent = 'By Month';
      container.appendChild(monthHeading);

      const monthList = document.createElement('ul');
      monthList.className = 'transparency-type-list';
      for (const row of report.byMonth) {
        const li = document.createElement('li');
        const label = document.createElement('span');
        label.textContent = row.month;
        const value = document.createElement('span');
        value.textContent = String(row.incidents);
        li.append(label, value);
        monthList.appendChild(li);
      }
      container.appendChild(monthList);
    }

    const notesHeading = document.createElement('h4');
    notesHeading.textContent = 'Notes';
    container.appendChild(notesHeading);
    const notesList = document.createElement('ul');
    notesList.className = 'transparency-notes';
    for (const note of report.notes) {
      const li = document.createElement('li');
      li.textContent = note;
      notesList.appendChild(li);
    }
    container.appendChild(notesList);

    const backLink = document.createElement('a');
    backLink.href = '#/citizen-report';
    backLink.textContent = 'Back to incident reporting';
    backLink.className = 'note';
    container.appendChild(backLink);
  }

  function statCard(value, label) {
    const el = document.createElement('div');
    el.className = 'stat-card';
    const valueEl = document.createElement('div');
    valueEl.className = 'stat-card__value stat-card__value--primary';
    valueEl.textContent = value;
    const labelEl = document.createElement('div');
    labelEl.className = 'stat-card__label';
    labelEl.textContent = label;
    el.append(valueEl, labelEl);
    return el;
  }

  function skeletonLine(width) {
    const el = document.createElement('div');
    el.className = 'skeleton skeleton--line';
    el.style.width = width;
    el.style.margin = '0 auto 1rem';
    return el;
  }

  function skeletonBlock() {
    const el = document.createElement('div');
    el.className = 'skeleton skeleton--block';
    el.style.height = '10rem';
    return el;
  }

  function openTransparencyPrintModal(report, barangayName) {
    const officeLabel = barangayName || 'Barangay Watch';
    const resRateStr = report.resolutionRatePercent === null ? '—' : `${report.resolutionRatePercent}%`;
    const typeRowsHtml = (report.byType || []).map((row) => `
      <tr>
        <td>${escapeHtml(row.label)}</td>
        <td class="print-sheet__table-num">${escapeHtml(String(row.incidents))}</td>
      </tr>
    `).join('');
    const monthRowsHtml = (report.byMonth || []).map((row) => `
      <tr>
        <td>${escapeHtml(row.month)}</td>
        <td class="print-sheet__table-num">${escapeHtml(String(row.incidents))}</td>
      </tr>
    `).join('');
    const notesText = (report.notes || []).map((n) => `• ${n}`).join('\n');

    const sheetHtml = `
      <div class="print-sheet__header">
        <p class="print-sheet__republic">Republic of the Philippines</p>
        <p class="print-sheet__office">${escapeHtml(officeLabel)}</p>
        <h3 class="print-sheet__title">Public Incident Transparency Summary</h3>
        <p class="print-sheet__subline">Covers the last ${escapeHtml(String(report.periodMonths))} months · As of ${escapeHtml(String(report.generatedAt))} UTC</p>
        <div>
          <span class="print-sheet__badge print-sheet__badge--finalized">Anonymized Public Record (RA 10173 Compliant)</span>
        </div>
      </div>

      <div class="print-sheet__kpi-grid">
        <div class="print-sheet__kpi-card">
          <div class="print-sheet__meta-label">Total Incidents</div>
          <div class="print-sheet__kpi-val">${escapeHtml(String(report.totalIncidents))}</div>
          <div class="print-sheet__kpi-sub">Last ${escapeHtml(String(report.periodMonths))} months</div>
        </div>
        <div class="print-sheet__kpi-card">
          <div class="print-sheet__meta-label">Resolved Cases</div>
          <div class="print-sheet__kpi-val">${escapeHtml(String(report.resolvedIncidents))}</div>
          <div class="print-sheet__kpi-sub">Closed / settled</div>
        </div>
        <div class="print-sheet__kpi-card">
          <div class="print-sheet__meta-label">Resolution Rate</div>
          <div class="print-sheet__kpi-val">${escapeHtml(resRateStr)}</div>
          <div class="print-sheet__kpi-sub">Community resolution</div>
        </div>
        <div class="print-sheet__kpi-card">
          <div class="print-sheet__meta-label">Categories Tracked</div>
          <div class="print-sheet__kpi-val">${escapeHtml(String((report.byType || []).length))}</div>
          <div class="print-sheet__kpi-sub">Pooled for privacy</div>
        </div>
      </div>

      ${typeRowsHtml ? `
        <div class="print-sheet__section">
          <h4 class="print-sheet__section-title">Incidents by Category</h4>
          <table class="print-sheet__table">
            <thead>
              <tr>
                <th>Category</th>
                <th class="print-sheet__table-num">Recorded Incidents</th>
              </tr>
            </thead>
            <tbody>
              ${typeRowsHtml}
            </tbody>
          </table>
        </div>
      ` : ''}

      ${monthRowsHtml ? `
        <div class="print-sheet__section">
          <h4 class="print-sheet__section-title">Incidents by Month</h4>
          <table class="print-sheet__table">
            <thead>
              <tr>
                <th>Month</th>
                <th class="print-sheet__table-num">Recorded Incidents</th>
              </tr>
            </thead>
            <tbody>
              ${monthRowsHtml}
            </tbody>
          </table>
        </div>
      ` : ''}

      <div class="print-sheet__section">
        <h4 class="print-sheet__section-title">Privacy &amp; Methodology Notes</h4>
        <div class="print-sheet__narrative">${escapeHtml(notesText)}</div>
      </div>

      <div class="print-sheet__footer">
        <span>Published via Baranguard Public Transparency Portal · ${escapeHtml(String(report.generatedAt))} UTC</span>
        <span>Aggregate &amp; Anonymized Data Only</span>
      </div>
    `;

    openPrintPreviewModal({
      title: 'Public Transparency Summary',
      subtitle: `${officeLabel} · Last ${report.periodMonths} months`,
      sheetId: 'printable-transparency-sheet',
      sheetHtml,
    });
  }
}

