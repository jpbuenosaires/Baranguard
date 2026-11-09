/**
 * sse.mjs — a controllable GET /gps/stream for tests. Each connection the
 * app opens becomes an entry in `conns` with push()/end() to feed the body,
 * and `cancelled`/`signal` to see whether the client let go of it.
 */
import { api } from './fakeApi.mjs';

const enc = new TextEncoder();

export function sseFrame(event, data) {
  return `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
}

export function gpsRow(userId, latitude, longitude, extra = {}) {
  return {
    user_id: userId, full_name: `Tanod ${userId}`, dispatch_id: null, latitude, longitude, accuracy_m: 8,
    recorded_at: '2026-11-06 01:00:00', received_at: '2026-11-06 01:00:01', age_seconds: 1, is_stale: false, ...extra,
  };
}

/** Routes /gps/stream to fresh controllable streams; `respond(n)` can answer connection n with a plain HTTP result instead. */
export function installStream({ respond } = {}) {
  const conns = [];
  const origFetch = globalThis.fetch;
  const signals = [];
  globalThis.fetch = (input, init) => {
    if (String(input).includes('/gps/stream')) signals.push(init?.signal);
    return origFetch(input, init);
  };
  api.on('GET', '/gps/stream', ({ headers, query }) => {
    const n = conns.length;
    const answer = respond?.(n);
    if (answer) {
      conns.push({ headers, query, cancelled: false, signal: signals[n], push() {}, end() {} });
      return answer;
    }
    let ctrl;
    const conn = { headers, query, cancelled: false, signal: signals[n], push: (str) => ctrl.enqueue(enc.encode(str)), end: () => ctrl.close() };
    conn.body = new ReadableStream({ start(c) { ctrl = c; }, cancel() { conn.cancelled = true; } });
    conns.push(conn);
    return { status: 200, headers: { 'Content-Type': 'text/event-stream' }, raw: conn.body };
  });
  return { conns, restore() { globalThis.fetch = origFetch; } };
}
