/**
 * apiClient.js — the ONE central `/api/v1` boundary (§4 "Boundary rule":
 * exactly one file per platform does snake_case <-> camelCase conversion;
 * no page/component may do that ad-hoc).
 *
 * Base URL: no build step exists yet (§1 stack: vanilla JS, no framework,
 * no bundler), so there's no env-var injection mechanism at build time.
 * Resolved decision (logged in DEVLOG.md): the base URL comes from
 * `window.BARANGUARD_API_BASE_URL` if index.html defines it, otherwise
 * defaults to the PHP built-in server's URL from
 * backend/scripts/README-serving.md Option B (`http://127.0.0.1:8080/api/v1`)
 * — the lowest-friction local-dev default. Point it at the real vhost
 * (`http://baranguard.local/api/v1`) by setting that global before this
 * module runs; see web/README-serving.md.
 *
 * Session storage: resolved decision (logged in DEVLOG.md) — the JWT and
 * its expiry/user info live in `sessionStorage`, not `localStorage`. This
 * is a shared-workstation CAD-style system (§8 tone); a session that dies
 * with the tab is the safer default for that context, and it still
 * survives an accidental page reload within the same tab. No httpOnly
 * cookie option exists because there's no server-side session cookie
 * mechanism built — the API is a stateless bearer-token JSON API per §6.
 *
 * snake_case <-> camelCase (§4): this file hand-maps each endpoint's known
 * *structural* field names rather than deep-recursively converting every
 * object key. That's deliberate, not a shortcut: GET /reports/summary's
 * `by_incident_type` / `by_status` are objects keyed by the raw §5 enum
 * *values* (`physical_injury`, `traffic_incident`, ...), which are data,
 * not field names — a blind recursive snake->camel pass would silently
 * rewrite `physical_injury` to `physicalInjury` and break any code that
 * compares against the real DB enum string. Structural keys are
 * converted; enum-valued keys are passed through byte-for-byte.
 */

const DEFAULT_BASE_URL = 'http://127.0.0.1:8080/api/v1';
const BASE_URL = (typeof window !== 'undefined' && window.BARANGUARD_API_BASE_URL) || DEFAULT_BASE_URL;

const SESSION_KEY = 'baranguard.session';

export class ApiClientError extends Error {
  constructor(status, code, message) {
    super(message);
    this.name = 'ApiClientError';
    this.status = status;
    this.code = code;
  }
}

// --- Session storage ------------------------------------------------------

function readSession() {
  try {
    const raw = sessionStorage.getItem(SESSION_KEY);
    if (!raw) return null;
    const parsed = JSON.parse(raw);
    if (!parsed || typeof parsed.token !== 'string' || typeof parsed.expiresAt !== 'string') {
      return null;
    }
    if (new Date(parsed.expiresAt).getTime() <= Date.now()) {
      sessionStorage.removeItem(SESSION_KEY);
      return null;
    }
    return parsed;
  } catch {
    return null;
  }
}

function writeSession(session) {
  sessionStorage.setItem(SESSION_KEY, JSON.stringify(session));
}

function clearSession() {
  sessionStorage.removeItem(SESSION_KEY);
}

export function getSession() {
  return readSession();
}

export function isAuthenticated() {
  return readSession() !== null;
}

// --- Low-level request helper ----------------------------------------------

async function request(method, path, { query, body, auth = true } = {}) {
  let url = `${BASE_URL}${path}`;
  if (query) {
    const params = new URLSearchParams();
    for (const [key, value] of Object.entries(query)) {
      if (value !== undefined && value !== null && value !== '') {
        params.set(key, value);
      }
    }
    const qs = params.toString();
    if (qs) url += `?${qs}`;
  }

  const headers = { Accept: 'application/json' };
  if (body !== undefined) headers['Content-Type'] = 'application/json';

  const session = auth ? readSession() : null;
  if (auth) {
    if (!session) {
      throw new ApiClientError(401, 'UNAUTHORIZED', 'Not signed in.');
    }
    headers.Authorization = `Bearer ${session.token}`;
  }

  let response;
  try {
    response = await fetch(url, {
      method,
      headers,
      body: body !== undefined ? JSON.stringify(body) : undefined,
    });
  } catch (networkError) {
    // §8 "Required states": every data-driven screen needs an Error state
    // with retry — a network failure/unreachable API is that case, not a
    // silent console error.
    throw new ApiClientError(0, 'NETWORK_ERROR', 'Could not reach the Baranguard server. Check your connection and try again.');
  }

  // Sliding renewal (§6): keep the token with the latest expiry.
  const renewed = response.headers.get('X-Renewed-Token');
  if (renewed && session) {
    const payload = decodeJwtPayload(renewed);
    if (payload && typeof payload.exp === 'number') {
      writeSession({ ...session, token: renewed, expiresAt: new Date(payload.exp * 1000).toISOString() });
    }
  }

  let json = null;
  const text = await response.text();
  if (text) {
    try {
      json = JSON.parse(text);
    } catch {
      throw new ApiClientError(response.status, 'INVALID_RESPONSE', 'The server returned an unreadable response.');
    }
  }

  if (!response.ok) {
    const errBody = json && json.error ? json.error : {};
    if (response.status === 401 && auth) {
      // Session is dead server-side (expired/revoked) — don't let the app
      // keep sending a token that will only ever come back 401.
      clearSession();
    }
    throw new ApiClientError(response.status, errBody.code || 'UNKNOWN_ERROR', errBody.message || 'Something went wrong.');
  }

  return json ?? {};
}

function decodeJwtPayload(token) {
  try {
    const [, payloadB64] = token.split('.');
    const normalized = payloadB64.replace(/-/g, '+').replace(/_/g, '/');
    const padded = normalized + '='.repeat((4 - (normalized.length % 4)) % 4);
    return JSON.parse(atob(padded));
  } catch {
    return null;
  }
}

// --- Auth -------------------------------------------------------------------

/** @returns {Promise<{userId:number, fullName:string, role:string, barangayId:number}>} */
export async function login(username, password) {
  const json = await request('POST', '/auth/login', { body: { username, password }, auth: false });
  const session = {
    token: json.token,
    expiresAt: json.expires_at,
    user: {
      userId: json.user.user_id,
      fullName: json.user.full_name,
      role: json.user.role,
      barangayId: json.user.barangay_id,
    },
  };
  writeSession(session);
  return session.user;
}

export async function logout() {
  try {
    await request('POST', '/auth/logout', { auth: true, body: {} });
  } catch {
    // §6: "server ignores a second logout safely" — client-side, logging
    // out is a local action regardless of whether the network call
    // succeeds; never block the user from leaving a signed-in state.
  } finally {
    clearSession();
  }
}

// --- Reports (W2 Admin Dashboard) -------------------------------------------

/**
 * GET /reports/summary. `dateFrom`/`dateTo` are optional "YYYY-MM-DD"
 * strings (Asia/Manila calendar days — see ReportsController.php); omit
 * both for the server's default trailing-30-day window.
 *
 * @returns {Promise<{
 *   totalIncidents:number, resolvedCount:number,
 *   avgResponseTimeMinutes:?number, activeTanods:number,
 *   byIncidentType:Record<string,number>, byStatus:Record<string,number>,
 *   trend:Array<{date:string, count:number}>
 * }>}
 */
export async function getReportsSummary({ dateFrom, dateTo } = {}) {
  const json = await request('GET', '/reports/summary', {
    query: { date_from: dateFrom, date_to: dateTo },
    auth: true,
  });
  return {
    totalIncidents: json.total_incidents,
    resolvedCount: json.resolved_count,
    avgResponseTimeMinutes: json.avg_response_time_minutes,
    activeTanods: json.active_tanods,
    // Enum-valued keys pass through unconverted — see file header.
    byIncidentType: json.by_incident_type,
    byStatus: json.by_status,
    trend: json.trend,
  };
}
