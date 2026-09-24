/**
 * fakeApi.mjs — replaces global `fetch`, which is the ONLY way the app
 * reaches the server (every call goes through apiClient.js's `request()`,
 * plus three authenticated blob/multipart fetches in the same file). So
 * the tests exercise the real client code — URL building, auth header,
 * snake_case mapping, error envelopes — against controlled responses.
 *
 * Any request with no matching route is answered 404 AND recorded in
 * `api.unexpected`. Page tests assert that list is empty, which catches
 * both a missing fixture and a typo'd endpoint path in the app.
 */

import { API_BASE, window } from './env.mjs';
import { buildRoutes } from './fixtures.mjs';

function compile(pattern) {
  const names = [];
  const source = pattern.replace(/:[a-zA-Z]+/g, (m) => { names.push(m.slice(1)); return '([^/]+)'; });
  return { regex: new RegExp(`^${source}$`), names };
}

class FakeApi {
  constructor() {
    this.calls = [];
    this.unexpected = [];
    this.inFlight = 0;
    this.scenario = 'populated';
    this.overrides = [];
    this.routes = [];
    this.setScenario('populated');
  }

  /**
   * 'populated' — realistic data everywhere.
   * 'empty'     — every list endpoint returns zero rows, optional records 404.
   * 'xss'       — populated, but every free-text field carries a markup payload.
   * 'error'     — every GET answers 500 with the real error envelope.
   */
  setScenario(scenario) {
    this.scenario = scenario;
    this.routes = buildRoutes(scenario).map((r) => ({ ...r, ...compile(r.path) }));
  }

  /** Per-test override; takes priority over the scenario's routes. */
  on(method, path, handler) {
    this.overrides.unshift({ method, path, handler, ...compile(path) });
  }

  /** Make one route fail with the server's real error envelope. */
  fail(method, path, status = 500, code = 'SERVER_ERROR', message = 'Simulated server failure.') {
    this.on(method, path, () => ({ status, body: { error: { code, message } } }));
  }

  reset() {
    this.calls.length = 0;
    this.unexpected.length = 0;
    this.overrides.length = 0;
    this.inFlight = 0;
    this.setScenario('populated');
  }

  callsTo(method, path) {
    const { regex } = compile(path);
    return this.calls.filter((c) => c.method === method && regex.test(c.path));
  }

  match(method, path) {
    for (const route of [...this.overrides, ...this.routes]) {
      if (route.method !== method) continue;
      const m = route.regex.exec(path);
      if (!m) continue;
      const params = Object.fromEntries(route.names.map((n, i) => [n, decodeURIComponent(m[i + 1])]));
      return { route, params };
    }
    return null;
  }

  async fetch(input, init = {}) {
    const url = new URL(typeof input === 'string' ? input : input.url);
    const method = (init.method || 'GET').toUpperCase();
    const headers = Object.fromEntries(Object.entries(init.headers || {}).map(([k, v]) => [k.toLowerCase(), v]));
    let body = init.body;
    if (typeof body === 'string') {
      try { body = JSON.parse(body); } catch { /* leave as text */ }
    }
    const path = url.pathname.replace(new URL(API_BASE).pathname, '');
    const query = Object.fromEntries(url.searchParams.entries());
    const call = { method, path, query, headers, body };
    this.calls.push(call);

    this.inFlight += 1;
    try {
      // Yield once, like a real network round trip, so loading states render.
      await new Promise((resolve) => setImmediate(resolve));
      const found = this.match(method, path);
      let result;
      if (!found) {
        this.unexpected.push(`${method} ${path}`);
        result = { status: 404, body: { error: { code: 'NOT_FOUND', message: `No fixture for ${method} ${path}` } } };
      } else if (this.scenario === 'error' && method === 'GET' && !found.route.alwaysOk && !this.overrides.includes(found.route)) {
        result = { status: 500, body: { error: { code: 'SERVER_ERROR', message: 'Simulated server failure.' } } };
      } else {
        result = await found.route.handler({ ...call, params: found.params, scenario: this.scenario });
      }
      const { status = 200, body: resBody, headers: resHeaders = {}, raw } = result;
      if (raw !== undefined) {
        return new Response(raw, { status, headers: resHeaders });
      }
      return new Response(resBody === undefined ? '' : JSON.stringify(resBody), {
        status,
        headers: { 'Content-Type': 'application/json', ...resHeaders },
      });
    } finally {
      this.inFlight -= 1;
    }
  }
}

export const api = new FakeApi();

const boundFetch = (input, init) => api.fetch(input, init);
Object.defineProperty(globalThis, 'fetch', { value: boundFetch, configurable: true, writable: true });
window.fetch = boundFetch;
