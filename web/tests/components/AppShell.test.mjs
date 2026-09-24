import { api, window, signIn, cleanup, settle, wait, text, click, type, key, $, $$, assertNoRuntimeErrors } from '../harness/render.mjs';
import { describe, test, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { AppShell } from '../../src/components/AppShell.js';

afterEach(() => cleanup());

function mountShell(role, activePage = 'settings', userOverrides = {}) {
  const user = signIn(role, userOverrides);
  const navigations = [];
  let loggedOut = 0;
  const shell = AppShell(user, activePage, (page, param) => navigations.push({ page, param }), () => { loggedOut += 1; });
  window.document.getElementById('app').appendChild(shell.el);
  return { shell, navigations, get loggedOut() { return loggedOut; } };
}
const navLabels = () => $$('.sidebar__nav-item').map((b) => b.title);

// REFERENCE.md §3/§7 + main.js PAGE_ROLES.
const EXPECTED_NAV = {
  admin: ['Dashboard', 'Dispatch Center', 'Incident Management', 'Live Map', 'Citizen Reports', 'Analytics', 'Personnel', 'SMS Monitor', 'Audit Log', 'Service Health', 'Map Packages', 'Settings'],
  secretary: ['Incident Management', 'Citizen Reports', 'Settings'],
  punong_barangay: ['Dashboard', 'Live Map', 'Analytics', 'Personnel', 'Settings'],
};

describe('AppShell navigation', () => {
  for (const [role, expected] of Object.entries(EXPECTED_NAV)) {
    test(`${role} sees exactly the screens main.js lets them open`, async () => {
      mountShell(role);
      await settle();
      assert.deepEqual(navLabels(), expected);
      assertNoRuntimeErrors();
    });
  }

  test('the current page is marked aria-current and nav items navigate', async () => {
    const ctx = mountShell('secretary', 'citizen-inbox');
    await settle();
    const active = $$('.sidebar__nav-item').filter((b) => b.getAttribute('aria-current') === 'page');
    assert.deepEqual(active.map((b) => b.title), ['Citizen Reports']);
    click($$('.sidebar__nav-item').find((b) => b.title === 'Incident Management'));
    assert.deepEqual(ctx.navigations.at(-1), { page: 'incident-management', param: undefined });
  });

  test('breadcrumbs show where you are', async () => {
    mountShell('admin', 'audit-log');
    await settle();
    assert.match(text($('.topbar__breadcrumbs')), /System\s*\/\s*Audit Log/);
  });
});

describe('AppShell branding', () => {
  test('the sidebar shows the logo image with an empty alt (the wordmark beside it names it)', () => {
    mountShell('admin');
    const logo = $('.sidebar__brand img');
    assert.equal(logo.getAttribute('src'), 'assets/logo.svg');
    assert.equal(logo.getAttribute('alt'), '');
    assert.equal(text($('.sidebar__wordmark')), 'BARANGUARD');
  });

  test('the jurisdiction chip names the signed-in user\'s OWN barangay (§2 Rule 6)', async () => {
    mountShell('admin', 'settings', { barangayId: 2 });
    await settle();
    assert.doesNotMatch(text($('.topbar__jurisdiction')), /Dao/, 'a Binanuahan admin is told they are in Dao — the chip is hard-coded');
  });
});

describe('AppShell role-gated chrome', () => {
  test('only Admin polls nav counts and shows badges', async () => {
    mountShell('admin');
    await settle();
    assert.ok(api.callsTo('GET', '/reports/nav-counts').length >= 1);
    const dispatch = $$('.sidebar__nav-item').find((b) => b.title === 'Dispatch Center');
    assert.equal(text($('.sidebar__nav-badge', dispatch)), '2');
    assert.equal(dispatch.getAttribute('aria-label'), 'Dispatch Center, 2 pending', 'the count must reach screen readers too');
  });

  for (const role of ['secretary', 'punong_barangay']) {
    test(`${role} never calls Admin-only endpoints from the shell`, async () => {
      mountShell(role);
      await settle();
      assert.equal(api.callsTo('GET', '/reports/nav-counts').length, 0);
      assert.equal(api.callsTo('GET', '/system/health').length, 0);
    });
  }

  test('the notification bell announces the unread count', async () => {
    mountShell('admin');
    await settle();
    const bell = $$('button').find((b) => /^Notifications/.test(b.getAttribute('aria-label') || ''));
    assert.equal(bell.getAttribute('aria-label'), 'Notifications, 1 unread');
  });
});

describe('AppShell controls', () => {
  test('the live clock ticks after mount', async () => {
    mountShell('admin');
    await wait(1100);
    assert.match(text($('.topbar__clock-digits')), /^\d{1,2}:\d{2}:\d{2} (AM|PM) PST$/);
    assert.match(text($('.topbar__clock-shift')), /Duty/);
  });

  test('the theme toggle flips the theme, persists it, and relabels itself', async () => {
    mountShell('secretary');
    await settle();
    const toggle = $('.topbar__theme-toggle');
    assert.equal(toggle.getAttribute('aria-label'), 'Switch to dark theme');
    click(toggle);
    assert.equal(window.document.documentElement.getAttribute('data-theme'), 'dark');
    assert.equal(window.localStorage.getItem('baranguard.theme'), 'dark');
    assert.equal(toggle.getAttribute('aria-label'), 'Switch to light theme');
  });

  test('topbar search asks the server and opens the chosen incident', async () => {
    const ctx = mountShell('admin');
    await settle();
    type($('#topbar-search'), 'theft');
    await wait(500);
    const [call] = api.callsTo('GET', '/search');
    assert.equal(call?.query.q, 'theft');
    const result = $('.topbar__search-result');
    assert.ok(result, 'no results rendered');
    click(result);
    assert.deepEqual(ctx.navigations.at(-1), { page: 'blotter-detail', param: 901 });
  });

  test('a failed search says so instead of showing nothing', async () => {
    api.fail('GET', '/search');
    mountShell('admin');
    await settle();
    type($('#topbar-search'), 'fire');
    await wait(500);
    assert.match(text($('.topbar__search-results')), /Search failed/);
  });

  test('Ctrl+K focuses the search box', async () => {
    mountShell('admin');
    await settle();
    key(window, 'k', { ctrlKey: true });
    assert.equal(window.document.activeElement, $('#topbar-search'));
  });

  test('sign out calls onLogout', async () => {
    const ctx = mountShell('secretary');
    await settle();
    click($('.sidebar__user-action'));
    assert.equal(ctx.loggedOut, 1);
  });

  test('search results render server enums as text', async () => {
    api.on('GET', '/search', () => ({ status: 200, body: { items: [{ incident_id: 1, incident_type: '<b data-xss-canary>x</b>', status: '<b data-xss-canary>y</b>', priority: 'normal', created_at: '2026-09-01 00:00:00' }] } }));
    mountShell('admin');
    await settle();
    type($('#topbar-search'), 'x');
    await wait(500);
    assert.equal($$('[data-xss-canary]').length, 0);
  });

  test('the signed-in name is shown as text, not markup', async () => {
    mountShell('admin', 'settings', { fullName: '<b data-xss-canary>Evil</b>' });
    await settle();
    assert.equal($$('[data-xss-canary]').length, 0);
  });
});

describe('AppShell notification popover', () => {
  test('opening the bell dropdown renders the overhauled notification panel with header, tabs, and cards', async () => {
    mountShell('admin');
    await settle();
    const bell = $$('button').find((b) => /^Notifications/.test(b.getAttribute('aria-label') || ''));
    click(bell);
    await settle();

    const panel = $('.menu__panel--notifications');
    assert.ok(panel, 'notifications panel not found');

    const header = $('.notification-panel__header', panel);
    assert.ok(header, 'header missing');
    assert.match(text(header), /Notifications/);

    const tabs = $$('.notification-panel__tab', panel);
    assert.equal(tabs.length, 3);
    assert.match(text(tabs[0]), /All/);
    assert.match(text(tabs[1]), /Unread/);
    assert.match(text(tabs[2]), /Critical/);

    const cards = $$('.notification-card', panel);
    assert.ok(cards.length >= 1, 'notification cards missing');
    assert.ok($('.notification-card--unread', panel), 'unread card missing');
  });

  test('clicking mark all read clears unread states and sends ack-all', async () => {
    mountShell('admin');
    await settle();
    const bell = $$('button').find((b) => /^Notifications/.test(b.getAttribute('aria-label') || ''));
    click(bell);
    await settle();

    const markAllBtn = $('.notification-panel__mark-read');
    assert.ok(markAllBtn, 'mark all read button missing');
    click(markAllBtn);
    await settle();

    assert.ok(api.callsTo('POST', '/notifications/ack-all').length >= 1);
    assert.equal(bell.getAttribute('aria-label'), 'Notifications');
  });

  test('clicking a notification card marks it read and navigates to the incident', async () => {
    const ctx = mountShell('admin');
    await settle();
    const bell = $$('button').find((b) => /^Notifications/.test(b.getAttribute('aria-label') || ''));
    click(bell);
    await settle();

    const unreadCard = $('.notification-card--unread');
    assert.ok(unreadCard);
    click(unreadCard);
    await settle();

    assert.ok(api.callsTo('POST', '/notifications/1/ack').length >= 1);
    assert.deepEqual(ctx.navigations.at(-1), { page: 'blotter-detail', param: 902 });
  });

  test('clicking the close button or re-clicking the bell collapses the notification panel', async () => {
    mountShell('admin');
    await settle();
    const bell = $$('button').find((b) => /^Notifications/.test(b.getAttribute('aria-label') || ''));
    click(bell);
    await settle();

    const panel = $('.menu__panel--notifications');
    assert.equal(panel.hidden, false);

    // Click close button
    const closeBtn = $('.notification-panel__close-btn', panel);
    assert.ok(closeBtn);
    click(closeBtn);
    await settle();
    assert.equal(panel.hidden, true);

    // Click bell again to open
    click(bell);
    await settle();
    assert.equal(panel.hidden, false);

    // Click bell again to collapse
    click(bell);
    await settle();
    assert.equal(panel.hidden, true);
  });
});

describe('AppShell avatar / account menu', () => {
  test('opening the avatar dropdown renders the overhauled account panel with header and action items', async () => {
    mountShell('admin', 'dashboard', { fullName: 'Lorenzo Flores' });
    await settle();

    const avatarBtn = $('.topbar__avatar-button');
    assert.ok(avatarBtn, 'avatar trigger button missing');
    assert.match(avatarBtn.getAttribute('aria-label'), /Lorenzo Flores/);

    // Click to open avatar menu
    click(avatarBtn);
    await settle();

    const panel = $('.menu__panel--account');
    assert.ok(panel, 'account panel not found');
    assert.equal(panel.hidden, false);

    // Rich Account Header
    const header = $('.menu__account-header', panel);
    assert.ok(header, 'account header missing');

    const name = $('.menu__account-name', header);
    assert.equal(text(name), 'Lorenzo Flores');

    const rolePill = $('.menu__account-role-pill', header);
    assert.equal(text(rolePill), 'Admin');

    const status = $('.menu__account-status', header);
    assert.match(text(status), /Active Session/);

    // Items
    const items = $$('.menu__item', panel);
    assert.ok(items.length >= 3, 'expected at least 3 menu items');

    const settingsItem = items.find((i) => /Settings/.test(text(i)));
    assert.ok(settingsItem, 'settings item missing');
    assert.match(text(settingsItem), /System preferences & profile/);

    const themeItem = items.find((i) => /Switch to (dark|light) theme/.test(text(i)));
    assert.ok(themeItem, 'theme item missing');
    const accessory = $('.menu__item-accessory', themeItem);
    assert.ok(accessory, 'theme accessory badge missing');

    // Divider
    const divider = $('hr.menu__divider', panel);
    assert.ok(divider, 'menu divider missing');

    // Danger logout button
    const logoutItem = items.find((i) => /Sign out/.test(text(i)));
    assert.ok(logoutItem, 'sign out item missing');
    assert.ok(logoutItem.classList.contains('menu__item--danger'));
  });

  test('clicking theme toggle inside avatar menu flips theme and updates accessory badge', async () => {
    mountShell('secretary');
    await settle();

    const avatarBtn = $('.topbar__avatar-button');
    click(avatarBtn);
    await settle();

    const panel = $('.menu__panel--account');
    const themeItem = $$('.menu__item', panel).find((i) => /Switch to dark theme/.test(text(i)));
    assert.ok(themeItem);

    click(themeItem);
    await settle();

    assert.equal(window.document.documentElement.getAttribute('data-theme'), 'dark');
    assert.equal(text($('.menu__item-accessory', panel)), 'Dark');
  });

  test('clicking avatar trigger again collapses the account menu', async () => {
    mountShell('admin');
    await settle();

    const avatarBtn = $('.topbar__avatar-button');
    click(avatarBtn);
    await settle();

    const panel = $('.menu__panel--account');
    assert.equal(panel.hidden, false);

    click(avatarBtn);
    await settle();
    assert.equal(panel.hidden, true);
  });
});


