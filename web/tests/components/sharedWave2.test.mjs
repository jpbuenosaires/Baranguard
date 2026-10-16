/**
 * Shared-component fixes from the 2026-10-09 web audit, wave 2:
 * site-wide SOS bar + repeating tone, "Updates paused", Manila clock, shared
 * modal/tab accessibility, theme-change signal, toasts, menus, dialogs,
 * PageHeader h1, and 401 reporting from the secondary API clients.
 */
import { api, window, signIn, cleanup, settle, wait, text, click, key, $, $$, assertNoRuntimeErrors } from '../harness/render.mjs';
import { maps } from '../harness/env.mjs';
import { describe, test, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { AppShell } from '../../src/components/AppShell.js';
import { playCriticalAlertTone, MIN_TONE_GAP_MS, isAlertSoundUnlocked, __resetAlertSoundForTests } from '../../src/utils/criticalAlertSound.js';
import { startModalA11y, __managedModalCount } from '../../src/components/modalA11y.js';
import { startTabA11y } from '../../src/components/tabA11y.js';
import { THEME_CHANGE_EVENT, startThemeWatcher, onThemeChange } from '../../src/components/themeEvents.js';
import { confirmDialog, promptText } from '../../src/components/ConfirmDialog.js';
import { showToast } from '../../src/components/Toast.js';
import { Menu, MenuItem } from '../../src/components/Menu.js';
import { PageHeader } from '../../src/components/PageHeader.js';
import { LineChart } from '../../src/components/LineChart.js';
import { BarChart } from '../../src/components/BarChart.js';
import { LiveMap } from '../../src/components/LiveMap.js';
import { getAvailability } from '../../src/services/shellWorkflowApi.js';
import { getSession, onSessionExpired } from '../../src/api/apiClient.js';

const { document } = window;

afterEach(() => {
  cleanup();
  maps.length = 0;
  __resetAlertSoundForTests();
});

function mountShell(role, activePage = 'settings') {
  const user = signIn(role);
  const navigations = [];
  const shell = AppShell(user, activePage, (page, param) => navigations.push({ page, param }), () => {});
  document.getElementById('app').appendChild(shell.el);
  return { shell, navigations };
}

// The default /notifications fixture carries ONE pending SOS notification.
describe('Site-wide SOS bar removed (all pages)', () => {
  test('never renders on any page even when an SOS notification is pending', async () => {
    mountShell('admin', 'incident-management');
    await settle();
    assert.equal($('.sos-bar'), null);
    assertNoRuntimeErrors();
  });

  test('never renders for Punong Barangay either', async () => {
    mountShell('punong_barangay', 'approvals');
    await settle();
    assert.equal($('.sos-bar'), null);
  });

  test('stays absent on settings and dashboard', async () => {
    mountShell('admin', 'settings');
    await settle();
    assert.equal($('.sos-bar'), null);
  });
});

describe('Alert tone de-duplication', () => {
  test('a second tone within the gap is skipped, one after it plays', () => {
    __resetAlertSoundForTests({ unlocked: true });
    // jsdom has no AudioContext, so "played" is reported false, but the
    // throttle decision is what matters: record the first call's time.
    const t0 = 1_000_000;
    playCriticalAlertTone({ now: t0 });
    // Skipped calls return false without touching audio at all; to observe
    // the throttle, a fake AudioContext counts started oscillators.
    let oscillators = 0;
    const fakeCtx = function FakeCtx() {
      this.state = 'running';
      this.currentTime = 0;
      this.destination = {};
      this.createOscillator = () => { oscillators += 1; return { type: '', frequency: { setValueAtTime() {} }, connect() {}, start() {}, stop() {} }; };
      this.createGain = () => ({ gain: { setValueAtTime() {}, linearRampToValueAtTime() {}, exponentialRampToValueAtTime() {} }, connect() {} });
    };
    window.AudioContext = fakeCtx;
    try {
      __resetAlertSoundForTests({ unlocked: true });
      assert.equal(playCriticalAlertTone({ now: t0 }), true);
      assert.equal(playCriticalAlertTone({ now: t0 + 2000 }), false, 'a second loop 2 s later must not double the chime');
      assert.equal(playCriticalAlertTone({ now: t0 + MIN_TONE_GAP_MS + 1 }), true);
      assert.equal(oscillators, 6, 'two three-tone chimes');
    } finally {
      delete window.AudioContext;
    }
  });
});

describe('"Updates paused" indicator (X-01)', () => {
  test('appears with role=status when the shell poll fails and clears on success', async () => {
    api.fail('GET', '/notifications', 503);
    mountShell('secretary', 'settings');
    await settle();
    const stale = $('.topbar__stale');
    assert.equal(stale.getAttribute('role'), 'status');
    assert.equal(stale.hidden, false);
    assert.equal(text(stale), 'Updates paused');
    api.reset();
    // Next poll succeeds: re-run it through a fresh shell's first poll.
    cleanup();
    mountShell('secretary', 'settings');
    await settle();
    assert.equal($('.topbar__stale').hidden, true);
  });
});

describe('Topbar clock and role label', () => {
  test('clock is Manila time labelled PHT and not announced every second', async () => {
    mountShell('admin');
    await settle();
    const clock = $('.topbar__clock');
    assert.equal(clock.getAttribute('role'), 'timer');
    assert.equal(clock.getAttribute('aria-live'), 'off');
    assert.match(text($('.topbar__clock-digits')), /Manila \(PHT\)$/);
  });

  test('the Punong Barangay is no longer labelled read-only', async () => {
    mountShell('punong_barangay', 'approvals');
    await settle();
    assert.doesNotMatch(text($('.sidebar__user-role')), /read-only/i);
    assert.doesNotMatch($('.topbar__role-tag').title, /read-only/i);
  });

  test('the health badge is a real button whose name carries the live state', async () => {
    mountShell('admin');
    await settle();
    const badge = $('.status-badge');
    assert.equal(badge.tagName, 'BUTTON');
    assert.match(badge.getAttribute('aria-label'), /^System health: .+\. Open Service Health\.$/);
    assert.doesNotMatch(badge.getAttribute('aria-label'), /checking/);
  });

  test('the account menu links the privacy notice in a new tab', async () => {
    mountShell('secretary');
    await settle();
    const opened = [];
    const realOpen = window.open;
    window.open = (...args) => { opened.push(args); return null; };
    try {
      click($('.topbar__avatar-button'));
      click($$('.menu__item').find((i) => /Privacy notice/.test(text(i))));
      assert.deepEqual(opened, [['privacy.html', '_blank', 'noopener']]);
    } finally {
      window.open = realOpen;
    }
  });
});

describe('Shared modal accessibility (X-10/D-19)', () => {
  function openPageModal() {
    const opener = document.createElement('button');
    opener.textContent = 'Open';
    document.getElementById('app').appendChild(opener);
    opener.focus();
    const overlay = document.createElement('div');
    overlay.className = 'sms-modal-overlay';
    overlay.innerHTML = '<div class="sms-modal"><div class="sms-modal__header"><h3 class="sms-modal__title">New SMS</h3><button type="button" class="sms-modal__close">x</button></div><input id="m-a"><button type="button" id="m-last">Send</button></div>';
    overlay.querySelector('.sms-modal__close').addEventListener('click', () => overlay.remove());
    document.body.appendChild(overlay);
    return { opener, overlay };
  }

  test('adds dialog semantics, a name and initial focus', async () => {
    startModalA11y();
    const { overlay } = openPageModal();
    await settle();
    const dialog = overlay.querySelector('.sms-modal');
    assert.equal(dialog.getAttribute('role'), 'dialog');
    assert.equal(dialog.getAttribute('aria-modal'), 'true');
    assert.equal(document.getElementById(dialog.getAttribute('aria-labelledby')).textContent, 'New SMS');
    assert.equal(document.activeElement.id, 'm-a', 'focus goes to the first form control');
  });

  test('Tab wraps inside the dialog', async () => {
    startModalA11y();
    const { overlay } = openPageModal();
    await settle();
    overlay.querySelector('#m-last').focus();
    key(document.activeElement, 'Tab');
    assert.equal(document.activeElement, overlay.querySelector('.sms-modal__close'));
    key(document.activeElement, 'Tab', { shiftKey: true });
    assert.equal(document.activeElement.id, 'm-last');
  });

  test('Escape closes it via its own close control and focus returns to the opener', async () => {
    startModalA11y();
    const { opener, overlay } = openPageModal();
    await settle();
    key(document.activeElement, 'Escape');
    await settle();
    assert.equal(overlay.isConnected, false);
    assert.equal(document.activeElement, opener);
    assert.equal(__managedModalCount(), 0);
  });

  test('stands aside for ConfirmDialog (no double close of a page modal underneath)', async () => {
    startModalA11y();
    const { overlay } = openPageModal();
    await settle();
    const answer = confirmDialog({ title: 'Discard?' });
    await settle();
    key(document.activeElement, 'Escape');
    assert.equal(await answer, false);
    await settle();
    assert.equal(overlay.isConnected, true, 'Escape closed only the confirmation');
    assert.equal($('.confirm-backdrop'), null, 'the confirmation itself is gone');
  });
});

describe('ConfirmDialog semantics (X-14)', () => {
  test('description is linked and the dialog marks itself self-managed', async () => {
    const p = promptText({ title: 'Duplicate of', description: 'Enter the target id.', label: 'Incident id' });
    await settle();
    const dialog = $('.confirm-dialog');
    assert.equal(dialog.getAttribute('role'), 'alertdialog');
    assert.equal(document.getElementById(dialog.getAttribute('aria-describedby')).textContent, 'Enter the target id.');
    assert.equal($('.confirm-backdrop').getAttribute('data-modal-a11y'), 'self');
    key(document.activeElement, 'Escape');
    await p;
    const c = confirmDialog({ title: 'Sure?' });
    await settle();
    assert.equal($('.confirm-dialog').getAttribute('role'), 'alertdialog');
    key(document.activeElement, 'Escape');
    await c;
  });

  test('the busy confirm label is text, never markup', async () => {
    let release;
    const p = confirmDialog({ title: 'x', confirmLabel: '<img src=x onerror=alert(1)>', onConfirmAsync: () => new Promise((r) => { release = r; }) });
    await settle();
    click($$('.confirm-dialog button').at(-1));
    await settle();
    assert.equal($('.confirm-dialog img'), null);
    release();
    await p;
  });
});

describe('Tabs (X-11)', () => {
  test('page tab bars get tablist/tab roles, aria-selected that follows is-active, and arrow keys', async () => {
    startTabA11y();
    const list = document.createElement('div');
    list.className = 'page-tabs';
    const tabs = ['Users', 'Scheduler'].map((label, i) => {
      const b = document.createElement('button');
      b.className = 'page-tab' + (i === 0 ? ' is-active' : '');
      b.textContent = label;
      b.addEventListener('click', () => tabs.forEach((t) => t.classList.toggle('is-active', t === b)));
      list.appendChild(b);
      return b;
    });
    document.getElementById('app').appendChild(list);
    await settle();
    assert.equal(list.getAttribute('role'), 'tablist');
    assert.equal(tabs[0].getAttribute('role'), 'tab');
    assert.equal(tabs[0].getAttribute('aria-selected'), 'true');
    assert.equal(tabs[1].getAttribute('tabindex'), '-1');
    tabs[0].focus();
    key(tabs[0], 'ArrowRight');
    await settle();
    assert.equal(document.activeElement, tabs[1]);
    assert.equal(tabs[1].getAttribute('aria-selected'), 'true');
    assert.equal(tabs[0].getAttribute('aria-selected'), 'false');
  });
});

describe('Theme change signal (D-10)', () => {
  test('a data-theme change from anywhere dispatches baranguard:themechange once', async () => {
    startThemeWatcher();
    const seen = [];
    const handler = (e) => seen.push(e.detail.theme);
    window.addEventListener(THEME_CHANGE_EVENT, handler);
    try {
      document.documentElement.setAttribute('data-theme', 'dark');
      await settle();
      document.documentElement.setAttribute('data-theme', 'dark');
      await settle();
      assert.deepEqual(seen, ['dark']);
    } finally {
      window.removeEventListener(THEME_CHANGE_EVENT, handler);
    }
  });

  test('the topbar toggle follows a theme set elsewhere (Settings cards)', async () => {
    mountShell('secretary');
    await settle();
    document.documentElement.setAttribute('data-theme', 'dark');
    await settle();
    assert.equal($('.topbar__theme-toggle').getAttribute('aria-label'), 'Switch to light theme');
  });

  test('a listener tied to a detached element removes itself', async () => {
    startThemeWatcher();
    const el = document.createElement('div');
    let calls = 0;
    onThemeChange(el, () => { calls += 1; });
    document.documentElement.setAttribute('data-theme', 'dark');
    await settle();
    assert.equal(calls, 0, 'never attached, so never called');
  });

  test('charts colour through CSS variables so they follow the theme without a redraw', () => {
    const line = LineChart({ points: [{ label: 'a', values: [1, 2] }, { label: 'b', values: [3, 1] }], series: [{ name: 'R', colorVar: '--chart-line-1' }, { name: 'S', colorVar: '--chart-line-2' }] });
    const bar = BarChart({ bars: [{ label: 'a', value: 2 }] });
    const strokes = [...line.querySelectorAll('path')].map((p) => p.style.stroke).filter(Boolean);
    assert.ok(strokes.includes('var(--chart-line-1)'), 'line series uses the token, not a resolved hex');
    assert.equal(bar.querySelector('rect').style.fill, 'var(--chart-line-1)');
    assert.ok(![...line.querySelectorAll('line')].some((l) => /^#/.test(l.getAttribute('stroke') || '')));
  });

  test('LiveMap re-applies its paint colours on a theme change', async () => {
    const host = document.createElement('div');
    document.getElementById('app').appendChild(host);
    LiveMap(host);
    await settle();
    const [map] = maps;
    map.addLayer({ id: 'barangay-boundary-line', type: 'line' });
    const painted = [];
    map.setPaintProperty = (layer, prop) => { painted.push(`${layer}.${prop}`); return map; };
    document.documentElement.setAttribute('data-theme', 'dark');
    await settle();
    assert.ok(painted.includes('barangay-boundary-line.line-color'), `painted: ${painted.join(', ')}`);
    assertNoRuntimeErrors();
  });
});

describe('Toast (X-08)', () => {
  test('an error stays until dismissed; a success still auto-dismisses', async () => {
    showToast('Save failed.', { variant: 'error' });
    showToast('Saved.', { variant: 'success', duration: 50 });
    await wait(600);
    const left = $$('.toast');
    assert.equal(left.length, 1);
    assert.equal(left[0].getAttribute('role'), 'alert');
    assert.ok(left[0].classList.contains('toast--persistent'));
    click($('.toast__close'));
    await wait(450);
    assert.equal($$('.toast').length, 0);
  });
});

describe('Menu keyboard (X)', () => {
  test('Escape on the trigger closes an open menu; Home/End jump', () => {
    const trigger = document.createElement('button');
    const menu = Menu({ trigger, label: 'Account' });
    const a = MenuItem({ label: 'A', onClick() {} });
    const b = MenuItem({ label: 'B', onClick() {} });
    menu.panel.append(a, b);
    document.getElementById('app').appendChild(menu.el);
    click(trigger);
    assert.equal(menu.isOpen(), true);
    key(trigger, 'Escape');
    assert.equal(menu.isOpen(), false);
    key(trigger, 'ArrowDown');
    key(document.activeElement, 'End');
    assert.equal(document.activeElement, b);
    key(document.activeElement, 'Home');
    assert.equal(document.activeElement, a);
  });
});

describe('PageHeader (X-12)', () => {
  test('the page title is the h1', () => {
    const { el } = PageHeader({ title: 'Dispatch Center' });
    assert.equal(el.querySelector('.page-header__title').tagName, 'H1');
  });
});

describe('Secondary API clients report a 401 (F-08/X-02)', () => {
  test('shellWorkflowApi ends the session app-wide on a server 401', async () => {
    signIn('punong_barangay');
    let expired = null;
    onSessionExpired((reason) => { expired = reason; });
    api.on('GET', '/availability', () => ({ status: 401, body: { error: { code: 'UNAUTHORIZED', message: 'Session revoked.' } } }));
    await assert.rejects(getAvailability(), (err) => err.status === 401);
    await settle();
    assert.equal(getSession(), null, 'the dead session is cleared');
    assert.equal(expired, 'unauthorized');
    onSessionExpired(null);
  });
});
