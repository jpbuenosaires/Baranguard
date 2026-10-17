/**
 * sms-monitor.js — W14 SMS Monitor.
 * Overhauled UI/UX:
 * - 3-column operational layout with high-density tokenized interface
 * - Initials avatars with deterministic color hashing
 * - Grouped message threads with date dividers and delivery status indicators
 * - Quick response canned reply chips (e.g. "Tanod en route", "Report received")
 * - Live multi-segment SMS character counter and Ctrl+Enter keyboard shortcuts
 * - Interactive Live Feed with category filters and click-to-open conversation
 * - Polished floating modals: Broadcast Alert (with live device preview) and Direct Message
 * - Comprehensive Activity Log with correlation ID inspection and incident linking
 */

import {
  getSmsConversations,
  getSmsConversationMessages,
  markSmsThreadResolved,
  sendSms,
  broadcastSms,
  getSmsLogs,
  getUsers,
  getSmsSubscribers,
  addSmsSubscriber,
  optOutSmsSubscriber,
  logout,
  ApiClientError,
} from '../api/apiClient.js';
import { AppShell } from '../components/AppShell.js';
import { PageHeader } from '../components/PageHeader.js';
import { DataTable, exportRowsToCsv } from '../components/DataTable.js';
import { StatStrip } from '../components/StatStrip.js';
import { showToast } from '../components/Toast.js';
import { confirmDialog } from '../components/ConfirmDialog.js';
import { icons } from '../components/icons.js';
import { DateRangePicker } from '../components/DateRangePicker.js';
import { avatarInitials } from '../components/Avatar.js';
import { escapeHtml } from '../utils/escapeHtml.js';
import { formatManilaDate, formatManilaDateTime, formatManilaTime, manilaDateKey } from '../utils/manilaTime.js';
import { formatIncidentCode, formatDispatchCode, formatCitizenReportCode, formatSmsCode } from '../services/tanodWorkflowUi.js';

const PAGE_SIZE = 25;
const LIVE_FEED_POLL_MS = 10000;
const SMS_SINGLE_LIMIT = 160;

const ROLE_LABELS = { admin: 'Admin', secretary: 'Secretary', punong_barangay: 'Punong Barangay', tanod: 'Tanod' };
const MESSAGE_TYPES = ['incident', 'dispatch', 'priority_alert', 'coord_ping', 'confirmation', 'duty_status', 'sos', 'manual'];
const DIRECTIONS = ['inbound', 'outbound'];
const STATUSES = ['queued', 'pending', 'sent', 'failed', 'refunded', 'received', 'rejected', 'deduplicated'];

// Plain words for the codes the SMS log stores (never shown raw).
const MESSAGE_TYPE_LABELS = {
  incident: 'Incident report', dispatch: 'Dispatch', priority_alert: 'Priority alert', coord_ping: 'Location ping',
  confirmation: 'Confirmation', duty_status: 'Duty status', sos: 'SOS', manual: 'Manual message',
};
const STATUS_LABELS = {
  queued: 'Waiting to send', pending: 'Sending', sent: 'Sent', failed: 'Failed', refunded: 'Refunded',
  received: 'Received', rejected: 'Rejected', deduplicated: 'Duplicate, ignored',
};
const DIRECTION_LABELS = { inbound: 'Incoming', outbound: 'Outgoing' };
const msgTypeLabel = (t) => MESSAGE_TYPE_LABELS[t] || 'Message';
const statusLabel = (s) => STATUS_LABELS[s] || 'Unknown';
const transportLabel = (t) => (t === 'gsm_modem' ? 'Phone SMS gateway' : 'Old SMS service');

const STATUS_PILL_CLASS = {
  sent: 'status-pill--success',
  received: 'status-pill--success',
  pending: 'status-pill--info',
  queued: 'status-pill--info',
  failed: 'status-pill--critical',
  rejected: 'status-pill--critical',
  refunded: 'status-pill--pending',
  deduplicated: 'status-pill--neutral',
};

const TYPE_TAG_CLASS = {
  sos: 'status-pill--critical',
  priority_alert: 'status-pill--critical',
  dispatch: 'status-pill--info',
  incident: 'status-pill--pending',
  confirmation: 'status-pill--success',
  duty_status: 'status-pill--neutral',
  coord_ping: 'status-pill--neutral',
  manual: 'status-pill--success',
};

const QUICK_RESPONSES = [
  {
    display: 'Report received, tanods on the way',
    full: 'Natanggap po namin ang inyong ulat. Papunta na po ang mga tanod sa inyong lokasyon. Manatili sa ligtas na lugar.',
  },
  {
    display: 'Ask for exact location',
    full: 'Maaari po bang ibigay ang inyong eksaktong lokasyon o pinakamalapit na landmark?',
  },
  {
    display: 'Situation resolved',
    full: 'Naresolba na po ang usapin. Salamat sa mabilis na tugon ng mga tanod. Mabuhay kayo!',
  },
  {
    display: 'Emergency: call 911',
    full: 'Kung may banta sa buhay, mangyaring tumawag agad sa 911 o sa hotline ng barangay habang paparating ang mga tanod.',
  },
];

/* SEEDED_CONVERSATIONS and SEEDED_LIVE_FEED removed 2026-09-06 - both
 * silently substituted fabricated named individuals, phone numbers and
 * realistic-looking Tagalog citizen-complaint text (Rule 6: no fabricated
 * statistics, no hardcoded identities) whenever the real API returned an
 * empty list OR failed outright. The genuinely-empty and error states now
 * both have honest handling instead: renderContactList()'s own
 * "No SMS conversations recorded." note (unchanged, it already existed),
 * and the Live Feed panel's renderEmptyFeed()/renderFeedError(). */
// The name.includes(<specific fake contact name>) clauses this function
// used to carry (juan dela cruz / baranguard / maria santos / dispatch /
// pedro reyes) were tuned to the removed fake seed conversations and
// served no purpose on real data except risking a real citizen who
// happens to share a common name being mis-tagged by coincidence.
// Stripped; messageType (a real, fixed server enum) and message-body
// keywords (real text, genuinely inspected) are what is actually being
// categorized here.
function getContactTagInfo(convo) {
  const type = convo.lastMessage?.messageType || 'manual';
  const direction = convo.lastMessage?.direction || 'inbound';
  const text = (convo.lastMessage?.messageBody || '').toLowerCase();

  if (text.includes('reklamo') || text.includes('complaint') || text.includes('maingay') || (type === 'manual' && direction === 'inbound') || type === 'complaint') {
    return { label: 'Complaint', pillClass: 'sms-tag-pill--complaint' };
  }
  if (type === 'priority_alert' || type === 'sos' || text.includes('alerto')) {
    return { label: 'Alert', pillClass: 'sms-tag-pill--alert' };
  }
  if (type === 'incident' || text.includes('suspek') || text.includes('palengke') || text.includes('tip')) {
    return { label: 'Tip', pillClass: 'sms-tag-pill--tip' };
  }
  if (type === 'dispatch' || text.includes('dispatch') || text.includes('balogo')) {
    return { label: 'Dispatch', pillClass: 'sms-tag-pill--dispatch' };
  }
  if (type === 'confirmation' || text.includes('salamat') || text.includes('naresolba') || text.includes('feedback')) {
    return { label: 'Feedback', pillClass: 'sms-tag-pill--feedback' };
  }
  return { label: msgTypeLabel(type), pillClass: 'sms-tag-pill--neutral' };
}

// getContactLocation() removed 2026-09-06 - GET /sms/conversations never
// returns a location field (SmsController::conversations() scopes every
// row to the caller's OWN barangay_id server-side, so every conversation
// on this screen already belongs to the same barangay), so this always
// fell through to keyword-matching text for names/phrases that only
// existed in the removed fake seed data, and finally to a phone-number
// hash picking one of four hardcoded names - one of which, "Brgy.
// Poblacion", is not even a real barangay this deployment serves (the
// real four are Dao/Binanuahan/Marifosque/Banuyo, REFERENCE.md section 1).
// That last branch was not a rare fallback - since .location is never
// set on real data, every single contact would have shown a fabricated,
// meaningless barangay label as if it were fact (Rule 6: no fabricated
// identities). There is no honest per-conversation location to show, so
// the label is gone rather than replaced with something that looks real
// but isn't.

function formatSmartTime(isoOrTime) {
  if (!isoOrTime) return '';
  if (typeof isoOrTime === 'string' && isoOrTime.length === 5) return isoOrTime;
  return formatManilaTime(isoOrTime, '');
}

const COLUMNS = [
  { key: 'id', label: 'ID', width: '9%', csvValue: (row) => row.logId },
  { key: 'direction', label: 'Direction', width: '11%', csvValue: (row) => row.direction },
  { key: 'type', label: 'Type', width: '13%', csvValue: (row) => row.messageType },
  { key: 'transport', label: 'Sent through', width: '15%', csvValue: (row) => row.transport },
  {
    key: 'linked', label: 'Linked to', width: '17%',
    csvValue: (row) => [
      row.incidentId ? `incident:${row.incidentId}` : null,
      row.dispatchId ? `dispatch:${row.dispatchId}` : null,
      row.reportId ? `report:${row.reportId}` : null,
    ].filter(Boolean).join(' '),
  },
  { key: 'when', label: 'Sent / Received', width: '17%', csvValue: (row) => row.sentAt || row.receivedAt || row.createdAt || '' },
  { key: 'status', label: 'Status', align: 'right', width: '18%', csvValue: (row) => row.status },
];

/**
 * Main SMS Monitor Page entry point.
 */
export function renderSmsMonitorPage(root, user, onLoggedOut, navigate, param) {
  root.innerHTML = '';

  let liveFeedTimer = null;
  const shell = AppShell(user, 'sms-log', navigate, async () => {
    shell.logoutButton.disabled = true;
    stopAllPolling();
    await logout();
    onLoggedOut();
  });
  const { header, content } = shell;
  root.appendChild(shell.el);

  const pageHeader = PageHeader({
    title: 'SMS Monitor',
    subtitle: 'Community reports and dispatch communications',
  });
  header.appendChild(pageHeader.el);

  // Tab switcher bar with icons & unread badge
  const tabBar = document.createElement('div');
  tabBar.className = 'page-tabs-bar';

  const tabRow = document.createElement('div');
  tabRow.className = 'page-tabs';
  tabRow.setAttribute('role', 'tablist');
  tabRow.setAttribute('aria-label', 'SMS Monitor sections');

  const conversationsTabBtn = document.createElement('button');
  conversationsTabBtn.type = 'button';
  conversationsTabBtn.className = 'page-tab is-active';
  conversationsTabBtn.innerHTML = `
    <span class="page-tab__icon" aria-hidden="true">${icons.messageSquare(16)}</span>
    <span>Conversations</span>
    <span class="page-tab__badge" id="sms-unread-tab-badge" role="status" aria-label="Unread conversations" style="display:none;">0</span>
  `;

  const activityTabBtn = document.createElement('button');
  activityTabBtn.type = 'button';
  activityTabBtn.className = 'page-tab';
  activityTabBtn.innerHTML = `
    <span class="page-tab__icon" aria-hidden="true">${icons.fileText(16)}</span>
    <span>Activity Log</span>
  `;

  // Advisory subscribers (migration 0018). Admin-only in the UI too —
  // the server enforces it regardless, but offering a tab that only
  // 403s would be a control that does nothing (§2 Rule 6).
  const subscribersTabBtn = document.createElement('button');
  subscribersTabBtn.type = 'button';
  subscribersTabBtn.className = 'page-tab';
  subscribersTabBtn.innerHTML = `
    <span class="page-tab__icon" aria-hidden="true">${icons.users(16)}</span>
    <span>Advisory List</span>
  `;

  const tabDefs = [['conversations', conversationsTabBtn], ['activity-log', activityTabBtn]];
  if (user.role === 'admin') tabDefs.push(['subscribers', subscribersTabBtn]);
  tabDefs.forEach(([key, btn], index) => {
    btn.id = `sms-tab-${key}`;
    btn.setAttribute('role', 'tab');
    btn.setAttribute('aria-controls', 'sms-tabpanel');
    // Arrow keys move between tabs (WAI-ARIA tabs pattern).
    btn.addEventListener('keydown', (event) => {
      if (event.key !== 'ArrowRight' && event.key !== 'ArrowLeft') return;
      event.preventDefault();
      const next = tabDefs[(index + (event.key === 'ArrowRight' ? 1 : tabDefs.length - 1)) % tabDefs.length];
      next[1].click();
      next[1].focus();
    });
  });
  tabRow.append(conversationsTabBtn, activityTabBtn);
  if (user.role === 'admin') tabRow.append(subscribersTabBtn);
  tabBar.appendChild(tabRow);
  header.appendChild(tabBar);

  const body = document.createElement('div');
  body.id = 'sms-tabpanel';
  body.setAttribute('role', 'tabpanel');
  content.appendChild(body);

  let activeTab = param === 'activity-log' ? 'activity-log' : 'conversations';
  const initialPhone = (param && param !== 'activity-log') ? String(param).trim() : null;

  function syncTabs() {
    conversationsTabBtn.classList.toggle('is-active', activeTab === 'conversations');
    activityTabBtn.classList.toggle('is-active', activeTab === 'activity-log');
    subscribersTabBtn.classList.toggle('is-active', activeTab === 'subscribers');
    for (const [key, btn] of tabDefs) {
      btn.setAttribute('aria-selected', String(activeTab === key));
      btn.tabIndex = activeTab === key ? 0 : -1;
    }
    body.setAttribute('aria-labelledby', `sms-tab-${activeTab}`);
  }

  conversationsTabBtn.addEventListener('click', () => {
    activeTab = 'conversations';
    syncTabs();
    renderActiveTab();
  });

  activityTabBtn.addEventListener('click', () => {
    activeTab = 'activity-log';
    syncTabs();
    renderActiveTab();
  });

  subscribersTabBtn.addEventListener('click', () => {
    activeTab = 'subscribers';
    syncTabs();
    renderActiveTab();
  });

  function stopLiveFeedPolling() {
    if (liveFeedTimer) clearInterval(liveFeedTimer);
    liveFeedTimer = null;
  }

  function stopAllPolling() {
    stopLiveFeedPolling();
  }

  function updateUnreadBadge(unreadTotal) {
    const badge = document.getElementById('sms-unread-tab-badge');
    if (!badge) return;
    if (unreadTotal > 0) {
      badge.textContent = unreadTotal > 99 ? '99+' : unreadTotal;
      badge.style.display = 'inline-block';
    } else {
      badge.style.display = 'none';
    }
  }

  function renderActiveTab() {
    stopAllPolling();
    pageHeader.actions.innerHTML = '';
    body.innerHTML = '';
    const existingInlineWrap = pageHeader.el.querySelector('.sms-stats-inline-wrap');
    if (existingInlineWrap) existingInlineWrap.remove();

    if (activeTab === 'conversations') {
      renderConversationsTab(
        body, pageHeader, user,
        (timer) => { liveFeedTimer = timer; },
        updateUnreadBadge, navigate, initialPhone,
      );
    } else if (activeTab === 'subscribers') {
      renderSubscribersTab(body);
    } else {
      renderActivityLogTab(body, pageHeader, navigate);
    }
  }

  syncTabs();
  renderActiveTab();

  return { stop: stopAllPolling };
}

// ============================================================
// Advisory List Tab (migration 0018)
// ============================================================

const CONSENT_SOURCE_LABELS = {
  walk_in: 'Walk-in / signed at the hall',
  staff_entry: 'Recorded by staff',
  sms_keyword: 'Texted in to subscribe',
};

/**
 * Manages the consented recipients of barangay-wide advisories.
 *
 * THE WHOLE SCREEN IS ABOUT CONSENT, not about collecting numbers. The
 * form cannot be submitted without saying how consent was obtained,
 * because the server will not accept it without that either — the UI is
 * not the control, it just refuses to pretend otherwise. Opted-out
 * entries stay listed, greyed, with the date they withdrew: that record
 * is the proof the withdrawal was honoured, and hiding it would make the
 * list look tidier while making the barangay less able to answer for
 * itself.
 *
 * All four states (§8): loading, error-with-retry, empty, populated.
 */
const SUBSCRIBER_COLUMNS = [
  { key: 'number', label: 'Number', width: '20%' },
  { key: 'consent', label: 'Consent', width: '38%' },
  { key: 'recorded', label: 'Recorded', width: '16%' },
  { key: 'status', label: 'Status', width: '14%' },
  { key: 'action', label: 'Action', align: 'right', width: '12%' },
];

function renderSubscribersTab(container) {
  container.className = 'sms-subscribers-page-container';
  container.innerHTML = '';

  const intro = document.createElement('div');
  intro.className = 'sms-subscribers-intro-banner';
  intro.innerHTML = `
    <span class="sms-subscribers-intro-icon" aria-hidden="true">${icons.info(18)}</span>
    <div class="sms-subscribers-intro-text">
      <strong>Consent-based advisory roster:</strong> Residents who have agreed to receive barangay-wide advisories (flood, curfew, suspension of classes). Numbers collected for incident reports are deliberately NOT reusable here — consent for one purpose is not consent for another under the Data Privacy Act, so every entry records how agreement was obtained.
    </div>
  `;
  container.appendChild(intro);

  const formCard = document.createElement('div');
  formCard.className = 'sms-subscriber-form';
  const form = document.createElement('form');
  form.className = 'sms-subscriber-form__row';

  const numberInput = document.createElement('input');
  numberInput.type = 'tel';
  numberInput.className = 'sms-subscriber-input';
  numberInput.placeholder = 'Mobile number';
  numberInput.setAttribute('aria-label', 'Subscriber mobile number');
  numberInput.required = true;

  const sourceSelect = document.createElement('select');
  sourceSelect.className = 'sms-subscriber-select';
  sourceSelect.setAttribute('aria-label', 'How consent was obtained');
  // No blank option and no pre-selected "default" that could be accepted
  // without a decision — the first entry is a prompt that fails
  // validation if left as-is.
  const prompt = document.createElement('option');
  prompt.value = '';
  prompt.textContent = 'How was consent given?';
  sourceSelect.appendChild(prompt);
  for (const [value, label] of Object.entries(CONSENT_SOURCE_LABELS)) {
    const opt = document.createElement('option');
    opt.value = value;
    opt.textContent = label;
    sourceSelect.appendChild(opt);
  }

  const noteInput = document.createElement('input');
  noteInput.type = 'text';
  noteInput.className = 'sms-subscriber-input';
  noteInput.placeholder = 'Note (optional) — e.g. barangay assembly list';
  noteInput.setAttribute('aria-label', 'Consent note');
  noteInput.maxLength = 255;

  const addBtn = document.createElement('button');
  addBtn.type = 'submit';
  addBtn.className = 'primary sms-subscriber-add-btn';
  addBtn.innerHTML = `<span aria-hidden="true">${icons.plus(16)}</span><span>Add subscriber</span>`;

  form.append(numberInput, sourceSelect, noteInput, addBtn);
  formCard.appendChild(form);
  container.appendChild(formCard);

  const listHost = document.createElement('div');
  listHost.className = 'sms-subscribers-list-host';
  container.appendChild(listHost);

  form.addEventListener('submit', async (event) => {
    event.preventDefault();
    const contactNumber = numberInput.value.trim();
    const consentSource = sourceSelect.value;
    if (contactNumber === '') {
      showToast('Enter the mobile number.', { variant: 'error' });
      return;
    }
    if (consentSource === '') {
      showToast('Select how consent was obtained — it cannot be left blank.', { variant: 'error' });
      return;
    }
    addBtn.disabled = true;
    try {
      await addSmsSubscriber({ contactNumber, consentSource, consentNote: noteInput.value.trim() });
      showToast('Subscriber added.', { variant: 'success' });
      numberInput.value = '';
      noteInput.value = '';
      sourceSelect.value = '';
      await load();
    } catch (err) {
      showToast(err instanceof ApiClientError ? err.message : 'Could not add the subscriber.', { variant: 'error' });
    } finally {
      addBtn.disabled = false;
    }
  });

  async function load() {
    listHost.innerHTML = '';
    const loading = document.createElement('p');
    loading.className = 'note';
    loading.textContent = 'Loading subscribers…';
    listHost.appendChild(loading);

    let data;
    try {
      data = await getSmsSubscribers();
    } catch (err) {
      listHost.innerHTML = '';
      const error = document.createElement('div');
      error.className = 'card';
      const msg = document.createElement('p');
      msg.textContent = err instanceof ApiClientError ? err.message : 'Could not load the advisory list.';
      const retry = document.createElement('button');
      retry.type = 'button';
      retry.className = 'ghost';
      retry.textContent = 'Retry';
      retry.addEventListener('click', () => load());
      error.append(msg, retry);
      listHost.appendChild(error);
      return;
    }

    listHost.innerHTML = '';

    const strip = document.createElement('div');
    strip.className = 'stat-card-grid stat-card-grid--2 sms-subscribers-stat-grid';
    for (const [label, value, tone] of [
      ['Active subscribers', data.activeCount, 'success'],
      ['Total on record', data.totalCount, 'primary'],
    ]) {
      const cell = document.createElement('div');
      cell.className = 'stat-card';
      const v = document.createElement('span');
      v.className = `stat-card__value${tone ? ' stat-card__value--' + tone : ''}`;
      v.textContent = String(value);
      const l = document.createElement('span');
      l.className = 'stat-card__label';
      l.textContent = label;
      cell.append(v, l);
      strip.appendChild(cell);
    }
    listHost.appendChild(strip);

    const tableCard = document.createElement('div');
    tableCard.className = 'sms-subscribers-table-card unified-table-card';

    tableCard.appendChild(DataTable({
      columns: SUBSCRIBER_COLUMNS,
      rows: data.items,
      rowKey: (row) => row.subscriberId,
      rowClass: (row) => row.optedOutAt ? 'is-opted-out' : '',
      caption: 'Advisory subscribers',
      emptyIcon: icons.users,
      emptyMessage: 'No one has subscribed yet. A barangay-wide advisory will reach nobody until residents opt in.',
      renderCell: (item, key) => renderSubscriberCell(item, key, load),
    }));

    listHost.appendChild(tableCard);
  }

  load();
}

function renderSubscriberCell(item, key, reload) {
  switch (key) {
    case 'number': {
      const span = document.createElement('span');
      span.className = 'sms-subscriber-number';
      span.textContent = item.contactNumber;
      return span;
    }
    case 'consent': {
      const wrap = document.createElement('div');
      wrap.className = 'sms-subscriber-consent';
      const main = document.createElement('div');
      main.textContent = CONSENT_SOURCE_LABELS[item.consentSource] || 'Not stated';
      wrap.appendChild(main);
      if (item.consentNote) {
        const note = document.createElement('div');
        note.className = 'sms-subscriber-note';
        note.textContent = item.consentNote;
        wrap.appendChild(note);
      }
      return wrap;
    }
    case 'recorded': {
      const span = document.createElement('span');
      span.className = 'text-secondary';
      span.textContent = item.consentAt ? formatManilaDate(item.consentAt) : '—';
      return span;
    }
    case 'status': {
      const wrap = document.createElement('div');
      wrap.className = 'sms-subscriber-status-wrap';
      const pill = document.createElement('span');
      pill.className = `status-pill ${item.optedOutAt ? 'status-pill--neutral' : 'status-pill--success'}`;
      pill.textContent = item.optedOutAt ? 'Opted out' : 'Subscribed';
      wrap.appendChild(pill);
      if (item.optedOutAt) {
        const date = document.createElement('div');
        date.className = 'sms-subscriber-note';
        date.textContent = `on ${formatManilaDate(item.optedOutAt)}`;
        wrap.appendChild(date);
      }
      return wrap;
    }
    case 'action': {
      if (item.optedOutAt) return '';
      const out = document.createElement('button');
      out.type = 'button';
      out.className = 'sms-subscriber-optout-btn';
      out.textContent = 'Opt out';
      out.setAttribute('aria-label', `Record opt-out for ${item.contactNumber}`);
      out.addEventListener('click', async () => {
        const ok = await confirmDialog({
          title: 'Record opt-out?',
          message: `${item.contactNumber} will stop receiving barangay advisories. The record is kept, not deleted, so the withdrawal can be shown to have been honoured.`,
          confirmLabel: 'Record opt-out',
        });
        if (!ok) return;
        try {
          await optOutSmsSubscriber(item.subscriberId);
          showToast('Opt-out recorded.', { variant: 'success' });
          await reload();
        } catch (err) {
          showToast(err instanceof ApiClientError ? err.message : 'Could not record the opt-out.', { variant: 'error' });
        }
      });
      return out;
    }
    default:
      return '';
  }
}

// ============================================================
// Conversations Tab
// ============================================================

function renderConversationsTab(container, pageHeader, user, setLiveFeedTimer, onUnreadChanged, navigate, initialPhone) {
  // Page Header Actions
  const actionsWrap = document.createElement('div');
  actionsWrap.className = 'sms-header-actions';

  const newMsgBtn = document.createElement('button');
  newMsgBtn.type = 'button';
  newMsgBtn.className = 'ghost';
  newMsgBtn.classList.add('sms-header-btn');
  newMsgBtn.innerHTML = `<span aria-hidden="true">${icons.plus(14)}</span><span>New Message</span>`;
  newMsgBtn.addEventListener('click', () => openNewMessageModal());

  const broadcastBtn = document.createElement('button');
  broadcastBtn.type = 'button';
  broadcastBtn.className = 'primary';
  broadcastBtn.classList.add('sms-header-btn');
  broadcastBtn.innerHTML = `<span aria-hidden="true">${icons.megaphone(14)}</span><span>Broadcast Alert</span>`;
  broadcastBtn.addEventListener('click', () => openBroadcastModal());

  actionsWrap.append(newMsgBtn, broadcastBtn);

  // Segmented KPI Card (Option 1 - mounted inside pageHeader.actions alongside action buttons)
  const kpiCard = document.createElement('div');
  kpiCard.className = 'sms-kpi-card';
  pageHeader.actions.append(kpiCard, actionsWrap);

  const layout = document.createElement('div');
  layout.className = 'sms-layout';
  container.appendChild(layout);

  const contactPane = document.createElement('div');
  contactPane.className = 'sms-contact-pane';

  const threadPane = document.createElement('div');
  threadPane.className = 'sms-thread-pane';

  const feedPane = document.createElement('div');
  feedPane.className = 'sms-feed-pane';

  layout.append(contactPane, threadPane, feedPane);

  let allConversations = [];
  let selectedPhone = initialPhone || null;
  let contactFilter = 'all'; // all | inbound | outbound | unread
  let searchQuery = '';

  // Set by renderThread() while a conversation is open, cleared by
  // renderThreadPlaceholder(). The AI composer's "Use this draft" writes
  // into it — the same closure-reference move the quick-reply chips
  // already make, rather than a document.querySelector.
  let composeTextareaRef = null;

  renderContactPaneShell();
  renderThreadPlaceholder();
  loadConversations();
  loadStatStrip();
  loadLiveFeed(feedPane, onSelectFeedPhone);
  setLiveFeedTimer(setInterval(() => loadLiveFeed(feedPane, onSelectFeedPhone), LIVE_FEED_POLL_MS));

  function onSelectFeedPhone(phone) {
    if (!phone) return;
    selectedPhone = phone;
    const found = allConversations.find((c) => c.phoneNumber === phone);
    renderContactList();
    if (found) {
      openThread(found);
    } else {
      openThread({ phoneNumber: phone, displayName: null, unreadCount: 0 });
    }
  }

  async function loadStatStrip() {
    const today = manilaDateKey(new Date());
    try {
      const [totalToday, inboundToday, outboundToday] = await Promise.all([
        getSmsLogs({ dateFrom: today, dateTo: today, limit: 1 }),
        getSmsLogs({ dateFrom: today, dateTo: today, direction: 'inbound', limit: 1 }),
        getSmsLogs({ dateFrom: today, dateTo: today, direction: 'outbound', limit: 1 }),
      ]);
      const unreadTotal = allConversations.reduce((sum, c) => sum + (c.unreadCount || 0), 0);
      onUnreadChanged(unreadTotal);

      // .total is a real count and 0 is a legitimate value (a quiet day
      // is real data, not something to paper over) — || here would
      // silently replace a genuine zero with a fabricated number, exactly
      // what Rule 6 (no fabricated statistics) exists to catch.
      const totalVal = totalToday.total ?? 0;
      const inVal = inboundToday.total ?? 0;
      const outVal = outboundToday.total ?? 0;
      const unreadVal = unreadTotal;

      kpiCard.innerHTML = `
        <button type="button" class="sms-kpi-col ${contactFilter === 'all' ? 'is-active' : ''}" data-filter="all" title="Show all messages">
          <span class="sms-kpi-val sms-kpi-val--total">${totalVal}</span>
          <span class="sms-kpi-label">Total Today</span>
        </button>
        <button type="button" class="sms-kpi-col ${contactFilter === 'inbound' ? 'is-active' : ''}" data-filter="inbound" title="Filter incoming messages">
          <span class="sms-kpi-val sms-kpi-val--inbound">${inVal}</span>
          <span class="sms-kpi-label">Incoming</span>
        </button>
        <button type="button" class="sms-kpi-col ${contactFilter === 'outbound' ? 'is-active' : ''}" data-filter="outbound" title="Filter outgoing messages">
          <span class="sms-kpi-val sms-kpi-val--outbound">${outVal}</span>
          <span class="sms-kpi-label">Outgoing</span>
        </button>
        <button type="button" class="sms-kpi-col ${contactFilter === 'unread' ? 'is-active' : ''}" data-filter="unread" title="Filter unread messages">
          <span class="sms-kpi-val sms-kpi-val--unread">${unreadVal}</span>
          <span class="sms-kpi-label">Unread</span>
        </button>
      `;

      kpiCard.querySelectorAll('.sms-kpi-col').forEach((item) => {
        item.addEventListener('click', () => {
          contactFilter = item.dataset.filter;
          updateFilterChipActive();
          updateStatStripActive();
          renderContactList();
        });
      });
    } catch {
      // Summary convenience
    }
  }

  function updateStatStripActive() {
    kpiCard.querySelectorAll('.sms-kpi-col').forEach((item) => {
      item.classList.toggle('is-active', item.dataset.filter === contactFilter);
    });
  }

  async function loadConversations() {
    try {
      const serverConvos = await getSmsConversations();
      // A genuinely empty list is real data (no conversations yet), not an
      // error - handled honestly by renderContactList()'s own "No SMS
      // conversations recorded." note. Never substitute placeholder rows.
      allConversations = Array.isArray(serverConvos) ? serverConvos : [];
      if (!selectedPhone && allConversations.length > 0) {
        selectedPhone = allConversations[0].phoneNumber;
      }
      renderContactList();
      loadStatStrip();
      if (selectedPhone) {
        const found = allConversations.find((c) => c.phoneNumber === selectedPhone);
        if (found) {
          openThread(found);
        } else {
          openThread({ phoneNumber: selectedPhone, displayName: null, unreadCount: 0 });
        }
      } else {
        renderThreadPlaceholder();
      }
    } catch (err) {
      // Never fall through to renderContactList()'s "No SMS conversations
      // recorded." — an outage must not read as a quiet inbox, or an
      // incoming emergency SMS could be missed.
      allConversations = [];
      selectedPhone = null;
      renderThreadPlaceholder();
      const listHost = contactPane._listHost;
      if (listHost) {
        renderError(
          listHost,
          err instanceof ApiClientError ? err.message : 'Could not load conversations.',
          loadConversations,
        );
      }
    }
  }

  function renderContactPaneShell() {
    contactPane.innerHTML = '';

    const headerEl = document.createElement('div');
    headerEl.className = 'sms-contact-pane__header';

    // Search bar
    const searchWrap = document.createElement('div');
    searchWrap.className = 'sms-search-wrap';

    const searchIcon = document.createElement('span');
    searchIcon.className = 'sms-search-icon';
    searchIcon.innerHTML = icons.search(14);
    searchIcon.setAttribute('aria-hidden', 'true');

    const searchInput = document.createElement('input');
    searchInput.type = 'search';
    searchInput.className = 'sms-search-input';
    searchInput.placeholder = 'Search messages…';
    searchInput.setAttribute('aria-label', 'Search conversations');

    const clearBtn = document.createElement('button');
    clearBtn.type = 'button';
    clearBtn.className = 'sms-search-clear';
    clearBtn.title = 'Clear search';
    clearBtn.setAttribute('aria-label', 'Clear search');
    clearBtn.innerHTML = icons.x(14);
    clearBtn.style.display = 'none';

    searchInput.addEventListener('input', (e) => {
      searchQuery = e.target.value.trim().toLowerCase();
      clearBtn.style.display = searchInput.value ? 'flex' : 'none';
      renderContactList();
    });

    clearBtn.addEventListener('click', () => {
      searchInput.value = '';
      searchQuery = '';
      clearBtn.style.display = 'none';
      searchInput.focus();
      renderContactList();
    });

    searchWrap.append(searchIcon, searchInput, clearBtn);
    contactPane._searchInput = searchInput;

    // Filter chips row matching screenshot (All, Inbox, Sent)
    const chipsRow = document.createElement('div');
    chipsRow.className = 'sms-filter-chips-row';
    contactPane._chipsRow = chipsRow;

    const filters = [
      { id: 'all', label: 'All' },
      { id: 'inbound', label: 'Inbox' },
      { id: 'outbound', label: 'Sent' },
    ];

    filters.forEach((f) => {
      const chip = document.createElement('button');
      chip.type = 'button';
      chip.className = `sms-filter-chip ${contactFilter === f.id ? 'is-active' : ''}`;
      chip.dataset.filterId = f.id;
      chip.textContent = f.label;
      chip.addEventListener('click', () => {
        contactFilter = f.id;
        updateFilterChipActive();
        updateStatStripActive();
        renderContactList();
      });
      chipsRow.appendChild(chip);
    });

    headerEl.append(searchWrap, chipsRow);

    const listHost = document.createElement('div');
    listHost.className = 'sms-contact-list';
    contactPane._listHost = listHost;

    contactPane.append(headerEl, listHost);
  }

  function updateFilterChipActive() {
    if (!contactPane._chipsRow) return;
    const buttons = contactPane._chipsRow.querySelectorAll('.sms-filter-chip');
    buttons.forEach((btn) => {
      btn.classList.toggle('is-active', btn.dataset.filterId === contactFilter);
    });
  }

  function getFilteredConversations() {
    return allConversations.filter((c) => {
      if (contactFilter === 'unread' && (!c.unreadCount || c.unreadCount === 0)) return false;
      if (contactFilter === 'inbound' && c.lastMessage?.direction !== 'inbound') return false;
      if (contactFilter === 'outbound' && c.lastMessage?.direction !== 'outbound') return false;

      if (searchQuery) {
        const phone = (c.phoneNumber || '').toLowerCase();
        const name = (c.displayName || '').toLowerCase();
        const body = (c.lastMessage?.messageBody || '').toLowerCase();
        if (!phone.includes(searchQuery) && !name.includes(searchQuery) && !body.includes(searchQuery)) {
          return false;
        }
      }
      return true;
    });
  }

  function renderContactList() {
    const listHost = contactPane._listHost;
    if (!listHost) return;
    listHost.innerHTML = '';

    const filtered = getFilteredConversations();

    if (filtered.length === 0) {
      const empty = document.createElement('p');
      empty.className = 'note sms-empty-note';
      empty.textContent = allConversations.length === 0
        ? 'No SMS conversations recorded.'
        : 'No conversations match your filter.';
      listHost.appendChild(empty);
      return;
    }

    filtered.forEach((convo) => {
      const card = document.createElement('div');
      card.className = `sms-contact-card ${convo.phoneNumber === selectedPhone ? 'is-selected' : ''}`;
      card.setAttribute('role', 'button');
      card.setAttribute('tabindex', '0');

      const tagInfo = getContactTagInfo(convo);
      const nameText = convo.displayName || convo.phoneNumber;
      const isUnread = convo.unreadCount > 0;

      // Top line: [Dot] Name & Time
      const top = document.createElement('div');
      top.className = 'sms-contact-card__top';

      const nameWrap = document.createElement('div');
      nameWrap.className = 'sms-contact-card__name-wrap';

      if (isUnread) {
        const unreadDot = document.createElement('span');
        unreadDot.className = 'sms-contact-unread-dot';
        unreadDot.setAttribute('aria-label', 'Unread message');
        nameWrap.appendChild(unreadDot);
      }

      const nameEl = document.createElement('span');
      nameEl.className = 'sms-contact-card__name';
      nameEl.textContent = nameText;
      nameWrap.appendChild(nameEl);

      const timeEl = document.createElement('span');
      timeEl.className = 'sms-contact-card__time';
      if (convo.lastMessage?.createdAt) {
        timeEl.textContent = convo.lastMessage.createdAt.length === 5 ? convo.lastMessage.createdAt : formatSmartTime(convo.lastMessage.createdAt);
      }
      top.append(nameWrap, timeEl);

      // Preview line (2-line clamped)
      const previewEl = document.createElement('div');
      previewEl.className = 'sms-contact-card__preview';
      previewEl.textContent = convo.lastMessage?.messageBody || `(${convo.lastMessage?.messageType ? msgTypeLabel(convo.lastMessage.messageType) : 'No message text'})`;

      // Bottom line: Pill Tag and Location
      const bottom = document.createElement('div');
      bottom.className = 'sms-contact-card__bottom';

      const pill = document.createElement('span');
      pill.className = `sms-tag-pill ${tagInfo.pillClass}`;
      pill.textContent = tagInfo.label;
      pill.title = 'Suggested label, guessed from the message';

      bottom.append(pill);
      card.append(top, previewEl, bottom);

      const triggerSelect = () => {
        selectedPhone = convo.phoneNumber;
        renderContactList();
        openThread(convo);
      };

      card.addEventListener('click', triggerSelect);
      card.addEventListener('keydown', (e) => {
        if (e.key === 'Enter' || e.key === ' ') {
          e.preventDefault();
          triggerSelect();
        }
      });

      listHost.appendChild(card);
    });
  }

  function renderThreadPlaceholder() {
    // No thread open means no compose box for a draft to land in.
    composeTextareaRef = null;
    threadPane.innerHTML = '';
    const card = document.createElement('div');
    card.className = 'sms-thread-card state-block';
    card.classList.add('sms-thread-placeholder');
    card.innerHTML = `
      <div class="sms-thread-placeholder__icon" aria-hidden="true">${icons.messageSquare(36)}</div>
      <h3 class="sms-thread-placeholder__title">Select a conversation</h3>
      <p class="note sms-thread-placeholder__desc">Choose a contact from the list on the left to read the messages, reply, or mark the conversation resolved.</p>
    `;
    threadPane.appendChild(card);
  }

  async function openThread(convo) {
    threadPane.innerHTML = '';
    const loading = document.createElement('div');
    loading.className = 'skeleton skeleton--block sms-thread-loading';
    loading.setAttribute('role', 'status');
    loading.setAttribute('aria-label', 'Loading conversation');
    threadPane.appendChild(loading);

    try {
      const messages = await getSmsConversationMessages(convo.phoneNumber);
      if (Array.isArray(messages) && messages.length > 0) {
        renderThread(convo, messages);
      } else if (convo.defaultMessages && convo.defaultMessages.length > 0) {
        renderThread(convo, convo.defaultMessages);
      } else {
        renderThread(convo, messages || []);
      }
    } catch (err) {
      if (convo.defaultMessages && convo.defaultMessages.length > 0) {
        renderThread(convo, convo.defaultMessages);
      } else {
        threadPane.innerHTML = '';
        const block = document.createElement('div');
        block.className = 'card state-block state-block--error';
        block.setAttribute('role', 'alert');
        const text = document.createElement('p');
        text.textContent = err instanceof ApiClientError ? err.message : 'Could not load this conversation.';
        block.appendChild(text);
        threadPane.appendChild(block);
      }
    }
  }

  function renderThread(convo, messages) {
    threadPane.innerHTML = '';
    const card = document.createElement('div');
    card.className = 'sms-thread-card';

    // 1. Thread Header
    const threadHeader = document.createElement('div');
    threadHeader.className = 'sms-thread-header';

    const contactWrap = document.createElement('div');
    contactWrap.className = 'sms-thread-header__contact';

    const avatar = document.createElement('div');
    avatar.className = 'sms-thread-avatar';
    const initialChar = (convo.displayName || convo.phoneNumber || 'C').trim().charAt(0).toUpperCase();
    avatar.textContent = initialChar;

    const info = document.createElement('div');
    info.className = 'sms-thread-header__info';

    const nameTitle = document.createElement('h3');
    nameTitle.className = 'sms-thread-header__name';
    nameTitle.textContent = convo.displayName || convo.phoneNumber;

    const tagInfo = getContactTagInfo(convo);

    const phoneLine = document.createElement('div');
    phoneLine.className = 'sms-thread-header__phone';
    phoneLine.innerHTML = `<span aria-hidden="true" class="sms-thread-header__phone-icon">${icons.phone(13)}</span><span>${escapeHtml(convo.phoneNumber)}</span>`;

    info.append(nameTitle, phoneLine);
    contactWrap.append(avatar, info);

    // Header actions on the right
    const headerActions = document.createElement('div');
    headerActions.className = 'sms-thread-header__actions';

    const headerTag = document.createElement('span');
    headerTag.className = `sms-tag-pill ${tagInfo.pillClass}`;
    headerTag.textContent = tagInfo.label;
    headerTag.title = 'Suggested label, guessed from the message';

    const resolveBtn = document.createElement('button');
    resolveBtn.type = 'button';
    resolveBtn.className = 'sms-resolve-btn';
    resolveBtn.textContent = 'Mark resolved';
    resolveBtn.disabled = convo.unreadCount === 0;
    resolveBtn.addEventListener('click', async () => {
      resolveBtn.disabled = true;
      try {
        await markSmsThreadResolved(convo.phoneNumber);
        showToast('Conversation marked as resolved.', { variant: 'success' });
        await loadConversations();
        convo.unreadCount = 0;
        resolveBtn.disabled = true;
      } catch (err) {
        resolveBtn.disabled = false;
        showToast(err instanceof ApiClientError ? err.message : 'Could not resolve conversation.', { variant: 'error' });
      }
    });

    headerActions.append(headerTag, resolveBtn);
    threadHeader.append(contactWrap, headerActions);
    card.appendChild(threadHeader);

    // 2. Messages List
    const messagesArea = document.createElement('div');
    messagesArea.className = 'sms-thread-messages';

    if (messages.length === 0) {
      const empty = document.createElement('p');
      empty.className = 'note sms-thread-empty';
      empty.textContent = 'No messages recorded for this contact yet.';
      messagesArea.appendChild(empty);
    } else {
      messages.forEach((msg) => {
        const at = msg.sentAt || msg.receivedAt || msg.createdAt;
        const isInbound = msg.direction === 'inbound';

        const bubbleRow = document.createElement('div');
        bubbleRow.className = `sms-bubble-row sms-bubble-row--${isInbound ? 'inbound' : 'outbound'}`;

        const bubble = document.createElement('div');
        bubble.className = `sms-bubble sms-bubble--${isInbound ? 'inbound' : 'outbound'}`;

        const text = document.createElement('div');
        text.className = 'sms-bubble__text';
        text.textContent = msg.messageBody || `(${msg.messageType ? msgTypeLabel(msg.messageType) : 'No message text'})`;
        bubble.appendChild(text);

        if (msg.incidentId) {
          const incidentLink = document.createElement('button');
          incidentLink.type = 'button';
          incidentLink.className = 'sms-bubble__linked-tag';
          incidentLink.innerHTML = `<span aria-hidden="true">${icons.fileText(12)}</span><span>${escapeHtml(formatIncidentCode(msg.incidentId, msg.incidentDisplayId))}</span>`;
          incidentLink.addEventListener('click', (e) => {
            e.stopPropagation();
            navigate('incident-detail', msg.incidentId);
          });
          bubble.appendChild(incidentLink);
        } else if (msg.dispatchId) {
          const dispatchTag = document.createElement('span');
          dispatchTag.className = 'sms-bubble__linked-tag';
          dispatchTag.innerHTML = `<span>${formatDispatchCode(msg.dispatchId)}</span>`;
          bubble.appendChild(dispatchTag);
        }

        bubbleRow.appendChild(bubble);

        // Metadata row BELOW bubble
        const metaRow = document.createElement('div');
        metaRow.className = 'sms-bubble__meta-row';

        const timeSpan = document.createElement('span');
        let timeFormatted = '';
        if (typeof at === 'string' && at.length === 5) {
          timeFormatted = at;
        } else if (at) {
          timeFormatted = formatManilaTime(at, '');
        }
        timeSpan.textContent = timeFormatted;
        metaRow.appendChild(timeSpan);

        if (isInbound) {
          const tagSpan = document.createElement('span');
          tagSpan.className = `sms-tag-pill ${tagInfo.pillClass}`;
          tagSpan.classList.add('sms-tag-pill--small');
          tagSpan.textContent = tagInfo.label;
          metaRow.appendChild(tagSpan);
        } else {
          const tick = document.createElement('span');
          if (msg.status === 'sent' || msg.status === 'received') {
            tick.className = 'sms-tick--success';
            tick.textContent = '✓✓';
            tick.title = 'Delivered';
            tick.setAttribute('aria-label', 'Delivered');
          } else if (msg.status === 'failed' || msg.status === 'rejected') {
            tick.className = 'sms-tick--fail';
            tick.textContent = 'Not delivered';
            tick.title = msg.failureReason || 'Not delivered';
          } else {
            tick.textContent = '✓';
            tick.title = statusLabel(msg.status);
            tick.setAttribute('aria-label', statusLabel(msg.status));
          }
          metaRow.appendChild(tick);
        }

        bubbleRow.appendChild(metaRow);
        messagesArea.appendChild(bubbleRow);
      });
    }

    card.appendChild(messagesArea);

    // 3. Quick Canned Responses (2-Column Pill Grid matching design)
    const quickRepliesSection = document.createElement('div');
    quickRepliesSection.className = 'sms-quick-replies-section';

    const qrTitle = document.createElement('div');
    qrTitle.className = 'sms-quick-replies-title';
    qrTitle.textContent = 'Quick replies';
    quickRepliesSection.appendChild(qrTitle);

    const qrGrid = document.createElement('div');
    qrGrid.className = 'sms-quick-replies-grid';

    QUICK_RESPONSES.forEach((qr) => {
      const chip = document.createElement('button');
      chip.type = 'button';
      chip.className = 'sms-quick-chip';
      chip.title = qr.full;
      chip.innerHTML = `<span class="sms-quick-chip__text">${escapeHtml(qr.display)}</span>`;
      chip.addEventListener('click', () => {
        composeTextarea.value = qr.full;
        updateCharCounter();
        composeTextarea.focus();
      });
      qrGrid.appendChild(chip);
    });

    quickRepliesSection.appendChild(qrGrid);
    card.appendChild(quickRepliesSection);

    // 4. Compose Box (Rounded card container)
    const composeSection = document.createElement('div');
    composeSection.className = 'sms-compose-section';

    const composeCard = document.createElement('div');
    composeCard.className = 'sms-compose-card';

    const composeTextarea = document.createElement('textarea');
    composeTextarea.className = 'sms-compose-textarea';
    composeTextarea.placeholder = 'I-type ang inyong mensahe dito...';
    composeTextarea.setAttribute('aria-label', 'Reply message');
    composeTextarea.rows = 2;
    // Where the AI composer's "Use this draft" delivers to.
    composeTextareaRef = composeTextarea;

    const composeFooter = document.createElement('div');
    composeFooter.className = 'sms-compose-footer';

    const toLine = document.createElement('span');
    toLine.className = 'sms-compose-to';
    toLine.textContent = `To: ${convo.phoneNumber}`;

    const rightWrap = document.createElement('div');
    rightWrap.className = 'sms-compose-right';

    const charCounter = document.createElement('span');
    charCounter.className = 'sms-compose-counter';
    charCounter.textContent = '0/160';

    const sendBtn = document.createElement('button');
    sendBtn.type = 'button';
    sendBtn.className = 'sms-compose-send-circle';
    sendBtn.setAttribute('aria-label', 'Send message');
    sendBtn.title = 'Send (Ctrl+Enter)';
    sendBtn.innerHTML = icons.send(16);
    sendBtn.disabled = true;

    function updateCharCounter() {
      const len = composeTextarea.value.length;
      const seg = getSmsSegmentCount(composeTextarea.value);
      charCounter.textContent = `${len}/${seg.limit} · ${seg.segments} SMS${seg.segments === 1 ? '' : 's'}${seg.encoding === 'UCS-2' ? ' · Unicode' : ''}`;
      charCounter.classList.toggle('is-warning', seg.segments > 1);
      charCounter.classList.toggle('is-danger', len > 800);
      sendBtn.disabled = composeTextarea.value.trim() === '';
    }

    composeTextarea.addEventListener('input', updateCharCounter);

    const handleSend = async () => {
      const message = composeTextarea.value.trim();
      if (!message) return;

      sendBtn.disabled = true;
      composeTextarea.disabled = true;

      try {
        const result = await sendSms({
          phoneNumber: convo.phoneNumber,
          message,
          idempotencyKey: crypto.randomUUID(),
        });

        if (result.status === 'sent') {
          showToast('Message sent successfully.', { variant: 'success' });
        } else {
          showToast(`Message saved but not confirmed sent. Status: ${statusLabel(result.status)}${result.failureReason ? ` (${result.failureReason})` : ''}.`, {
            variant: 'info',
          });
        }
        composeTextarea.value = '';
        updateCharCounter();
        await openThread(convo);
        await loadConversations();
      } catch (err) {
        showToast(err instanceof ApiClientError ? err.message : 'Could not send SMS.', { variant: 'error' });
      } finally {
        composeTextarea.disabled = false;
        sendBtn.disabled = composeTextarea.value.trim() === '';
      }
    };

    sendBtn.addEventListener('click', handleSend);

    composeTextarea.addEventListener('keydown', (e) => {
      if ((e.ctrlKey || e.metaKey) && e.key === 'Enter') {
        e.preventDefault();
        handleSend();
      }
    });

    rightWrap.append(charCounter, sendBtn);
    composeFooter.append(toLine, rightWrap);
    composeCard.append(composeTextarea, composeFooter);
    composeSection.appendChild(composeCard);
    card.appendChild(composeSection);

    threadPane.appendChild(card);

    // Auto-scroll messages to bottom
    setTimeout(() => {
      messagesArea.scrollTop = messagesArea.scrollHeight;
    }, 50);
  }

  // Modals
  function openBroadcastModal(initialText = '') {
    const opener = document.activeElement;
    const restoreFocus = () => { if (opener && typeof opener.focus === 'function' && opener.isConnected) opener.focus(); };
    const modalEl = buildBroadcastModal(() => {
      document.body.removeChild(modalEl);
      loadStatStrip();
      restoreFocus();
    }, () => {
      document.body.removeChild(modalEl);
      restoreFocus();
    }, initialText);
    document.body.appendChild(modalEl);
    modalEl.querySelector('textarea')?.focus();
  }

  function openNewMessageModal() {
    const opener = document.activeElement;
    const restoreFocus = () => { if (opener && typeof opener.focus === 'function' && opener.isConnected) opener.focus(); };
    const modalEl = buildNewMessageModal(allConversations, (phone) => {
      document.body.removeChild(modalEl);
      onSelectFeedPhone(phone);
      loadConversations();
      restoreFocus();
    }, () => {
      document.body.removeChild(modalEl);
      restoreFocus();
    });
    document.body.appendChild(modalEl);
    modalEl.querySelector('select')?.focus();
  }
}

// ============================================================
// Live Activity Feed (Right Pane)
// ============================================================

async function loadLiveFeed(feedPane, onSelectPhone) {
  let listHost = feedPane.querySelector('.sms-feed-list');

  if (!listHost) {
    feedPane.innerHTML = '';

    const header = document.createElement('div');
    header.className = 'sms-feed-header';

    const title = document.createElement('h3');
    title.className = 'sms-feed-title';
    title.textContent = 'Live Feed';

    const indicator = document.createElement('div');
    indicator.className = 'sms-live-indicator';
    indicator.innerHTML = `<span class="sms-live-dot" aria-hidden="true"></span><span>Live</span>`;

    header.append(title, indicator);

    listHost = document.createElement('div');
    listHost.className = 'sms-feed-list';

    const footer = document.createElement('div');
    footer.className = 'sms-feed-footer';

    const refreshBtn = document.createElement('button');
    refreshBtn.type = 'button';
    refreshBtn.className = 'sms-feed-refresh-btn';
    refreshBtn.innerHTML = `<span aria-hidden="true">${icons.repeat(14)}</span><span>Refresh</span>`;
    refreshBtn.addEventListener('click', () => loadLiveFeed(feedPane, onSelectPhone));

    const helpBtn = document.createElement('button');
    helpBtn.type = 'button';
    helpBtn.className = 'sms-feed-help-btn';
    helpBtn.title = 'About the live feed';
    helpBtn.setAttribute('aria-label', 'About the live feed');
    helpBtn.textContent = '?';
    helpBtn.addEventListener('click', () => {
      showToast('The live feed refreshes every few seconds with the latest incoming and outgoing messages.', { variant: 'info' });
    });

    footer.append(refreshBtn, helpBtn);

    feedPane.append(header, listHost, footer);
  }

  try {
    const result = await getSmsLogs({ limit: 25 });
    if (result.items && result.items.length > 0) {
      renderFeedItems(result.items, listHost, onSelectPhone);
    } else {
      renderEmptyFeed(listHost);
    }
  } catch {
    renderFeedError(listHost);
  }
}

// A quiet inline note, not a toast: this panel polls every
// LIVE_FEED_POLL_MS, and a real outage would otherwise spam a toast every
// cycle. Genuinely-empty and fetch-failed are worded differently so an
// Admin watching this panel can tell "nothing happening" from "this isn't
// working" - both used to render identically (fabricated placeholder rows).
function renderEmptyFeed(listHost) {
  listHost.innerHTML = '';
  const note = document.createElement('p');
  note.className = 'note sms-empty-note';
  note.textContent = 'No recent SMS activity.';
  listHost.appendChild(note);
}

function renderFeedError(listHost) {
  listHost.innerHTML = '';
  const note = document.createElement('p');
  note.className = 'note sms-empty-note';
  note.textContent = 'Could not load the live feed.';
  listHost.appendChild(note);
}

function renderFeedItems(items, listHost, onSelectPhone) {
  listHost.innerHTML = '';

  if (items.length === 0) {
    renderEmptyFeed(listHost);
    return;
  }

  items.forEach((item) => {
    const entry = document.createElement('div');
    entry.className = 'sms-feed-item';

    const dot = document.createElement('span');
    dot.className = 'sms-feed-dot';
    if (item.status === 'failed' || item.messageType === 'sos') {
      dot.classList.add('sms-feed-dot--red');
    } else if (item.direction === 'outbound') {
      dot.classList.add('sms-feed-dot--blue');
    } else {
      dot.classList.add('sms-feed-dot--green');
    }

    const body = document.createElement('div');
    body.className = 'sms-feed-body';

    const text = document.createElement('span');
    text.className = 'sms-feed-text';
    text.textContent = describeLiveFeedEvent(item);

    const time = document.createElement('span');
    time.className = 'sms-feed-time';
    const at = item.sentAt || item.receivedAt || item.createdAt;
    time.textContent = at ? formatManilaTime(at, '') : '';

    body.append(text, time);
    entry.append(dot, body);

    // 2026-09-13: removed a "Click to view related conversation" title +
    // click handler keyed on `item.phoneNumber` — GET /sms/logs never
    // returns a phone number (masked by design, REFERENCE.md §5) so this
    // could never actually fire; it looked interactive and did nothing,
    // exactly what §2 Rule 6 forbids. `onSelectPhone` stays a parameter
    // here (unused in this function now) since callers still thread it
    // through for `loadLiveFeed`'s own signature, shared with other real
    // uses of the same callback elsewhere in this file.

    listHost.appendChild(entry);
  });
}

// 2026-09-13: was keyword-matching against `item.messageBody`/hardcoded
// barangay and Tanod names ("Tanod Ramos", "Tanod Garcia", "Brgy.
// Marifosque"/"Brgy. Binanuahan") that exist nowhere in this project's
// real seed data — a live §2 Rule 6 violation ("no fabricated
// statistics... no hardcoded identities") found while closing out a
// backlog item elsewhere. Worse than a missing-data fallback: this ran
// on EVERY row unconditionally, and `GET /sms/logs` never even returns
// `message_body` or a phone number in the first place (masked by
// design, see REFERENCE.md §5's own note on this endpoint) — so the
// keyword branches could never match real data; they'd have silently
// fired their fabricated text only for the empty-string case, i.e.
// always. Replaced with a plain, honest description built from the two
// real fields this endpoint actually returns: direction and message
// type, same `replace(/_/g, ' ')` humanization already used elsewhere
// in this file (see the Conversations detail rendering).
function describeLiveFeedEvent(item) {
  const direction = item.direction === 'outbound' ? 'Outgoing' : 'Incoming';
  const typeLabel = item.messageType ? msgTypeLabel(item.messageType).toLowerCase() : 'message';
  const statusNote = item.status === 'failed' ? ' (failed)' : '';
  return `${direction} ${typeLabel}${statusNote}`;
}

// ============================================================
// Modals
// ============================================================

/**
 * Keyboard behaviour for the page's two SMS dialogs (audit X-10): Escape
 * closes, Tab stays inside. Focus return is done by the opener.
 */
function trapModalKeys(overlay, onCancel) {
  overlay.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') {
      e.stopPropagation();
      onCancel();
      return;
    }
    if (e.key !== 'Tab') return;
    const focusable = [...overlay.querySelectorAll('button, [href], input, select, textarea, [tabindex]:not([tabindex="-1"])')]
      .filter((el) => !el.disabled);
    if (focusable.length === 0) return;
    const first = focusable[0];
    const last = focusable[focusable.length - 1];
    if (e.shiftKey && document.activeElement === first) { e.preventDefault(); last.focus(); }
    else if (!e.shiftKey && document.activeElement === last) { e.preventDefault(); first.focus(); }
  });
}

/**
 * Broadcast Alert Modal with Live Device Preview.
 */
function buildBroadcastModal(onSuccess, onCancel, initialText = '') {
  const overlay = document.createElement('div');
  overlay.className = 'sms-modal-overlay';

  const modal = document.createElement('div');
  modal.className = 'sms-modal';
  modal.setAttribute('role', 'dialog');
  modal.setAttribute('aria-modal', 'true');
  modal.setAttribute('aria-labelledby', 'sms-broadcast-title');

  const header = document.createElement('div');
  header.className = 'sms-modal__header';

  const title = document.createElement('h3');
  title.className = 'sms-modal__title';
  title.id = 'sms-broadcast-title';
  title.innerHTML = `<span aria-hidden="true">${icons.megaphone(20)}</span><span>Send a broadcast SMS</span>`;

  const closeBtn = document.createElement('button');
  closeBtn.type = 'button';
  closeBtn.className = 'sms-modal__close';
  closeBtn.setAttribute('aria-label', 'Close');
  closeBtn.innerHTML = icons.x(18);
  closeBtn.addEventListener('click', onCancel);
  trapModalKeys(overlay, onCancel);

  header.append(title, closeBtn);

  const form = document.createElement('form');

  const body = document.createElement('div');
  body.className = 'sms-modal__body';

  // Target audience selection
  const scopeField = document.createElement('div');
  scopeField.className = 'sms-modal-field';

  const scopeLabel = document.createElement('label');
  scopeLabel.className = 'sms-modal-label';
  scopeLabel.htmlFor = 'sms-broadcast-audience';
  scopeLabel.textContent = 'Send to (required)';

  const scopeSelect = document.createElement('select');
  scopeSelect.id = 'sms-broadcast-audience';
  scopeSelect.className = 'personnel-form-select';
  const scopeOptions = [
    ['on_duty_tanods', 'All on-duty Tanods'],
    ['role:tanod', 'All Tanods (on or off duty)'],
    ['role:secretary', 'All Barangay Secretaries'],
    ['role:admin', 'All Admins (Chief Tanod accounts)'],
    ['role:punong_barangay', 'Punong Barangay'],
    ['subscribers', 'Residents: consented advisory subscribers only'],
  ];
  scopeOptions.forEach(([val, label]) => {
    const opt = document.createElement('option');
    opt.value = val;
    opt.textContent = label;
    scopeSelect.appendChild(opt);
  });
  scopeField.append(scopeLabel, scopeSelect);

  // Message content
  const msgField = document.createElement('div');
  msgField.className = 'sms-modal-field';

  const msgLabel = document.createElement('label');
  msgLabel.className = 'sms-modal-label';
  msgLabel.htmlFor = 'sms-broadcast-message';
  msgLabel.textContent = 'Message (required)';

  const textarea = document.createElement('textarea');
  textarea.id = 'sms-broadcast-message';
  textarea.className = 'sms-compose-textarea';
  textarea.rows = 4;
  textarea.placeholder = 'Type the message to send to the people selected above…';
  textarea.required = true;

  const counterWrap = document.createElement('div');
  counterWrap.className = 'sms-segment-counter';
  counterWrap.setAttribute('aria-live', 'polite');
  counterWrap.textContent = '0 / 160 characters · 1 text message';

  msgField.append(msgLabel, textarea, counterWrap);

  // Live Device Preview Box
  const previewBox = document.createElement('div');
  previewBox.className = 'sms-device-preview';

  const previewLabel = document.createElement('span');
  previewLabel.className = 'sms-device-preview__label';
  previewLabel.textContent = 'How it will look on the phone';

  const previewBubble = document.createElement('div');
  previewBubble.className = 'sms-device-preview__bubble';
  previewBubble.textContent = 'Your message text will appear here…';

  previewBox.append(previewLabel, previewBubble);

  textarea.addEventListener('input', () => {
    const len = textarea.value.length;
    const seg = getSmsSegmentCount(textarea.value);
    counterWrap.textContent = `${len} / ${seg.limit} characters · ${seg.segments} text message${seg.segments === 1 ? '' : 's'}${seg.encoding === 'UCS-2' ? ' · special characters' : ''}`;
    previewBubble.textContent = textarea.value.trim() || 'Your message text will appear here…';
  });

  if (initialText) {
    textarea.value = initialText;
    const initialLen = textarea.value.length;
    const initialSeg = getSmsSegmentCount(textarea.value);
    counterWrap.textContent = `${initialLen} / ${initialSeg.limit} characters · ${initialSeg.segments} text message${initialSeg.segments === 1 ? '' : 's'}${initialSeg.encoding === 'UCS-2' ? ' · special characters' : ''}`;
    previewBubble.textContent = textarea.value.trim() || 'Your message text will appear here…';
  }

  body.append(scopeField, msgField, previewBox);

  // Footer
  const footer = document.createElement('div');
  footer.className = 'sms-modal__footer';

  const cancelBtn = document.createElement('button');
  cancelBtn.type = 'button';
  cancelBtn.className = 'ghost';
  cancelBtn.textContent = 'Cancel';
  cancelBtn.addEventListener('click', onCancel);

  const sendBtn = document.createElement('button');
  sendBtn.type = 'submit';
  sendBtn.className = 'primary';
  sendBtn.innerHTML = `<span aria-hidden="true">${icons.send(14)}</span><span>Send broadcast</span>`;

  footer.append(cancelBtn, sendBtn);
  form.append(body, footer);
  modal.append(header, form);
  overlay.appendChild(modal);

  overlay.addEventListener('click', (e) => {
    if (e.target === overlay) onCancel();
  });

  form.addEventListener('submit', async (e) => {
    e.preventDefault();
    const message = textarea.value.trim();
    if (!message) return;

    const confirmed = await confirmDialog({
      title: 'Send this broadcast?',
      description: scopeSelect.value === 'subscribers'
        ? 'This immediately sends to every resident on your advisory list who has consented and not opted out. This action cannot be canceled once initiated.'
        : 'This immediately sends to every matching recipient in your barangay. This action cannot be canceled once initiated.',
      confirmLabel: 'Send broadcast',
      cancelLabel: 'Keep editing',
      danger: true,
    });
    if (!confirmed) return;

    sendBtn.disabled = true;
    sendBtn.textContent = 'Sending…';

    try {
      const [scopeKey, role] = scopeSelect.value.split(':');
      const result = await broadcastSms({
        message,
        scope: scopeKey === 'role' ? 'role' : (scopeKey === 'subscribers' ? 'subscribers' : 'on_duty_tanods'),
        role: scopeKey === 'role' ? role : undefined,
        idempotencyKey: crypto.randomUUID(),
      });
      showToast(`Broadcast done: ${result.recipientCount} recipient${result.recipientCount === 1 ? '' : 's'}, ${result.sent} sent.`, {
        variant: result.failed > 0 ? 'info' : 'success',
      });
      onSuccess();
    } catch (err) {
      showToast(err instanceof ApiClientError ? err.message : 'Could not broadcast SMS.', { variant: 'error' });
      sendBtn.disabled = false;
      sendBtn.innerHTML = `<span aria-hidden="true">${icons.send(14)}</span><span>Send broadcast</span>`;
    }
  });

  setTimeout(() => textarea.focus(), 50);
  return overlay;
}

/**
 * New Direct Message Modal.
 */
function buildNewMessageModal(existingConversations, onRecipientSelected, onCancel) {
  const overlay = document.createElement('div');
  overlay.className = 'sms-modal-overlay';

  const modal = document.createElement('div');
  modal.className = 'sms-modal';
  modal.setAttribute('role', 'dialog');
  modal.setAttribute('aria-modal', 'true');
  modal.setAttribute('aria-labelledby', 'sms-newmsg-title');

  const header = document.createElement('div');
  header.className = 'sms-modal__header';

  const title = document.createElement('h3');
  title.className = 'sms-modal__title';
  title.id = 'sms-newmsg-title';
  title.innerHTML = `<span aria-hidden="true">${icons.plus(20)}</span><span>New text message</span>`;

  const closeBtn = document.createElement('button');
  closeBtn.type = 'button';
  closeBtn.className = 'sms-modal__close';
  closeBtn.setAttribute('aria-label', 'Close');
  closeBtn.innerHTML = icons.x(18);
  closeBtn.addEventListener('click', onCancel);
  trapModalKeys(overlay, onCancel);

  header.append(title, closeBtn);

  const form = document.createElement('form');

  const body = document.createElement('div');
  body.className = 'sms-modal__body';

  // Recipient Dropdown / Select
  const recipField = document.createElement('div');
  recipField.className = 'sms-modal-field';

  const recipLabel = document.createElement('label');
  recipLabel.className = 'sms-modal-label';
  recipLabel.htmlFor = 'sms-newmsg-recipient';
  recipLabel.textContent = 'Send to (required)';

  const recipSelect = document.createElement('select');
  recipSelect.id = 'sms-newmsg-recipient';
  recipSelect.className = 'personnel-form-select';
  recipSelect.required = true;

  const defaultOpt = document.createElement('option');
  defaultOpt.value = '';
  defaultOpt.textContent = 'Choose a person or a recent contact';
  recipSelect.appendChild(defaultOpt);

  // Load registered Tanods / Users to allow messaging staff directly
  getUsers({ limit: 100 }).then((res) => {
    if (res.items.length > 0) {
      const groupPersonnel = document.createElement('optgroup');
      groupPersonnel.label = 'Barangay staff';
      res.items.forEach((u) => {
        if (u.contactNumber) {
          const opt = document.createElement('option');
          opt.value = `user:${u.userId}:${u.contactNumber}`;
          opt.textContent = `${u.fullName} (${ROLE_LABELS[u.role] || 'Staff'}) · ${u.contactNumber}`;
          groupPersonnel.appendChild(opt);
        }
      });
      recipSelect.appendChild(groupPersonnel);
    }
  }).catch(() => {});

  if (existingConversations.length > 0) {
    const groupRecent = document.createElement('optgroup');
    groupRecent.label = 'Recent conversations';
    existingConversations.forEach((c) => {
      const opt = document.createElement('option');
      opt.value = `phone:${c.phoneNumber}`;
      opt.textContent = `${c.displayName || 'Resident'} · ${c.phoneNumber}`;
      groupRecent.appendChild(opt);
    });
    recipSelect.appendChild(groupRecent);
  }

  recipField.append(recipLabel, recipSelect);

  // Message body
  const msgField = document.createElement('div');
  msgField.className = 'sms-modal-field';

  const msgLabel = document.createElement('label');
  msgLabel.className = 'sms-modal-label';
  msgLabel.htmlFor = 'sms-newmsg-message';
  msgLabel.textContent = 'Message (required)';

  const textarea = document.createElement('textarea');
  textarea.id = 'sms-newmsg-message';
  textarea.className = 'sms-compose-textarea';
  textarea.rows = 4;
  textarea.placeholder = 'Type your text message…';
  textarea.required = true;

  const counterWrap = document.createElement('div');
  counterWrap.className = 'sms-segment-counter';
  counterWrap.setAttribute('aria-live', 'polite');
  counterWrap.textContent = '0 / 160 characters · 1 text message';

  textarea.addEventListener('input', () => {
    const len = textarea.value.length;
    const seg = getSmsSegmentCount(textarea.value);
    counterWrap.textContent = `${len} / ${seg.limit} characters · ${seg.segments} text message${seg.segments === 1 ? '' : 's'}${seg.encoding === 'UCS-2' ? ' · special characters' : ''}`;
  });

  msgField.append(msgLabel, textarea, counterWrap);

  body.append(recipField, msgField);

  // Footer
  const footer = document.createElement('div');
  footer.className = 'sms-modal__footer';

  const cancelBtn = document.createElement('button');
  cancelBtn.type = 'button';
  cancelBtn.className = 'ghost';
  cancelBtn.textContent = 'Cancel';
  cancelBtn.addEventListener('click', onCancel);

  const sendBtn = document.createElement('button');
  sendBtn.type = 'submit';
  sendBtn.className = 'primary';
  sendBtn.innerHTML = `<span aria-hidden="true">${icons.send(14)}</span><span>Send message</span>`;

  footer.append(cancelBtn, sendBtn);
  form.append(body, footer);
  modal.append(header, form);
  overlay.appendChild(modal);

  overlay.addEventListener('click', (e) => {
    if (e.target === overlay) onCancel();
  });

  form.addEventListener('submit', async (e) => {
    e.preventDefault();
    const val = recipSelect.value;
    const message = textarea.value.trim();
    if (!val || !message) return;

    sendBtn.disabled = true;
    sendBtn.textContent = 'Sending…';

    const parts = val.split(':');
    const isUser = parts[0] === 'user';
    const recipientUserId = isUser ? Number(parts[1]) : undefined;
    const targetPhone = isUser ? parts[2] : parts[1];

    try {
      const result = await sendSms({
        recipientUserId,
        phoneNumber: isUser ? undefined : targetPhone,
        message,
        idempotencyKey: crypto.randomUUID(),
      });
      showToast(result.status === 'sent' ? 'Message sent.' : `Message saved. Status: ${statusLabel(result.status)}.`, {
        variant: result.status === 'sent' ? 'success' : 'info',
      });
      onRecipientSelected(targetPhone);
    } catch (err) {
      showToast(err instanceof ApiClientError ? err.message : 'Could not send SMS.', { variant: 'error' });
      sendBtn.disabled = false;
      sendBtn.innerHTML = `<span aria-hidden="true">${icons.send(14)}</span><span>Send message</span>`;
    }
  });

  return overlay;
}

// ============================================================
// Activity Log Tab (Preserved + Tokenized Alignment)
// ============================================================

/**
 * Thin adapter over the shared DateRangePicker component.
 *
 * 2026-09-06 UI/UX audit: this file used to hand-roll the whole control
 * (~130 lines), as four other screens also did. The shared component owns
 * it now; this wrapper only preserves the {wrapper, getDateRange, reset}
 * shape the Activity Log tab's call sites already expect, and translates
 * the component's {from, to} into the {dateFrom, dateTo} the SMS log's
 * query builder uses. "All time" maps to undefined/undefined, which is
 * this screen's way of sending no date bounds at all.
 */
function buildDateRangePicker(initialRange = '30', onRangeChange) {
  const picker = DateRangePicker({
    value: initialRange,
    allowAllTime: true,
    ariaLabel: 'Date range',
    selectClassName: 'sms-log-filter-select',
    onChange: ({ mode, from, to }) =>
      onRangeChange({ dateFrom: from ?? undefined, dateTo: to ?? undefined, range: mode }),
  });

  return {
    wrapper: picker.el,
    getDateRange: () => {
      const { from, to } = picker.getState();
      return { dateFrom: from ?? undefined, dateTo: to ?? undefined };
    },
  };
}

function renderActivityLogTab(container, pageHeader, navigate) {
  let currentPageItems = [];
  container.className = 'sms-log-page-container';

  const exportButton = document.createElement('button');
  exportButton.type = 'button';
  exportButton.className = 'ghost';
  exportButton.innerHTML = `<span aria-hidden="true">${icons.download(16)}</span><span>Export CSV</span>`;
  exportButton.addEventListener('click', () => exportRowsToCsv(COLUMNS, currentPageItems, 'baranguard-sms-log'));
  pageHeader.actions.appendChild(exportButton);

  const statStripHost = document.createElement('div');
  statStripHost.className = 'personnel-card-stat-strip sms-log-stat-strip';
  statStripHost.setAttribute('role', 'toolbar');
  statStripHost.setAttribute('aria-label', 'SMS log quick filters');

  const filterPanel = document.createElement('div');
  filterPanel.className = 'sms-log-filter-panel';

  const typeSelect = buildFilterSelect('sms-log-type', 'Message type', 'All types', MESSAGE_TYPES.map((v) => [v, msgTypeLabel(v)]));
  const directionSelect = buildFilterSelect('sms-log-direction', 'Direction', 'Both directions', DIRECTIONS.map((v) => [v, DIRECTION_LABELS[v]]));
  const statusSelect = buildFilterSelect('sms-log-status', 'Status', 'All statuses', STATUSES.map((v) => [v, statusLabel(v)]));

  const dateRangePicker = buildDateRangePicker('30', () => {
    currentPage = 1;
    load();
    refreshStats();
  });

  const col1 = document.createElement('div');
  col1.className = 'sms-log-filter-col';
  col1.append(typeSelect.fragment);

  const col2 = document.createElement('div');
  col2.className = 'sms-log-filter-col';
  col2.append(directionSelect.fragment);

  const col3 = document.createElement('div');
  col3.className = 'sms-log-filter-col';
  col3.append(statusSelect.fragment);

  const col4 = document.createElement('div');
  col4.className = 'sms-log-filter-col';
  col4.append(dateRangePicker.wrapper);

  filterPanel.append(col1, col2, col3, col4);

  const layout = document.createElement('div');
  layout.className = 'split-panel';
  container.appendChild(layout);

  const body = document.createElement('div');
  body.className = 'sms-table-body';

  const tableCard = document.createElement('div');
  tableCard.className = 'sms-table-card unified-table-card';
  tableCard.append(statStripHost, filterPanel, body);
  layout.appendChild(tableCard);

  const detailPane = document.createElement('div');
  detailPane.className = 'sms-detail-pane';
  layout.appendChild(detailPane);
  renderDetailPlaceholder(detailPane);

  let currentPage = 1;
  [typeSelect.select, directionSelect.select, statusSelect.select].forEach((el) => {
    el.addEventListener('change', () => {
      currentPage = 1;
      load();
      refreshStats();
    });
  });

  load();
  refreshStats();

  function activeFilters() {
    const range = dateRangePicker.getDateRange();
    return {
      messageType: typeSelect.select.value || undefined,
      direction: directionSelect.select.value || undefined,
      status: statusSelect.select.value || undefined,
      dateFrom: range.dateFrom,
      dateTo: range.dateTo,
    };
  }

  async function refreshStats() {
    const base = activeFilters();
    try {
      const [total, inbound, outbound, failed] = await Promise.all([
        getSmsLogs({ ...base, limit: 1 }),
        getSmsLogs({ ...base, direction: 'inbound', limit: 1 }),
        getSmsLogs({ ...base, direction: 'outbound', limit: 1 }),
        getSmsLogs({ ...base, status: 'failed', limit: 1 }),
      ]);
      statStripHost.innerHTML = '';

      const curDir = directionSelect.select.value;
      const curStat = statusSelect.select.value;

      const chips = [
        {
          label: 'Total',
          value: total.total,
          active: !curDir && !curStat,
          onClick: () => {
            directionSelect.select.value = '';
            statusSelect.select.value = '';
            currentPage = 1;
            load();
            refreshStats();
          },
        },
        {
          label: 'Inbound',
          value: inbound.total,
          tone: 'info',
          active: curDir === 'inbound' && !curStat,
          onClick: () => {
            directionSelect.select.value = 'inbound';
            currentPage = 1;
            load();
            refreshStats();
          },
        },
        {
          label: 'Outbound',
          value: outbound.total,
          tone: 'info',
          active: curDir === 'outbound' && !curStat,
          onClick: () => {
            directionSelect.select.value = 'outbound';
            currentPage = 1;
            load();
            refreshStats();
          },
        },
        {
          label: 'Failed',
          value: failed.total,
          tone: failed.total > 0 ? 'critical' : undefined,
          active: curStat === 'failed',
          onClick: () => {
            statusSelect.select.value = 'failed';
            currentPage = 1;
            load();
            refreshStats();
          },
        },
      ];

      chips.forEach((cfg) => {
        const btn = document.createElement('button');
        btn.type = 'button';
        btn.className = `personnel-stat-chip${cfg.active ? ' is-active' : ''}`;
        btn.setAttribute('aria-pressed', cfg.active ? 'true' : 'false');
        btn.setAttribute('aria-label', `${cfg.label} (${cfg.value})`);

        const lbl = document.createElement('span');
        lbl.className = 'stat-chip__label';
        lbl.textContent = cfg.label;

        const cnt = document.createElement('span');
        cnt.className = `stat-chip__count${cfg.tone ? ' tone-' + cfg.tone : ''}`;
        cnt.textContent = String(cfg.value);

        btn.append(lbl, cnt);
        btn.addEventListener('click', cfg.onClick);
        statStripHost.appendChild(btn);
      });
    } catch {}
  }

  async function load() {
    renderLoading(body);
    try {
      const result = await getSmsLogs({ ...activeFilters(), page: currentPage, limit: PAGE_SIZE });
      currentPageItems = result.items;
      renderList(body, result.items, result.total, (nextPage) => {
        currentPage = nextPage;
        load();
      });
    } catch (err) {
      const message = err instanceof ApiClientError ? err.message : 'Something went wrong loading the SMS log.';
      renderError(body, message, load);
    }
  }

  let selectedLogId = null;

  function renderList(listContainer, items, totalItems, onPageChange) {
    listContainer.innerHTML = '';
    const table = DataTable({
      columns: COLUMNS,
      rows: items,
      rowKey: (row) => row.logId,
      selectedKey: selectedLogId,
      onRowClick: (row) => {
        selectedLogId = row.logId;
        table.querySelectorAll('tbody tr').forEach((tr) => {
          const act = tr.querySelector('.data-table__row-activator');
          tr.classList.toggle('is-selected', Boolean(act && act.textContent.includes(String(row.logId))));
        });
        renderRowDetail(detailPane, row, navigate);
      },
      caption: 'SMS activity log',
      emptyIcon: icons.messageSquare,
      emptyMessage: 'No SMS activity matches these filters yet.',
      page: currentPage,
      totalItems,
      pageSize: PAGE_SIZE,
      onPageChange,
      renderCell: (row, key) => renderSmsLogCell(row, key, navigate),
    });
    listContainer.appendChild(table);
  }
}

function renderDetailPlaceholder(pane) {
  pane.innerHTML = `
    <div class="sms-detail-card sms-detail-card--empty">
      <div class="sms-detail-empty-icon">
        ${icons.messageSquare(28)}
      </div>
      <h3 class="sms-detail-empty-title">Select a message</h3>
      <p class="sms-detail-empty-desc">Choose a row on the left to see its delivery details and any linked incident.</p>
    </div>
  `;
}

function renderRowDetail(pane, row, navigate) {
  pane.innerHTML = '';
  const card = document.createElement('div');
  card.className = 'sms-detail-card';

  const header = document.createElement('div');
  header.className = 'sms-detail-header';

  const titleWrap = document.createElement('div');
  titleWrap.className = 'sms-detail-title-wrap';

  const title = document.createElement('h3');
  title.className = 'sms-detail-title';
  title.textContent = formatSmsCode(row.logId);

  const dirBadge = document.createElement('span');
  const isInbound = row.direction === 'inbound';
  dirBadge.className = `sms-detail-dir-badge sms-detail-dir-badge--${row.direction}`;
  dirBadge.innerHTML = `<span aria-hidden="true">${isInbound ? icons.arrowDownLeft(12) : icons.arrowUpRight(12)}</span><span>${isInbound ? 'Incoming' : 'Outgoing'}</span>`;

  titleWrap.append(title, dirBadge);

  const statusPill = document.createElement('span');
  const cls = STATUS_PILL_CLASS[row.status] || 'status-pill--neutral';
  statusPill.className = `status-pill ${cls}`;
  statusPill.textContent = statusLabel(row.status);

  header.append(titleWrap, statusPill);
  card.appendChild(header);

  if (row.messageBody) {
    const bodyBox = document.createElement('div');
    bodyBox.className = 'sms-detail-body-box';
    bodyBox.textContent = row.messageBody;
    card.appendChild(bodyBox);
  }

  if (row.failureReason) {
    const failBox = document.createElement('div');
    failBox.className = 'sms-detail-failure-box';
    failBox.innerHTML = `
      <div class="sms-detail-failure-head">
        <span class="sms-detail-failure-icon" aria-hidden="true">${icons.alertTriangle(14)}</span>
        <strong>Could not be delivered</strong>
      </div>
      <div class="sms-detail-failure-text">${escapeHtml(row.failureReason)}</div>
    `;
    card.appendChild(failBox);
  }

  const fields = document.createElement('dl');
  fields.className = 'sms-detail-grid';

  const addField = (label, value, isCopyable = false) => {
    if (value === null || value === undefined || value === '') return;
    const dt = document.createElement('dt');
    dt.className = 'sms-detail-dt';
    dt.textContent = label;

    const dd = document.createElement('dd');

    const valSpan = document.createElement('span');
    valSpan.className = isCopyable ? 'sms-detail-code' : 'sms-detail-val';
    valSpan.textContent = String(value);
    dd.appendChild(valSpan);

    if (isCopyable) {
      const copyBtn = document.createElement('button');
      copyBtn.type = 'button';
      copyBtn.className = 'sms-detail-copy-btn';
      copyBtn.title = `Copy ${label}`;
      copyBtn.setAttribute('aria-label', `Copy ${label}`);
      copyBtn.innerHTML = icons.copy(12);
      copyBtn.addEventListener('click', (e) => {
        e.stopPropagation();
        navigator.clipboard.writeText(String(value));
        showToast(`Copied ${label}`, { variant: 'info' });
      });
      dd.appendChild(copyBtn);
    }

    fields.append(dt, dd);
  };

  addField('Sent through', transportLabel(row.transport));
  addField('Message type', row.messageType ? msgTypeLabel(row.messageType) : null);
  if (row.phoneNumber) addField('Phone Number', row.phoneNumber, true);
  addField('Tracking ID', row.correlationId, true);
  addField('Gateway message ID', row.gatewayMessageId, true);
  addField('Phone message ID', row.modemMessageId, true);
  addField('Incident', row.incidentId ? formatIncidentCode(row.incidentId, row.incidentDisplayId) : null);
  addField('Dispatch', row.dispatchId ? formatDispatchCode(row.dispatchId) : null);
  addField('Citizen Report', row.reportId ? formatCitizenReportCode(row.reportId) : null);
  addField('Sent at', row.sentAt ? formatManilaDateTime(row.sentAt) : null);
  addField('Received at', row.receivedAt ? formatManilaDateTime(row.receivedAt) : null);
  addField('Logged at', formatManilaDateTime(row.createdAt));

  if (fields.children.length === 0 && !row.messageBody && !row.failureReason) {
    const none = document.createElement('p');
    none.className = 'note';
    none.textContent = 'No additional metadata recorded for this message.';
    card.appendChild(none);
  } else {
    card.appendChild(fields);
  }

  if (row.incidentId) {
    const jumpBtn = document.createElement('button');
    jumpBtn.type = 'button';
    jumpBtn.className = 'primary sms-detail-action-btn';
    jumpBtn.innerHTML = `<span aria-hidden="true">${icons.fileText(14)}</span><span>Open Incident ${escapeHtml(formatIncidentCode(row.incidentId, row.incidentDisplayId))}</span>`;
    jumpBtn.addEventListener('click', () => navigate('incident-detail', row.incidentId));
    card.appendChild(jumpBtn);
  }

  pane.appendChild(card);
}

function buildFilterSelect(id, srLabel, allLabel, options) {
  const fragment = document.createDocumentFragment();
  const label = document.createElement('label');
  label.className = 'sr-only';
  label.htmlFor = id;
  label.textContent = srLabel;
  const select = document.createElement('select');
  select.id = id;
  select.className = 'input--auto sms-log-filter-select';
  [['', allLabel], ...options].forEach(([value, text]) => {
    const option = document.createElement('option');
    option.value = value;
    option.textContent = text;
    select.appendChild(option);
  });
  fragment.append(label, select);
  return { fragment, select };
}

function renderSmsLogCell(row, key, navigate) {
  switch (key) {
    case 'id': {
      const span = document.createElement('span');
      span.className = 'sms-code-cell';
      span.textContent = formatSmsCode(row.logId);
      return span;
    }
    case 'direction': {
      const span = document.createElement('span');
      span.className = 'data-table__sub sms-log-direction-cell';
      span.innerHTML = `<span aria-hidden="true">${row.direction === 'inbound' ? icons.arrowDownLeft(14) : icons.arrowUpRight(14)}</span>`;
      span.append(' ' + (row.direction === 'inbound' ? 'Incoming' : 'Outgoing'));
      return span;
    }
    case 'type': {
      const span = document.createElement('span');
      span.textContent = msgTypeLabel(row.messageType);
      return span;
    }
    case 'transport': {
      const span = document.createElement('span');
      span.textContent = transportLabel(row.transport);
      return span;
    }
    case 'linked': {
      const span = document.createElement('span');
      span.className = 'data-table__sub';
      if (row.incidentId) {
        const link = document.createElement('button');
        link.type = 'button';
        link.className = 'link-button';
        link.textContent = formatIncidentCode(row.incidentId, row.incidentDisplayId);
        link.addEventListener('click', (event) => {
          event.stopPropagation();
          navigate('incident-detail', row.incidentId);
        });
        span.appendChild(link);
      }
      const restParts = [];
      if (row.dispatchId) restParts.push(formatDispatchCode(row.dispatchId));
      if (row.reportId) restParts.push(formatCitizenReportCode(row.reportId));
      if (restParts.length) {
        if (row.incidentId) span.append(' · ');
        span.append(restParts.join(' · '));
      }
      if (!row.incidentId && restParts.length === 0) span.textContent = '—';
      return span;
    }
    case 'when': {
      const at = row.sentAt || row.receivedAt || row.createdAt;
      const span = document.createElement('span');
      span.className = 'sms-log-time-cell';
      span.textContent = at ? formatManilaDateTime(at) : '—';
      return span;
    }
    case 'status': {
      const wrap = document.createElement('span');
      wrap.className = 'data-table__stacked sms-log-status-wrap';
      const pill = document.createElement('span');
      const cls = STATUS_PILL_CLASS[row.status] || 'status-pill--neutral';
      pill.className = `status-pill ${cls}`;
      pill.textContent = statusLabel(row.status);
      wrap.appendChild(pill);
      if (row.failureReason) {
        const reason = document.createElement('span');
        reason.className = 'data-table__sub sms-log-failure-sub';
        reason.textContent = row.failureReason;
        wrap.appendChild(reason);
      }
      return wrap;
    }
    default:
      return '';
  }
}

// ============================================================
// Utilities
// ============================================================

// Code-review finding H-22 (2026-09-24): this always assumed the GSM-7
// default alphabet's 160/153-char limits, regardless of what the message
// actually contained. Any character outside GSM 03.38's basic set (most
// emoji, many Unicode punctuation marks, most non-Latin scripts) forces
// the WHOLE message into UCS-2 encoding, whose real limits are 70 chars
// single / 67 per concatenated segment — a message showing "1 segment"
// under the old always-GSM-7 assumption could actually need 2+ once it
// contains even one such character. Bikol/Filipino text in plain Latin
// script (including ñ, which IS in the GSM-7 basic set) is unaffected;
// this matters for curly quotes, em dashes, emoji, or other characters an
// operator might paste in from elsewhere. Doesn't distinguish the GSM-7
// EXTENSION table (€, [, ], {, }, ^, ~, \, |, each costing 2 of the 160/153
// budget) — a smaller, rarer case than the UCS-2 gap this fixes, and
// still gives a closer estimate than assuming plain GSM-7 for everything.
// The actual SEND path (LocalGsmOutboundClient.php -> Android's own
// SmsManager.divideMessage()) already segments correctly regardless —
// this only fixes the operator-facing estimate shown while composing.
const GSM7_BASIC_CHARS = new Set(
  "@£$¥èéùìòÇ\nØø\rÅåΔ_ΦΓΛΩΠΨΣΘΞÆæßÉ !\"#¤%&'()*+,-./0123456789:;<=>?¡ABCDEFGHIJKLMNOPQRSTUVWXYZÄÖÑÜ§¿abcdefghijklmnopqrstuvwxyzäöñüà"
);

function requiresUcs2(text) {
  for (const ch of text) {
    if (!GSM7_BASIC_CHARS.has(ch)) return true;
  }
  return false;
}

function getSmsSegmentCount(text) {
  const length = text.length;
  const ucs2 = requiresUcs2(text);
  const singleLimit = ucs2 ? 70 : SMS_SINGLE_LIMIT;
  const segmentLimit = ucs2 ? 67 : 153;
  if (length <= singleLimit) {
    return { segments: 1, limit: singleLimit, encoding: ucs2 ? 'UCS-2' : 'GSM-7' };
  }
  const segments = Math.ceil(length / segmentLimit);
  return { segments, limit: segments * segmentLimit, encoding: ucs2 ? 'UCS-2' : 'GSM-7' };
}

function renderLoading(container) {
  container.innerHTML = '';
  const wrap = document.createElement('div');
  wrap.className = 'stack';
  wrap.setAttribute('role', 'status');
  wrap.setAttribute('aria-label', 'Loading SMS logs');
  for (let i = 0; i < 6; i++) {
    const skeleton = document.createElement('div');
    skeleton.className = 'skeleton skeleton--row';
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
