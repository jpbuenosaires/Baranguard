/**
 * render.mjs — mounting, settling and cleaning up a page, plus the generic
 * checks every page gets.
 *
 * Import order matters: env.mjs must install the DOM before any app module
 * loads (see env.mjs), so test files import THIS module first.
 */

import assert from 'node:assert/strict';
import { resetDom, jsdomErrors, window } from './env.mjs';
import { api } from './fakeApi.mjs';
import { XSS } from './fixtures.mjs';
import { __setSessionForTests } from '../../src/api/apiClient.js';

export { api, XSS };
export { window };

// --- Timers: track everything the app schedules so nothing outlives a test --

const realSetTimeout = globalThis.setTimeout;
const realClearTimeout = globalThis.clearTimeout;
const realSetInterval = globalThis.setInterval;
const realClearInterval = globalThis.clearInterval;
const liveTimers = new Set();
const liveIntervals = new Set();

globalThis.setTimeout = (fn, ms, ...args) => {
  const id = realSetTimeout(() => { liveTimers.delete(id); fn(...args); }, ms);
  liveTimers.add(id);
  return id;
};
globalThis.clearTimeout = (id) => { liveTimers.delete(id); realClearTimeout(id); };
globalThis.setInterval = (fn, ms, ...args) => {
  const id = realSetInterval(fn, ms, ...args);
  liveIntervals.add(id);
  return id;
};
globalThis.clearInterval = (id) => { liveIntervals.delete(id); realClearInterval(id); };
for (const name of ['setTimeout', 'clearTimeout', 'setInterval', 'clearInterval']) window[name] = globalThis[name];

/** Intervals still registered — a page whose stop() works leaves none of its own. */
export function activeIntervalCount() {
  return liveIntervals.size;
}

// --- Error capture -----------------------------------------------------------

export const captured = { consoleErrors: [], consoleWarnings: [], uncaught: [], rejections: [] };
const realConsoleError = console.error;
const realConsoleWarn = console.warn;
console.error = (...args) => { captured.consoleErrors.push(args.map(String).join(' ')); };
console.warn = (...args) => { captured.consoleWarnings.push(args.map(String).join(' ')); };
process.on('uncaughtException', (err) => captured.uncaught.push(err));
process.on('unhandledRejection', (err) => captured.rejections.push(err));
window.addEventListener('error', (event) => captured.uncaught.push(event.error ?? event.message));

// --- Sessions ----------------------------------------------------------------

export const USERS = {
  admin: { userId: 1, fullName: 'Ramon Elcano', role: 'admin', barangayId: 1 },
  secretary: { userId: 2, fullName: 'Liwayway Ferrer', role: 'secretary', barangayId: 1 },
  punong_barangay: { userId: 3, fullName: 'Teresa Magbanua', role: 'punong_barangay', barangayId: 1 },
  tanod: { userId: 4, fullName: 'Jose Reyes', role: 'tanod', barangayId: 1 },
};

/** Seeds the same in-memory session shape apiClient.login() would write. */
export function signIn(role, overrides = {}) {
  const user = { ...USERS[role], ...overrides };
  __setSessionForTests({
    token: `test-token-${role}`,
    expiresAt: new Date(Date.now() + 15 * 60 * 1000).toISOString(),
    user,
  });
  return user;
}

// --- Mount / settle / cleanup -----------------------------------------------

let activeHandle = null;

/**
 * Renders a page the way main.js does: (root, user, onLoggedOut, navigate, param).
 * Returns synchronously-available context; call `settle()` to let data load.
 */
export function mountPage(renderFn, { role = 'admin', param, scenario = 'populated', userOverrides } = {}) {
  api.setScenario(scenario);
  const overrides = scenario === 'xss' ? { fullName: `${USERS[role].fullName} ${XSS}`, ...userOverrides } : userOverrides;
  const user = signIn(role, overrides);
  const root = window.document.getElementById('app');
  const navigations = [];
  let loggedOut = 0;
  const navigate = (page, nextParam) => { navigations.push({ page, param: nextParam }); };
  const onLoggedOut = () => { loggedOut += 1; };
  const handle = renderFn(root, user, onLoggedOut, navigate, param);
  activeHandle = handle;
  return { root, user, handle, navigations, get loggedOut() { return loggedOut; } };
}

/** Lets every queued fetch, promise chain and zero-delay timer run to completion. */
export async function settle({ maxRounds = 600 } = {}) {
  let idle = 0;
  for (let i = 0; i < maxRounds && idle < 6; i += 1) {
    await new Promise((resolve) => realSetTimeout(resolve, 0));
    await new Promise((resolve) => setImmediate(resolve));
    idle = api.inFlight === 0 ? idle + 1 : 0;
  }
}

/** Waits real time (for debounced handlers), then settles. */
export async function wait(ms) {
  await new Promise((resolve) => realSetTimeout(resolve, ms));
  await settle();
}

export function cleanup() {
  try { activeHandle?.stop?.(); } catch { /* reported by the test that owns it */ }
  activeHandle = null;
  for (const id of liveTimers) realClearTimeout(id);
  for (const id of liveIntervals) realClearInterval(id);
  liveTimers.clear();
  liveIntervals.clear();
  api.reset();
  resetDom();
  __setSessionForTests(null);
  captured.consoleErrors.length = 0;
  captured.consoleWarnings.length = 0;
  captured.uncaught.length = 0;
  captured.rejections.length = 0;
  delete window.__xssFired;
}

// --- DOM helpers -------------------------------------------------------------

export const $ = (sel, scope = window.document) => scope.querySelector(sel);
export const $$ = (sel, scope = window.document) => [...scope.querySelectorAll(sel)];
export const text = (el = window.document.body) => (el?.textContent ?? '').replace(/\s+/g, ' ').trim();

/**
 * Clicks like a user would. A disabled control swallows the click, as in a
 * real browser — jsdom would otherwise still run its listeners, which would
 * make "this button is disabled" untestable.
 */
export function click(el) {
  assert.ok(el, 'click(): element not found');
  if (el.disabled || el.closest?.('fieldset[disabled]')) return false;
  el.dispatchEvent(new window.MouseEvent('click', { bubbles: true, cancelable: true }));
  return true;
}

export function type(el, value) {
  assert.ok(el, 'type(): element not found');
  el.value = value;
  el.dispatchEvent(new window.Event('input', { bubbles: true }));
  el.dispatchEvent(new window.Event('change', { bubbles: true }));
}

export function key(el, keyName, extra = {}) {
  el.dispatchEvent(new window.KeyboardEvent('keydown', { key: keyName, bubbles: true, cancelable: true, ...extra }));
}

export function buttonByText(pattern, scope = window.document) {
  const re = pattern instanceof RegExp ? pattern : new RegExp(pattern, 'i');
  return $$('button', scope).find((b) => re.test(text(b)) || re.test(b.getAttribute('aria-label') || ''));
}

// --- Generic assertions -------------------------------------------------------

/** jsdom "not implemented" noise that is a harness gap, not an app defect. */
const BENIGN_JSDOM = [/Not implemented: HTMLCanvasElement/, /Not implemented: window\.computedStyle\(elt, pseudoElt\)/];

export function assertNoRuntimeErrors({ allowConsoleErrors = false } = {}) {
  const uncaught = captured.uncaught.map((e) => e?.stack || String(e));
  assert.deepEqual(uncaught, [], `Uncaught exception(s):\n${uncaught.join('\n\n')}`);
  const rejections = captured.rejections.map((e) => e?.stack || String(e));
  assert.deepEqual(rejections, [], `Unhandled promise rejection(s):\n${rejections.join('\n\n')}`);
  const domErrors = jsdomErrors
    .filter((e) => !BENIGN_JSDOM.some((re) => re.test(e.message)))
    .map((e) => `${e.message}\n${e.detail?.stack || ''}`);
  assert.deepEqual(domErrors, [], `Errors reported by the DOM:\n${domErrors.join('\n\n')}`);
  if (!allowConsoleErrors) {
    assert.deepEqual(captured.consoleErrors, [], `console.error was called:\n${captured.consoleErrors.join('\n')}`);
  }
}

export function assertNoUnexpectedRequests() {
  assert.deepEqual(api.unexpected, [], `Requests with no fixture (missing fixture or wrong path in the app): ${api.unexpected.join(', ')}`);
}

/** Classic rendering bugs: a missing field or bad maths printed straight to the screen. */
const BAD_TEXT = /\b(undefined|NaN)\b|\[object Object\]|Invalid Date|\bnull\b/;
export function assertNoBrokenValues(scope = window.document.body) {
  const walker = window.document.createTreeWalker(scope, 4 /* SHOW_TEXT */);
  const bad = [];
  for (let node = walker.nextNode(); node; node = walker.nextNode()) {
    const parentTag = node.parentElement?.tagName;
    if (parentTag === 'SCRIPT' || parentTag === 'STYLE') continue;
    if (BAD_TEXT.test(node.textContent)) bad.push(`"${node.textContent.trim().slice(0, 80)}" in <${parentTag?.toLowerCase()} class="${node.parentElement?.className}">`);
  }
  for (const el of scope.querySelectorAll('*')) {
    for (const attr of el.attributes) {
      if (attr.name === 'style' || attr.name.startsWith('data-')) continue;
      if (/\bNaN\b|\bundefined\b|\[object Object\]/.test(attr.value)) bad.push(`${attr.name}="${attr.value.slice(0, 60)}" on <${el.tagName.toLowerCase()}>`);
    }
  }
  assert.deepEqual(bad, [], `Broken values rendered:\n${bad.join('\n')}`);
}

/** A skeleton still on screen after every request finished = stuck loading state. */
export function assertNoStuckLoading(scope = window.document.body) {
  const skeletons = scope.querySelectorAll('.skeleton');
  assert.equal(skeletons.length, 0, `${skeletons.length} loading skeleton(s) still showing after all data loaded`);
}

/** No user/server-supplied markup became live DOM (the 2026-09-07 audit's bug class). */
export function assertNoInjectedMarkup() {
  const injected = window.document.querySelectorAll('[data-xss-canary]');
  assert.equal(injected.length, 0, `${injected.length} element(s) created from untrusted text via innerHTML: ${[...injected].map((n) => n.parentElement?.outerHTML.slice(0, 160)).join(' | ')}`);
  assert.equal(window.__xssFired, undefined, 'An injected event handler executed');
}

/**
 * `role="alert"` alone is not an error — urgent-but-healthy content (the
 * dashboard's SOS attention banner) uses it too — so an alert only counts
 * when it actually reads as a failure.
 */
// Load-failure phrasing only: a page whose job is REPORTING failures (Service
// Health's "Failing services: …") is not itself in an error state.
const ERROR_WORDING = /could not|couldn['’]t|unable to|went wrong|not reach|failed to (load|fetch|reach)|simulated server failure|try again|retry/i;
export function hasErrorState(scope = window.document.body) {
  if (scope.querySelector('.state-block--error')) return true;
  return [...scope.querySelectorAll('[role="alert"]')]
    .some((el) => !isHidden(el) && ERROR_WORDING.test(text(el)));
}

export function findRetryButton(scope = window.document.body) {
  return buttonByText(/try again|retry/i, scope);
}

/** Accessible name per the accname fallbacks this app relies on. */
function accessibleName(el) {
  const labelledby = el.getAttribute('aria-labelledby');
  if (labelledby) {
    const joined = labelledby.split(/\s+/).map((id) => text(window.document.getElementById(id))).join(' ').trim();
    if (joined) return joined;
  }
  return (el.getAttribute('aria-label') || '').trim() || text(el) || (el.getAttribute('title') || '').trim();
}

function isHidden(el) {
  for (let n = el; n; n = n.parentElement) {
    if (n.hidden || n.getAttribute?.('aria-hidden') === 'true') return true;
  }
  return false;
}

export function accessibilityViolations(scope = window.document.body) {
  const problems = [];
  for (const b of scope.querySelectorAll('button, [role="button"], a[href]')) {
    if (isHidden(b)) continue;
    if (!accessibleName(b)) problems.push(`unnamed ${b.tagName.toLowerCase()} (class="${b.className}")`);
  }
  for (const img of scope.querySelectorAll('img')) {
    if (!img.hasAttribute('alt')) problems.push(`<img src="${img.getAttribute('src')}"> has no alt attribute`);
  }
  for (const field of scope.querySelectorAll('input, select, textarea')) {
    if (field.type === 'hidden' || isHidden(field)) continue;
    const labelled = (field.id && scope.ownerDocument.querySelector(`label[for="${CSS.escape(field.id)}"]`))
      || field.closest('label')
      || field.getAttribute('aria-label')
      || field.getAttribute('aria-labelledby')
      || field.getAttribute('title');
    if (!labelled) problems.push(`${field.tagName.toLowerCase()}[type=${field.type || ''}] (id="${field.id}", placeholder="${field.getAttribute('placeholder') || ''}") has no label — a placeholder is not a label`);
  }
  const seen = new Map();
  for (const el of scope.querySelectorAll('[id]')) seen.set(el.id, (seen.get(el.id) || 0) + 1);
  for (const [id, n] of seen) if (n > 1) problems.push(`id="${id}" is used ${n} times`);
  return problems;
}

export function assertAccessible(scope = window.document.body) {
  const problems = accessibilityViolations(scope);
  assert.deepEqual(problems, [], `Accessibility problems:\n${problems.join('\n')}`);
}
