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
 * - Comprehensive Activity Log with correlation ID inspection and Blotter linking
 */

import {
  getSmsConversations,
  getSmsConversationMessages,
  markSmsThreadResolved,
  sendSms,
  broadcastSms,
  getSmsLogs,
  getUsers,
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
import { avatarInitials } from '../components/Avatar.js';

const PAGE_SIZE = 25;
const LIVE_FEED_POLL_MS = 10000;
const SMS_SINGLE_LIMIT = 160;

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
    display: 'Acknowledge & Dispatching',
    full: 'Natanggap po namin ang inyong ulat. Papunta na po ang mga tanod sa kanto ng San Jose St. Manatili sa ligtas na lugar.',
  },
  {
    display: 'Request Exact Location',
    full: 'Maaari po bang ibigay ang inyong eksaktong lokasyon o pinakamalapit na landmark?',
  },
  {
    display: 'Situation Resolved',
    full: 'Naresolba na po ang usapin. Salamat sa mabilis na tugon ng mga tanod. Mabuhay kayo!',
  },
  {
    display: 'Emergency - Call 911',
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
  return { label: type.replace(/_/g, ' '), pillClass: 'sms-tag-pill--neutral' };
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
  const d = new Date(isoOrTime);
  if (isNaN(d.getTime())) return String(isoOrTime);
  return d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', hour12: false });
}

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
 * Main SMS Monitor Page entry point.
 */
export function renderSmsMonitorPage(root, user, onLoggedOut, navigate, param) {
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
    subtitle: 'Community reports and dispatch communications',
  });
  header.appendChild(pageHeader.el);

  // Tab switcher bar with icons & unread badge
  const tabBar = document.createElement('div');
  tabBar.className = 'page-tabs-bar';

  const tabRow = document.createElement('div');
  tabRow.className = 'sms-tabs-row';

  const conversationsTabBtn = document.createElement('button');
  conversationsTabBtn.type = 'button';
  conversationsTabBtn.className = 'sms-tab-btn is-active';
  conversationsTabBtn.innerHTML = `
    <span class="sms-tab-btn__icon" aria-hidden="true">${icons.messageSquare(16)}</span>
    <span>Conversations</span>
    <span class="sms-tab-badge" id="sms-unread-tab-badge" style="display:none;">0</span>
  `;

  const activityTabBtn = document.createElement('button');
  activityTabBtn.type = 'button';
  activityTabBtn.className = 'sms-tab-btn';
  activityTabBtn.innerHTML = `
    <span class="sms-tab-btn__icon" aria-hidden="true">${icons.fileText(16)}</span>
    <span>Activity Log</span>
  `;

  tabRow.append(conversationsTabBtn, activityTabBtn);
  tabBar.appendChild(tabRow);
  header.appendChild(tabBar);

  const body = document.createElement('div');
  content.appendChild(body);

  let activeTab = param === 'activity-log' ? 'activity-log' : 'conversations';
  const initialPhone = (param && param !== 'activity-log') ? String(param).trim() : null;

  function syncTabs() {
    conversationsTabBtn.classList.toggle('is-active', activeTab === 'conversations');
    activityTabBtn.classList.toggle('is-active', activeTab === 'activity-log');
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

  function stopLiveFeedPolling() {
    if (liveFeedTimer) clearInterval(liveFeedTimer);
    liveFeedTimer = null;
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
    stopLiveFeedPolling();
    pageHeader.actions.innerHTML = '';
    body.innerHTML = '';
    const existingInlineWrap = pageHeader.el.querySelector('.sms-stats-inline-wrap');
    if (existingInlineWrap) existingInlineWrap.remove();

    if (activeTab === 'conversations') {
      renderConversationsTab(body, pageHeader, user, (timer) => { liveFeedTimer = timer; }, updateUnreadBadge, navigate, initialPhone);
    } else {
      renderActivityLogTab(body, pageHeader, navigate);
    }
  }

  syncTabs();
  renderActiveTab();

  return { stop: stopLiveFeedPolling };
}

// ============================================================
// Conversations Tab
// ============================================================

function renderConversationsTab(container, pageHeader, user, setLiveFeedTimer, onUnreadChanged, navigate, initialPhone) {
  // Page Header Actions
  const actionsWrap = document.createElement('div');
  actionsWrap.style.cssText = 'display: flex; align-items: center; gap: 0.5rem;';

  const newMsgBtn = document.createElement('button');
  newMsgBtn.type = 'button';
  newMsgBtn.className = 'ghost';
  newMsgBtn.style.cssText = 'font-size: 0.8125rem; font-weight: 600; padding: 0.45rem 0.85rem;';
  newMsgBtn.innerHTML = `<span aria-hidden="true">${icons.plus(14)}</span><span>New Message</span>`;
  newMsgBtn.addEventListener('click', () => openNewMessageModal());

  const broadcastBtn = document.createElement('button');
  broadcastBtn.type = 'button';
  broadcastBtn.className = 'primary';
  broadcastBtn.style.cssText = 'font-size: 0.875rem; font-weight: 600; padding: 0.5rem 1.125rem; border-radius: 8px; background: #2563eb;';
  broadcastBtn.innerHTML = `<span aria-hidden="true" style="font-size: 1.05rem; margin-right: 0.35rem; font-weight: 700;">+</span><span>Broadcast Alert</span>`;
  broadcastBtn.addEventListener('click', () => openBroadcastModal());

  actionsWrap.append(newMsgBtn, broadcastBtn);
  pageHeader.actions.appendChild(actionsWrap);

  const statStripHost = document.createElement('div');
  statStripHost.className = 'sms-stats-inline-wrap';
  const titlesBlock = pageHeader.el.querySelector('.page-header__titles');
  if (titlesBlock) {
    titlesBlock.appendChild(statStripHost);
  } else {
    container.appendChild(statStripHost);
  }

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
    const today = new Date().toISOString().slice(0, 10);
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

      statStripHost.innerHTML = `
        <div class="sms-stats-inline">
          <span class="sms-stat-inline-item ${contactFilter === 'all' ? 'is-active' : ''}" data-filter="all" title="Show all messages">
            <strong class="sms-stat-num sms-stat-num--total">${totalVal}</strong> Total Today
          </span>
          <span class="sms-stat-inline-item ${contactFilter === 'inbound' ? 'is-active' : ''}" data-filter="inbound" title="Filter incoming messages">
            <strong class="sms-stat-num sms-stat-num--inbound">${inVal}</strong> Incoming
          </span>
          <span class="sms-stat-inline-item ${contactFilter === 'outbound' ? 'is-active' : ''}" data-filter="outbound" title="Filter outgoing messages">
            <strong class="sms-stat-num sms-stat-num--outbound">${outVal}</strong> Outgoing
          </span>
          <span class="sms-stat-inline-item ${contactFilter === 'unread' ? 'is-active' : ''}" data-filter="unread" title="Filter unread messages">
            <strong class="sms-stat-num sms-stat-num--unread">${unreadVal}</strong> Unread
          </span>
        </div>
      `;

      statStripHost.querySelectorAll('.sms-stat-inline-item').forEach((item) => {
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
    statStripHost.querySelectorAll('.sms-stat-inline-item').forEach((item) => {
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
      allConversations = [];
      selectedPhone = null;
      renderContactList();
      renderThreadPlaceholder();
      showToast(err instanceof ApiClientError ? err.message : 'Could not load conversations.', { variant: 'error' });
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

    const searchInput = document.createElement('input');
    searchInput.type = 'search';
    searchInput.className = 'sms-search-input';
    searchInput.placeholder = 'Search messages...';

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
      empty.className = 'note';
      empty.style.cssText = 'padding: var(--spacing-md); text-align: center; color: var(--color-text-tertiary);';
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
      previewEl.textContent = convo.lastMessage?.messageBody || `(${convo.lastMessage?.messageType?.replace(/_/g, ' ') || 'No message text'})`;

      // Bottom line: Pill Tag and Location
      const bottom = document.createElement('div');
      bottom.className = 'sms-contact-card__bottom';

      const pill = document.createElement('span');
      pill.className = `sms-tag-pill ${tagInfo.pillClass}`;
      pill.textContent = tagInfo.label;

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
    threadPane.innerHTML = '';
    const card = document.createElement('div');
    card.className = 'sms-thread-card state-block';
    card.style.cssText = 'justify-content: center; align-items: center; text-align: center; padding: var(--spacing-xl);';
    card.innerHTML = `
      <div style="color: var(--color-primary); margin-bottom: 0.5rem;" aria-hidden="true">${icons.messageSquare(36)}</div>
      <h3 style="margin: 0 0 0.25rem 0;">Select a Conversation</h3>
      <p class="note" style="max-width: 20rem; margin: 0;">Choose a contact thread from the left directory to view full chat history, reply, or mark resolved.</p>
    `;
    threadPane.appendChild(card);
  }

  async function openThread(convo) {
    threadPane.innerHTML = '';
    const loading = document.createElement('div');
    loading.className = 'skeleton skeleton--block';
    loading.style.height = '100%';
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
    phoneLine.innerHTML = `<span aria-hidden="true" style="display:inline-flex; color: var(--color-text-tertiary);">${icons.phone(13)}</span><span>${convo.phoneNumber}</span>`;

    info.append(nameTitle, phoneLine);
    contactWrap.append(avatar, info);

    // Header actions on the right
    const headerActions = document.createElement('div');
    headerActions.className = 'sms-thread-header__actions';

    const headerTag = document.createElement('span');
    headerTag.className = `sms-tag-pill ${tagInfo.pillClass}`;
    headerTag.style.cssText = 'font-size: 0.75rem; padding: 0.2rem 0.65rem;';
    headerTag.textContent = tagInfo.label;

    const resolveBtn = document.createElement('button');
    resolveBtn.type = 'button';
    resolveBtn.className = 'sms-resolve-btn';
    resolveBtn.textContent = 'Mark Resolved';
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
      empty.className = 'note';
      empty.style.cssText = 'text-align: center; margin: auto;';
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
        text.textContent = msg.messageBody || `(${msg.messageType?.replace(/_/g, ' ') || 'No message text'})`;
        bubble.appendChild(text);

        if (msg.incidentId) {
          const incidentLink = document.createElement('button');
          incidentLink.type = 'button';
          incidentLink.className = 'sms-bubble__linked-tag';
          incidentLink.innerHTML = `<span aria-hidden="true">${icons.fileText(12)}</span><span>Incident #${msg.incidentId}</span>`;
          incidentLink.addEventListener('click', (e) => {
            e.stopPropagation();
            navigate('blotter-detail', msg.incidentId);
          });
          bubble.appendChild(incidentLink);
        } else if (msg.dispatchId) {
          const dispatchTag = document.createElement('span');
          dispatchTag.className = 'sms-bubble__linked-tag';
          dispatchTag.innerHTML = `<span>Dispatch #${msg.dispatchId}</span>`;
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
          timeFormatted = new Date(at).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', hour12: false });
        }
        timeSpan.textContent = timeFormatted;
        metaRow.appendChild(timeSpan);

        if (isInbound) {
          const tagSpan = document.createElement('span');
          tagSpan.className = `sms-tag-pill ${tagInfo.pillClass}`;
          tagSpan.style.cssText = 'font-size: 0.625rem; padding: 0.05rem 0.45rem;';
          tagSpan.textContent = tagInfo.label;
          metaRow.appendChild(tagSpan);
        } else {
          const tick = document.createElement('span');
          if (msg.status === 'sent' || msg.status === 'received') {
            tick.className = 'sms-tick--success';
            tick.textContent = '✓✓';
            tick.title = 'Delivered';
          } else if (msg.status === 'failed' || msg.status === 'rejected') {
            tick.className = 'sms-tick--fail';
            tick.textContent = '⚠️ Failed';
            tick.title = msg.failureReason || 'Failed';
          } else {
            tick.textContent = '✓';
            tick.title = msg.status;
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
    qrTitle.textContent = 'Quick Replies';
    quickRepliesSection.appendChild(qrTitle);

    const qrGrid = document.createElement('div');
    qrGrid.className = 'sms-quick-replies-grid';

    QUICK_RESPONSES.forEach((qr) => {
      const chip = document.createElement('button');
      chip.type = 'button';
      chip.className = 'sms-quick-chip';
      chip.title = qr.full;
      chip.innerHTML = `<span class="sms-quick-chip__text">${qr.display}</span>`;
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
    composeTextarea.rows = 2;

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
    sendBtn.setAttribute('aria-label', 'Send SMS');
    sendBtn.title = 'Send (Ctrl+Enter)';
    sendBtn.innerHTML = icons.send(16);
    sendBtn.disabled = true;

    function updateCharCounter() {
      const len = composeTextarea.value.length;
      charCounter.textContent = `${len}/160`;
      charCounter.classList.toggle('is-warning', len > 160);
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
          showToast(`Logged, but delivery status: ${result.status} (${result.failureReason || 'gateway offline'})`, {
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
  function openBroadcastModal() {
    const modalEl = buildBroadcastModal(() => {
      document.body.removeChild(modalEl);
      loadStatStrip();
    }, () => {
      document.body.removeChild(modalEl);
    });
    document.body.appendChild(modalEl);
  }

  function openNewMessageModal() {
    const modalEl = buildNewMessageModal(allConversations, (phone) => {
      document.body.removeChild(modalEl);
      onSelectFeedPhone(phone);
      loadConversations();
    }, () => {
      document.body.removeChild(modalEl);
    });
    document.body.appendChild(modalEl);
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
    helpBtn.title = 'Help & Live Feed Info';
    helpBtn.textContent = '?';
    helpBtn.addEventListener('click', () => {
      showToast('Live Feed polls incoming and outgoing SMS activity in real-time.', { variant: 'info' });
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
  note.className = 'note';
  note.style.cssText = 'padding: var(--spacing-md); text-align: center; color: var(--color-text-tertiary);';
  note.textContent = 'No recent SMS activity.';
  listHost.appendChild(note);
}

function renderFeedError(listHost) {
  listHost.innerHTML = '';
  const note = document.createElement('p');
  note.className = 'note';
  note.style.cssText = 'padding: var(--spacing-md); text-align: center; color: var(--color-text-tertiary);';
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
    entry.title = 'Click to view related conversation';

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
    time.textContent = at ? new Date(at).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', hour12: false }) : '';

    body.append(text, time);
    entry.append(dot, body);

    entry.addEventListener('click', () => {
      if (item.phoneNumber) {
        onSelectPhone(item.phoneNumber);
      }
    });

    listHost.appendChild(entry);
  });
}

function describeLiveFeedEvent(item) {
  const type = item.messageType || '';
  const direction = item.direction || 'inbound';
  const body = (item.messageBody || '').toLowerCase();

  if (direction === 'inbound') {
    if (type === 'confirmation' || body.includes('salamat') || body.includes('naresolba')) {
      return 'Positive feedback from Brgy. Binanuahan';
    }
    if (body.includes('suspek') || type === 'incident') {
      return 'Tip received from Brgy. Marifosque';
    }
    if (body.includes('dispatch') || body.includes('confirmed')) {
      return 'Tanod Ramos confirmed dispatch';
    }
    return 'New report from Brgy. Dao';
  } else {
    if (type === 'dispatch' || body.includes('garcia') || body.includes('balogo')) {
      return 'Dispatch order sent to Tanod Garcia';
    }
    if (type === 'priority_alert' || body.includes('ramos') || body.includes('alerto')) {
      return 'Auto-alert sent to Tanod Ramos';
    }
    return 'Dispatch order sent to on-duty team';
  }
}

// ============================================================
// Modals
// ============================================================

/**
 * Broadcast Alert Modal with Live Device Preview.
 */
function buildBroadcastModal(onSuccess, onCancel) {
  const overlay = document.createElement('div');
  overlay.className = 'sms-modal-overlay';

  const modal = document.createElement('div');
  modal.className = 'sms-modal';
  modal.setAttribute('role', 'dialog');
  modal.setAttribute('aria-modal', 'true');

  const header = document.createElement('div');
  header.className = 'sms-modal__header';

  const title = document.createElement('h3');
  title.className = 'sms-modal__title';
  title.innerHTML = `<span aria-hidden="true">${icons.megaphone(20)}</span><span>Broadcast SMS Alert</span>`;

  const closeBtn = document.createElement('button');
  closeBtn.type = 'button';
  closeBtn.className = 'sms-modal__close';
  closeBtn.innerHTML = icons.x(18);
  closeBtn.addEventListener('click', onCancel);

  header.append(title, closeBtn);

  const form = document.createElement('form');

  const body = document.createElement('div');
  body.className = 'sms-modal__body';

  // Target audience selection
  const scopeField = document.createElement('div');
  scopeField.style.cssText = 'display: flex; flex-direction: column; gap: 0.35rem;';

  const scopeLabel = document.createElement('label');
  scopeLabel.style.cssText = 'font-size: var(--font-size-xs); font-weight: 700; text-transform: uppercase; color: var(--color-text-secondary);';
  scopeLabel.textContent = 'Recipient Audience *';

  const scopeSelect = document.createElement('select');
  scopeSelect.className = 'personnel-form-select';
  const scopeOptions = [
    ['on_duty_tanods', '🛡️ All on-duty Tanods'],
    ['role:tanod', '👮 All Tanods (on or off duty)'],
    ['role:secretary', '📑 All Barangay Secretaries'],
    ['role:admin', '⚙️ All System Admins'],
    ['role:punong_barangay', '🏛️ Punong Barangay'],
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
  msgField.style.cssText = 'display: flex; flex-direction: column; gap: 0.35rem;';

  const msgLabel = document.createElement('label');
  msgLabel.style.cssText = 'font-size: var(--font-size-xs); font-weight: 700; text-transform: uppercase; color: var(--color-text-secondary);';
  msgLabel.textContent = 'Alert Message *';

  const textarea = document.createElement('textarea');
  textarea.className = 'sms-compose-textarea';
  textarea.rows = 4;
  textarea.placeholder = 'Type alert text to broadcast to selected audience…';
  textarea.required = true;

  const counterWrap = document.createElement('div');
  counterWrap.className = 'sms-segment-counter';
  counterWrap.style.marginTop = '0.25rem';
  counterWrap.textContent = '0 / 160 chars · 1 SMS segment';

  msgField.append(msgLabel, textarea, counterWrap);

  // Live Device Preview Box
  const previewBox = document.createElement('div');
  previewBox.className = 'sms-device-preview';

  const previewLabel = document.createElement('span');
  previewLabel.className = 'sms-device-preview__label';
  previewLabel.textContent = 'Recipient Device Preview';

  const previewBubble = document.createElement('div');
  previewBubble.className = 'sms-device-preview__bubble';
  previewBubble.textContent = 'Your message text will appear here…';

  previewBox.append(previewLabel, previewBubble);

  textarea.addEventListener('input', () => {
    const len = textarea.value.length;
    const seg = getSmsSegmentCount(len);
    counterWrap.innerHTML = `${len} / ${seg.limit} chars · ${seg.segments} SMS ${seg.segments === 1 ? 'segment' : 'segments'}`;
    previewBubble.textContent = textarea.value.trim() || 'Your message text will appear here…';
  });

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
  sendBtn.innerHTML = `<span aria-hidden="true">${icons.send(14)}</span><span>Send Broadcast</span>`;

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
      title: 'Confirm Broadcast SMS?',
      description: 'This immediately sends to every matching recipient in your barangay. This action cannot be canceled once initiated.',
      confirmLabel: 'Send Broadcast',
      cancelLabel: 'Keep Editing',
      danger: true,
    });
    if (!confirmed) return;

    sendBtn.disabled = true;
    sendBtn.textContent = 'Broadcasting…';

    try {
      const [scopeKey, role] = scopeSelect.value.split(':');
      const result = await broadcastSms({
        message,
        scope: scopeKey === 'role' ? 'role' : 'on_duty_tanods',
        role: scopeKey === 'role' ? role : undefined,
        idempotencyKey: crypto.randomUUID(),
      });
      showToast(`Broadcast complete: ${result.recipientCount} recipient(s), ${result.sent} delivered.`, {
        variant: result.failed > 0 ? 'info' : 'success',
      });
      onSuccess();
    } catch (err) {
      showToast(err instanceof ApiClientError ? err.message : 'Could not broadcast SMS.', { variant: 'error' });
      sendBtn.disabled = false;
      sendBtn.innerHTML = `<span aria-hidden="true">${icons.send(14)}</span><span>Send Broadcast</span>`;
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

  const header = document.createElement('div');
  header.className = 'sms-modal__header';

  const title = document.createElement('h3');
  title.className = 'sms-modal__title';
  title.innerHTML = `<span aria-hidden="true">${icons.plus(20)}</span><span>New Direct SMS Message</span>`;

  const closeBtn = document.createElement('button');
  closeBtn.type = 'button';
  closeBtn.className = 'sms-modal__close';
  closeBtn.innerHTML = icons.x(18);
  closeBtn.addEventListener('click', onCancel);

  header.append(title, closeBtn);

  const form = document.createElement('form');

  const body = document.createElement('div');
  body.className = 'sms-modal__body';

  // Recipient Dropdown / Select
  const recipField = document.createElement('div');
  recipField.style.cssText = 'display: flex; flex-direction: column; gap: 0.35rem;';

  const recipLabel = document.createElement('label');
  recipLabel.style.cssText = 'font-size: var(--font-size-xs); font-weight: 700; text-transform: uppercase; color: var(--color-text-secondary);';
  recipLabel.textContent = 'Select Recipient *';

  const recipSelect = document.createElement('select');
  recipSelect.className = 'personnel-form-select';
  recipSelect.required = true;

  const defaultOpt = document.createElement('option');
  defaultOpt.value = '';
  defaultOpt.textContent = '— Choose a contact or personnel —';
  recipSelect.appendChild(defaultOpt);

  // Load registered Tanods / Users to allow messaging staff directly
  getUsers({ limit: 100 }).then((res) => {
    if (res.items.length > 0) {
      const groupPersonnel = document.createElement('optgroup');
      groupPersonnel.label = 'Barangay Personnel';
      res.items.forEach((u) => {
        if (u.contactNumber) {
          const opt = document.createElement('option');
          opt.value = `user:${u.userId}:${u.contactNumber}`;
          opt.textContent = `${u.fullName} (${u.role}) · ${u.contactNumber}`;
          groupPersonnel.appendChild(opt);
        }
      });
      recipSelect.appendChild(groupPersonnel);
    }
  }).catch(() => {});

  if (existingConversations.length > 0) {
    const groupRecent = document.createElement('optgroup');
    groupRecent.label = 'Recent Conversations';
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
  msgField.style.cssText = 'display: flex; flex-direction: column; gap: 0.35rem;';

  const msgLabel = document.createElement('label');
  msgLabel.style.cssText = 'font-size: var(--font-size-xs); font-weight: 700; text-transform: uppercase; color: var(--color-text-secondary);';
  msgLabel.textContent = 'Message *';

  const textarea = document.createElement('textarea');
  textarea.className = 'sms-compose-textarea';
  textarea.rows = 4;
  textarea.placeholder = 'Type direct SMS message…';
  textarea.required = true;

  const counterWrap = document.createElement('div');
  counterWrap.className = 'sms-segment-counter';
  counterWrap.style.marginTop = '0.25rem';
  counterWrap.textContent = '0 / 160 chars · 1 SMS segment';

  textarea.addEventListener('input', () => {
    const len = textarea.value.length;
    const seg = getSmsSegmentCount(len);
    counterWrap.innerHTML = `${len} / ${seg.limit} chars · ${seg.segments} SMS ${seg.segments === 1 ? 'segment' : 'segments'}`;
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
  sendBtn.innerHTML = `<span aria-hidden="true">${icons.send(14)}</span><span>Send Message</span>`;

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
      showToast(result.status === 'sent' ? 'Message sent.' : `Logged (${result.status})`, {
        variant: result.status === 'sent' ? 'success' : 'info',
      });
      onRecipientSelected(targetPhone);
    } catch (err) {
      showToast(err instanceof ApiClientError ? err.message : 'Could not send SMS.', { variant: 'error' });
      sendBtn.disabled = false;
      sendBtn.innerHTML = `<span aria-hidden="true">${icons.send(14)}</span><span>Send Message</span>`;
    }
  });

  return overlay;
}

// ============================================================
// Activity Log Tab (Preserved + Tokenized Alignment)
// ============================================================

function todayIso() {
  return new Date().toISOString().slice(0, 10);
}

function daysAgoIso(n) {
  const d = new Date();
  d.setDate(d.getDate() - n);
  return d.toISOString().slice(0, 10);
}

function buildDateRangePicker(initialRange = '30', onRangeChange) {
  const PRESET_DAYS_AGO = { 7: 6, 30: 29, 90: 89 };
  let currentRange = initialRange;
  let customFrom = daysAgoIso(29);
  let customTo = todayIso();
  let previousValue = initialRange;

  const wrapper = document.createElement('div');
  wrapper.className = 'date-range-picker-wrapper';

  const select = document.createElement('select');
  select.className = 'input--auto range-select sms-log-filter-select';
  select.setAttribute('aria-label', 'Date range');

  const options = [
    ['7', 'Last 7 days'],
    ['30', 'Last 30 days'],
    ['90', 'Last 90 days'],
    ['all', 'All time'],
    ['custom', 'Custom range...'],
  ];

  options.forEach(([val, label]) => {
    const opt = document.createElement('option');
    opt.value = val;
    opt.textContent = label;
    select.appendChild(opt);
  });
  select.value = initialRange;

  // Popover dialog
  const popover = document.createElement('div');
  popover.className = 'date-range-popover';
  popover.hidden = true;
  popover.setAttribute('role', 'dialog');
  popover.setAttribute('aria-label', 'Custom date range');

  const title = document.createElement('div');
  title.className = 'date-range-popover__title';
  title.textContent = 'Custom Date Range';

  const grid = document.createElement('div');
  grid.className = 'date-range-popover__grid';

  const fromField = document.createElement('div');
  fromField.className = 'date-range-popover__field';
  const fromLabel = document.createElement('label');
  fromLabel.className = 'date-range-popover__label';
  fromLabel.textContent = 'From';
  const fromInput = document.createElement('input');
  fromInput.type = 'date';
  fromInput.className = 'date-range-popover__input';
  fromInput.value = customFrom;
  fromField.append(fromLabel, fromInput);

  const toField = document.createElement('div');
  toField.className = 'date-range-popover__field';
  const toLabel = document.createElement('label');
  toLabel.className = 'date-range-popover__label';
  toLabel.textContent = 'To';
  const toInput = document.createElement('input');
  toInput.type = 'date';
  toInput.className = 'date-range-popover__input';
  toInput.value = customTo;
  toField.append(toLabel, toInput);

  grid.append(fromField, toField);

  const errorEl = document.createElement('span');
  errorEl.className = 'app-inline-error';
  errorEl.style.cssText = 'color: var(--color-critical); font-size: 0.75rem; font-weight: 500;';
  errorEl.hidden = true;
  errorEl.setAttribute('role', 'alert');

  const actions = document.createElement('div');
  actions.className = 'date-range-popover__actions';

  const cancelBtn = document.createElement('button');
  cancelBtn.type = 'button';
  cancelBtn.className = 'ghost';
  cancelBtn.textContent = 'Cancel';

  const applyBtn = document.createElement('button');
  applyBtn.type = 'button';
  applyBtn.className = 'primary';
  applyBtn.textContent = 'Apply Range';

  actions.append(cancelBtn, applyBtn);
  popover.append(title, grid, errorEl, actions);
  wrapper.append(select, popover);

  const validate = () => {
    const invalid = Boolean(fromInput.value && toInput.value && fromInput.value > toInput.value);
    applyBtn.disabled = invalid;
    errorEl.hidden = !invalid;
    errorEl.textContent = invalid ? 'From date must be on or before To date.' : '';
  };
  fromInput.addEventListener('change', validate);
  toInput.addEventListener('change', validate);

  const openPopover = () => {
    popover.hidden = false;
    validate();
    fromInput.focus();
  };

  const closePopover = (restorePrevious = false) => {
    popover.hidden = true;
    errorEl.hidden = true;
    if (restorePrevious) {
      select.value = previousValue;
    }
  };

  cancelBtn.addEventListener('click', () => closePopover(true));

  applyBtn.addEventListener('click', () => {
    if (fromInput.value && toInput.value && fromInput.value > toInput.value) return;
    customFrom = fromInput.value;
    customTo = toInput.value;
    currentRange = 'custom';
    previousValue = 'custom';
    closePopover();
    onRangeChange({ dateFrom: customFrom, dateTo: customTo, range: 'custom' });
  });

  select.addEventListener('change', () => {
    if (select.value === 'custom') {
      openPopover();
    } else {
      closePopover();
      currentRange = select.value;
      previousValue = select.value;
      if (select.value === 'all') {
        onRangeChange({ dateFrom: undefined, dateTo: undefined, range: 'all' });
      } else {
        const days = PRESET_DAYS_AGO[select.value] ?? 29;
        onRangeChange({ dateFrom: daysAgoIso(days), dateTo: todayIso(), range: select.value });
      }
    }
  });

  document.addEventListener('click', (e) => {
    if (!popover.hidden && !wrapper.contains(e.target)) {
      closePopover(true);
    }
  });

  return {
    wrapper,
    select,
    getDateRange: () => {
      if (currentRange === 'all') return { dateFrom: undefined, dateTo: undefined };
      if (currentRange === 'custom') return { dateFrom: customFrom, dateTo: customTo };
      const days = PRESET_DAYS_AGO[currentRange] ?? 29;
      return { dateFrom: daysAgoIso(days), dateTo: todayIso() };
    },
    reset: (val = '30') => {
      currentRange = val;
      previousValue = val;
      select.value = val;
      closePopover();
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
  statStripHost.className = 'sms-log-stat-strip';
  container.appendChild(statStripHost);

  const filterPanel = document.createElement('div');
  filterPanel.className = 'sms-log-filter-panel';

  const typeSelect = buildFilterSelect('sms-log-type', 'Message type', ['All types', ...MESSAGE_TYPES]);
  const directionSelect = buildFilterSelect('sms-log-direction', 'Direction', ['Both directions', ...DIRECTIONS]);
  const statusSelect = buildFilterSelect('sms-log-status', 'Status', ['All statuses', ...STATUSES]);

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
  container.appendChild(filterPanel);

  const layout = document.createElement('div');
  layout.className = 'split-panel';
  container.appendChild(layout);

  const body = document.createElement('div');
  layout.appendChild(body);

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
      statStripHost.appendChild(StatStrip({
        items: [
          {
            label: 'Total',
            value: total.total,
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
            tone: failed.total > 0 ? 'critical' : 'default',
            onClick: () => {
              statusSelect.select.value = 'failed';
              currentPage = 1;
              load();
              refreshStats();
            },
          },
        ],
      }));
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
      <p class="sms-detail-empty-desc">Choose any row on the left to inspect correlation tokens, delivery routing, and linked records.</p>
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
  title.textContent = `Message #${row.logId}`;

  const dirBadge = document.createElement('span');
  const isInbound = row.direction === 'inbound';
  dirBadge.className = `sms-detail-dir-badge sms-detail-dir-badge--${row.direction}`;
  dirBadge.innerHTML = `<span aria-hidden="true">${isInbound ? icons.arrowDownLeft(12) : icons.arrowUpRight(12)}</span><span>${isInbound ? 'Inbound' : 'Outbound'}</span>`;

  titleWrap.append(title, dirBadge);

  const statusPill = document.createElement('span');
  const cls = STATUS_PILL_CLASS[row.status] || 'status-pill--neutral';
  statusPill.className = `status-pill ${cls}`;
  statusPill.textContent = row.status.toUpperCase();

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
        <span class="sms-detail-failure-icon">⚠️</span>
        <strong>Delivery Failure</strong>
      </div>
      <div class="sms-detail-failure-text">${row.failureReason}</div>
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

  addField('Transport', row.transport === 'gsm_modem' ? 'GSM Modem' : 'Semaphore');
  addField('Message Type', row.messageType ? row.messageType.replace(/_/g, ' ') : null);
  if (row.phoneNumber) addField('Phone Number', row.phoneNumber, true);
  addField('Correlation ID', row.correlationId, true);
  addField('Gateway Msg ID', row.gatewayMessageId, true);
  addField('Modem Msg ID', row.modemMessageId, true);
  addField('Incident', row.incidentId ? `#${row.incidentId}` : null);
  addField('Dispatch', row.dispatchId ? `#${row.dispatchId}` : null);
  addField('Citizen Report', row.reportId ? `#${row.reportId}` : null);
  addField('Sent At', row.sentAt ? new Date(row.sentAt).toLocaleString() : null);
  addField('Received At', row.receivedAt ? new Date(row.receivedAt).toLocaleString() : null);
  addField('Logged At', new Date(row.createdAt).toLocaleString());

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
    jumpBtn.innerHTML = `<span aria-hidden="true">${icons.fileText(14)}</span><span>Open Blotter Incident #${row.incidentId}</span>`;
    jumpBtn.addEventListener('click', () => navigate('blotter-detail', row.incidentId));
    card.appendChild(jumpBtn);
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
  select.className = 'input--auto sms-log-filter-select';
  optionLabels.forEach((text, i) => {
    const option = document.createElement('option');
    option.value = i === 0 ? '' : text;
    option.textContent = i === 0 ? text : text.replace(/_/g, ' ');
    select.appendChild(option);
  });
  fragment.append(label, select);
  return { fragment, select };
}

function renderSmsLogCell(row, key, navigate) {
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
      if (row.incidentId) {
        const link = document.createElement('button');
        link.type = 'button';
        link.className = 'link-button';
        link.textContent = `Incident #${row.incidentId}`;
        link.addEventListener('click', (event) => {
          event.stopPropagation();
          navigate('blotter-detail', row.incidentId);
        });
        span.appendChild(link);
      }
      const restParts = [];
      if (row.dispatchId) restParts.push(`Dispatch #${row.dispatchId}`);
      if (row.reportId) restParts.push(`Report #${row.reportId}`);
      if (restParts.length) {
        if (row.incidentId) span.append(' · ');
        span.append(restParts.join(' · '));
      }
      if (!row.incidentId && restParts.length === 0) span.textContent = '—';
      return span;
    }
    case 'when': {
      const at = row.sentAt || row.receivedAt || row.createdAt;
      return at ? new Date(at).toLocaleString([], { dateStyle: 'short', timeStyle: 'short' }) : '—';
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

// ============================================================
// Utilities
// ============================================================

function formatGroupDate(dateString) {
  if (!dateString) return 'Previous Messages';
  const d = new Date(dateString);
  const now = new Date();
  const today = new Date(now.getFullYear(), now.getMonth(), now.getDate());
  const yesterday = new Date(today.getTime() - 24 * 60 * 60 * 1000);
  const targetDate = new Date(d.getFullYear(), d.getMonth(), d.getDate());

  if (targetDate.getTime() === today.getTime()) return 'Today';
  if (targetDate.getTime() === yesterday.getTime()) return 'Yesterday';
  return d.toLocaleDateString([], {
    month: 'short',
    day: 'numeric',
    year: d.getFullYear() !== now.getFullYear() ? 'numeric' : undefined,
  });
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

function getSmsSegmentCount(length) {
  if (length <= SMS_SINGLE_LIMIT) {
    return { segments: 1, limit: SMS_SINGLE_LIMIT };
  }
  const segments = Math.ceil(length / 153);
  return { segments, limit: segments * 153 };
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
