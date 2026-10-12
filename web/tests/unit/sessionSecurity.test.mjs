/**
 * Audit 2026-10-09 fixes owned together: V-01 (?api_base= exfiltration),
 * X-02/F-07 (session expiry returns to sign-in with a message and the same
 * screen), the idle lock, V-04 (security headers / CSP hash drift) and the
 * V-03/V-12 XSS sinks (swap requests, KpiCard, DataTable).
 */
import { api, window, signIn, cleanup, settle, text, $, $$, click, type, mountPage, assertNoInjectedMarkup, XSS } from '../harness/render.mjs';
import { describe, test, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { JSDOM } from 'jsdom';
import * as client from '../../src/api/apiClient.js';
import { renderSwapRequestsTab } from '../../src/pages/swap-requests.js';
import { KpiCard } from '../../src/components/KpiCard.js';
import { DataTable, cellContent } from '../../src/components/DataTable.js';

const WEB = fileURLToPath(new URL('../../', import.meta.url));
const read = (rel) => readFileSync(WEB + rel, 'utf8');

afterEach(() => cleanup());

// --- V-01: ?api_base= --------------------------------------------------------

const INDEX_HTML = read('index.html');
const KEY = 'baranguard.apiBaseUrlOverride';

/** Runs index.html's inline scripts (only) at `url`, optionally with a pre-stored override. */
function loadIndex(url, stored) {
  const dom = new JSDOM(INDEX_HTML, {
    url,
    runScripts: 'dangerously',
    beforeParse(w) { if (stored !== undefined) w.localStorage.setItem(KEY, stored); },
  });
  const w = dom.window;
  return { base: w.BARANGUARD_API_BASE_URL, stored: w.localStorage.getItem(KEY), href: w.location.href, close: () => w.close() };
}

describe('V-01: the ?api_base= override cannot redirect sign-ins off-site', () => {
  test('a foreign host on the public domain is ignored, not stored, and stripped from the URL', () => {
    const r = loadIndex('https://baranguardph.win/?api_base=https://evil.example/api/v1&x=1');
    assert.equal(r.base, 'https://api.baranguardph.win/api/v1');
    assert.equal(r.stored, null);
    assert.equal(r.href, 'https://baranguardph.win/?x=1');
    r.close();
  });

  test('look-alike hosts, plain http and embedded credentials are all rejected off localhost', () => {
    for (const bad of [
      'https://api.baranguardph.win.evil.example/api/v1',
      'https://evilapi.baranguardph.win/api/v1',
      'http://api.baranguardph.win/api/v1',
      'https://user:pw@api.baranguardph.win/api/v1',
      'javascript:alert(1)',
      'not a url',
    ]) {
      const r = loadIndex(`https://baranguardph.win/?api_base=${encodeURIComponent(bad)}`);
      assert.equal(r.base, 'https://api.baranguardph.win/api/v1', `accepted ${bad}`);
      assert.equal(r.stored, null);
      r.close();
    }
  });

  test('https api.<page host> is honoured and remembered', () => {
    const r = loadIndex('https://baranguardph.win/?api_base=https://api.baranguardph.win/api/v2');
    assert.equal(r.base, 'https://api.baranguardph.win/api/v2');
    assert.equal(r.stored, 'https://api.baranguardph.win/api/v2');
    r.close();
  });

  test('a previously stored foreign override is deleted at startup', () => {
    const r = loadIndex('https://baranguardph.win/', 'https://evil.example/api/v1');
    assert.equal(r.base, 'https://api.baranguardph.win/api/v1');
    assert.equal(r.stored, null, 'the poisoned value must be removed, not just skipped');
    r.close();
  });

  test('local dev keeps the convenience: any http(s) override is accepted on localhost', () => {
    for (const host of ['localhost', '127.0.0.1', '[::1]']) {
      const r = loadIndex(`http://${host}/baranguard/web/?api_base=https://abc.trycloudflare.com/api/v1`);
      assert.equal(r.base, 'https://abc.trycloudflare.com/api/v1', host);
      r.close();
    }
    const r = loadIndex('http://localhost/baranguard/web/');
    assert.equal(r.base, 'http://localhost:8081/api/v1');
    r.close();
  });

  test('a LAN page may point at its own host on another port (same machine)', () => {
    const r = loadIndex('http://192.168.1.10/baranguard/web/?api_base=http://192.168.1.10:8081/api/v1');
    assert.equal(r.base, 'http://192.168.1.10:8081/api/v1');
    r.close();
    const bad = loadIndex('http://192.168.1.10/baranguard/web/?api_base=http://192.168.1.99:8081/api/v1');
    assert.notEqual(bad.base, 'http://192.168.1.99:8081/api/v1');
    bad.close();
  });
});

// --- V-04: headers / CSP hash drift ------------------------------------------

describe('V-04: security headers', () => {
  const webHt = read('.htaccess');
  const apiHt = readFileSync(WEB + '../backend/public/.htaccess', 'utf8');
  const csp = webHt.match(/Content-Security-Policy "([^"]+)"/)?.[1] ?? '';
  const sha = (s) => `'sha256-${createHash('sha256').update(s, 'utf8').digest('base64')}'`;

  test('every inline <script> in index.html is allowed by its exact hash (edit one => update .htaccess)', () => {
    // The HTML parser normalises CRLF to LF before the browser hashes it.
    const html = INDEX_HTML.replace(/\r\n?/g, '\n');
    const inline = [...html.matchAll(/<script>([\s\S]*?)<\/script>/g)].map((m) => m[1]);
    assert.ok(inline.length >= 2);
    for (const body of inline) assert.ok(csp.includes(sha(body)), `CSP is missing ${sha(body)} — update web/.htaccess`);
  });

  test("the inline handler(s) in markup strings are allowed by hash ('unsafe-hashes')", (t) => {
    const handlers = [];
    for (const rel of ['src/pages/gis-live-tracking.js']) {
      for (const m of read(rel).matchAll(/ on[a-z]+="([^"$]*)"/g)) handlers.push(m[1]);
    }
    if (handlers.length === 0) {
      t.diagnostic("no inline handler left: remove 'unsafe-hashes' and its hash from web/.htaccess");
      return;
    }
    for (const h of handlers) assert.ok(csp.includes(sha(h)), `CSP lacks the hash for inline handler "${h}"`);
  });

  test('web and API send nosniff and DENY framing; the API sends no referrer, the web app only its origin; API keeps its Authorization rewrite', () => {
    for (const ht of [webHt, apiHt]) {
      assert.match(ht, /<IfModule mod_headers\.c>/);
      assert.match(ht, /X-Content-Type-Options "nosniff"/);
      assert.match(ht, /X-Frame-Options "DENY"/);
      assert.match(ht, /frame-ancestors 'none'/);
    }
    // The API never needs a referrer; the web app must send its origin so OpenStreetMap
    // tile servers do not answer 403 "Access blocked" (a path is never sent cross-origin).
    assert.match(apiHt, /Referrer-Policy "no-referrer"/);
    assert.match(webHt, /Referrer-Policy "strict-origin-when-cross-origin"/);
    assert.match(apiHt, /RewriteRule \.\* - \[E=HTTP_AUTHORIZATION:%\{HTTP:Authorization\}\]/);
    assert.doesNotMatch(csp, /'unsafe-eval'/);
    assert.doesNotMatch(csp.match(/script-src[^;]*/)[0], /'unsafe-inline'/);
  });
});

// --- X-02: expiry handling in the API client ---------------------------------

describe('X-02: a dead session is reported once and explained', () => {
  test('a server 401 clears the session, uses the plain-language message and notifies once', async () => {
    const seen = [];
    client.onSessionExpired((reason) => seen.push(reason));
    signIn('admin');
    api.fail('GET', '/incidents', 401, 'UNAUTHORIZED', 'Invalid or expired token.');
    await assert.rejects(client.getIncidents(), (err) => err.status === 401 && err.message === client.SESSION_EXPIRED_MESSAGE);
    await assert.rejects(client.getIncidents(), (err) => err.message === client.SESSION_EXPIRED_MESSAGE);
    await settle();
    assert.equal(client.getSession(), null);
    assert.deepEqual(seen, ['unauthorized']);
    client.onSessionExpired(null);
  });

  test('a locally expired session notifies too', async () => {
    const seen = [];
    client.onSessionExpired((reason) => seen.push(reason));
    client.__setSessionForTests({ token: 't', expiresAt: new Date(Date.now() - 1000).toISOString(), user: {} });
    await assert.rejects(client.getIncidents(), (err) => err.status === 401);
    await settle();
    assert.deepEqual(seen, ['expired']);
    client.onSessionExpired(null);
  });

  test('a wrong CURRENT password (change-password 401) does not sign the user out', async () => {
    signIn('admin');
    await assert.rejects(client.changePassword('wrong', 'New-Password-123'), (err) => err.message === 'Current password is incorrect.');
    assert.ok(client.getSession(), 'session must survive a wrong current password');
  });

  test('logout drops the local session at once, before the server answers', async () => {
    signIn('admin');
    const pending = client.logout();
    assert.equal(client.getSession(), null);
    await pending;
    assert.equal(api.callsTo('POST', '/auth/logout')[0].headers.authorization, 'Bearer test-token-admin');
  });
});

// --- X-02 / idle lock through main.js ----------------------------------------

let n = 0;
async function bootMain() {
  const mod = await import(`../../src/main.js?session=${++n}`);
  await settle();
  return { mod, root: window.document.getElementById('app') };
}
const navButton = (re) => $$('nav button, nav a, .sidebar button, .sidebar a, aside button, aside a').find((b) => re.test(text(b)));

async function signInViaForm(root, username) {
  type($('#login-username', root), username);
  type($('#login-password', root), 'Correct-Horse-9');
  $('form', root).dispatchEvent(new window.Event('submit', { bubbles: true, cancelable: true }));
  await settle();
}

describe('X-02: back to sign-in with a message, then back to the same screen', () => {
  test('a 401 mid-session shows the expiry notice; the same user returns to the same screen', async () => {
    signIn('secretary');
    const { root } = await bootMain();
    const target = navButton(/citizen reports/i);
    assert.ok(target, 'nav item not found');
    click(target);
    await settle();
    assert.match(text($('.page-header__title', root)), /Citizen Reports/);

    api.fail('GET', '/incidents', 401, 'UNAUTHORIZED', 'Invalid or expired token.');
    await client.getIncidents().catch(() => {});
    await settle();
    assert.ok($('#login-username', root), 'not returned to sign-in');
    assert.equal(text($('#login-notice', root)), 'Your session expired. Please sign in again.');
    assert.equal(window.document.title, 'Sign in — Baranguard');
    api.overrides.length = 0;

    await signInViaForm(root, 'secretary.dao');
    assert.match(text($('.page-header__title', root)), /Citizen Reports/, 'did not return to the previous screen');
  });

  test('a DIFFERENT user signing in lands on their own default page, not the previous screen', async () => {
    signIn('secretary');
    const { root } = await bootMain();
    click(navButton(/citizen reports/i));
    await settle();
    api.fail('GET', '/incidents', 401, 'UNAUTHORIZED', 'Invalid or expired token.');
    await client.getIncidents().catch(() => {});
    await settle();
    api.overrides.length = 0; // the server is healthy again
    await signInViaForm(root, 'admin.dao');
    assert.match(text($('.page-header__title', root)), /^Dashboard|Admin Dashboard/);
  });
});

describe('idle lock', () => {
  test('warns before the limit, any input cancels the warning, and the limit signs out', async () => {
    signIn('admin');
    const { mod, root } = await bootMain();
    const lock = mod.__idleLockForTests;
    assert.equal(mod.IDLE_TIMEOUT_MS, 15 * 60 * 1000);
    assert.ok(lock.running);

    const t0 = lock.lastActivityAt;
    lock.check(t0 + mod.IDLE_TIMEOUT_MS - 30 * 1000);
    const toast = $('.toast--warning');
    assert.ok(toast, 'no inactivity warning shown');
    assert.match(text(toast), /signed out in 30 seconds/);

    window.document.dispatchEvent(new window.KeyboardEvent('keydown', { key: 'Shift', bubbles: true }));
    assert.ok(toast.classList.contains('toast--leaving'), 'input should dismiss the warning');
    assert.ok(lock.lastActivityAt >= t0);

    lock.check(lock.lastActivityAt + mod.IDLE_TIMEOUT_MS - 1000);
    assert.ok(client.getSession(), 'not yet at the limit');
    lock.check(lock.lastActivityAt + mod.IDLE_TIMEOUT_MS);
    await settle();
    assert.equal(client.getSession(), null);
    assert.ok($('#login-username', root));
    assert.equal(text($('#login-notice', root)), mod.IDLE_SIGNED_OUT_MESSAGE);
    assert.equal(api.callsTo('POST', '/auth/logout').length, 1, 'the server session must be revoked too');
    assert.equal(lock.running, false);
  });
});

// --- V-03 / V-12: XSS sinks ----------------------------------------------------

describe('V-03/V-12: free text never becomes markup', () => {
  test('Swap requests: a patrol zone with markup renders as text (V-03)', async () => {
    api.setScenario('xss');
    signIn('admin');
    const host = window.document.getElementById('app');
    renderSwapRequestsTab(host, { userId: 1, role: 'admin', barangayId: 1, fullName: 'Ramon Elcano' }, () => {});
    await settle();
    assert.match(text(host), /Zone 2 - Market/);
    assert.ok(text(host).includes('<img src=x'), 'the zone text should be shown literally');
    assertNoInjectedMarkup();
  });

  test("KpiCard: a 'live' chip's text is text", () => {
    const card = KpiCard({ label: 'x', value: 1, badgeChip: { tone: 'live', text: XSS } });
    window.document.body.appendChild(card);
    assert.ok(card.textContent.includes('<img'));
    assertNoInjectedMarkup();
  });

  test('DataTable: string cells keep static formatting but lose anything executable', () => {
    const table = DataTable({
      columns: [{ key: 'a', label: 'A' }, { key: 'b', label: `B ${XSS}`, sortable: true, sortValue: (r) => r.a }],
      rows: [{ id: 1, a: XSS }],
      rowKey: (r) => r.id,
      renderCell: (row, key) => (key === 'a' ? row.a : '<span class="text-tertiary" style="color:red">—</span>'),
      onRowClick: () => {},
    });
    window.document.body.appendChild(table);
    assertNoInjectedMarkup();
    const kept = table.querySelector('td span.text-tertiary');
    assert.ok(kept, 'static caller markup must still render');
    assert.equal(kept.getAttribute('style'), 'color:red');
    const frag = cellContent('<b onclick="x()" class="k">ok</b><script>bad()</script><a href="javascript:x">l</a>&amp;');
    const holder = window.document.createElement('div');
    holder.appendChild(frag);
    assert.equal(holder.innerHTML, '<b class="k">ok</b>bad()l&amp;');
  });
});
