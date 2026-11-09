/**
 * openGpsStream(): the SSE client behind the live map's server push.
 * Frames are parsed by hand (fetch + ReadableStream), so the parser, the
 * reconnect/backoff rules and the session-expiry path are tested here.
 */
import { signIn, cleanup, settle } from '../harness/render.mjs';
import { installStream, sseFrame, gpsRow } from '../harness/sse.mjs';
import { describe, test, afterEach, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import * as client from '../../src/api/apiClient.js';

let stub;
let closers = [];
let trackedSetTimeout;
const delays = [];
const sleep = (ms) => new Promise((resolve) => trackedSetTimeout(resolve, ms));

/** Shrinks the listed delays to 5 ms (and records every delay asked for), so backoff is testable without waiting. */
function shrink(...values) {
  const base = trackedSetTimeout;
  globalThis.setTimeout = (fn, ms, ...rest) => {
    delays.push(ms);
    return base(fn, values.includes(ms) ? 5 : ms, ...rest);
  };
}

function open(handlers = {}) {
  const got = { snapshots: [], positions: [], states: [] };
  const stream = client.openGpsStream(1, {
    onSnapshot: (items) => got.snapshots.push(items),
    onPosition: (items) => got.positions.push(items),
    onState: (state) => got.states.push(state),
    ...handlers,
  });
  closers.push(stream);
  return { stream, got };
}

const httpAnswer = (status) => () => ({ status, body: { error: { code: 'X', message: 'x' } } });
function useStub(options) {
  stub.restore();
  stub = installStream(options);
}

beforeEach(() => {
  trackedSetTimeout = globalThis.setTimeout;
  signIn('admin');
  stub = installStream();
  delays.length = 0;
});
afterEach(() => {
  closers.forEach((s) => s.close());
  closers = [];
  stub.restore();
  globalThis.setTimeout = trackedSetTimeout;
  cleanup();
});

describe('openGpsStream', () => {
  test('sends the bearer token and barangay_id, then maps snapshot and position frames (split across chunks, comments, CRLF)', async () => {
    const { got } = open();
    await settle();
    assert.equal(stub.conns.length, 1);
    assert.equal(stub.conns[0].headers.authorization, 'Bearer test-token-admin');
    assert.equal(stub.conns[0].headers.accept, 'text/event-stream');
    assert.equal(stub.conns[0].query.barangay_id, '1');
    assert.deepEqual(got.states, ['connecting', 'open']);

    const snapshot = sseFrame('snapshot', { items: [gpsRow(4, 12.9, 123.6)] });
    stub.conns[0].push(snapshot.slice(0, 11));
    await settle();
    assert.equal(got.snapshots.length, 0, 'half a frame must not be delivered');
    stub.conns[0].push(snapshot.slice(11, -1));
    await settle();
    assert.equal(got.snapshots.length, 0, 'the frame is not finished until the blank line');
    const position = sseFrame('position', { items: [gpsRow(4, 12.91, 123.61)] }).replace(/\n/g, '\r\n');
    stub.conns[0].push(`\n: ping\n\n${position}`);
    await settle();

    assert.equal(got.snapshots.length, 1);
    const [row] = got.snapshots[0];
    assert.deepEqual(
      { ...row, recordedAt: undefined, receivedAt: undefined },
      { userId: 4, fullName: 'Tanod 4', dispatchId: null, latitude: 12.9, longitude: 123.6, accuracyM: 8, recordedAt: undefined, receivedAt: undefined, ageSeconds: 1, isStale: false },
    );
    assert.match(String(row.recordedAt), /^2026-11-06T01:00:00/, 'bare SQL timestamps are tagged UTC like every other call');
    assert.equal(got.positions.length, 1);
    assert.equal(got.positions[0][0].latitude, 12.91);
  });

  test('a lone ": ping" comment and an unknown event are ignored', async () => {
    const { got } = open();
    await settle();
    stub.conns[0].push(': ping\n\nevent: nonsense\ndata: {}\n\n');
    await settle();
    assert.deepEqual([got.snapshots.length, got.positions.length], [0, 0]);
    assert.equal(stub.conns.length, 1);
  });

  test('"reconnect" reopens at once with no backoff, and the new connection delivers', async () => {
    shrink(1000);
    const { got } = open();
    await settle();
    stub.conns[0].push(sseFrame('reconnect', {}));
    await settle();
    assert.equal(stub.conns.length, 2);
    assert.ok(stub.conns[0].cancelled, 'the old connection is released');
    assert.ok(!delays.includes(1000), 'no backoff wait after a requested reconnect');
    stub.conns[1].push(sseFrame('position', { items: [gpsRow(5, 12.8, 123.5)] }));
    await settle();
    assert.equal(got.positions.length, 1);
  });

  test('a renewed token on the stream response is kept (same sliding renewal as other calls)', async () => {
    const b64 = (o) => Buffer.from(JSON.stringify(o)).toString('base64url');
    const renewed = `${b64({ alg: 'HS256' })}.${b64({ exp: Math.floor(Date.now() / 1000) + 3600 })}.sig`;
    useStub({ respond: () => ({ status: 200, headers: { 'Content-Type': 'text/event-stream', 'X-Renewed-Token': renewed }, raw: new ReadableStream({}) }) });
    open();
    await settle();
    assert.equal(client.getSession().token, renewed);
  });

  test('5xx answers back off 1 s, 2 s, 5 s, then cap at 10 s', async () => {
    shrink(1000, 2000, 5000, 10000);
    useStub({ respond: httpAnswer(503) });
    const { got } = open();
    await sleep(150);
    closers.forEach((c) => c.close());
    await settle(); // let in-flight requests finish so the fake API counter stays balanced
    assert.ok(stub.conns.length >= 6);
    assert.deepEqual(delays.filter((d) => d >= 1000).slice(0, 5), [1000, 2000, 5000, 10000, 10000]);
    assert.ok(got.states.includes('connecting'));
    assert.ok(!got.states.includes('open'));
  });

  test('429, 403 and 404 wait 30 s before trying again and report closed meanwhile', async () => {
    for (const status of [429, 403, 404]) {
      delays.length = 0;
      shrink(); // record delays only
      useStub({ respond: httpAnswer(status) });
      const { stream, got } = open();
      await settle();
      assert.ok(delays.includes(30000), `status ${status} waits 30 s`);
      assert.equal(stub.conns.length, 1, `status ${status} is not retried fast`);
      assert.equal(got.states.at(-1), 'closed');
      stream.close();
    }
  });

  test('"auth_expired" ends the session through the normal expiry path and stops for good', async () => {
    shrink(1000);
    const seen = [];
    client.onSessionExpired((reason) => seen.push(reason));
    const { got } = open();
    await settle();
    stub.conns[0].push(sseFrame('auth_expired', {}));
    await settle();
    assert.deepEqual(seen, ['unauthorized']);
    assert.equal(client.getSession(), null);
    assert.equal(got.states.at(-1), 'closed');
    await sleep(30);
    assert.equal(stub.conns.length, 1, 'no reconnect after auth_expired');
    client.onSessionExpired(null);
  });

  test('HTTP 401 does the same', async () => {
    const seen = [];
    client.onSessionExpired((reason) => seen.push(reason));
    useStub({ respond: httpAnswer(401) });
    const { got } = open();
    await settle();
    assert.deepEqual(seen, ['unauthorized']);
    assert.equal(got.states.at(-1), 'closed');
    assert.equal(stub.conns.length, 1);
    client.onSessionExpired(null);
  });

  test('close() aborts the fetch, releases the body, goes quiet and never reconnects', async () => {
    shrink(1000);
    const { stream, got } = open();
    await settle();
    stub.conns[0].push(sseFrame('position', { items: [gpsRow(4, 12.9, 123.6)] }));
    await settle();
    assert.equal(got.positions.length, 1);
    stream.close();
    assert.equal(stub.conns[0].signal.aborted, true);
    assert.equal(got.states.at(-1), 'closed');
    try { stub.conns[0].push(sseFrame('position', { items: [gpsRow(4, 1, 1)] })); } catch { /* body already cancelled */ }
    await sleep(30);
    assert.ok(stub.conns[0].cancelled);
    assert.equal(got.positions.length, 1, 'nothing is delivered after close()');
    assert.equal(stub.conns.length, 1);
  });

  test('close() during a backoff wait cancels the retry', async () => {
    useStub({ respond: httpAnswer(500) });
    const { stream } = open();
    await settle();
    stream.close();
    await sleep(30);
    assert.equal(stub.conns.length, 1);
  });

  test('45 s of silence on an open stream is treated as dead and reconnects', async () => {
    shrink(45000, 1000);
    const { got } = open();
    await settle();
    await sleep(50);
    closers.forEach((c) => c.close());
    await settle();
    assert.ok(stub.conns.length >= 2, 'the silent stream was dropped and reopened');
    assert.ok(stub.conns[0].cancelled);
    assert.ok(got.states.includes('open'));
  });

  test('a throwing page callback does not stop the stream', async () => {
    const { got } = open({ onPosition() { throw new Error('page bug'); } });
    await settle();
    stub.conns[0].push(sseFrame('position', { items: [gpsRow(4, 12.9, 123.6)] }));
    stub.conns[0].push(sseFrame('snapshot', { items: [gpsRow(5, 12.8, 123.5)] }));
    await settle();
    assert.equal(got.snapshots.length, 1);
  });
});

describe('mergeGpsFixes', () => {
  const fix = (userId, recordedAt, latitude) => ({ userId, recordedAt, latitude });
  test('a push keeps users it does not mention, replaces older fixes and ignores older pushes', () => {
    const base = [fix(4, '2026-11-06T01:00:10Z', 1), fix(5, '2026-11-06T01:00:00Z', 2)];
    const merged = client.mergeGpsFixes(base, [fix(4, '2026-11-06T01:00:05Z', 9), fix(5, '2026-11-06T01:00:20Z', 8), fix(6, '2026-11-06T01:00:00Z', 7)], true);
    assert.deepEqual(merged.map((g) => [g.userId, g.latitude]), [[4, 1], [5, 8], [6, 7]]);
  });
  test('a poll replaces the list (drops absent users) but still prefers a newer pushed fix', () => {
    const base = [fix(4, '2026-11-06T01:00:10Z', 1), fix(5, '2026-11-06T01:00:00Z', 2)];
    const merged = client.mergeGpsFixes(base, [fix(4, '2026-11-06T01:00:05Z', 9)], false);
    assert.deepEqual(merged.map((g) => [g.userId, g.latitude]), [[4, 1]]);
  });
});
