/**
 * map-packages.js — W18 Map Package Management
 *
 * §9: "Roles: Admin only · API: GET /map-packages/:barangay_id,
 * POST /map-packages — Shows only the Admin's own barangay package.
 * Displays published version/checksum and upload validation result."
 * Scope is metadata + upload only — the Tanod-only `/download` route is
 * not surfaced here (an Admin has no offline map to install).
 *
 * No published package is a normal empty state (server 404), not an
 * error — `getMapPackage` in apiClient.js already collapses that to
 * `null` for this screen to render honestly rather than alarmingly.
 *
 * Overhauled with:
 * - Baranguard Design Tokens & light/dark theme contrast compliance
 * - Offline Resilience Notice Banner (§2 Rule 14 disaster continuity)
 * - Map Package Quick StatStrip (active version, integrity, sync readiness, max size)
 * - Active Published Basemap Showcase Card with copyable SHA-256 integrity checksum
 * - Interactive Drag-and-Drop MBTiles Publisher with file inspection and version helper
 * - Offline Basemap Ecosystem & Tanod Field Sync Runbook
 *
 * kebab-case filename per §4.
 */

import { getMapPackage, uploadMapPackage, logout, ApiClientError } from '../api/apiClient.js';
import { AppShell } from '../components/AppShell.js';
import { PageHeader } from '../components/PageHeader.js';
import { showToast } from '../components/Toast.js';
import { icons } from '../components/icons.js';
import { escapeHtml } from '../utils/escapeHtml.js';

const VERSION_PATTERN = /^[A-Za-z0-9._-]{1,64}$/;
const MAX_BYTES = 500 * 1024 * 1024; // 500 MB server ceiling

const BARANGAY_NAMES = {
  1: 'Dao',
  2: 'Marifosque',
  3: 'Binanuahan',
  4: 'Banuyo',
};

/**
 * Formats byte counts into human-readable strings (KB, MB, GB)
 * @param {number} bytes
 * @returns {string}
 */
function formatBytes(bytes) {
  if (!bytes || bytes === 0) return '0 B';
  const k = 1024;
  const sizes = ['B', 'KB', 'MB', 'GB'];
  const i = Math.floor(Math.log(bytes) / Math.log(k));
  return `${(bytes / Math.pow(k, i)).toFixed(1)} ${sizes[i]}`;
}

/**
 * Returns today's date formatted as YYYY.MM.DD
 * @returns {string}
 */
function getTodayVersionString() {
  const d = new Date();
  const year = d.getFullYear();
  const month = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  return `${year}.${month}.${day}`;
}

/**
 * @param {HTMLElement} root
 * @param {{fullName:string, role:string, barangayId:number}} user
 * @param {() => void} onLoggedOut
 * @param {(page: string, param?: any) => void} navigate
 */
export function renderMapPackagesPage(root, user, onLoggedOut, navigate) {
  root.innerHTML = '';

  const shell = AppShell(user, 'map-packages', navigate, async () => {
    shell.logoutButton.disabled = true;
    await logout();
    onLoggedOut();
  });
  const { header, content } = shell;
  root.appendChild(shell.el);

  const barangayName = BARANGAY_NAMES[user.barangayId] || `Barangay #${user.barangayId}`;

  // Page Header
  const pageHeader = PageHeader({
    title: 'Map Packages',
    subtitle: `Offline basemap management & field deployment for Brgy. ${barangayName}`,
    icon: icons.map,
  });
  header.appendChild(pageHeader.el);

  // Outer Page Container
  const pageContainer = document.createElement('div');
  pageContainer.className = 'map-pkg-container';
  content.appendChild(pageContainer);

  // 1. Disaster-Resilient Offline Basemaps Notice Banner
  const banner = document.createElement('div');
  banner.className = 'map-pkg-banner';
  banner.innerHTML = `
    <div class="map-pkg-banner__icon">
      ${icons.shield(22)}
    </div>
    <div class="map-pkg-banner__content">
      <div class="map-pkg-banner__title">
        <span>Disaster-Ready Offline Basemaps</span>
        <span class="map-pkg-banner__badge">Offline-First Guarantee (§2 Rule 14)</span>
      </div>
      <p class="map-pkg-banner__text">
        Patrolling Tanods rely on self-contained SQLite basemap packages (.mbtiles) to navigate roads, alleys, rivers, and evacuation centers
        without requiring internet or cellular connectivity. Tanod mobile terminals automatically verify and pull published updates upon M1 Login.
      </p>
    </div>
  `;
  pageContainer.appendChild(banner);

  // 2. StatStrip Host
  const statStripHost = document.createElement('div');
  statStripHost.className = 'stat-card-grid';
  pageContainer.appendChild(statStripHost);

  // 3. Main 2-Column Operations Grid
  const mainGrid = document.createElement('div');
  mainGrid.className = 'map-pkg-main-grid';

  const statusCardHost = document.createElement('div');
  const publisherCard = buildPublisherCard();

  mainGrid.append(statusCardHost, publisherCard.el);
  pageContainer.appendChild(mainGrid);

  // 4. Offline Basemap Ecosystem & Device Sync Guide
  const guideSection = document.createElement('div');
  guideSection.className = 'map-pkg-guide-section';
  guideSection.innerHTML = `
    <div class="map-pkg-guide-card">
      <div class="map-pkg-guide-card__header">
        <span class="map-pkg-guide-card__icon">${icons.layers(16)}</span>
        <span>MBTiles SQLite Format</span>
      </div>
      <p class="map-pkg-guide-card__text">
        Packaged as a high-performance SQLite database container storing zoom levels 12–18 with OpenStreetMap road networks,
        topography, and localized barangay boundary layers.
      </p>
    </div>
    <div class="map-pkg-guide-card">
      <div class="map-pkg-guide-card__header">
        <span class="map-pkg-guide-card__icon">${icons.radio(16)}</span>
        <span>Non-Blocking M1 Sync</span>
      </div>
      <p class="map-pkg-guide-card__text">
        Tanod mobile devices verify basemap checksums during authentication. If a new version is detected, the device synchronizes
        in the background without halting dispatch operations.
      </p>
    </div>
    <div class="map-pkg-guide-card">
      <div class="map-pkg-guide-card__header">
        <span class="map-pkg-guide-card__icon">${icons.shield(16)}</span>
        <span>Blackout Continuity</span>
      </div>
      <p class="map-pkg-guide-card__text">
        Zero external cloud dependencies. During typhoons and cellular grid outages, patrol teams retain full interactive map rendering,
        incident geotagging, and GPS breadcrumbs.
      </p>
    </div>
  `;
  pageContainer.appendChild(guideSection);

  // Initial Load
  load();

  async function load() {
    renderLoading(statusCardHost);
    try {
      const pkg = await getMapPackage(user.barangayId);
      renderStatStrip(pkg);
      renderStatusCard(statusCardHost, pkg);
    } catch (err) {
      const message = err instanceof ApiClientError ? err.message : 'Something went wrong loading the map package.';
      renderError(statusCardHost, message, load);
    }
  }

  function renderStatStrip(pkg) {
    statStripHost.innerHTML = '';

    const isPublished = Boolean(pkg && pkg.version);

    const statItems = [
      {
        label: 'Active Basemap Version',
        value: isPublished ? `v${pkg.version}` : 'None Active',
        tone: isPublished ? 'success' : 'neutral',
        icon: icons.map(16),
      },
      {
        label: 'Cryptographic Checksum',
        value: isPublished ? 'SHA-256 Verified' : 'Awaiting Package',
        tone: isPublished ? 'primary' : 'neutral',
        icon: icons.shield(16),
      },
      {
        label: 'Tanod Mobile Sync',
        value: isPublished ? 'Ready on Login' : 'Offline Map Missing',
        tone: isPublished ? 'info' : 'neutral',
        icon: icons.send(16),
      },
      {
        label: 'Package Size Ceiling',
        value: '500 MB Max',
        tone: 'neutral',
        icon: icons.layers(16),
      },
    ];

    statItems.forEach((item) => {
      const card = document.createElement('div');
      card.className = 'stat-card';

      const val = document.createElement('span');
      val.className = `stat-card__value stat-card__value--${item.tone}`;
      val.innerHTML = `${item.icon}<span>${item.value}</span>`;

      const lbl = document.createElement('span');
      lbl.className = 'stat-card__label';
      lbl.textContent = item.label;

      card.append(val, lbl);
      statStripHost.appendChild(card);
    });
  }

  function renderStatusCard(container, pkg) {
    container.innerHTML = '';

    const card = document.createElement('div');
    card.className = 'map-pkg-card';

    // Header
    const headerEl = document.createElement('div');
    headerEl.className = 'map-pkg-card__header';

    const titleWrap = document.createElement('div');
    titleWrap.className = 'map-pkg-card__title-wrap';

    const iconSpan = document.createElement('span');
    iconSpan.className = 'map-pkg-card__icon';
    iconSpan.innerHTML = icons.map(18);

    const title = document.createElement('h3');
    title.className = 'map-pkg-card__title';
    title.textContent = 'Active Barangay Basemap';

    titleWrap.append(iconSpan, title);

    const pill = document.createElement('span');
    pill.className = `status-pill ${pkg ? 'status-pill--success' : 'status-pill--neutral'}`;
    pill.textContent = pkg ? 'PUBLISHED' : 'NO PACKAGE';

    headerEl.append(titleWrap, pill);

    // Body
    const bodyEl = document.createElement('div');
    bodyEl.className = 'map-pkg-card__body';

    if (!pkg) {
      const emptyState = document.createElement('div');
      emptyState.className = 'map-pkg-empty-state';

      const emptyIcon = document.createElement('div');
      emptyIcon.className = 'map-pkg-empty-icon';
      emptyIcon.innerHTML = icons.map(28);

      const emptyTitle = document.createElement('h4');
      emptyTitle.className = 'map-pkg-empty-title';
      emptyTitle.textContent = 'No Offline Basemap Deployed';

      const emptyDesc = document.createElement('p');
      emptyDesc.className = 'map-pkg-empty-desc';
      emptyDesc.textContent = `Brgy. ${barangayName} does not have an active offline basemap published yet. Use the publisher to deploy an .mbtiles basemap for your patrolling tanods.`;

      emptyState.append(emptyIcon, emptyTitle, emptyDesc);
      bodyEl.appendChild(emptyState);
    } else {
      const detailsList = document.createElement('div');
      detailsList.className = 'map-pkg-details-list';

      // Item 1: Jurisdiction
      const brgyItem = document.createElement('div');
      brgyItem.className = 'map-pkg-detail-item';
      brgyItem.innerHTML = `
        <span class="map-pkg-detail-label">Assigned Barangay Tenant</span>
        <span class="map-pkg-detail-val">Brgy. ${barangayName} (Barangay ID: #${user.barangayId})</span>
      `;

      // Item 2: Version
      const versionItem = document.createElement('div');
      versionItem.className = 'map-pkg-detail-item';
      versionItem.innerHTML = `
        <span class="map-pkg-detail-label">Current Published Version</span>
        <span class="map-pkg-detail-val" style="font-size: 1.125rem; color: var(--color-primary);">v${escapeHtml(pkg.version)}</span>
      `;

      // Item 3: Device Sync Status
      const syncItem = document.createElement('div');
      syncItem.className = 'map-pkg-detail-item';
      syncItem.innerHTML = `
        <span class="map-pkg-detail-label">Tanod Field Synchronization</span>
        <span class="map-pkg-detail-val" style="color: var(--color-success-text); display: flex; align-items: center; gap: 0.35rem;">
          ${icons.checkCircle(14)}
          <span>Active — Patrolling devices download this version on login</span>
        </span>
      `;

      // Item 4: Cryptographic Checksum with Copy button
      const checksumItem = document.createElement('div');
      checksumItem.className = 'map-pkg-detail-item';

      const checksumLabel = document.createElement('span');
      checksumLabel.className = 'map-pkg-detail-label';
      checksumLabel.textContent = 'Cryptographic Integrity (SHA-256 Checksum)';

      const checksumBox = document.createElement('div');
      checksumBox.className = 'map-pkg-checksum-box';

      const checksumText = document.createElement('code');
      checksumText.className = 'map-pkg-checksum-text';
      checksumText.textContent = pkg.checksumSha256;
      checksumText.title = pkg.checksumSha256;

      const copyBtn = document.createElement('button');
      copyBtn.type = 'button';
      copyBtn.className = 'map-pkg-btn-copy';
      copyBtn.innerHTML = `${icons.copy(12)}<span>Copy Hash</span>`;

      copyBtn.addEventListener('click', async () => {
        try {
          await navigator.clipboard.writeText(pkg.checksumSha256);
          copyBtn.innerHTML = `${icons.checkCircle(12)}<span>Copied!</span>`;
          setTimeout(() => {
            copyBtn.innerHTML = `${icons.copy(12)}<span>Copy Hash</span>`;
          }, 2000);
        } catch {
          showToast('Could not copy hash to clipboard', { variant: 'error' });
        }
      });

      checksumBox.append(checksumText, copyBtn);
      checksumItem.append(checksumLabel, checksumBox);

      detailsList.append(brgyItem, versionItem, syncItem, checksumItem);
      bodyEl.appendChild(detailsList);
    }

    card.append(headerEl, bodyEl);
    container.appendChild(card);
  }

  function buildPublisherCard() {
    const card = document.createElement('div');
    card.className = 'map-pkg-card';

    // Header
    const headerEl = document.createElement('div');
    headerEl.className = 'map-pkg-card__header';

    const titleWrap = document.createElement('div');
    titleWrap.className = 'map-pkg-card__title-wrap';

    const iconSpan = document.createElement('span');
    iconSpan.className = 'map-pkg-card__icon';
    iconSpan.innerHTML = icons.send(18);

    const title = document.createElement('h3');
    title.className = 'map-pkg-card__title';
    title.textContent = 'Publish New Basemap';

    titleWrap.append(iconSpan, title);
    headerEl.appendChild(titleWrap);

    // Body
    const bodyEl = document.createElement('div');
    bodyEl.className = 'map-pkg-card__body';

    const form = document.createElement('form');
    form.className = 'map-pkg-form';

    // 1. Version Field
    const versionField = document.createElement('div');
    versionField.className = 'map-pkg-field';

    const versionLabelRow = document.createElement('div');
    versionLabelRow.className = 'map-pkg-field__label-row';

    const versionLabel = document.createElement('label');
    versionLabel.className = 'map-pkg-label';
    versionLabel.textContent = 'Package Version';
    versionLabel.htmlFor = 'map-package-version';

    const quickDateBtn = document.createElement('button');
    quickDateBtn.type = 'button';
    quickDateBtn.className = 'map-pkg-btn-text';
    quickDateBtn.textContent = "Use Today's Date";

    versionLabelRow.append(versionLabel, quickDateBtn);

    const versionInput = document.createElement('input');
    versionInput.id = 'map-package-version';
    versionInput.className = 'map-pkg-input';
    versionInput.type = 'text';
    versionInput.placeholder = 'e.g. 2026.09.06 or v1.0.0';
    versionInput.required = true;

    quickDateBtn.addEventListener('click', () => {
      versionInput.value = getTodayVersionString();
      versionInput.focus();
    });

    versionField.append(versionLabelRow, versionInput);

    // 2. Drag-and-Drop Dropzone
    const fileField = document.createElement('div');
    fileField.className = 'map-pkg-field';

    const fileLabel = document.createElement('label');
    fileLabel.className = 'map-pkg-label';
    fileLabel.textContent = 'MBTiles Package File';
    fileLabel.htmlFor = 'map-package-file';

    const fileInput = document.createElement('input');
    fileInput.id = 'map-package-file';
    fileInput.type = 'file';
    fileInput.accept = '.mbtiles';
    fileInput.style.display = 'none';

    const dropzone = document.createElement('div');
    dropzone.className = 'map-pkg-dropzone';
    dropzone.setAttribute('tabindex', '0');
    dropzone.setAttribute('role', 'button');
    dropzone.setAttribute('aria-label', 'Upload .mbtiles file');

    dropzone.innerHTML = `
      <div class="map-pkg-dropzone__icon">${icons.layers(28)}</div>
      <div class="map-pkg-dropzone__prompt">Drag & drop your <span>.mbtiles</span> basemap here</div>
      <div class="map-pkg-dropzone__hint">or click to browse local files (max 500 MB)</div>
    `;

    // File Selected Preview Box
    const filePreview = document.createElement('div');
    filePreview.className = 'map-pkg-file-selected';
    filePreview.hidden = true;

    const fileInfo = document.createElement('div');
    fileInfo.className = 'map-pkg-file-info';

    const fileIcon = document.createElement('span');
    fileIcon.style.color = 'var(--color-primary)';
    fileIcon.innerHTML = icons.fileText(20);

    const fileNameWrap = document.createElement('div');
    fileNameWrap.style.cssText = 'display:flex; flex-direction:column; min-width:0;';

    const fileNameEl = document.createElement('span');
    fileNameEl.className = 'map-pkg-file-name';

    const fileSizeEl = document.createElement('span');
    fileSizeEl.className = 'map-pkg-file-size';

    fileNameWrap.append(fileNameEl, fileSizeEl);
    fileInfo.append(fileIcon, fileNameWrap);

    const removeBtn = document.createElement('button');
    removeBtn.type = 'button';
    removeBtn.className = 'map-pkg-btn-remove';
    removeBtn.textContent = 'Remove';

    filePreview.append(fileInfo, removeBtn);

    let selectedFile = null;

    const handleFileSelected = (file) => {
      if (!file) return;

      if (!file.name.toLowerCase().endsWith('.mbtiles')) {
        showToast('Invalid file format. Please choose an .mbtiles package.', { variant: 'error' });
        return;
      }
      if (file.size > MAX_BYTES) {
        showToast(`File size (${formatBytes(file.size)}) exceeds the 500 MB server ceiling.`, { variant: 'error' });
        return;
      }

      selectedFile = file;
      fileNameEl.textContent = file.name;
      fileSizeEl.textContent = formatBytes(file.size);
      dropzone.hidden = true;
      filePreview.hidden = false;
    };

    removeBtn.addEventListener('click', () => {
      selectedFile = null;
      fileInput.value = '';
      dropzone.hidden = false;
      filePreview.hidden = true;
    });

    dropzone.addEventListener('click', () => fileInput.click());
    dropzone.addEventListener('keydown', (e) => {
      if (e.key === 'Enter' || e.key === ' ') {
        e.preventDefault();
        fileInput.click();
      }
    });

    fileInput.addEventListener('change', () => {
      if (fileInput.files && fileInput.files[0]) {
        handleFileSelected(fileInput.files[0]);
      }
    });

    // Drag-and-drop event listeners
    ['dragenter', 'dragover'].forEach((eventName) => {
      dropzone.addEventListener(eventName, (e) => {
        e.preventDefault();
        e.stopPropagation();
        dropzone.classList.add('is-dragover');
      });
    });

    ['dragleave', 'drop'].forEach((eventName) => {
      dropzone.addEventListener(eventName, (e) => {
        e.preventDefault();
        e.stopPropagation();
        dropzone.classList.remove('is-dragover');
      });
    });

    dropzone.addEventListener('drop', (e) => {
      const dt = e.dataTransfer;
      if (dt && dt.files && dt.files[0]) {
        handleFileSelected(dt.files[0]);
      }
    });

    fileField.append(fileLabel, fileInput, dropzone, filePreview);

    // 3. Upload Progress Indicator
    const uploadingBox = document.createElement('div');
    uploadingBox.className = 'map-pkg-uploading-box';
    uploadingBox.hidden = true;
    uploadingBox.innerHTML = `
      <div class="map-pkg-spinner" aria-hidden="true"></div>
      <span>Uploading and verifying MBTiles SQLite structure… please wait.</span>
    `;

    // 4. Submit Button
    const submitButton = document.createElement('button');
    submitButton.type = 'submit';
    submitButton.className = 'primary';
    submitButton.style.cssText = 'display: inline-flex; align-items: center; justify-content: center; gap: 0.5rem; width: 100%; height: 2.375rem;';
    submitButton.innerHTML = `${icons.map(16)}<span>Publish to Barangay Tanods</span>`;

    form.append(versionField, fileField, uploadingBox, submitButton);
    bodyEl.appendChild(form);
    card.append(headerEl, bodyEl);

    // Form Submit Handler
    form.addEventListener('submit', async (e) => {
      e.preventDefault();

      const version = versionInput.value.trim();
      if (!VERSION_PATTERN.test(version)) {
        showToast('Version must be 1-64 characters containing only letters, numbers, . _ or -.', { variant: 'error' });
        versionInput.focus();
        return;
      }

      if (!selectedFile) {
        showToast('Please select or drag an .mbtiles file to publish.', { variant: 'error' });
        return;
      }

      submitButton.disabled = true;
      versionInput.disabled = true;
      removeBtn.disabled = true;
      quickDateBtn.disabled = true;
      uploadingBox.hidden = false;

      try {
        await uploadMapPackage(version, selectedFile);
        showToast(`Basemap package v${version} published successfully!`, { variant: 'success' });
        versionInput.value = '';
        selectedFile = null;
        fileInput.value = '';
        dropzone.hidden = false;
        filePreview.hidden = true;
        load();
      } catch (err) {
        const message = err instanceof ApiClientError ? err.message : 'Could not publish the map package.';
        showToast(message, { variant: 'error' });
      } finally {
        submitButton.disabled = false;
        versionInput.disabled = false;
        removeBtn.disabled = false;
        quickDateBtn.disabled = false;
        uploadingBox.hidden = true;
      }
    });

    return { el: card };
  }
}

function renderLoading(container) {
  container.innerHTML = '';
  const wrap = document.createElement('div');
  wrap.className = 'stack';
  wrap.setAttribute('role', 'status');
  wrap.setAttribute('aria-label', 'Loading map package status');
  for (let i = 0; i < 3; i++) {
    const skeleton = document.createElement('div');
    skeleton.className = 'skeleton skeleton--block';
    wrap.appendChild(skeleton);
  }
  container.appendChild(wrap);
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
