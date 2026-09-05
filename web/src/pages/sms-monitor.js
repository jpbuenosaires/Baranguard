/**
 * sms-monitor.js — W14 SMS Monitor, renamed from `sms-log.js` in the
 * 2026-09-05 UX pass. That file's own header used to say this screen
 * "stays READ-ONLY this sprint and every sprint after unless
 * deliberately rescoped" and named this EXACT chat/reply/broadcast
 * direction as the reason why not. The user explicitly asked for that
 * rescoping (see `.claude/plans/fancy-crafting-lark.md` and
 * `backend/DEVLOG.md`'s "Full UI/UX overhaul" entries) — this is that
 * rescoping, not a silent reversal of the earlier decision.
 *
 * Two tabs:
 *   - **Conversations** (new, default) — a 3-column contact list / thread
 *     / Live Feed view over the new `GET /sms/conversations` +
 *     `GET /sms/conversations/:phone/messages` endpoints, with compose
 *     (`POST /sms/send`) and broadcast (`POST /sms/broadcast`).
 *   - **Activity Log** (unchanged) — the original read-only table over
 *     `GET /sms/logs`, which is ITSELF unchanged (still never returns a
 *     phone number — see `SmsController::index()`'s own doc). Kept
 *     verbatim rather than removed: date-range filtering, CSV export,
 *     and the correlation/gateway-id detail pane it already has are all
 *     real, working capabilities this pass has no reason to regress.
 *
 * NOT built (disclosed, not silently dropped — see DEVLOG.md's Phase 8
 * entry): Quick Reply template buttons (the mockup's pre-written Filipino
 * responses aren't sourced from anywhere in this codebase, and inventing
 * template text isn't this pass's call to make).
 *
 * kebab-case filename per §4.
 */

import {
  getSmsConversations, getSmsConversationMessages, markSmsThreadResolved, sendSms, broadcastSms,
  getSmsLogs, logout, ApiClientError,
} from '../api/apiClient.js';
import { AppShell } from '../components/AppShell.js';
import { PageHeader } from '../components/PageHeader.js';
import { DataTable, exportRowsToCsv } from '../components/DataTable.js';
import { StatStrip } from '../components/StatStrip.js';
import { showToast } from '../components/Toast.js';
import { confirmDialog } from '../components/ConfirmDialog.js';
import { icons } from '../components/icons.js';

const PAGE_SIZE = 25;
const LIVE_FEED_POLL_MS = 10000;
const SMS_MAX_LENGTH = 160; // ordinary single-segment SMS — the compose box's own counter, not a hard server cap (SmsController::send() allows up to 918, matching multi-part).

const MESSAGE_TYPES = ['incident', 'dispatch', 'priority_alert', 'coord_ping', 'confirmation', 'duty_status', 'sos', 'manual'];
const DIRECTIONS = ['inbound', 'outbound'];
const STATUSES = ['queued', 'pending', 'sent', 'failed', 'refunded', 'received', 'rejected', 'deduplicated'];

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

// Message-type tag colors (2026-09-05 UX pass) — real `message_type` enum
// values, not the mockup's fictional Complaint/Alert/Tip/Dispatch
// categories, which don't exist anywhere in this schema.
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

const COLUMNS = [
  { key: 'id', label: 'ID', width: '4.5rem', csvValue: (row) => row.logId },
  { key: 'direction', label: 'Direction', width: '7rem', csvValue: (row) => row.direction },
  { key: 'type', label: 'Type', width: '9rem', csvValue: (row) => row.messageType },
  { key: 'transport', label: 'Transport', width: '8rem', csvValue: (row) => row.transport },
  {
    key: 'linked', label: 'Linked to',
    csvValue: (row) => [
      row.incidentId ? `incident:${row.incidentId}` : null,
      row.dispatchId ? `dispatch:${row.dispatchId}` : null,
      row.reportId ? `report:${row.reportId}` : null,
    ].filter(Boolean).join(' '),
  },
  { key: 'when', label: 'Sent / Received', csvValue: (row) => row.sentAt || row.receivedAt || row.createdAt || '' },
  { key: 'status', label: 'Status', align: 'right', csvValue: (row) => row.status },
];

/**
 * @param {HTMLElement} root
 * @param {{fullName:string, role:string}} user
 * @param {() => void} onLoggedOut
 * @param {(page: string) => void} navigate
 * @returns {{stop: () => void}}
 */
export function renderSmsMonitorPage(root, user, onLoggedOut, navigate) {
  root.innerHTML = '';

  let liveFeedTimer = null;
  const shell = AppShell(user, 'sms-log', navigate, async () => {
    shell.logoutButton.disabled = true;
    stopLiveFeedPolling();
    await logout();
    onLoggedOut();
  });
  const { header, content } = shell;
  root.appendChild(shell.el);

  const pageHeader = PageHeader({
    title: 'SMS Monitor',
    subtitle: 'Conversations, compose, and broadcast — plus the full read-only activity log',
    icon: icons.messageSquare,
  });
  header.appendChild(pageHeader.el);

  const tabRow = document.createElement('div');
  tabRow.className = 'filter-chip-row';
  const conversationsTabButton = document.createElement('button');
  conversationsTabButton.type = 'button';
  conversationsTabButton.className = 'filter-chip';
  conversationsTabButton.textContent = 'Conversations';
  const activityTabButton = document.createElement('button');
  activityTabButton.type = 'button';
  activityTabButton.className = 'filter-chip';
  activityTabButton.textContent = 'Activity Log';
  tabRow.append(conversationsTabButton, activityTabButton);
  header.appendChild(tabRow);

  const body = document.createElement('div');
  content.appendChild(body);

  let activeTab = 'conversations';
  function syncTabs() {
    conversationsTabButton.classList.toggle('is-active', activeTab === 'conversations');
    activityTabButton.classList.toggle('is-active', activeTab === 'activity-log');
  }
  conversationsTabButton.addEventListener('click', () => { activeTab = 'conversations'; syncTabs(); renderActiveTab(); });
  activityTabButton.addEventListener('click', () => { activeTab = 'activity-log'; syncTabs(); renderActiveTab(); });
  syncTabs();

  function stopLiveFeedPolling() {
    if (liveFeedTimer) clearInterval(liveFeedTimer);
    liveFeedTimer = null;
  }

  function renderActiveTab() {
    stopLiveFeedPolling();
    pageHeader.actions.innerHTML = '';
    body.innerHTML = '';
    if (activeTab === 'conversations') {
      renderConversationsTab(body, pageHeader, user, (timer) => { liveFeedTimer = timer; });
    } else {
      renderActivityLogTab(body, pageHeader);
    }
  }
  renderActiveTab();

  return { stop: stopLiveFeedPolling };
}

// ============================================================
// Conversations tab (2026-09-05 UX pass)
// ============================================================

function renderConversationsTab(container, pageHeader, user, setLiveFeedTimer) {
  const broadcastButton = document.createElement('button');
  broadcastButton.type = 'button';
  broadcastButton.className = 'primary';
  broadcastButton.innerHTML = `<span aria-hidden="true">${icons.megaphone(16)}</span><span>Broadcast Alert</span>`;
  broadcastButton.addEventListener('click', () => openBroadcastDialog());
  pageHeader.actions.appendChild(broadcastButton);

  const statStripHost = document.createElement('div');
  container.appendChild(statStripHost);

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
  let selectedPhone = null;
  let contactFilter = 'all'; // all | inbound | outbound (last message direction)

  renderContactPaneShell();
  renderThreadPlaceholder();
  loadConversations();
  loadStatStrip();
  loadLiveFeed(feedPane);
  setLiveFeedTimer(setInterval(() => loadLiveFeed(feedPane), LIVE_FEED_POLL_MS));

  async function loadStatStrip() {
    const today = new Date().toISOString().slice(0, 10);
    try {
      const [totalToday, inboundToday, outboundToday] = await Promise.all([
        getSmsLogs({ dateFrom: today, dateTo: today, limit: 1 }),
        getSmsLogs({ dateFrom: today, dateTo: today, direction: 'inbound', limit: 1 }),
        getSmsLogs({ dateFrom: today, dateTo: today, direction: 'outbound', limit: 1 }),
      ]);
      const unread = allConversations.reduce((sum, c) => sum + c.unreadCount, 0);
      statStripHost.innerHTML = '';
      statStripHost.appendChild(StatStrip({
        items: [
          { label: 'Total Today', value: totalToday.total },
          { label: 'Incoming', value: inboundToday.total, tone: 'info' },
          { label: 'Outgoing', value: outboundToday.total, tone: 'info' },
          { label: 'Unread', value: unread, tone: unread > 0 ? 'critical' : 'default' },
        ],
      }));
    } catch {
      // Stat strip is a summary convenience; a failed fetch leaves whatever was there.
    }
  }

  async function loadConversations() {
    try {
      allConversations = await getSmsConversations();
      renderContactList();
      loadStatStrip();
    } catch (err) {
      contactPane.innerHTML = '';
      const block = document.createElement('div');
      block.className = 'card state-block state-block--error';
      block.setAttribute('role', 'alert');
      const text = document.createElement('p');
      text.textContent = err instanceof ApiClientError ? err.message : 'Could not load conversations.';
      const retry = document.createElement('button');
      retry.className = 'primary';
      retry.textContent = 'Retry';
      retry.addEventListener('click', () => { renderContactPaneShell(); loadConversations(); });
      block.append(text, retry);
      contactPane.appendChild(block);
    }
  }

  function renderContactPaneShell() {
    contactPane.innerHTML = '';
    const searchWrap = document.createElement('div');
    searchWrap.className = 'filter-panel__search sms-contact-pane__search';
    const searchIcon = document.createElement('span');
    searchIcon.className = 'filter-panel__search-icon';
    searchIcon.setAttribute('aria-hidden', 'true');
    searchIcon.innerHTML = icons.search(16);
    const searchLabel = document.createElement('label');
    searchLabel.className = 'sr-only';
    searchLabel.htmlFor = 'sms-contact-search';
    searchLabel.textContent = 'Search messages';
    const searchInput = document.createElement('input');
    searchInput.id = 'sms-contact-search';
    searchInput.type = 'search';
    searchInput.placeholder = 'Search messages…';
    searchInput.addEventListener('input', () => renderContactList());
    searchWrap.append(searchIcon, searchLabel, searchInput);
    contactPane._searchInput = searchInput;

    const tabRow = document.createElement('div');
    tabRow.className = 'filter-chip-row sms-contact-pane__tabs';
    const tabs = { all: 'All', inbound: 'Inbox', outbound: 'Sent' };
    const tabButtons = {};
    for (const [key, label] of Object.entries(tabs)) {
      const btn = document.createElement('button');
      btn.type = 'button';
      btn.className = 'filter-chip';
      btn.textContent = label;
      btn.addEventListener('click', () => {
        contactFilter = key;
        for (const [k, b] of Object.entries(tabButtons)) b.classList.toggle('is-active', k === key);
        renderContactList();
      });
      tabButtons[key] = btn;
      tabRow.appendChild(btn);
    }
    tabButtons.all.classList.add('is-active');

    const listHost = document.createElement('div');
    listHost.className = 'sms-contact-list';
    contactPane._listHost = listHost;

    contactPane.append(searchWrap, tabRow, listHost);
  }

  function renderContactList() {
    const listHost = contactPane._listHost;
    const q = (contactPane._searchInput.value || '').trim().toLowerCase();
    let filtered = allConversations;
    if (contactFilter !== 'all') {
      filtered = filtered.filter((c) => c.lastMessage && c.lastMessage.direction === contactFilter);
    }
    if (q) {
      filtered = filtered.filter((c) =>
        c.phoneNumber.toLowerCase().includes(q) || (c.displayName || '').toLowerCase().includes(q));
    }

    listHost.innerHTML = '';
    if (filtered.length === 0) {
      const empty = document.createElement('p');
      empty.className = 'note';
      empty.textContent = allConversations.length === 0 ? 'No SMS conversations yet.' : 'No conversations match this filter.';
      listHost.appendChild(empty);
      return;
    }

    for (const convo of filtered) {
      const row = document.createElement('button');
      row.type = 'button';
      row.className = 'sms-contact-row' + (convo.phoneNumber === selectedPhone ? ' is-selected' : '');
      const avatar = document.createElement('span');
      avatar.className = 'sms-contact-row__avatar';
      avatar.textContent = (convo.displayName || convo.phoneNumber).slice(0, 1).toUpperCase();
      const main = document.createElement('span');
      main.className = 'sms-contact-row__main';
      const nameLine = document.createElement('span');
      nameLine.className = 'sms-contact-row__name';
      nameLine.textContent = convo.displayName || convo.phoneNumber;
      if (convo.unreadCount > 0) {
        const dot = document.createElement('span');
        dot.className = 'sms-contact-row__unread-dot';
        dot.setAttribute('aria-label', `${convo.unreadCount} unread`);
        nameLine.appendChild(dot);
      }
      const preview = document.createElement('span');
      preview.className = 'sms-contact-row__preview';
      preview.textContent = convo.lastMessage?.messageBody || `(${(convo.lastMessage?.messageType || 'message').replace(/_/g, ' ')} — no text on record)`;
      main.append(nameLine, preview);
      const meta = document.createElement('span');
      meta.className = 'sms-contact-row__meta';
      const when = convo.lastMessage?.createdAt ? new Date(convo.lastMessage.createdAt).toLocaleDateString() : '';
      meta.textContent = when;
      if (convo.lastMessage) {
        const tag = document.createElement('span');
        tag.className = `status-pill ${TYPE_TAG_CLASS[convo.lastMessage.messageType] || 'status-pill--neutral'}`;
        tag.textContent = convo.lastMessage.messageType.replace(/_/g, ' ');
        meta.appendChild(tag);
      }
      row.append(avatar, main, meta);
      row.addEventListener('click', () => { selectedPhone = convo.phoneNumber; renderContactList(); openThread(convo); });
      listHost.appendChild(row);
    }
  }

  function renderThreadPlaceholder() {
    threadPane.innerHTML = '';
    const card = document.createElement('div');
    card.className = 'card state-block';
    card.innerHTML = '<h3>Select a conversation</h3><p>Choose a contact on the left to see the full thread.</p>';
    threadPane.appendChild(card);
  }

  async function openThread(convo) {
    threadPane.innerHTML = '';
    const loading = document.createElement('div');
    loading.className = 'skeleton skeleton--block';
    loading.setAttribute('role', 'status');
    loading.setAttribute('aria-label', 'Loading conversation');
    threadPane.appendChild(loading);

    try {
      const messages = await getSmsConversationMessages(convo.phoneNumber);
      renderThread(convo, messages);
    } catch (err) {
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

  function renderThread(convo, messages) {
    threadPane.innerHTML = '';
    const card = document.createElement('div');
    card.className = 'card sms-thread';

    const threadHeader = document.createElement('div');
    threadHeader.className = 'sms-thread__header';
    const headerMain = document.createElement('div');
    const nameEl = document.createElement('h3');
    nameEl.textContent = convo.displayName || convo.phoneNumber;
    const phoneEl = document.createElement('p');
    phoneEl.className = 'note';
    phoneEl.textContent = convo.displayName ? convo.phoneNumber : 'No matching staff record';
    headerMain.append(nameEl, phoneEl);
    const resolveButton = document.createElement('button');
    resolveButton.type = 'button';
    resolveButton.className = 'ghost';
    resolveButton.textContent = 'Mark Resolved';
    resolveButton.disabled = convo.unreadCount === 0;
    resolveButton.addEventListener('click', async () => {
      resolveButton.disabled = true;
      try {
        await markSmsThreadResolved(convo.phoneNumber);
        showToast('Conversation marked resolved.', { variant: 'success' });
        await loadConversations();
      } catch (err) {
        resolveButton.disabled = false;
        showToast(err instanceof ApiClientError ? err.message : 'Could not resolve this conversation.', { variant: 'error' });
      }
    });
    threadHeader.append(headerMain, resolveButton);
    card.appendChild(threadHeader);

    const bubbleList = document.createElement('div');
    bubbleList.className = 'sms-thread__messages';
    if (messages.length === 0) {
      const empty = document.createElement('p');
      empty.className = 'note';
      empty.textContent = 'No messages recorded for this contact yet.';
      bubbleList.appendChild(empty);
    }
    for (const msg of messages) {
      const bubble = document.createElement('div');
      bubble.className = `sms-bubble sms-bubble--${msg.direction === 'inbound' ? 'inbound' : 'outbound'}`;
      const text = document.createElement('div');
      text.className = 'sms-bubble__text';
      text.textContent = msg.messageBody || `(${msg.messageType.replace(/_/g, ' ')} — no text recorded for this row)`;
      const meta = document.createElement('div');
      meta.className = 'sms-bubble__meta';
      const tag = document.createElement('span');
      tag.className = `status-pill ${TYPE_TAG_CLASS[msg.messageType] || 'status-pill--neutral'}`;
      tag.textContent = msg.messageType.replace(/_/g, ' ');
      const time = document.createElement('span');
      const at = msg.sentAt || msg.receivedAt || msg.createdAt;
      time.textContent = new Date(at).toLocaleString();
      meta.append(tag, time);
      if (msg.status === 'failed' && msg.failureReason) {
        const failure = document.createElement('div');
        failure.className = 'sms-bubble__failure';
        failure.textContent = `Not delivered: ${msg.failureReason}`;
        bubble.append(text, meta, failure);
      } else {
        bubble.append(text, meta);
      }
      bubbleList.appendChild(bubble);
    }
    card.appendChild(bubbleList);

    card.appendChild(buildComposeBox(convo));
    threadPane.appendChild(card);
  }

  function buildComposeBox(convo) {
    const wrap = document.createElement('div');
    wrap.className = 'sms-compose';

    const textarea = document.createElement('textarea');
    textarea.className = 'textarea--resizable';
    textarea.rows = 2;
    textarea.placeholder = `Message ${convo.displayName || convo.phoneNumber}…`;
    textarea.setAttribute('aria-label', 'Compose SMS reply');

    const footer = document.createElement('div');
    footer.className = 'sms-compose__footer';
    const counter = document.createElement('span');
    counter.className = 'note';
    counter.textContent = `0/${SMS_MAX_LENGTH}`;
    const sendButton = document.createElement('button');
    sendButton.type = 'button';
    sendButton.className = 'primary';
    sendButton.innerHTML = `<span aria-hidden="true">${icons.send(16)}</span><span>Send</span>`;
    sendButton.disabled = true;

    textarea.addEventListener('input', () => {
      const len = textarea.value.length;
      counter.textContent = `${len}/${SMS_MAX_LENGTH}`;
      counter.classList.toggle('sms-compose__counter--over', len > SMS_MAX_LENGTH);
      sendButton.disabled = textarea.value.trim() === '';
    });

    sendButton.addEventListener('click', async () => {
      const message = textarea.value.trim();
      if (!message) return;
      sendButton.disabled = true;
      textarea.disabled = true;
      try {
        const result = await sendSms({ phoneNumber: convo.phoneNumber, message, idempotencyKey: crypto.randomUUID() });
        if (result.status === 'sent') {
          showToast('Message sent.', { variant: 'success' });
        } else {
          // Honest, not silent — this environment has no funded Semaphore
          // account (see SmsGatewayService's own doc), so a "failed"
          // outcome with SEMAPHORE_NOT_CONFIGURED is the expected,
          // correct result here, not a bug being hidden.
          showToast(`Logged, but not delivered: ${result.failureReason || 'unknown reason'}`, { variant: 'error' });
        }
        textarea.value = '';
        counter.textContent = `0/${SMS_MAX_LENGTH}`;
        await openThread(convo);
      } catch (err) {
        showToast(err instanceof ApiClientError ? err.message : 'Could not send this message.', { variant: 'error' });
      } finally {
        textarea.disabled = false;
        sendButton.disabled = textarea.value.trim() === '';
      }
    });

    footer.append(counter, sendButton);
    wrap.append(textarea, footer);
    return wrap;
  }

  function openBroadcastDialog() {
    // Reuses the same overlay markup pattern ConfirmDialog.js already
    // establishes (fixed overlay + centered card) rather than a second
    // dialog implementation, but needs a textarea + select the shared
    // confirmDialog()/promptSelect() helpers don't support — built
    // directly here as a one-off.
    const overlay = document.createElement('div');
    overlay.className = 'confirm-backdrop';
    const card = document.createElement('div');
    card.className = 'confirm-dialog';
    const heading = document.createElement('h3');
    heading.textContent = 'Broadcast Alert';
    const description = document.createElement('p');
    description.textContent = `Sends to every recipient in the chosen scope, in ${user?.barangayId ? 'your barangay' : 'your barangay'} only.`;

    const scopeLabel = document.createElement('label');
    scopeLabel.className = 'label';
    scopeLabel.textContent = 'Send to';
    const scopeSelect = document.createElement('select');
    // Deliberately no "All Barangays" option — see
    // SmsController::broadcast()'s own doc for why a cross-tenant
    // broadcast isn't offered.
    const scopeOptions = [
      ['on_duty_tanods', 'All on-duty Tanods'],
      ['role:tanod', 'All Tanods (on or off duty)'],
      ['role:secretary', 'All Secretaries'],
      ['role:admin', 'All Admins'],
      ['role:punong_barangay', 'Punong Barangay'],
    ];
    for (const [value, label] of scopeOptions) {
      const option = document.createElement('option');
      option.value = value;
      option.textContent = label;
      scopeSelect.appendChild(option);
    }

    const messageLabel = document.createElement('label');
    messageLabel.className = 'label';
    messageLabel.textContent = 'Message';
    const messageInput = document.createElement('textarea');
    messageInput.className = 'textarea--resizable';
    messageInput.rows = 4;

    const actions = document.createElement('div');
    actions.className = 'confirm-dialog__actions';
    const cancelButton = document.createElement('button');
    cancelButton.type = 'button';
    cancelButton.className = 'ghost';
    cancelButton.textContent = 'Cancel';
    cancelButton.addEventListener('click', () => overlay.remove());
    const sendButton = document.createElement('button');
    sendButton.type = 'button';
    sendButton.className = 'primary';
    sendButton.textContent = 'Send Broadcast';
    sendButton.addEventListener('click', async () => {
      const message = messageInput.value.trim();
      if (!message) {
        showToast('Enter a message to broadcast.', { variant: 'error' });
        return;
      }
      const confirmed = await confirmDialog({
        title: 'Send this broadcast now?',
        description: `This immediately messages every matching recipient. This cannot be undone.`,
        confirmLabel: 'Send now',
        cancelLabel: 'Keep editing',
        danger: true,
      });
      if (!confirmed) return;

      sendButton.disabled = true;
      sendButton.textContent = 'Sending…';
      try {
        const [scopeKey, role] = scopeSelect.value.split(':');
        const result = await broadcastSms({
          message,
          scope: scopeKey === 'role' ? 'role' : 'on_duty_tanods',
          role: scopeKey === 'role' ? role : undefined,
          idempotencyKey: crypto.randomUUID(),
        });
        showToast(`Broadcast sent to ${result.recipientCount} recipient(s): ${result.sent} delivered, ${result.failed} failed.`, { variant: result.failed > 0 ? 'info' : 'success' });
        overlay.remove();
      } catch (err) {
        sendButton.disabled = false;
        sendButton.textContent = 'Send Broadcast';
        showToast(err instanceof ApiClientError ? err.message : 'Could not send this broadcast.', { variant: 'error' });
      }
    });
    actions.append(cancelButton, sendButton);

    card.append(heading, description, scopeLabel, scopeSelect, messageLabel, messageInput, actions);
    overlay.appendChild(card);
    document.body.appendChild(overlay);
  }
}

/**
 * Live Feed (right panel) — client-side derived from `GET /sms/logs`'s
 * own already-existing fields (message_type, direction, linked incident/
 * dispatch id, timestamps), same "real derived state, not fabricated"
 * approach `gis-live-tracking.js`'s own activity feed already uses. No
 * new backend endpoint for this.
 */
async function loadLiveFeed(feedPane) {
  const isFirstLoad = !feedPane._loaded;
  if (isFirstLoad) {
    feedPane.innerHTML = '';
    const heading = document.createElement('h3');
    heading.className = 'sms-feed-pane__heading';
    const liveDot = document.createElement('span');
    liveDot.className = 'sms-feed-pane__live-dot';
    liveDot.setAttribute('aria-hidden', 'true');
    heading.append('Live Feed ', liveDot);
    const refreshButton = document.createElement('button');
    refreshButton.type = 'button';
    refreshButton.className = 'ghost';
    refreshButton.textContent = 'Refresh';
    refreshButton.addEventListener('click', () => loadLiveFeed(feedPane));
    const listHost = document.createElement('div');
    listHost.className = 'sms-live-feed';
    feedPane.append(heading, listHost, refreshButton);
    feedPane._listHost = listHost;
    feedPane._loaded = true;
  }

  try {
    const result = await getSmsLogs({ limit: 15 });
    const listHost = feedPane._listHost;
    listHost.innerHTML = '';
    if (result.items.length === 0) {
      const empty = document.createElement('p');
      empty.className = 'note';
      empty.textContent = 'No recent SMS activity.';
      listHost.appendChild(empty);
      return;
    }
    for (const item of result.items) {
      const row = document.createElement('div');
      row.className = 'sms-live-feed__entry';
      const dot = document.createElement('span');
      dot.className = `sms-live-feed__dot sms-live-feed__dot--${STATUS_PILL_CLASS[item.status] ? item.status : 'neutral'}`;
      const text = document.createElement('span');
      text.className = 'sms-live-feed__text';
      text.textContent = describeLiveFeedEvent(item);
      const time = document.createElement('span');
      time.className = 'note';
      const at = item.sentAt || item.receivedAt || item.createdAt;
      time.textContent = formatRelativeTime(at);
      row.append(dot, text, time);
      listHost.appendChild(row);
    }
  } catch {
    // A failed poll leaves whatever the feed already showed — same
    // "don't blank a working panel over one missed refresh" contract
    // every other polling screen in this app already follows.
  }
}

function describeLiveFeedEvent(item) {
  const typeLabel = item.messageType.replace(/_/g, ' ');
  const directionWord = item.direction === 'inbound' ? 'received from' : 'sent to';
  const linked = item.incidentId ? ` (incident #${item.incidentId})` : item.dispatchId ? ` (dispatch #${item.dispatchId})` : '';
  const outcome = item.status === 'failed' ? ' — not delivered' : item.status === 'sent' ? ' — delivered' : '';
  return `${typeLabel} message ${directionWord} a contact${linked}${outcome}`;
}

function formatRelativeTime(isoString) {
  if (!isoString) return '';
  const seconds = Math.max(0, Math.round((Date.now() - new Date(isoString).getTime()) / 1000));
  if (seconds < 60) return `${seconds}s ago`;
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h ago`;
  return `${Math.floor(hours / 24)}d ago`;
}

// ============================================================
// Activity Log tab — UNCHANGED from the old sms-log.js (see this file's
// own header for why it's kept verbatim).
// ============================================================

function renderActivityLogTab(container, pageHeader) {
  let currentPageItems = [];
  const exportButton = document.createElement('button');
  exportButton.type = 'button';
  exportButton.className = 'ghost';
  exportButton.innerHTML = `<span aria-hidden="true">${icons.download(16)}</span><span>Export CSV</span>`;
  exportButton.addEventListener('click', () => exportRowsToCsv(COLUMNS, currentPageItems, 'baranguard-sms-log'));
  pageHeader.actions.appendChild(exportButton);

  const statStripHost = document.createElement('div');
  container.appendChild(statStripHost);

  const filterPanel = document.createElement('div');
  filterPanel.className = 'filter-panel';

  const typeSelect = buildFilterSelect('sms-log-type', 'Message type', ['All types', ...MESSAGE_TYPES]);
  const directionSelect = buildFilterSelect('sms-log-direction', 'Direction', ['Both directions', ...DIRECTIONS]);
  const statusSelect = buildFilterSelect('sms-log-status', 'Status', ['All statuses', ...STATUSES]);
  const fromLabel = document.createElement('label');
  fromLabel.className = 'sr-only';
  fromLabel.htmlFor = 'sms-log-from';
  fromLabel.textContent = 'From date';
  const fromInput = document.createElement('input');
  fromInput.id = 'sms-log-from';
  fromInput.type = 'date';
  const toLabel = document.createElement('label');
  toLabel.className = 'sr-only';
  toLabel.htmlFor = 'sms-log-to';
  toLabel.textContent = 'To date';
  const toInput = document.createElement('input');
  toInput.id = 'sms-log-to';
  toInput.type = 'date';
  filterPanel.append(
    typeSelect.fragment, directionSelect.fragment, statusSelect.fragment,
    fromLabel, fromInput, toLabel, toInput
  );
  container.appendChild(filterPanel);

  const layout = document.createElement('div');
  layout.className = 'split-panel';
  container.appendChild(layout);
  const body = document.createElement('div');
  layout.appendChild(body);
  const detailPane = document.createElement('div');
  detailPane.className = 'blotter-detail-pane';
  layout.appendChild(detailPane);
  renderDetailPlaceholder(detailPane);

  let currentPage = 1;
  [typeSelect.select, directionSelect.select, statusSelect.select, fromInput, toInput].forEach((el) => {
    el.addEventListener('change', () => { currentPage = 1; load(); refreshStats(); });
  });

  load();
  refreshStats();

  function activeFilters() {
    return {
      messageType: typeSelect.select.value || undefined,
      direction: directionSelect.select.value || undefined,
      status: statusSelect.select.value || undefined,
      dateFrom: fromInput.value || undefined,
      dateTo: toInput.value || undefined,
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
      statStripHost.appendChild(StatStrip({
        items: [
          { label: 'Total', value: total.total },
          { label: 'Inbound', value: inbound.total, tone: 'info' },
          { label: 'Outbound', value: outbound.total, tone: 'info' },
          { label: 'Failed', value: failed.total, tone: failed.total > 0 ? 'critical' : 'default' },
        ],
      }));
    } catch {
      // The stat strip is a summary convenience; a failed fetch just
      // leaves whatever was there before (or nothing, on first load).
    }
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
      onRowClick: (row) => { selectedLogId = row.logId; renderRowDetail(detailPane, row); },
      caption: 'SMS activity log',
      emptyIcon: icons.messageSquare,
      emptyMessage: 'No SMS activity matches these filters yet.',
      page: currentPage,
      totalItems,
      pageSize: PAGE_SIZE,
      onPageChange,
      renderCell: renderSmsLogCell,
    });
    listContainer.appendChild(table);
  }
}

function renderDetailPlaceholder(pane) {
  pane.innerHTML = '';
  const card = document.createElement('div');
  card.className = 'card state-block';
  card.innerHTML = '<h3>Select a message</h3><p>Choose a row to see its correlation and gateway identifiers.</p>';
  pane.appendChild(card);
}

function renderRowDetail(pane, row) {
  pane.innerHTML = '';
  const card = document.createElement('div');
  card.className = 'card';
  const heading = document.createElement('h3');
  heading.textContent = `Message #${row.logId}`;
  card.appendChild(heading);

  const fields = document.createElement('dl');
  fields.className = 'detail-fields';
  const addField = (label, value) => {
    if (value === null || value === undefined) return;
    const dt = document.createElement('dt');
    dt.textContent = label;
    const dd = document.createElement('dd');
    dd.textContent = String(value);
    fields.append(dt, dd);
  };
  addField('Correlation ID', row.correlationId);
  addField('Gateway message ID', row.gatewayMessageId);
  addField('Modem message ID', row.modemMessageId);
  addField('Incident', row.incidentId ? `#${row.incidentId}` : null);
  addField('Dispatch', row.dispatchId ? `#${row.dispatchId}` : null);
  addField('Citizen report', row.reportId ? `#${row.reportId}` : null);
  addField('Sent', row.sentAt ? new Date(row.sentAt).toLocaleString() : null);
  addField('Received', row.receivedAt ? new Date(row.receivedAt).toLocaleString() : null);
  addField('Logged', new Date(row.createdAt).toLocaleString());
  if (fields.children.length === 0) {
    const none = document.createElement('p');
    none.className = 'note';
    none.textContent = 'No correlation or gateway identifiers recorded for this message.';
    card.appendChild(none);
  } else {
    card.appendChild(fields);
  }

  if (row.failureReason) {
    const failure = document.createElement('p');
    failure.className = 'note';
    failure.textContent = `Failure reason: ${row.failureReason}`;
    card.appendChild(failure);
  }

  pane.appendChild(card);
}

function buildFilterSelect(id, srLabel, optionLabels) {
  const fragment = document.createDocumentFragment();
  const label = document.createElement('label');
  label.className = 'sr-only';
  label.htmlFor = id;
  label.textContent = srLabel;
  const select = document.createElement('select');
  select.id = id;
  optionLabels.forEach((text, i) => {
    const option = document.createElement('option');
    option.value = i === 0 ? '' : text;
    option.textContent = i === 0 ? text : text.replace(/_/g, ' ');
    select.appendChild(option);
  });
  fragment.append(label, select);
  return { fragment, select };
}

function renderSmsLogCell(row, key) {
  switch (key) {
    case 'id':
      return `#${row.logId}`;
    case 'direction': {
      const span = document.createElement('span');
      span.className = 'data-table__sub';
      span.innerHTML = (row.direction === 'inbound' ? icons.arrowDownLeft(14) : icons.arrowUpRight(14));
      span.append(' ' + (row.direction === 'inbound' ? 'Inbound' : 'Outbound'));
      return span;
    }
    case 'type': {
      const span = document.createElement('span');
      span.textContent = row.messageType.replace(/_/g, ' ');
      return span;
    }
    case 'transport': {
      const span = document.createElement('span');
      span.textContent = row.transport === 'gsm_modem' ? 'GSM modem' : 'Semaphore';
      return span;
    }
    case 'linked': {
      const span = document.createElement('span');
      span.className = 'data-table__sub';
      const parts = [];
      if (row.incidentId) parts.push(`Incident #${row.incidentId}`);
      if (row.dispatchId) parts.push(`Dispatch #${row.dispatchId}`);
      if (row.reportId) parts.push(`Report #${row.reportId}`);
      span.textContent = parts.length ? parts.join(' · ') : '—';
      return span;
    }
    case 'when': {
      const at = row.sentAt || row.receivedAt || row.createdAt;
      return at ? new Date(at).toLocaleString() : '—';
    }
    case 'status': {
      const wrap = document.createElement('span');
      wrap.className = 'data-table__stacked';
      const pill = document.createElement('span');
      const cls = STATUS_PILL_CLASS[row.status] || 'status-pill--neutral';
      pill.className = `status-pill ${cls}`;
      pill.textContent = row.status.toUpperCase();
      wrap.appendChild(pill);
      if (row.failureReason) {
        const reason = document.createElement('span');
        reason.className = 'data-table__sub';
        reason.textContent = row.failureReason;
        wrap.appendChild(reason);
      }
      return wrap;
    }
    default:
      return '';
  }
}

function renderLoading(container) {
  container.innerHTML = '';
  const wrap = document.createElement('div');
  wrap.className = 'stack';
  wrap.setAttribute('role', 'status');
  wrap.setAttribute('aria-label', 'Loading SMS activity log');
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
