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
import { confirmDialog } from '../components/ConfirmDialog.js';
import { escapeHtml } from '../utils/escapeHtml.js';
import { manilaDateKey } from '../utils/manilaTime.js';

const VERSION_PATTERN = /^[A-Za-z0-9._-]{1,64}$/;
const MAX_BYTES = 500 * 1024 * 1024; // 500 MB server ceiling

const BARANGAY_NAMES = {
  1: 'Dao',
  2: 'Binanuahan',
  3: 'Marifosque',
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
  // Manila calendar day, not the browser's (Rule 11).
  return manilaDateKey(new Date()).replace(/-/g, '.');
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
        <span class="map-pkg-banner__badge">Works without internet</span>
      </div>
      <p class="map-pkg-banner__text">
        Patrolling Tanods use a map file (.mbtiles) stored on their phones to see roads, alleys, rivers, and evacuation centers
        without internet or a mobile signal. Their phones check for a newer published map each time they sign in.
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
        <span>About the map file</span>
      </div>
      <p class="map-pkg-guide-card__text">
        The map file holds the roads, terrain, and barangay boundaries for your area at the zoom levels used in the field,
        so it can be used with no connection.
      </p>
    </div>
    <div class="map-pkg-guide-card">
      <div class="map-pkg-guide-card__header">
        <span class="map-pkg-guide-card__icon">${icons.radio(16)}</span>
        <span>How phones get the map</span>
      </div>
      <p class="map-pkg-guide-card__text">
        When a Tanod signs in, the phone checks whether a newer map has been published. If so, it downloads it in the background
        without interrupting dispatch work.
      </p>
    </div>
    <div class="map-pkg-guide-card">
      <div class="map-pkg-guide-card__header">
        <span class="map-pkg-guide-card__icon">${icons.shield(16)}</span>
        <span>During a blackout</span>
      </div>
      <p class="map-pkg-guide-card__text">
        The map is stored on the phone, so during typhoons and mobile network outages patrol teams can still see the map,
        mark where an incident is, and record their route.
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
        label: 'Published map version',
        value: isPublished ? `v${pkg.version}` : 'None published',
        tone: isPublished ? 'success' : 'neutral',
        icon: icons.map(16),
      },
      {
        label: 'File check code',
        value: isPublished ? 'Recorded' : 'Awaiting map file',
        tone: isPublished ? 'primary' : 'neutral',
        icon: icons.shield(16),
      },
      {
        label: 'Tanod phones',
        value: isPublished ? 'Download at sign-in' : 'No offline map yet',
        tone: isPublished ? 'info' : 'neutral',
        icon: icons.send(16),
      },
      {
        label: 'Largest file allowed',
        value: '500 MB',
        tone: 'neutral',
        icon: icons.layers(16),
      },
    ];

    statItems.forEach((item) => {
      const card = document.createElement('div');
      card.className = 'stat-card';

      const val = document.createElement('span');
      val.className = `stat-card__value stat-card__value--${item.tone}`;
      val.innerHTML = `${item.icon}<span>${escapeHtml(item.value)}</span>`;

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
    title.textContent = 'Current barangay map';

    titleWrap.append(iconSpan, title);

    const pill = document.createElement('span');
    pill.className = `status-pill ${pkg ? 'status-pill--success' : 'status-pill--neutral'}`;
    pill.textContent = pkg ? 'Published' : 'No map published';

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
      emptyTitle.textContent = 'No offline map published';

      const emptyDesc = document.createElement('p');
      emptyDesc.className = 'map-pkg-empty-desc';
      emptyDesc.textContent = `Brgy. ${barangayName} does not have an offline map published yet. Use the form to publish an .mbtiles map file for your patrolling tanods.`;

      emptyState.append(emptyIcon, emptyTitle, emptyDesc);
      bodyEl.appendChild(emptyState);
    } else {
      const detailsList = document.createElement('div');
      detailsList.className = 'map-pkg-details-list';

      // Item 1: Jurisdiction
      const brgyItem = document.createElement('div');
      brgyItem.className = 'map-pkg-detail-item';
      brgyItem.innerHTML = `
        <span class="map-pkg-detail-label">Barangay</span>
        <span class="map-pkg-detail-val">Brgy. ${escapeHtml(barangayName)}</span>
      `;

      // Item 2: Version
      const versionItem = document.createElement('div');
      versionItem.className = 'map-pkg-detail-item';
      versionItem.innerHTML = `
        <span class="map-pkg-detail-label">Current Published Version</span>
        <span class="map-pkg-detail-val map-pkg-detail-val--version">v${escapeHtml(pkg.version)}</span>
      `;

      // Item 3: Device Sync Status
      const syncItem = document.createElement('div');
      syncItem.className = 'map-pkg-detail-item';
      syncItem.innerHTML = `
        <span class="map-pkg-detail-label">Tanod phones</span>
        <span class="map-pkg-detail-val map-pkg-detail-val--ok">
          <span aria-hidden="true">${icons.checkCircle(14)}</span>
          <span>In use. Patrol phones download this version when they sign in.</span>
        </span>
      `;

      // Item 4: Cryptographic Checksum with Copy button
      const checksumItem = document.createElement('div');
      checksumItem.className = 'map-pkg-detail-item';

      const checksumLabel = document.createElement('span');
      checksumLabel.className = 'map-pkg-detail-label';
      checksumLabel.textContent = 'File check code (SHA-256). Used to confirm the file was not damaged.';

      const checksumBox = document.createElement('div');
      checksumBox.className = 'map-pkg-checksum-box';

      const checksumText = document.createElement('code');
      checksumText.className = 'map-pkg-checksum-text';
      checksumText.textContent = pkg.checksumSha256;
      checksumText.title = pkg.checksumSha256;

      const copyBtn = document.createElement('button');
      copyBtn.type = 'button';
      copyBtn.className = 'map-pkg-btn-copy';
      copyBtn.innerHTML = `${icons.copy(12)}<span>Copy code</span>`;

      copyBtn.addEventListener('click', async () => {
        try {
          await navigator.clipboard.writeText(pkg.checksumSha256);
          copyBtn.innerHTML = `${icons.checkCircle(12)}<span>Copied</span>`;
          setTimeout(() => {
            copyBtn.innerHTML = `${icons.copy(12)}<span>Copy code</span>`;
          }, 2000);
        } catch {
          showToast('Could not copy the code to the clipboard', { variant: 'error' });
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
    title.textContent = 'Publish a new map';

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
    versionLabel.textContent = 'Map version';
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
    fileLabel.textContent = 'Map file (.mbtiles)';
    fileLabel.htmlFor = 'map-package-file';

    const fileInput = document.createElement('input');
    fileInput.id = 'map-package-file';
    fileInput.type = 'file';
    fileInput.accept = '.mbtiles';
    fileInput.hidden = true;

    const dropzone = document.createElement('div');
    dropzone.className = 'map-pkg-dropzone';
    dropzone.setAttribute('tabindex', '0');
    dropzone.setAttribute('role', 'button');
    dropzone.setAttribute('aria-label', 'Choose the .mbtiles map file to upload');

    dropzone.innerHTML = `
      <div class="map-pkg-dropzone__icon" aria-hidden="true">${icons.layers(28)}</div>
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
    fileIcon.className = 'map-pkg-file-icon';
    fileIcon.setAttribute('aria-hidden', 'true');
    fileIcon.innerHTML = icons.fileText(20);

    const fileNameWrap = document.createElement('div');
    fileNameWrap.className = 'map-pkg-file-name-wrap';

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
        showToast('That is not a map file. Please choose a file ending in .mbtiles.', { variant: 'error' });
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
      <span role="status">Uploading and checking the map file. Please wait.</span>
    `;

    // 4. Submit Button
    const submitButton = document.createElement('button');
    submitButton.type = 'submit';
    submitButton.className = 'primary';
    submitButton.classList.add('map-pkg-submit');
    submitButton.innerHTML = `<span aria-hidden="true">${icons.map(16)}</span><span>Publish to Barangay Tanods</span>`;

    form.append(versionField, fileField, uploadingBox, submitButton);
    bodyEl.appendChild(form);
    card.append(headerEl, bodyEl);

    // Form Submit Handler
    form.addEventListener('submit', async (e) => {
      e.preventDefault();

      const version = versionInput.value.trim();
      if (!VERSION_PATTERN.test(version)) {
        showToast('The version can be up to 64 characters: letters, numbers, dots, dashes or underscores only.', { variant: 'error' });
        versionInput.focus();
        return;
      }

      if (!selectedFile) {
        showToast('Please choose or drag the .mbtiles map file to publish.', { variant: 'error' });
        return;
      }

      // Publishing replaces the map every Tanod phone downloads next sign-in,
      // so name what is live now and what will replace it (audit A-30).
      let liveVersion = null;
      try { liveVersion = (await getMapPackage(user.barangayId))?.version || null; } catch { /* confirm without it */ }
      const ok = await confirmDialog({
        title: 'Publish this map to all Tanod phones?',
        description: liveVersion
          ? `Version ${version} will replace the map now in use (version ${liveVersion}). Every patrol phone will download it the next time it signs in.`
          : `Version ${version} will become the offline map for Brgy. ${barangayName}. Every patrol phone will download it the next time it signs in.`,
        confirmLabel: 'Publish map',
        cancelLabel: 'Not yet',
      });
      if (!ok) return;

      submitButton.disabled = true;
      versionInput.disabled = true;
      removeBtn.disabled = true;
      quickDateBtn.disabled = true;
      uploadingBox.hidden = false;

      try {
        await uploadMapPackage(version, selectedFile);
        showToast(`Map version ${version} published.`, { variant: 'success' });
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
