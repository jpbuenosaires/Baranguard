/**
 * map-packages.js — W18 Map Package Management (built this cut).
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
 * kebab-case filename per §4.
 */

import { getMapPackage, uploadMapPackage, logout, ApiClientError } from '../api/apiClient.js';
import { AppShell } from '../components/AppShell.js';
import { PageHeader } from '../components/PageHeader.js';
import { showToast } from '../components/Toast.js';
import { icons } from '../components/icons.js';

const VERSION_PATTERN = /^[A-Za-z0-9._-]{1,64}$/;

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

  const pageHeader = PageHeader({
    title: 'Map Packages',
    subtitle: 'Offline basemap package for your barangay',
    icon: icons.map,
  });
  header.appendChild(pageHeader.el);

  const statusBody = document.createElement('div');
  const uploadCard = buildUploadForm();
  content.append(statusBody, uploadCard.el);

  load();

  async function load() {
    renderLoading(statusBody);
    try {
      const pkg = await getMapPackage(user.barangayId);
      renderStatus(statusBody, pkg);
    } catch (err) {
      const message = err instanceof ApiClientError ? err.message : 'Something went wrong loading the map package.';
      renderError(statusBody, message, load);
    }
  }

  function buildUploadForm() {
    const el = document.createElement('form');
    el.className = 'card';

    const versionLabel = document.createElement('label');
    versionLabel.textContent = 'Version';
    versionLabel.htmlFor = 'map-package-version';
    const versionInput = document.createElement('input');
    versionInput.id = 'map-package-version';
    versionInput.type = 'text';
    versionInput.placeholder = 'e.g. 2026.09.05';
    versionInput.required = true;

    const fileLabel = document.createElement('label');
    fileLabel.textContent = 'MBTiles file';
    fileLabel.htmlFor = 'map-package-file';
    const fileInput = document.createElement('input');
    fileInput.id = 'map-package-file';
    fileInput.type = 'file';
    fileInput.accept = '.mbtiles';
    fileInput.required = true;

    const submitButton = document.createElement('button');
    submitButton.type = 'submit';
    submitButton.className = 'primary';
    submitButton.textContent = 'Publish package';

    const progressNote = document.createElement('p');
    progressNote.className = 'note';
    progressNote.hidden = true;

    el.append(versionLabel, versionInput, fileLabel, fileInput, submitButton, progressNote);

    el.addEventListener('submit', async (event) => {
      event.preventDefault();

      const version = versionInput.value.trim();
      if (!VERSION_PATTERN.test(version)) {
        showToast('Version must be 1-64 characters of letters, numbers, . _ or -.', { variant: 'error' });
        return;
      }
      const file = fileInput.files && fileInput.files[0];
      if (!file) {
        showToast('Choose an .mbtiles file to upload.', { variant: 'error' });
        return;
      }

      submitButton.disabled = true;
      versionInput.disabled = true;
      fileInput.disabled = true;
      // No fabricated progress bar — a 500MB upload over localhost can
      // genuinely take a while, and this screen shows what it actually
      // knows (uploading in progress), nothing more (§2 Rule 6).
      progressNote.hidden = false;
      progressNote.textContent = 'Uploading… this can take a while for a large package.';

      try {
        await uploadMapPackage(version, file);
        showToast(`Version ${version} published.`, { variant: 'success' });
        versionInput.value = '';
        fileInput.value = '';
        load();
      } catch (err) {
        // Show the server's real validation message (bad version
        // pattern, not-MBTiles, duplicate version, oversize) verbatim —
        // paraphrasing it could hide which check actually failed.
        const message = err instanceof ApiClientError ? err.message : 'Could not upload the map package.';
        showToast(message, { variant: 'error' });
      } finally {
        submitButton.disabled = false;
        versionInput.disabled = false;
        fileInput.disabled = false;
        progressNote.hidden = true;
      }
    });

    return { el };
  }
}

function renderStatus(container, pkg) {
  container.innerHTML = '';
  const card = document.createElement('div');
  card.className = 'card';

  if (pkg === null) {
    const empty = document.createElement('p');
    empty.className = 'note';
    empty.textContent = 'No map package published yet for this barangay.';
    card.appendChild(empty);
    container.appendChild(card);
    return;
  }

  const pill = document.createElement('span');
  pill.className = 'status-pill status-pill--success';
  pill.textContent = 'Published';

  const versionLine = document.createElement('p');
  versionLine.textContent = `Version: ${pkg.version}`;

  const checksumLine = document.createElement('p');
  checksumLine.className = 'data-table__sub';
  checksumLine.style.fontFamily = 'monospace';
  checksumLine.textContent = `SHA-256: ${pkg.checksumSha256}`;

  card.append(pill, versionLine, checksumLine);
  container.appendChild(card);
}

function renderLoading(container) {
  container.innerHTML = '';
  const wrap = document.createElement('div');
  wrap.className = 'stack';
  wrap.setAttribute('role', 'status');
  wrap.setAttribute('aria-label', 'Loading map package');
  const skeleton = document.createElement('div');
  skeleton.className = 'skeleton skeleton--row';
  wrap.appendChild(skeleton);
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
