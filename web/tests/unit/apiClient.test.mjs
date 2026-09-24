/**
 * apiClient.js is the ONE /api/v1 boundary (§4): auth header, error
 * envelope, UTC timestamp revival, sliding token renewal, idempotency
 * header and the hand-written snake_case -> camelCase mapping all live
 * here, so every page depends on it being exactly right.
 */
import { api, window, signIn, cleanup } from '../harness/render.mjs';
import { describe, test, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import * as client from '../../src/api/apiClient.js';

const { ApiClientError } = client;
afterEach(() => cleanup());

const session = () => client.getSession();

function fakeJwt(expSeconds) {
  const b64 = (o) => Buffer.from(JSON.stringify(o)).toString('base64url');
  return `${b64({ alg: 'HS256' })}.${b64({ exp: expSeconds })}.sig`;
}

describe('session', () => {
  test('login stores the token/expiry/mapped user in memory, and NEVER in any Storage object (H-05)', async () => {
    const user = await client.login('admin.dao', 'Correct-Horse-9');
    assert.deepEqual(user, { userId: 1, fullName: 'Ramon Elcano', role: 'admin', barangayId: 1 });
    assert.equal(session().token, 'test-token-admin');
    assert.equal(window.sessionStorage.length, 0, 'the token must not be readable via sessionStorage (XSS exfiltration risk, H-05)');
    assert.equal(window.localStorage.length, 0, 'a shared workstation session must die with the tab, and never touch localStorage either');
    const [call] = api.callsTo('POST', '/auth/login');
    assert.equal(call.headers.authorization, undefined, 'login must not send a bearer token');
  });

  test('wrong credentials throw the server\'s own message and store nothing', async () => {
    await assert.rejects(client.login('admin.dao', 'nope'), (err) => err instanceof ApiClientError && err.status === 401 && err.message === 'Invalid username or password.');
    assert.equal(client.getSession(), null);
  });

  test('an expired session is treated as signed out and removed', () => {
    client.__setSessionForTests({ token: 't', expiresAt: new Date(Date.now() - 1000).toISOString(), user: {} });
    assert.equal(client.getSession(), null);
    assert.equal(client.isAuthenticated(), false);
  });

  test('a malformed session shape is ignored rather than crashing', () => {
    client.__setSessionForTests({ notAValidSessionShape: true });
    assert.equal(client.getSession(), null);
  });

  test('logout clears the session even when the server call fails', async () => {
    signIn('admin');
    api.fail('POST', '/auth/logout');
    await client.logout();
    assert.equal(client.getSession(), null);
  });

  test('an authenticated call without a session fails fast, without hitting the network', async () => {
    await assert.rejects(client.getIncidents(), (err) => err.status === 401 && err.code === 'UNAUTHORIZED');
    assert.equal(api.calls.length, 0);
  });
});

describe('request plumbing', () => {
  test('sends the bearer token and JSON accept header', async () => {
    signIn('secretary');
    await client.getIncidents();
    const [call] = api.callsTo('GET', '/incidents');
    assert.equal(call.headers.authorization, 'Bearer test-token-secretary');
    assert.equal(call.headers.accept, 'application/json');
  });

  test('drops empty query parameters instead of sending ?q=&status=', async () => {
    signIn('admin');
    await client.getIncidents({ status: 'pending', priority: '', q: undefined, page: 1 });
    const [call] = api.callsTo('GET', '/incidents');
    assert.deepEqual(call.query, { status: 'pending', page: '1' });
  });

  test('surfaces the server error envelope as ApiClientError(status, code, message)', async () => {
    signIn('admin');
    api.fail('GET', '/incidents', 409, 'CONFLICT', 'Stale version.');
    await assert.rejects(client.getIncidents(), (err) => err instanceof ApiClientError && err.status === 409 && err.code === 'CONFLICT' && err.message === 'Stale version.');
  });

  test('a 401 from the server clears the dead session', async () => {
    signIn('admin');
    api.fail('GET', '/incidents', 401, 'UNAUTHORIZED', 'Session expired.');
    await assert.rejects(client.getIncidents());
    assert.equal(client.getSession(), null);
  });

  test('a network failure becomes a friendly NETWORK_ERROR, not a raw TypeError', async () => {
    signIn('admin');
    api.on('GET', '/incidents', () => { throw new TypeError('Failed to fetch'); });
    await assert.rejects(client.getIncidents(), (err) => err.code === 'NETWORK_ERROR' && /Could not reach the Baranguard server/.test(err.message));
  });

  test('a non-JSON body becomes INVALID_RESPONSE', async () => {
    signIn('admin');
    api.on('GET', '/incidents', () => ({ status: 200, raw: '<html>502 Bad Gateway</html>' }));
    await assert.rejects(client.getIncidents(), (err) => err.code === 'INVALID_RESPONSE');
  });

  test('X-Renewed-Token slides the stored session forward (§6 sliding renewal)', async () => {
    signIn('admin');
    const exp = Math.floor(Date.now() / 1000) + 3600;
    api.on('GET', '/incidents', () => ({ status: 200, body: { items: [], page: 1, limit: 25, total: 0 }, headers: { 'X-Renewed-Token': fakeJwt(exp) } }));
    await client.getIncidents();
    assert.equal(session().token, fakeJwt(exp));
    assert.equal(new Date(session().expiresAt).getTime(), exp * 1000);
  });

  test('web writes carry an Idempotency-Key header (Rule 3)', async () => {
    signIn('admin');
    await client.updateIncident(901, { priority: 'high', idempotencyKey: 'abc-123' });
    const [call] = api.callsTo('PATCH', '/incidents/:id');
    assert.equal(call.headers['idempotency-key'], 'abc-123');
    assert.deepEqual(call.body, { priority: 'high' });
  });

  test('updateIncident has no way to send a narrative (Rule 4: only ai-draft/approve may write it)', async () => {
    signIn('secretary');
    await client.updateIncident(901, { rawNarrative: 'x', redactedNarrative: 'y', locationDescription: 'Purok 1' });
    const [call] = api.callsTo('PATCH', '/incidents/:id');
    assert.deepEqual(call.body, { location_description: 'Purok 1' });
  });

  test('public endpoints (citizen report, barangays) never send a token', async () => {
    signIn('admin');
    await client.getBarangays();
    await client.submitCitizenReport({ barangayId: 1, description: 'Flooding', contactNumber: null, latitude: null, longitude: null });
    for (const call of api.calls) assert.equal(call.headers.authorization, undefined, `${call.method} ${call.path} leaked a token`);
  });
});

describe('UTC timestamp revival (the 8-hour offset bug)', () => {
  test('bare SQL datetimes are read as UTC instants', async () => {
    signIn('admin');
    api.on('GET', '/incidents/:id', () => ({ status: 200, body: { incident_id: 1, created_at: '2026-09-06 13:41:20', synced_at: '2026-09-06T13:41:20+08:00', dispatches: [] } }));
    const incident = await client.getIncident(1);
    assert.equal(incident.createdAt, '2026-09-06T13:41:20Z');
    assert.equal(new Date(incident.createdAt).toISOString(), '2026-09-06T13:41:20.000Z');
    assert.equal(incident.syncedAt, '2026-09-06T13:41:20+08:00', 'values that already carry an offset are untouched');
  });

  test('date-only strings stay literal (date-range inputs depend on it)', async () => {
    signIn('admin');
    const summary = await client.getReportsSummary();
    assert.match(summary.trend[0].date, /^\d{4}-\d{2}-\d{2}$/);
  });
});

describe('snake_case -> camelCase mapping', () => {
  test('enum-valued keys pass through byte-for-byte (by_incident_type is data, not field names)', async () => {
    signIn('admin');
    const summary = await client.getReportsSummary();
    assert.ok('medical_emergency' in summary.byIncidentType, 'enum keys must not become medicalEmergency');
    assert.equal(summary.avgResponseTimeMinutes, 20.3);
    assert.equal(summary.responseTimeTrend[0].avgMinutes, null, 'a genuine gap stays null, never 0');
  });

  test('raw narrative and party fields are optional — absent for non-Secretaries, not undefined-crashing', async () => {
    signIn('admin');
    const asAdmin = await client.getIncident(901);
    assert.equal(asAdmin.rawNarrative, null);
    assert.equal(asAdmin.complainantName, null);
    signIn('secretary');
    const asSecretary = await client.getIncident(901);
    assert.match(asSecretary.rawNarrative, /^RAW-NARRATIVE-901/);
    assert.equal(asSecretary.complainantName, 'Juan Santos');
  });

  test('multi-responder incidents keep every dispatch', async () => {
    signIn('admin');
    const incident = await client.getIncident(902);
    assert.equal(incident.dispatches.length, 2);
    assert.equal(incident.hasActiveDispatch, true);
  });

  test('route_json is normalised to the same shape the mobile app uses', async () => {
    signIn('admin');
    const { items } = await client.getDispatches({ incidentId: 902 });
    assert.deepEqual(items[0].routeJson.steps[0], { instruction: 'Head north', maneuver: 'depart', distanceM: 420, durationS: 300 });
    assert.equal(items[1].routeJson, null);
  });

  for (const [name, call, path] of [
    ['getAiDraft', (c) => c.getAiDraft(904), '/incidents/:id/ai-draft'],
    ['getExtractionDraft', (c) => c.getExtractionDraft(904), '/incidents/:id/ai-draft/extraction'],
    ['getBlotterForIncident', (c) => c.getBlotterForIncident(901), '/incidents/:id/blotter'],
  ]) {
    test(`${name}: a 404 is an ordinary "not yet" state (null), not an error`, async () => {
      signIn('secretary');
      assert.equal(await call(client), null);
      assert.equal(api.callsTo('GET', path).length, 1);
    });
  }

  test('getMapPackage: no published package (404) is null', async () => {
    signIn('admin');
    api.setScenario('empty');
    assert.equal(await client.getMapPackage(1), null);
  });

  test('404 handling does not swallow real failures', async () => {
    signIn('secretary');
    api.fail('GET', '/incidents/:id/ai-draft', 500);
    await assert.rejects(client.getAiDraft(901), (err) => err.status === 500);
  });

  test('every list endpoint maps without leaving snake_case keys behind', async () => {
    signIn('admin');
    const results = {
      users: (await client.getUsers()).items[0],
      incidents: (await client.getIncidents()).items[0],
      dispatches: (await client.getDispatches()).items[0],
      gps: (await client.getGpsLive(1))[0],
      sos: (await client.getTanodSos())[0],
      notifications: (await client.getNotifications()).items[0],
      duty: (await client.getDutyStatus(1))[0],
      citizenReports: (await client.getCitizenReports()).items[0],
      shifts: (await client.getShifts()).items[0],
      swaps: (await client.getShiftSwapRequests()).items[0],
      fatigue: (await client.getFatigueFlags()).items[0],
      audit: (await client.getAuditLog()).items[0],
      smsLogs: (await client.getSmsLogs()).items[0],
      conversations: (await client.getSmsConversations())[0],
      subscribers: (await client.getSmsSubscribers()).items[0],
      blotter: (await client.getBlotterList()).items[0],
      evidence: (await client.getIncidentEvidence(902))[0],
      health: await client.getSystemHealth(),
      healthHistory: (await client.getSystemHealthHistory()).items[0],
    };
    const leftovers = [];
    for (const [name, obj] of Object.entries(results)) {
      for (const [key, value] of Object.entries(obj)) {
        if (key.includes('_')) leftovers.push(`${name}.${key}`);
        if (value === undefined) leftovers.push(`${name}.${key} is undefined (field missing from the wire mapping)`);
      }
    }
    assert.deepEqual(leftovers, []);
  });
});
