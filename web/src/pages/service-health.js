/**
 * service-health.js — W20 Service Health / Recovery (§9): "Roles: Admin
 * only · API: GET /system/health (local-only) · Shows MariaDB, API,
 * OSRM, Ollama, GSM ingestion, notification configuration, and
 * backup/last-restore-test status. This is operational diagnostics, not
 * a public endpoint."
 *
 * The endpoint has existed since the Sprint 1 polish pass and already
 * backs the topbar's status badge; §9 wants a real screen behind it, and
 * that badge's own tooltip was the only place most of these dependencies
 * were ever visible.
 *
 * THE POINT OF THIS SCREEN IS HONESTY ABOUT WHAT ISN'T WIRED UP.
 * §6 gives three coarse statuses, and the distinction between two of
 * them carries the whole meaning:
 *   healthy         — checked, and it answered.
 *   unhealthy       — CONFIGURED, checked, and it failed. Act on this.
 *   not_configured  — never wired up on this deployment. NOT a fault.
 * So `not_configured` renders neutral with an explanation, never as a
 * red error — an OSRM that was never installed is not an outage, and
 * showing it as one would train an operator to ignore the whole screen.
 * Equally, it is never shown green: §8 forbids a fabricated
 * "all systems operational" reading, which is exactly what colouring an
 * unconfigured dependency green would be.
 *
 * kebab-case filename per §4.
 */

import { getSystemHealth, logout, ApiClientError } from '../api/apiClient.js';
import { AppShell } from '../components/AppShell.js';
import { PageHeader } from '../components/PageHeader.js';
import { icons } from '../components/icons.js';

const REFRESH_MS = 30000;

// Ordered by how much an operator cares when it breaks: the two things
// that stop the system entirely come first.
const DEPENDENCIES = [
  { key: 'api', label: 'API', description: 'This endpoint answering at all' },
  { key: 'db', label: 'MariaDB', description: 'Live query against the database' },
  { key: 'osrm', label: 'OSRM routing', description: 'Turn-by-turn routing for dispatch' },
  { key: 'ollama', label: 'Ollama / SEA-LION', description: 'Self-hosted AI redaction model' },
  { key: 'gsmIngestion', label: 'GSM ingestion', description: 'Inbound SMS envelope receiver' },
  { key: 'notificationConfig', label: 'Notification config', description: 'FCM/SMS transport configuration' },
  { key: 'fcm', label: 'FCM push', description: 'Firebase service-account credentials' },
  { key: 'smsSemaphore', label: 'Semaphore SMS', description: 'Outbound SMS gateway credentials' },
];

const STATUS_PILL_CLASS = {
  healthy: 'status-pill--success',
  unhealthy: 'status-pill--critical',
  not_configured: 'status-pill--neutral',
};
const STATUS_LABEL = {
  healthy: 'HEALTHY',
  unhealthy: 'UNHEALTHY',
  not_configured: 'NOT CONFIGURED',
};

/**
 * @param {HTMLElement} root
 * @param {{fullName:string, role:string}} user
 * @param {() => void} onLoggedOut
 * @param {(page: string, param?: any) => void} navigate
 * @returns {{stop: () => void}} polling handle — main.js stops it on navigation
 */
export function renderServiceHealthPage(root, user, onLoggedOut, navigate) {
  root.innerHTML = '';

  const shell = AppShell(user, 'service-health', navigate, async () => {
    shell.logoutButton.disabled = true;
    await logout();
    onLoggedOut();
  });
  const { header, content } = shell;
  root.appendChild(shell.el);

  const pageHeader = PageHeader({
    title: 'Service Health',
    subtitle: 'Operational diagnostics for this workstation — dependencies, backups, restore drills',
    icon: icons.activity,
  });
  header.appendChild(pageHeader.el);

  const freshness = document.createElement('span');
  freshness.className = 'note';
  freshness.setAttribute('role', 'status');
  pageHeader.actions.appendChild(freshness);

  const refreshButton = document.createElement('button');
  refreshButton.type = 'button';
  refreshButton.className = 'ghost';
  refreshButton.textContent = 'Refresh';
  refreshButton.addEventListener('click', () => load());
  pageHeader.actions.appendChild(refreshButton);

  const body = document.createElement('div');
  content.appendChild(body);

  let timer = null;
  load();
  timer = setInterval(() => {
    if (!shell.el.isConnected) { clearInterval(timer); return; }
    load({ background: true });
  }, REFRESH_MS);

  async function load({ background = false } = {}) {
    if (!background) renderLoading(body);
    try {
      const health = await getSystemHealth();
      renderHealth(health);
      freshness.textContent = `Checked ${new Date().toLocaleTimeString()}`;
    } catch (err) {
      // A failed background poll must not blank an already-populated
      // screen — same contract Dispatch Center and GIS already use.
      if (background) return;
      const message = err instanceof ApiClientError ? err.message : 'Could not read service health.';
      renderError(body, message, () => load());
    }
  }

  function renderHealth(health) {
    body.innerHTML = '';

    const unhealthy = DEPENDENCIES.filter((d) => health[d.key] === 'unhealthy');
    const banner = document.createElement('div');
    banner.className = unhealthy.length > 0 ? 'card state-block state-block--error' : 'card state-block';
    if (unhealthy.length > 0) banner.setAttribute('role', 'alert');
    const bannerHeading = document.createElement('h3');
    bannerHeading.textContent = unhealthy.length > 0
      ? `${unhealthy.length} configured ${unhealthy.length === 1 ? 'dependency is' : 'dependencies are'} failing`
      : 'All configured dependencies are responding';
    const bannerText = document.createElement('p');
    bannerText.textContent = unhealthy.length > 0
      ? `Failing: ${unhealthy.map((d) => d.label).join(', ')}.`
      : 'Anything marked "not configured" below has never been wired up on this deployment — that is not a fault.';
    banner.append(bannerHeading, bannerText);
    body.appendChild(banner);

    const card = document.createElement('div');
    card.className = 'card';
    const heading = document.createElement('h3');
    heading.textContent = 'Dependencies';
    card.appendChild(heading);

    const list = document.createElement('div');
    list.className = 'stack';
    for (const dep of DEPENDENCIES) {
      const status = health[dep.key] ?? 'not_configured';
      const row = document.createElement('div');
      row.className = 'row-between health-row';

      const text = document.createElement('span');
      text.className = 'data-table__stacked';
      const name = document.createElement('span');
      name.textContent = dep.label;
      const desc = document.createElement('span');
      desc.className = 'data-table__sub';
      desc.textContent = dep.description;
      text.append(name, desc);

      const pill = document.createElement('span');
      pill.className = `status-pill ${STATUS_PILL_CLASS[status] || 'status-pill--neutral'}`;
      pill.textContent = STATUS_LABEL[status] || String(status).toUpperCase();

      row.append(text, pill);
      list.appendChild(row);
    }
    card.appendChild(list);
    body.appendChild(card);

    // Recovery half of "Service Health / Recovery". §6 is explicit that
    // these read real file timestamps and are null when nothing has run
    // — never a fabricated recent time — so "Never" is a real, and
    // actionable, answer here.
    const recovery = document.createElement('div');
    recovery.className = 'card';
    const recoveryHeading = document.createElement('h3');
    recoveryHeading.textContent = 'Backup & recovery';
    recovery.appendChild(recoveryHeading);

    const fields = document.createElement('dl');
    fields.className = 'detail-fields';
    const addField = (label, value, warn) => {
      const dt = document.createElement('dt');
      dt.textContent = label;
      const dd = document.createElement('dd');
      dd.textContent = value;
      if (warn) dd.classList.add('health-value--warn');
      fields.append(dt, dd);
    };
    addField(
      'Last successful backup',
      health.backupLastSuccess ? new Date(health.backupLastSuccess).toLocaleString() : 'Never',
      !health.backupLastSuccess
    );
    addField(
      'Last restore drill',
      health.restoreTestAt ? new Date(health.restoreTestAt).toLocaleString() : 'Never',
      !health.restoreTestAt
    );
    recovery.appendChild(fields);

    const recoveryNote = document.createElement('p');
    recoveryNote.className = 'note';
    recoveryNote.textContent =
      'A backup that has never been restored is an untested backup. Run '
      + 'backend/scripts/restore-drill.sh to verify one end to end; it records the drill here.';
    recovery.appendChild(recoveryNote);
    body.appendChild(recovery);
  }

  return {
    stop: () => { if (timer) clearInterval(timer); },
  };
}

function renderLoading(container) {
  container.innerHTML = '';
  const wrap = document.createElement('div');
  wrap.className = 'stack';
  wrap.setAttribute('role', 'status');
  wrap.setAttribute('aria-label', 'Checking service health');
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
