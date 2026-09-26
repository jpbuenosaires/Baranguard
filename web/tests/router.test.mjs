/**
 * main.js — boot/router: session gate, per-role landing page, the
 * default-landing preference, document title, focus management, and the
 * public #/citizen-report entry point. main.js boots itself on import, so
 * each case imports a fresh copy (cache-busting query) after arranging
 * the session it needs.
 */
import { api, window, signIn, cleanup, settle, text, $ } from './harness/render.mjs';
import { describe, test, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import * as apiClient from '../src/api/apiClient.js';

let n = 0;
async function boot() {
  await import(`../src/main.js?case=${++n}`);
  await settle();
  return window.document.getElementById('app');
}
const heading = (root) => text($('.page-header__title, h1, h2', root));

afterEach(() => cleanup());

describe('router: session gate', () => {
  test('no session shows the login page', async () => {
    const root = await boot();
    assert.ok($('#login-username', root), 'login form not shown');
    assert.equal(window.document.title, 'Sign in — Baranguard');
  });

  test('an expired session is treated as no session', async () => {
    apiClient.__setSessionForTests({ token: 'x', expiresAt: new Date(Date.now() - 60000).toISOString(), user: { role: 'admin' } });
    const root = await boot();
    assert.ok($('#login-username', root));
  });
});

describe('router: landing page per role', () => {
  for (const [role, expected] of [['admin', 'Admin Dashboard'], ['punong_barangay', 'Admin Dashboard'], ['secretary', 'Incident Management']]) {
    test(`${role} lands on ${expected}`, async () => {
      signIn(role);
      const root = await boot();
      assert.ok(heading(root).startsWith(expected), `landed on "${heading(root)}"`);
    });
  }

  test('a Tanod can sign in but gets an honest "no web screen" page (mobile-only role)', async () => {
    signIn('tanod');
    const root = await boot();
    assert.match(text(root), /tanod role has no built web screen yet/i);
    assert.ok([...root.querySelectorAll('button')].some((b) => /sign out/i.test(b.textContent)));
  });

  test('a stored default landing page is honoured when the role may open it', async () => {
    window.localStorage.setItem('baranguard.defaultPage', 'citizen-inbox');
    signIn('secretary');
    const root = await boot();
    assert.ok(heading(root).startsWith('Citizen Reports'));
  });

  test('a stored default landing page the role may NOT open is ignored', async () => {
    window.localStorage.setItem('baranguard.defaultPage', 'dispatch');
    signIn('secretary');
    const root = await boot();
    assert.ok(heading(root).startsWith('Incident Management'));
    assert.equal(api.callsTo('GET', '/dispatch').length, 0, 'the Admin-only screen must not even start loading');
  });

  test('a detail page is never chosen as a default landing page (it needs an id)', async () => {
    // 'ai-review' was the example here before the 2026-09-27 tab merge
    // (DEVLOG (38)) folded it into 'blotter-detail' as a tab — that's
    // still the only real DETAIL_PAGES entry to test against.
    window.localStorage.setItem('baranguard.defaultPage', 'blotter-detail');
    signIn('secretary');
    const root = await boot();
    assert.ok(heading(root).startsWith('Incident Management'));
  });
});

describe('router: title and focus', () => {
  test('the browser tab title is the page heading, cleanly', async () => {
    signIn('admin');
    await boot();
    assert.equal(window.document.title, 'Admin Dashboard — Baranguard',
      'badges placed INSIDE the <h2> (e.g. the "Brgy. Dao" pill) leak into the tab title');
  });

  test('focus moves to the new page heading for keyboard/screen-reader users', async () => {
    signIn('secretary');
    const root = await boot();
    const h = $('.page-header__title', root);
    assert.equal(window.document.activeElement, h);
    assert.equal(h.getAttribute('tabindex'), '-1', 'focusable programmatically without joining the Tab order');
  });
});

describe('router: public citizen report', () => {
  // Kept last in the file: it sets location.hash, and every earlier import
  // of main.js registered its own hashchange listener.
  test('#/citizen-report renders the public form with no session at all', async () => {
    window.location.hash = '#/citizen-report';
    const root = await boot();
    assert.ok($('#citizen-report-description', root), 'public report form not shown');
    assert.equal(apiClient.getSession(), null);
    for (const call of api.calls) assert.equal(call.headers.authorization, undefined, `${call.path} sent a token from the public page`);
  });
});
