/**
 * service-health.js — W20 Service Health / Recovery (§9): "Roles: Admin
 * only · API: GET /system/health (local-only) · Shows MariaDB, API,
 * routing, GSM ingestion, notification configuration, and
 * backup/last-restore-test status. This is operational diagnostics, not
 * a public endpoint." (Routing is OpenRouteService (ORS), not the
 * self-hosted OSRM this spec line originally named, and not Google's
 * Routes API either — Google was ruled out because it requires a
 * billing account with a card on file even for free-tier use, which
 * this deployment doesn't have. 2026-09-13 architecture decisions, see
 * OrsClient.php's own doc block.)
 *
 * THE POINT OF THIS SCREEN IS HONESTY ABOUT WHAT ISN'T WIRED UP.
 * §6 gives three coarse statuses, and the distinction between two of
 * them carries the whole meaning:
 *   healthy         — checked, and it answered live probes.
 *   unhealthy       — CONFIGURED, checked, and it failed. Action Required!
 *   configured      — set up, but nothing here can test it (FCM, GSM gateway,
 *                     GSM ingestion). Neutral, NOT healthy (Rule 6).
 *   not_configured  — never wired up on this deployment. NOT a fault.
 * So `not_configured` renders neutral with an explanation, never as a
 * red error. Equally, it is never shown green: §8 forbids a fabricated
 * "all systems operational" reading.
 *
 * Overhauled with:
 * - Baranguard Design Tokens & light/dark theme contrast compliance
 * - Live Telemetry Header (pulsing indicator, freshness badge, active refresh)
 * - Operational Status Hero Banner (nominal vs critical failure states)
 * - Interactive Health StatStrip (overall, healthy, alert, unconfigured) with quick-filter
 * - Categorized Subsystem Cards (Core Infrastructure, Intelligence & Routing, Communications)
 * - Disaster Recovery & Business Continuity Hub (encrypted backup & statutory restore drill)
 * - Click-to-inspect Diagnostic & Troubleshooting Modal with operator runbooks
 *
 * kebab-case filename per §4.
 */

import { getSystemHealth, getSystemHealthHistory, logout, ApiClientError } from '../api/apiClient.js';
import { AppShell } from '../components/AppShell.js';
import { PageHeader } from '../components/PageHeader.js';
import { icons } from '../components/icons.js';
import { showToast } from '../components/Toast.js';
import { renderLoadingSkeleton, renderErrorState } from '../components/AsyncState.js';
import { formatManilaDateTime, formatManilaTimeSeconds } from '../utils/manilaTime.js';

const REFRESH_MS = 30000;

const DOMAINS = {
  core: {
    id: 'core',
    label: 'Core Infrastructure',
    description: 'Primary application server, front controller, and relational database engine',
    icon: icons.layoutDashboard,
  },
  intelligence: {
    id: 'intelligence',
    label: 'Routing',
    description: 'OpenRouteService turn-by-turn calculations',
    icon: icons.compass,
  },
  communications: {
    id: 'communications',
    label: 'Communications & Transports',
    description: 'Cellular SMS hardware modem receiver, push dispatch, and broadcast gateways',
    icon: icons.radio,
  },
};

const DEPENDENCIES = [
  {
    key: 'api',
    domain: 'core',
    label: 'API Gateway',
    description: 'Front controller & HTTP endpoint responding on local port',
    icon: icons.activity,
    whatToDo: 'If this fails, nothing else will work. Close and reopen the Start Baranguard launcher on the workstation, or ask whoever maintains the computer.',
    probeType: 'Live HTTP Probe',
    probeDetail: 'Endpoint executes within local request lifecycle and returns JSON',
    configKey: 'Web server (port 8081)',
    impacted: [
      'All web console and mobile application API requests',
      'Live operations, incident dispatches, and authentication sessions',
    ],
    runbook: '# Test local HTTP endpoint reachability:\ncurl -I http://127.0.0.1:8081/api/v1/system/health\n# Verify Apache/PHP process status on the host workstation.',
  },
  {
    key: 'db',
    domain: 'core',
    label: 'MariaDB Database',
    description: 'Primary relational database (10.4+) storage layer',
    icon: icons.layers,
    whatToDo: 'If this fails, the records cannot be read. Make sure MySQL is running (the Start Baranguard launcher starts it), or ask whoever maintains the computer.',
    probeType: 'Live SQL: SELECT 1',
    probeDetail: 'PDO executes live SELECT 1 check against local MariaDB connection',
    configKey: 'DB_HOST, DB_NAME, DB_USER, DB_PASS',
    impacted: [
      'User credentials, login authentication, and RBAC sessions',
      'Incident tracking, audit logs, and shift schedules',
    ],
    runbook: '# Test MariaDB local connectivity:\nmysql -u root -p -e "USE baranguard; SELECT 1;"\n# Check if XAMPP MySQL/MariaDB service is running in Windows Services.',
  },
  {
    key: 'ors',
    domain: 'intelligence',
    label: 'OpenRouteService (Routing)',
    description: 'Cloud turn-by-turn routing for tanod dispatch and patrol ETA (car and foot), free tier, no card required',
    icon: icons.map,
    whatToDo: 'Only affects road directions for Tanods. Dispatching still works. Ask whoever maintains the computer to check the routing key.',
    probeType: 'Live Route Request',
    probeDetail: 'Requests a real route between two fixed Pilar/Sorsogon points, not just a key presence check',
    configKey: 'ORS_API_KEY',
    impacted: [
      'Dispatch Center (W3) Tanod-to-incident road travel time and ETA',
      'Falls back to the mobile app’s external navigation link if unconfigured or unreachable',
    ],
    runbook: '# Verify the key is working (coordinates confirmed on-road in Pilar,\n# unlike the map\'s own DEFAULT_CENTER — see OrsClient.php\'s doc block):\ncurl -X POST "https://api.openrouteservice.org/v2/directions/driving-car/geojson" \\\n  -H "Content-Type: application/json" \\\n  -H "Authorization: $ORS_API_KEY" \\\n  -d \'{"coordinates":[[123.670203,12.918905],[123.672552,12.921617]]}\'\n# Set ORS_API_KEY in backend/.env — free key from openrouteservice.org/sign-up, no card required (that signup is yours to do, not automatable).',
  },
  {
    key: 'gsmIngestion',
    domain: 'communications',
    label: 'GSM Cellular Ingestion',
    description: 'Inbound SMS envelope receiver for local cellular modems',
    icon: icons.inbox,
    whatToDo: 'Check that the SMS phone is plugged in and its app is open. This screen can only tell that the setting exists, not that texts are arriving.',
    probeType: 'Setting check only (not a live test)',
    probeDetail: 'Only checks that INTERNAL_SERVICE_TOKEN is set. It does not confirm the ingest daemon or gateway phone is running',
    configKey: 'INTERNAL_SERVICE_TOKEN',
    impacted: [
      'Direct incoming citizen SMS reception in SMS Monitor (W5/W6)',
      'Tanod mobile offline GSM emergency SOS fallback transport',
    ],
    runbook: '# Check INTERNAL_SERVICE_TOKEN in backend/.env:\nINTERNAL_SERVICE_TOKEN=your_secure_random_token\n# Verify hardware modem forwarding script is running.',
  },
  {
    key: 'notificationConfig',
    domain: 'communications',
    label: 'Notification Dispatcher',
    description: 'Aggregated push and SMS transport routing readiness',
    icon: icons.bell,
    whatToDo: 'Make sure at least one way of alerting Tanods (push or SMS) is set up.',
    probeType: 'Setting check only (not a live test)',
    probeDetail: 'Shows Configured if either FCM or the local GSM SMS gateway is configured. Neither is tested from the dashboard',
    configKey: 'FCM_SERVICE_ACCOUNT_PATH or GSM_GATEWAY_ENABLED',
    impacted: [
      'Multi-channel emergency escalation to tanods and desk officers',
      'Automated panic broadcast triggers',
    ],
    runbook: '# Ensure at least one notification transport is configured:\n# Configure FCM_SERVICE_ACCOUNT_PATH or set GSM_GATEWAY_ENABLED=true in backend/.env',
  },
  {
    key: 'fcm',
    domain: 'communications',
    label: 'Firebase Cloud Messaging',
    description: 'Mobile push dispatch for Tanod operations mobile app',
    icon: icons.send,
    whatToDo: 'Push alerts need a Firebase key file. Ask whoever maintains the computer if this shows Not set up.',
    probeType: 'Key file check (not a live test)',
    probeDetail: 'Checks that the FCM_SERVICE_ACCOUNT_PATH file exists, is readable and has the expected keys. Google is not contacted, so push delivery is not tested',
    configKey: 'FCM_SERVICE_ACCOUNT_PATH',
    impacted: [
      'Instant push notifications to Tanod mobile devices (M1-M4)',
      'Emergency SOS dispatch rings for patrolling officers',
    ],
    runbook: '# Download service-account.json from Firebase Console:\nFCM_SERVICE_ACCOUNT_PATH=path/to/firebase-credentials.json\n# Set in backend/.env',
  },
  {
    key: 'smsGsmGateway',
    domain: 'communications',
    label: 'GSM SMS Gateway',
    description: 'Outbound citizen alert and broadcast SMS via the tethered gateway phone’s own SIM',
    icon: icons.messageSquare,
    whatToDo: 'Check that the SMS phone is plugged in, has load, and its app is open. This screen only knows the setting is switched on.',
    probeType: 'Setting check only (not a live test)',
    probeDetail: 'Only checks that GSM_GATEWAY_ENABLED is true. It does not confirm the gateway phone is connected or can send',
    configKey: 'GSM_GATEWAY_ENABLED',
    impacted: [
      'Barangay emergency broadcast SMS alerts to resident phone lists (W7)',
      'Two-way citizen communication replies from SMS Monitor',
    ],
    runbook: '# Install the sms-gateway/ companion app on the tethered phone,\n# grant SEND_SMS (adb shell pm grant), then set in backend/.env:\nGSM_GATEWAY_ENABLED=true',
  },
];

const STATUS_PILL_CLASS = {
  healthy: 'status-pill--success',
  unhealthy: 'status-pill--critical',
  configured: 'status-pill--neutral',
  not_configured: 'status-pill--neutral',
};

const STATUS_LABEL = {
  healthy: 'Working',
  unhealthy: 'Not working',
  configured: 'Set up, not tested',
  not_configured: 'Not set up',
};

// Rule 6: no probe exists that proves these work end-to-end from the dashboard.
const CONFIGURED_TOOLTIP = 'Set up, but this screen cannot test it';

/**
 * Calculates human-friendly relative age or date
 * @param {string|null} dateStr
 * @returns {{ formatted: string, isRecent: boolean, isWarning: boolean }}
 */
function evaluateTimestampFreshness(dateStr, maxHours = 24) {
  if (!dateStr) {
    return { formatted: 'Never recorded', isRecent: false, isWarning: true };
  }
  const d = new Date(dateStr);
  if (isNaN(d.getTime())) {
    return { formatted: 'Not recorded', isRecent: false, isWarning: true };
  }

  const now = new Date();
  const diffHours = (now.getTime() - d.getTime()) / (1000 * 60 * 60);

  const formatted = formatManilaDateTime(d);

  return {
    formatted,
    isRecent: diffHours < maxHours,
    isWarning: diffHours >= maxHours,
  };
}

/**
 * @param {HTMLElement} root
 * @param {{fullName:string, role:string}} user
 * @param {() => void} onLoggedOut
 * @param {(page: string, param?: any) => void} navigate
 * @returns {{stop: () => void}} polling handle
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

  // Page Header
  const pageHeader = PageHeader({
    title: 'Service Health',
    subtitle: 'Whether the system\'s parts are working, and when the last backup was made',
    icon: icons.activity,
  });

  // Header Actions
  const headerActions = document.createElement('div');
  headerActions.className = 'health-header-actions';

  const telemetryPill = document.createElement('span');
  telemetryPill.className = 'health-telemetry-pill';
  telemetryPill.innerHTML = '<span class="health-pulse-dot" aria-hidden="true"></span><span>Live Monitor (30s)</span>';

  const freshnessPill = document.createElement('span');
  freshnessPill.className = 'health-freshness-pill';
  freshnessPill.setAttribute('role', 'status');
  freshnessPill.innerHTML = `${icons.clock(13)}<span>Checking…</span>`;

  const refreshButton = document.createElement('button');
  refreshButton.type = 'button';
  refreshButton.className = 'ghost health-refresh-btn';
  refreshButton.innerHTML = `${icons.rotateCcw(14)}<span>Refresh Now</span>`;
  refreshButton.addEventListener('click', () => load());

  headerActions.append(telemetryPill, freshnessPill, refreshButton);
  pageHeader.actions.appendChild(headerActions);
  header.appendChild(pageHeader.el);

  const pageContainer = document.createElement('div');
  pageContainer.className = 'health-page-container';
  content.appendChild(pageContainer);

  let timer = null;
  let lastCheckedLabel = null;
  let activeFilter = 'all'; // 'all' | 'healthy' | 'unhealthy' | 'not_configured'
  let cachedHealth = null;

  load();

  timer = setInterval(() => {
    if (!shell.el.isConnected) {
      clearInterval(timer);
      return;
    }
    load({ background: true });
  }, REFRESH_MS);

  async function load({ background = false } = {}) {
    if (!background) {
      refreshButton.classList.add('is-refreshing');
      renderLoading(pageContainer);
    }
    try {
      const health = await getSystemHealth();
      cachedHealth = health;
      renderHealth(health);
      lastCheckedLabel = formatManilaTimeSeconds(new Date());
      freshnessPill.classList.remove('is-stale');
      freshnessPill.innerHTML = `${icons.clock(13)}<span>Checked ${lastCheckedLabel}</span>`;
    } catch (err) {
      if (background) {
        // Do not blank the populated screen, but never let old results look current (audit A-31).
        freshnessPill.classList.add('is-stale');
        freshnessPill.innerHTML = `${icons.alertTriangle(13)}<span>Cannot reach the server. Showing results from ${lastCheckedLabel || 'an earlier check'}.</span>`;
        return;
      }
      const message = err instanceof ApiClientError ? err.message : 'Could not retrieve operational service health.';
      renderError(pageContainer, message, () => load());
    } finally {
      refreshButton.classList.remove('is-refreshing');
    }
  }

  function renderHealth(health) {
    pageContainer.innerHTML = '';

    const healthyCount = DEPENDENCIES.filter((d) => health[d.key] === 'healthy').length;
    const unhealthyDeps = DEPENDENCIES.filter((d) => health[d.key] === 'unhealthy');
    const configuredCount = DEPENDENCIES.filter((d) => health[d.key] === 'configured').length;
    const notConfiguredCount = DEPENDENCIES.filter((d) => (health[d.key] ?? 'not_configured') === 'not_configured').length;
    const isDegraded = unhealthyDeps.length > 0;

    // 1. Operational Status Hero Banner
    const heroBanner = document.createElement('div');
    heroBanner.className = `health-hero-banner ${isDegraded ? 'health-hero-banner--alert' : 'health-hero-banner--nominal'}`;
    heroBanner.setAttribute('role', isDegraded ? 'alert' : 'status');

    const heroIcon = document.createElement('div');
    heroIcon.className = 'health-hero-banner__icon';
    heroIcon.innerHTML = isDegraded ? icons.alertTriangle(26) : icons.shield(26);

    const heroContent = document.createElement('div');
    heroContent.className = 'health-hero-banner__content';

    const heroHeader = document.createElement('div');
    heroHeader.className = 'health-hero-banner__header';

    const heroTitle = document.createElement('h3');
    heroTitle.className = 'health-hero-banner__title';
    heroTitle.textContent = isDegraded
      ? `Needs attention: ${unhealthyDeps.length} part${unhealthyDeps.length === 1 ? ' is' : 's are'} not working`
      : 'Everything that can be tested is working';

    const heroBadge = document.createElement('span');
    heroBadge.className = 'health-hero-banner__badge';
    heroBadge.textContent = isDegraded ? 'Needs attention' : 'Working';

    heroHeader.append(heroTitle, heroBadge);

    const heroText = document.createElement('p');
    heroText.className = 'health-hero-banner__text';
    heroText.textContent = isDegraded
      ? `Not working: ${unhealthyDeps.map((d) => d.label).join(', ')}. Click a card below to see what it affects and what to do.`
      : 'The server and database answered a live test. Parts marked "Set up, not tested" or "Not set up" cannot be tested from this screen, so they are shown in grey, not green.';

    heroContent.append(heroHeader, heroText);
    heroBanner.append(heroIcon, heroContent);
    pageContainer.appendChild(heroBanner);

    // 2. Interactive Health StatStrip (Clickable Filters)
    const statStrip = document.createElement('div');
    statStrip.className = 'stat-card-grid';

    const statItems = [
      {
        id: 'all',
        label: 'Overall',
        value: isDegraded ? 'Needs attention' : 'Working',
        tone: isDegraded ? 'critical' : 'success',
        icon: isDegraded ? icons.alertTriangle(16) : icons.shield(16),
      },
      {
        id: 'healthy',
        label: 'Working',
        value: `${healthyCount} / ${DEPENDENCIES.length}`,
        tone: 'success',
        icon: icons.checkCircle(16),
      },
      {
        id: 'unhealthy',
        label: 'Not working',
        value: `${unhealthyDeps.length} not working`,
        tone: unhealthyDeps.length > 0 ? 'critical' : 'neutral',
        icon: icons.alertTriangle(16),
      },
      {
        id: 'configured',
        label: 'Set up, not tested',
        value: `${configuredCount} part${configuredCount === 1 ? '' : 's'}`,
        tone: 'neutral',
        icon: icons.settings(16),
      },
      {
        id: 'not_configured',
        label: 'Not set up',
        value: `${notConfiguredCount} part${notConfiguredCount === 1 ? '' : 's'}`,
        tone: 'neutral',
        icon: icons.settings(16),
      },
    ];

    statItems.forEach((item) => {
      const card = document.createElement('button');
      card.type = 'button';
      card.className = `stat-card ${activeFilter === item.id ? 'is-active' : ''}`;
      card.setAttribute('aria-label', `${item.label}: ${item.value}. Filter by this status`);
      card.setAttribute('aria-pressed', String(activeFilter === item.id));

      const val = document.createElement('span');
      val.className = `stat-card__value stat-card__value--${item.tone}`;
      val.innerHTML = `<span aria-hidden="true">${item.icon}</span><span>${item.value}</span>`;

      const lbl = document.createElement('span');
      lbl.className = 'stat-card__label';
      lbl.textContent = item.label;

      card.append(val, lbl);
      card.addEventListener('click', () => {
        activeFilter = activeFilter === item.id ? 'all' : item.id;
        renderHealth(cachedHealth);
      });

      statStrip.appendChild(card);
    });

    pageContainer.appendChild(statStrip);

    // 3. Categorized Subsystem Cards (Grid Layout)
    const domainsContainer = document.createElement('div');
    domainsContainer.className = 'health-domains-container';

    Object.values(DOMAINS).forEach((domain) => {
      let domainDeps = DEPENDENCIES.filter((d) => d.domain === domain.id);
      if (activeFilter !== 'all') {
        domainDeps = domainDeps.filter((d) => (health[d.key] ?? 'not_configured') === activeFilter);
      }
      if (domainDeps.length === 0) return;

      const groupEl = document.createElement('div');
      groupEl.className = 'health-domain-group';

      const groupHeader = document.createElement('div');
      groupHeader.className = 'health-domain-header';

      const titleEl = document.createElement('h4');
      titleEl.className = 'health-domain-header__title';
      titleEl.innerHTML = `<span class="health-domain-header__icon">${domain.icon(16)}</span><span>${domain.label}</span>`;

      const countEl = document.createElement('span');
      countEl.className = 'health-domain-header__count';
      countEl.textContent = `${domainDeps.length} ${domainDeps.length === 1 ? 'service' : 'services'}`;

      groupHeader.append(titleEl, countEl);
      groupEl.appendChild(groupHeader);

      const servicesGrid = document.createElement('div');
      servicesGrid.className = 'health-services-grid';

      domainDeps.forEach((dep) => {
        const status = health[dep.key] ?? 'not_configured';

        const card = document.createElement('div');
        card.className = `health-service-card health-service-card--${status}`;
        card.setAttribute('role', 'button');
        card.setAttribute('tabindex', '0');
        card.setAttribute('aria-label', `${dep.label}, status: ${STATUS_META[status]?.label || status}. Inspect diagnostic details`);

        // Top row
        const topRow = document.createElement('div');
        topRow.className = 'health-service-card__top';

        const identity = document.createElement('div');
        identity.className = 'health-service-card__identity';

        const iconBox = document.createElement('div');
        iconBox.className = 'health-service-card__icon-box';
        iconBox.innerHTML = dep.icon(18);

        const nameBlock = document.createElement('div');
        nameBlock.className = 'health-service-card__name-block';

        const name = document.createElement('span');
        name.className = 'health-service-card__name';
        name.textContent = dep.label;

        const domLabel = document.createElement('span');
        domLabel.className = 'health-service-card__domain';
        domLabel.textContent = domain.label;

        nameBlock.append(name, domLabel);
        identity.append(iconBox, nameBlock);

        const pill = document.createElement('span');
        pill.className = `status-pill ${STATUS_PILL_CLASS[status] || 'status-pill--neutral'}`;
        pill.textContent = STATUS_LABEL[status] || 'Unknown';
        if (status === 'configured') pill.title = CONFIGURED_TOOLTIP;

        topRow.append(identity, pill);

        // Description
        const desc = document.createElement('p');
        desc.className = 'health-service-card__desc';
        desc.textContent = dep.description;

        // Footer with probe info
        const footer = document.createElement('div');
        footer.className = 'health-service-card__footer';

        const probe = document.createElement('span');
        probe.className = 'health-service-card__probe';
        probe.textContent = dep.probeType;

        const actionHint = document.createElement('span');
        actionHint.className = 'health-service-card__action-hint';
        actionHint.textContent = 'What this affects and what to do →';

        footer.append(probe, actionHint);
        card.append(topRow, desc, footer);

        const onCardClick = () => openServiceModal(dep, status);
        card.addEventListener('click', onCardClick);
        card.addEventListener('keydown', (e) => {
          if (e.key === 'Enter' || e.key === ' ') {
            e.preventDefault();
            onCardClick();
          }
        });

        servicesGrid.appendChild(card);
      });

      groupEl.appendChild(servicesGrid);
      domainsContainer.appendChild(groupEl);
    });

    pageContainer.appendChild(domainsContainer);

    // 4. Disaster Recovery & Business Continuity Hub (§5/§9 W20)
    const drSection = document.createElement('div');
    drSection.className = 'health-dr-section';

    // Card A: Encrypted Database Backup
    const backupCard = document.createElement('div');
    backupCard.className = 'health-dr-card';

    const backupHeader = document.createElement('div');
    backupHeader.className = 'health-dr-card__header';
    const backupTitle = document.createElement('h4');
    backupTitle.className = 'health-dr-card__title';
    backupTitle.innerHTML = `${icons.shield(18)}<span>Daily Database Backup</span>`;

    const backupFreshness = evaluateTimestampFreshness(health.backupLastSuccess, 24);
    const backupBadge = document.createElement('span');
    backupBadge.className = `health-dr-card__badge ${backupFreshness.isRecent ? 'status-pill--success' : (backupFreshness.isWarning ? 'status-pill--warning' : 'status-pill--critical')}`;
    backupBadge.textContent = backupFreshness.isRecent ? 'Recent (within 24 hours)' : (health.backupLastSuccess ? 'Older than 24 hours' : 'No backup yet');
    backupHeader.append(backupTitle, backupBadge);

    const backupField = document.createElement('div');
    backupField.className = 'health-dr-field';
    const backupLabel = document.createElement('span');
    backupLabel.className = 'health-dr-label';
    backupLabel.textContent = 'Last successful backup (Manila time)';
    const backupValRow = document.createElement('div');
    backupValRow.className = 'health-dr-value-row';
    const backupVal = document.createElement('span');
    backupVal.className = `health-dr-value ${!health.backupLastSuccess ? 'health-dr-value--warn' : ''}`;
    backupVal.textContent = backupFreshness.formatted;
    backupValRow.appendChild(backupVal);
    backupField.append(backupLabel, backupValRow);

    const backupNote = document.createElement('p');
    backupNote.className = 'health-dr-note';
    backupNote.textContent = 'A scheduled job makes an encrypted copy of the database every day. Keep a recent copy somewhere other than this computer.';

    const backupSnippet = buildTerminalBox('bash backend/scripts/backup.sh');
    backupCard.append(backupHeader, backupField, backupNote, backupSnippet);

    // Card B: Statutory Recovery Verification Drill (§5/§9 W20)
    const restoreCard = document.createElement('div');
    restoreCard.className = 'health-dr-card';

    const restoreHeader = document.createElement('div');
    restoreHeader.className = 'health-dr-card__header';
    const restoreTitle = document.createElement('h4');
    restoreTitle.className = 'health-dr-card__title';
    restoreTitle.innerHTML = `${icons.repeat(18)}<span>Restore Test</span>`;

    const restoreFreshness = evaluateTimestampFreshness(health.restoreTestAt, 168); // 7 days
    const restoreBadge = document.createElement('span');
    restoreBadge.className = `health-dr-card__badge ${health.restoreTestAt ? 'status-pill--success' : 'status-pill--critical'}`;
    restoreBadge.textContent = health.restoreTestAt ? 'Restore tested' : 'Never tested';
    restoreHeader.append(restoreTitle, restoreBadge);

    const restoreField = document.createElement('div');
    restoreField.className = 'health-dr-field';
    const restoreLabel = document.createElement('span');
    restoreLabel.className = 'health-dr-label';
    restoreLabel.textContent = 'Last successful restore test (Manila time)';
    const restoreValRow = document.createElement('div');
    restoreValRow.className = 'health-dr-value-row';
    const restoreVal = document.createElement('span');
    restoreVal.className = `health-dr-value ${!health.restoreTestAt ? 'health-dr-value--warn' : ''}`;
    restoreVal.textContent = restoreFreshness.formatted;
    restoreValRow.appendChild(restoreVal);
    restoreField.append(restoreLabel, restoreValRow);

    const restoreNote = document.createElement('p');
    restoreNote.className = 'health-dr-note';
    restoreNote.textContent = 'A backup that has never been restored is an untested backup. The restore test brings a backup back into a separate practice database to check that nothing is missing.';

    const restoreSnippet = buildTerminalBox('bash backend/scripts/restore-drill.sh');
    restoreCard.append(restoreHeader, restoreField, restoreNote, restoreSnippet);

    // Card C: Notification Delivery Reliability (code-review finding
    // H-20, 2026-09-24) — Rule 12's FCM-retry-then-SMS ladder is a real
    // bounded retry policy, but nothing surfaced what happens once BOTH
    // tiers are exhausted for a target. This is that missing signal.
    const notifCard = document.createElement('div');
    notifCard.className = 'health-dr-card';

    const notifHeader = document.createElement('div');
    notifHeader.className = 'health-dr-card__header';
    const notifTitle = document.createElement('h4');
    notifTitle.className = 'health-dr-card__title';
    notifTitle.innerHTML = `${icons.bell(18)}<span>Notification Delivery</span>`;

    const failedCount = Number.isFinite(health.notificationDeliveryFailures24h) ? health.notificationDeliveryFailures24h : 0;
    const notifBadge = document.createElement('span');
    notifBadge.className = `health-dr-card__badge ${failedCount === 0 ? 'status-pill--success' : 'status-pill--warning'}`;
    notifBadge.textContent = failedCount === 0 ? 'All reaching recipients' : 'Some alerts not delivered';
    notifHeader.append(notifTitle, notifBadge);

    const notifField = document.createElement('div');
    notifField.className = 'health-dr-field';
    const notifLabel = document.createElement('span');
    notifLabel.className = 'health-dr-label';
    notifLabel.textContent = 'Not delivered at all (last 24 hours)';
    const notifValRow = document.createElement('div');
    notifValRow.className = 'health-dr-value-row';
    const notifVal = document.createElement('span');
    notifVal.className = `health-dr-value ${failedCount > 0 ? 'health-dr-value--warn' : ''}`;
    notifVal.textContent = `${failedCount} notification${failedCount === 1 ? '' : 's'}`;
    notifValRow.appendChild(notifVal);
    notifField.append(notifLabel, notifValRow);

    const notifNote = document.createElement('p');
    notifNote.className = 'health-dr-note';
    notifNote.textContent = 'Alerts where both push and SMS failed, so the person was not reached. A single failed try that a backup channel still delivered is not counted.';

    notifCard.append(notifHeader, notifField, notifNote);

    drSection.append(backupCard, restoreCard, notifCard);
    pageContainer.appendChild(drSection);

    renderHistory(pageContainer);
  }

  /**
   * Dependency-status transitions (migration 0017). Appended after the
   * current-state cards because it answers the follow-up question, not
   * the first one: the cards say what is true now, this says how stable
   * that has been — the thing §2 Rule 15's single-point-of-failure risk
   * actually turns on.
   *
   * Its own async load, with its own failure handling: history is
   * strictly secondary to the live snapshot, so a failure here must
   * degrade to a note rather than blanking a page an operator is likely
   * reading BECAUSE something is broken.
   */
  async function renderHistory(container) {
    const section = document.createElement('div');
    section.className = 'health-history';

    const heading = document.createElement('h3');
    heading.className = 'health-history__heading';
    heading.textContent = 'Dependency status changes';
    section.appendChild(heading);

    const note = document.createElement('p');
    note.className = 'health-history__note';
    section.appendChild(note);

    container.appendChild(section);

    let history;
    try {
      history = await getSystemHealthHistory();
    } catch {
      note.textContent = 'Status history could not be loaded. The live checks above are unaffected.';
      return;
    }
    // Same liveness idiom the refresh timer above uses — this page has no
    // stop handle, it checks whether its own shell is still in the DOM.
    if (!shell.el.isConnected) return;

    // The caveat is stated before the data, not under it — a gap in this
    // list means nobody was looking, and an operator who reads the rows
    // first will have already drawn the wrong conclusion.
    note.textContent = 'A row is recorded only when a status actually changes, and only while this page is being checked — '
      + 'nothing polls in the background yet, so a gap means no one was watching, not that nothing happened.';

    if (history.items.length === 0) {
      const empty = document.createElement('p');
      empty.className = 'health-history__empty';
      empty.textContent = 'No status changes recorded yet. The first check writes one entry; after that, only changes appear.';
      section.appendChild(empty);
      return;
    }

    const DEPENDENCIES = [
      ['db', 'Database'],
      ['ors', 'Routing (ORS)'],
      ['gsmIngestion', 'GSM ingestion'],
      ['fcm', 'Push (FCM)'],
      ['smsGsmGateway', 'SMS (GSM gateway)'],
    ];

    const list = document.createElement('ul');
    list.className = 'health-history__list';
    // Walk oldest-to-newest so each entry can name what CHANGED against
    // the one before it; the list is then reversed for display, keeping
    // newest first without computing diffs backwards.
    const chronological = [...history.items].reverse();
    const entries = chronological.map((row, index) => {
      const previous = index === 0 ? null : chronological[index - 1];
      const changed = previous === null
        ? []
        : DEPENDENCIES.filter(([key]) => row[key] !== previous[key]);
      return { row, changed, isFirst: previous === null };
    });

    for (const { row, changed, isFirst } of entries.reverse()) {
      const item = document.createElement('li');
      item.className = 'health-history__item';

      const when = document.createElement('span');
      when.className = 'health-history__when';
      when.textContent = formatManilaDateTime(row.recordedAt);
      item.appendChild(when);

      const what = document.createElement('span');
      what.className = 'health-history__what';
      if (isFirst) {
        what.textContent = 'First recorded check.';
      } else {
        what.textContent = changed
          .map(([key, label]) => `${label} → ${STATUS_LABEL[row[key]] || 'Unknown'}`)
          .join(' · ');
      }
      item.appendChild(what);

      // A transition INTO a non-healthy state is the one worth spotting
      // in a scan; recoveries are good news and do not need to shout.
      if (changed.some(([key]) => row[key] === 'unhealthy')) {
        item.classList.add('health-history__item--degraded');
      }
      list.appendChild(item);
    }
    section.appendChild(list);
  }

  function buildTerminalBox(command) {
    const box = document.createElement('div');
    box.className = 'health-terminal-box';

    const code = document.createElement('code');
    code.className = 'health-terminal-code';
    code.textContent = command;

    const copyBtn = document.createElement('button');
    copyBtn.type = 'button';
    copyBtn.className = 'health-btn-terminal-copy';
    copyBtn.innerHTML = `${icons.copy(12)}<span>Copy</span>`;

    copyBtn.addEventListener('click', async (e) => {
      e.stopPropagation();
      try {
        await navigator.clipboard.writeText(command);
        copyBtn.innerHTML = `${icons.checkCircle(12)}<span>Copied</span>`;
        setTimeout(() => {
          copyBtn.innerHTML = `${icons.copy(12)}<span>Copy</span>`;
        }, 2000);
      } catch (err) {
        showToast('Could not copy command to clipboard.', { variant: 'error' });
      }
    });

    box.append(code, copyBtn);
    return box;
  }

  /**
   * Opens the Diagnostic Inspection & Troubleshooting Modal
   * @param {object} dep
   * @param {'healthy'|'unhealthy'|'configured'|'not_configured'} status
   */
  function openServiceModal(dep, status) {
    const existing = document.querySelector('.health-modal-backdrop');
    if (existing) existing.remove();

    const backdrop = document.createElement('div');
    backdrop.className = 'health-modal-backdrop';
    backdrop.setAttribute('role', 'dialog');
    backdrop.setAttribute('aria-modal', 'true');
    backdrop.setAttribute('aria-labelledby', 'health-modal-title');

    const card = document.createElement('div');
    card.className = 'health-modal-card';

    // Header
    const headerEl = document.createElement('div');
    headerEl.className = 'health-modal-header';

    const titleWrap = document.createElement('div');
    titleWrap.className = 'health-modal-title-wrap';
    const iconSpan = document.createElement('span');
    iconSpan.className = 'health-modal-icon';
    iconSpan.setAttribute('aria-hidden', 'true');
    iconSpan.innerHTML = dep.icon(20);

    const titleEl = document.createElement('h3');
    titleEl.className = 'health-modal-title';
    titleEl.id = 'health-modal-title';
    titleEl.textContent = `${dep.label}: details`;

    const pill = document.createElement('span');
    pill.className = `status-pill ${STATUS_PILL_CLASS[status] || 'status-pill--neutral'}`;
    pill.textContent = STATUS_LABEL[status] || 'Unknown';

    titleWrap.append(iconSpan, titleEl, pill);

    const closeBtn = document.createElement('button');
    closeBtn.type = 'button';
    closeBtn.className = 'health-modal-close';
    closeBtn.setAttribute('aria-label', 'Close dialog');
    closeBtn.innerHTML = icons.x(16);

    headerEl.append(titleWrap, closeBtn);

    // Body
    const bodyEl = document.createElement('div');
    bodyEl.className = 'health-modal-body';

    const grid = document.createElement('div');
    grid.className = 'health-modal-grid';

    grid.innerHTML = `
      <div class="health-modal-field">
        <span class="health-modal-label">Group</span>
        <span class="health-modal-val">${DOMAINS[dep.domain]?.label || dep.domain}</span>
      </div>
      <div class="health-modal-field">
        <span class="health-modal-label">Status</span>
        <span class="health-modal-val health-modal-val--${status}">${STATUS_LABEL[status] || 'Unknown'}${status === 'configured' ? ` (${CONFIGURED_TOOLTIP})` : ''}</span>
      </div>
      <div class="health-modal-field">
        <span class="health-modal-label">How it is checked</span>
        <span class="health-modal-val">${dep.probeType}</span>
      </div>
      <div class="health-modal-field">
        <span class="health-modal-label">Technical setting name</span>
        <code class="health-modal-code">${dep.configKey}</code>
      </div>
    `;

    // Impacted features
    const impactSection = document.createElement('div');
    impactSection.className = 'health-modal-section';
    const impactTitle = document.createElement('span');
    impactTitle.className = 'health-modal-section-title';
    impactTitle.textContent = 'What this affects:';

    const impactList = document.createElement('ul');
    impactList.className = 'health-modal-impact-list';
    dep.impacted.forEach((item) => {
      const li = document.createElement('li');
      li.textContent = item;
      impactList.appendChild(li);
    });
    impactSection.append(impactTitle, impactList);

    // Plain-language first step, before the technical commands.
    const todoSection = document.createElement('div');
    todoSection.className = 'health-modal-section';
    const todoTitle = document.createElement('span');
    todoTitle.className = 'health-modal-section-title';
    todoTitle.textContent = 'What to do:';
    const todoText = document.createElement('p');
    todoText.textContent = dep.whatToDo;
    todoSection.append(todoTitle, todoText);

    // Runbook / Remediation
    const runbookSection = document.createElement('div');
    runbookSection.className = 'health-modal-section';
    const runbookTitle = document.createElement('span');
    runbookTitle.className = 'health-modal-section-title';
    runbookTitle.textContent = 'For whoever maintains the computer (technical commands):';

    const runbookCode = document.createElement('pre');
    runbookCode.className = 'health-modal-runbook';
    runbookCode.textContent = dep.runbook;

    runbookSection.append(runbookTitle, runbookCode);
    bodyEl.append(grid, impactSection, todoSection, runbookSection);

    // Footer
    const footerEl = document.createElement('div');
    footerEl.className = 'health-modal-footer';

    const copyBtn = document.createElement('button');
    copyBtn.type = 'button';
    copyBtn.className = 'ghost';
    copyBtn.classList.add('health-modal-copy');
    copyBtn.innerHTML = `${icons.copy(14)}<span>Copy commands</span>`;

    copyBtn.addEventListener('click', async () => {
      try {
        await navigator.clipboard.writeText(dep.runbook);
        copyBtn.innerHTML = `${icons.checkCircle(14)}<span>Copied</span>`;
        setTimeout(() => {
          copyBtn.innerHTML = `${icons.copy(14)}<span>Copy commands</span>`;
        }, 2000);
      } catch (err) {
        showToast('Could not copy the commands to the clipboard.', { variant: 'error' });
      }
    });

    const closeBtnFooter = document.createElement('button');
    closeBtnFooter.type = 'button';
    closeBtnFooter.className = 'primary';
    closeBtnFooter.textContent = 'Close';

    footerEl.append(copyBtn, closeBtnFooter);

    card.append(headerEl, bodyEl, footerEl);
    backdrop.appendChild(card);
    document.body.appendChild(backdrop);

    // Focus management (audit X-10): move focus in, trap Tab, restore on close.
    const opener = document.activeElement;
    const closeModal = () => {
      document.removeEventListener('keydown', handleKey);
      backdrop.remove();
      if (opener && typeof opener.focus === 'function' && opener.isConnected) opener.focus();
    };

    const handleKey = (e) => {
      if (e.key === 'Escape') { closeModal(); return; }
      if (e.key !== 'Tab') return;
      const focusable = [...card.querySelectorAll('button, [href], input, select, textarea, [tabindex]:not([tabindex="-1"])')]
        .filter((el) => !el.disabled);
      if (focusable.length === 0) return;
      const first = focusable[0];
      const last = focusable[focusable.length - 1];
      if (e.shiftKey && document.activeElement === first) { e.preventDefault(); last.focus(); }
      else if (!e.shiftKey && document.activeElement === last) { e.preventDefault(); first.focus(); }
    };

    closeBtn.addEventListener('click', closeModal);
    closeBtnFooter.addEventListener('click', closeModal);
    backdrop.addEventListener('click', (e) => {
      if (e.target === backdrop) closeModal();
    });
    document.addEventListener('keydown', handleKey);
    closeBtn.focus();
  }

  return {
    stop: () => {
      if (timer) clearInterval(timer);
    },
  };
}

function renderLoading(container) {
  renderLoadingSkeleton({ container, count: 4, ariaLabel: 'Checking operational service health' });
}

function renderError(container, message, onRetry) {
  renderErrorState({ container, message, onRetry, retryLabel: 'Try again' });
}
