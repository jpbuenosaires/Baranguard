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

async function request(method, path, { query, body, auth = true, idempotencyKey } = {}) {
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
  if (idempotencyKey) headers['Idempotency-Key'] = idempotencyKey;

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

/** W15 Settings/Account. Throws ApiClientError(401,...) on a wrong current password. */
export async function changePassword(currentPassword, newPassword) {
  await request('POST', '/auth/change-password', {
    body: { current_password: currentPassword, new_password: newPassword },
    auth: true,
  });
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
 *   trend:Array<{date:string, count:number, resolved:number}>,
 *   byHour:number[], responseTimeTrend:Array<{date:string, avgMinutes:?number}>
 * }>}
 * `byHour`/`responseTimeTrend` are Phase 9 (Analytics) additions — see
 * ReportsController::summary() for exactly what each buckets.
 * `trend[].count` is incidents REPORTED that day; `trend[].resolved` is
 * incidents CLOSED OUT that day, bucketed on the dispatch completion time
 * (the only resolution moment §5 records) — see ReportsController::summary
 * for why the two series are not expected to reconcile with resolvedCount.
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
    byHour: json.by_hour,
    responseTimeTrend: (json.response_time_trend || []).map((d) => ({ date: d.date, avgMinutes: d.avg_minutes })),
  };
}

/** GET /reports/heatmap (W5). Same date_from/date_to convention as getReportsSummary. */
export async function getReportsHeatmap({ dateFrom, dateTo } = {}) {
  const json = await request('GET', '/reports/heatmap', {
    query: { date_from: dateFrom, date_to: dateTo },
    auth: true,
  });
  return json.items.map((row) => ({ latitude: row.latitude, longitude: row.longitude, weight: row.weight }));
}

/** GET /reports/nav-counts (§4.1 of the UI/UX review, sidebar badge counts). Admin only. */
export async function getNavCounts() {
  const json = await request('GET', '/reports/nav-counts', { auth: true });
  return {
    pendingIncidents: json.pending_incidents,
    unconvertedCitizenReports: json.unconverted_citizen_reports,
    pendingSwapRequests: json.pending_swap_requests,
    unacknowledgedFatigueFlags: json.unacknowledged_fatigue_flags,
  };
}

// --- Users (Tanod-picker lookup + W10 User Management) ----------------------

/** @returns {Promise<{items:Array<object>, page:number, limit:number, total:number}>} */
export async function getUsers({ role, page, limit } = {}) {
  const json = await request('GET', '/users', { query: { role, page, limit }, auth: true });
  return {
    items: json.items.map((row) => ({
      userId: row.user_id,
      fullName: row.full_name,
      username: row.username,
      role: row.role, // enum value, unconverted
      contactNumber: row.contact_number,
      isActive: row.is_active,
      isSuspended: row.is_suspended,
      createdAt: row.created_at,
      lastLoginAt: row.last_login_at,
    })),
    page: json.page,
    limit: json.limit,
    total: json.total,
  };
}

/**
 * PATCH /users/:id — W10's admin-editing-another-user path. Cross-tenant
 * or the last-active-Admin case surface as the server's real ApiClientError
 * (404 / 409 respectively) — the caller should show that message as-is,
 * not paraphrase it.
 */
export async function setUserActive(userId, isActive) {
  const json = await request('PATCH', `/users/${userId}`, { body: { is_active: isActive }, auth: true });
  return { userId: json.user_id, updated: json.updated, isActive: json.is_active, isSuspended: json.is_suspended };
}

/**
 * PATCH /users/:id — the suspend/unsuspend action (2026-09-05 UX pass),
 * independent of `setUserActive`'s deactivate/reactivate — see
 * UsersController::updateOtherUserStatus()'s own doc for why these are
 * two separate flags, not one three-way enum. `reason` is only sent when
 * suspending (`isSuspended=true`); ignored otherwise.
 */
export async function setUserSuspended(userId, isSuspended, reason) {
  const json = await request('PATCH', `/users/${userId}`, {
    body: { is_suspended: isSuspended, suspended_reason: isSuspended ? (reason || null) : undefined },
    auth: true,
  });
  return { userId: json.user_id, updated: json.updated, isActive: json.is_active, isSuspended: json.is_suspended };
}

/**
 * POST /users — Admin creates a new account in their own barangay.
 * Surfaces the server's real validation/409 message as-is (bad
 * username shape, weak password, duplicate username) — see
 * UsersController::create's own doc for why there's no separate
 * idempotency token here.
 */
export async function createUser({ username, password, fullName, role, contactNumber }) {
  const json = await request('POST', '/users', {
    body: { username, password, full_name: fullName, role, contact_number: contactNumber || null },
    auth: true,
  });
  return {
    userId: json.user_id,
    username: json.username,
    fullName: json.full_name,
    role: json.role,
    contactNumber: json.contact_number,
    isActive: json.is_active,
  };
}

// --- Incidents (W3 Dispatch Center queue) -----------------------------------

/** @returns {Promise<{items:Array<object>, page:number, limit:number, total:number}>} */
/** `q` (2026-09-05 UX pass): real server-side search — see IncidentsController::index()'s own doc for why this isn't client-side. */
export async function getIncidents({ status, priority, q, page, limit } = {}) {
  const json = await request('GET', '/incidents', {
    query: { status, priority, q, page, limit },
    auth: true,
  });
  return {
    items: json.items.map((row) => ({
      incidentId: row.incident_id,
      barangayId: row.barangay_id,
      reportedBy: row.reported_by,
      incidentType: row.incident_type, // enum value, unconverted
      priority: row.priority,          // enum value, unconverted
      status: row.status,              // enum value, unconverted
      source: row.source,
      latitude: row.latitude,
      longitude: row.longitude,
      createdAt: row.created_at,
      deviceOfflineCreatedAt: row.device_offline_created_at,
      syncedAt: row.synced_at,
      locationDescription: row.location_description,
      displayId: row.display_id,
      officerName: row.officer_name,
    })),
    page: json.page,
    limit: json.limit,
    total: json.total,
  };
}

/**
 * POST /incidents (web path, W6 Electronic Blotter List's new-entry form).
 * `idempotencyKey` is the required UUID (Idempotency-Key header, not a
 * body field for web writes — see IncidentsController.php) — generate one
 * per user-initiated submit and reuse only on an automatic retry.
 *
 * `locationDescription`/`complainantName`/`respondentName`/
 * `complainantContactNumber` (2026-09-05 UX pass): optional, ported from
 * the same party-field widget `finalizeBlotter`/`amendBlotter` already
 * use — see IncidentsController::createWeb()'s own comment on why these
 * were never wired up here before despite the columns existing since
 * migration 0008.
 */
export async function createIncident({
  incidentType, rawNarrative, latitude, longitude,
  locationDescription, complainantName, respondentName, complainantContactNumber,
  idempotencyKey,
}) {
  const json = await request('POST', '/incidents', {
    body: {
      incident_type: incidentType,
      raw_narrative: rawNarrative,
      latitude,
      longitude,
      location_description: locationDescription || undefined,
      complainant_name: complainantName || undefined,
      respondent_name: respondentName || undefined,
      complainant_contact_number: complainantContactNumber || undefined,
    },
    idempotencyKey,
    auth: true,
  });
  return {
    incidentId: json.incident_id,
    barangayId: json.barangay_id,
    reportedBy: json.reported_by,
    incidentType: json.incident_type,
    priority: json.priority,
    status: json.status,
    source: json.source,
    latitude: json.latitude,
    longitude: json.longitude,
    locationDescription: json.location_description,
    displayId: json.display_id,
    createdAt: json.created_at,
  };
}

/**
 * PATCH /incidents/:id/status — Admin only, body is exactly
 * `{status:'resolved'}` (see IncidentsController::updateStatus()'s own
 * doc — this is not a general status-setter).
 */
export async function updateIncidentStatus(incidentId) {
  const json = await request('PATCH', `/incidents/${incidentId}/status`, {
    body: { status: 'resolved' },
    auth: true,
  });
  return { incidentId: json.incident_id, status: json.status };
}

// --- Dispatch (W3a/W3b) -----------------------------------------------------

/**
 * `incidentId` (Sprint 6 backend addition, not previously wired up here):
 * narrows to one incident's dispatch history — used by Incident
 * Management's detail pane to resolve the assigned Tanod for a Contact
 * button, same tenant-scoped list this endpoint already returns, just
 * filtered narrower.
 * @returns {Promise<{items:Array<object>, page:number, limit:number, total:number}>}
 */
export async function getDispatches({ status, incidentId, page, limit } = {}) {
  const json = await request('GET', '/dispatch', { query: { status, incident_id: incidentId, page, limit }, auth: true });
  return {
    items: json.items.map(mapDispatch),
    page: json.page,
    limit: json.limit,
    total: json.total,
  };
}

/**
 * POST /dispatch. `requestId` is the required idempotency key (§6) — the
 * caller generates one UUID per user-initiated create action and reuses
 * it only on an automatic retry of that same action, never on a new one.
 */
export async function createDispatch({ incidentId, tanodId, requestId }) {
  const json = await request('POST', '/dispatch', {
    body: { incident_id: incidentId, tanod_id: tanodId, request_id: requestId },
    auth: true,
  });
  return {
    dispatchId: json.dispatch_id,
    status: json.status,
    incidentId: json.incident_id,
    routeStatus: json.route_status,
  };
}

export async function cancelDispatch(dispatchId) {
  const json = await request('PATCH', `/dispatch/${dispatchId}/cancel`, { body: {}, auth: true });
  return {
    dispatchId: json.dispatch_id,
    status: json.status,
    incidentId: json.incident_id,
    incidentStatus: json.incident_status,
    cancelledAt: json.cancelled_at,
  };
}

function mapDispatch(row) {
  return {
    dispatchId: row.dispatch_id,
    incidentId: row.incident_id,
    tanodId: row.tanod_id,
    tanodName: row.tanod_name ?? null,
    priority: row.priority,
    routeJson: row.route_json,
    routeStatus: row.route_status,
    status: row.status,
    dispatchedAt: row.dispatched_at,
    enRouteAt: row.en_route_at,
    arrivedAt: row.arrived_at,
    completedAt: row.completed_at,
    cancelledAt: row.cancelled_at,
  };
}

// --- GPS (W4 GIS Live Tracking) ---------------------------------------------

/** @returns {Promise<Array<object>>} */
export async function getGpsLive(barangayId) {
  const json = await request('GET', '/gps/live', { query: { barangay_id: barangayId }, auth: true });
  return json.items.map((row) => ({
    userId: row.user_id,
    fullName: row.full_name,
    dispatchId: row.dispatch_id,
    latitude: row.latitude,
    longitude: row.longitude,
    accuracyM: row.accuracy_m,
    recordedAt: row.recorded_at,
    receivedAt: row.received_at,
    ageSeconds: row.age_seconds,
    isStale: row.is_stale,
  }));
}

export async function getGpsHistory({ userId, dateFrom, dateTo, page, limit }) {
  const json = await request('GET', '/gps/history', {
    query: { user_id: userId, date_from: dateFrom, date_to: dateTo, page, limit },
    auth: true,
  });
  return {
    items: json.items.map((row) => ({
      trackId: row.track_id,
      userId: row.user_id,
      dispatchId: row.dispatch_id,
      latitude: row.latitude,
      longitude: row.longitude,
      accuracyM: row.accuracy_m,
      recordedAt: row.recorded_at,
      receivedAt: row.received_at,
    })),
    page: json.page,
    limit: json.limit,
    total: json.total,
  };
}

// --- Tanod SOS --------------------------------------------------------------

/** @returns {Promise<Array<object>>} */
export async function getTanodSos({ status } = {}) {
  const json = await request('GET', '/tanod-sos', { query: { status }, auth: true });
  return json.items.map((row) => ({
    sosId: row.sos_id,
    userId: row.user_id,
    dispatchId: row.dispatch_id,
    latitude: row.latitude,
    longitude: row.longitude,
    triggeredAt: row.triggered_at,
    receivedAt: row.received_at,
    status: row.status, // enum value, unconverted
    acknowledgedAt: row.acknowledged_at,
    resolvedAt: row.resolved_at,
  }));
}

/**
 * GET /notifications — the caller's own notification targets, newest and
 * unacknowledged first, plus the total unread count for the bell badge.
 * Not in §6's list; see NotificationsController::index for why it exists.
 */
export async function getNotifications({ limit } = {}) {
  const json = await request('GET', '/notifications', { query: { limit }, auth: true });
  return {
    items: json.items.map((row) => ({
      notificationId: row.notification_id,
      notificationType: row.notification_type, // enum value, unconverted
      dispatchId: row.dispatch_id,
      sosId: row.sos_id,
      incidentId: row.incident_id,
      createdAt: row.created_at,
      targetedAt: row.targeted_at,
      ackStatus: row.ack_status, // enum value, unconverted
      acknowledgedAt: row.acknowledged_at,
    })),
    unreadCount: json.unread_count,
  };
}

/**
 * PATCH /tanod-sos/:id/acknowledge. Built in Sprint 4 but never reachable
 * from the UI until the audit's W3 pass — the Dispatch Center banner
 * reported an SOS and offered no way to act on it.
 * Acknowledging deliberately does NOT clear the banner (§9 W3): the alert
 * stays up until it is resolved.
 */
export async function acknowledgeTanodSos(sosId) {
  return request('PATCH', `/tanod-sos/${sosId}/acknowledge`, { auth: true });
}

// --- Duty status (read-only this sprint: Admin's Tanod-picker source) ------

/** @returns {Promise<Array<{userId:number, status:string, channel:string, changedAt:string}>>} */
export async function getDutyStatus(barangayId) {
  const json = await request('GET', '/duty-status', { query: { barangay_id: barangayId }, auth: true });
  return json.items.map((row) => ({
    userId: row.user_id,
    status: row.status, // enum value, unconverted
    channel: row.channel,
    changedAt: row.changed_at,
  }));
}

// --- Settings/Account (W15) --------------------------------------------------

/** PATCH /users/:id, self-only (full_name and/or contact_number). */
export async function updateProfile(userId, { fullName, contactNumber } = {}) {
  const body = {};
  if (fullName !== undefined) body.full_name = fullName;
  if (contactNumber !== undefined) body.contact_number = contactNumber;
  const json = await request('PATCH', `/users/${userId}`, { body, auth: true });
  // Keep the in-memory session's display name in sync — there's no
  // "GET /users/me" endpoint (§6 never documents one) to re-fetch from,
  // so the client applies its own known-good write locally instead.
  if (fullName !== undefined) {
    const session = readSession();
    if (session) writeSession({ ...session, user: { ...session.user, fullName } });
  }
  return { userId: json.user_id, updated: json.updated };
}

// --- Citizen reports (W16 inbox, W19 public form) ---------------------------

/** POST /citizen-reports — public, no session required. */
export async function submitCitizenReport({ barangayId, description, contactNumber, latitude, longitude }) {
  const json = await request('POST', '/citizen-reports', {
    body: {
      barangay_id: barangayId,
      description,
      contact_number: contactNumber,
      latitude,
      longitude,
    },
    auth: false,
  });
  return { reportId: json.report_id, confirmation: json.confirmation };
}

/** GET /citizen-reports (W16 inbox — list only, no convert action yet). */
export async function getCitizenReports({ status, page, limit } = {}) {
  const json = await request('GET', '/citizen-reports', { query: { status, page, limit }, auth: true });
  return {
    items: json.items.map((row) => ({
      reportId: row.report_id,
      description: row.description,
      contactNumber: row.contact_number,
      latitude: row.latitude,
      longitude: row.longitude,
      submittedAt: row.submitted_at,
      incidentId: row.incident_id,
    })),
    page: json.page,
    limit: json.limit,
    total: json.total,
  };
}

// --- Shifts / fatigue (W11 Scheduler, W12 Swap Requests, W13 Fatigue Flags) -

function mapShift(row) {
  return { shiftId: row.shift_id, userId: row.user_id, patrolZone: row.patrol_zone, startAt: row.start_at, endAt: row.end_at, version: row.version };
}

/** POST /shifts. `requestId` is the required idempotency key (§6). */
export async function createShift({ userId, patrolZone, startAt, endAt, requestId }) {
  const json = await request('POST', '/shifts', {
    body: { user_id: userId, patrol_zone: patrolZone, start_at: startAt, end_at: endAt, request_id: requestId },
    auth: true,
  });
  return mapShift(json);
}

/** @returns {Promise<{items:Array<object>, page:number, limit:number, total:number}>} */
export async function getShifts({ page, limit } = {}) {
  const json = await request('GET', '/shifts', { query: { page, limit }, auth: true });
  return { items: json.items.map(mapShift), page: json.page, limit: json.limit, total: json.total };
}

/**
 * PATCH /shifts/:id. `version` is the required optimistic-concurrency
 * token from the shift's last-known state (§6) — a stale version means
 * someone else changed it first; the caller should reload and retry.
 * `userId` may be `null` to explicitly unassign a shift.
 */
export async function updateShift(shiftId, { userId, patrolZone, startAt, endAt, version }) {
  const body = { version };
  if (userId !== undefined) body.user_id = userId;
  if (patrolZone !== undefined) body.patrol_zone = patrolZone;
  if (startAt !== undefined) body.start_at = startAt;
  if (endAt !== undefined) body.end_at = endAt;
  const json = await request('PATCH', `/shifts/${shiftId}`, { body, auth: true });
  return { shiftId: json.shift_id, updatedAt: json.updated_at, version: json.version };
}

/** @returns {Promise<{items:Array<object>, page:number, limit:number, total:number}>} */
export async function getShiftSwapRequests({ page, limit } = {}) {
  const json = await request('GET', '/shift-swap-requests', { query: { page, limit }, auth: true });
  return {
    items: json.items.map((row) => ({
      requestId: row.request_id,
      requestingUserId: row.requesting_user_id,
      shiftId: row.shift_id,
      targetUserId: row.target_user_id,
      reason: row.reason,
      status: row.status, // enum value, unconverted
      requestedAt: row.requested_at,
      resolvedAt: row.resolved_at,
      resolvedBy: row.resolved_by,
      version: row.version,
    })),
    page: json.page,
    limit: json.limit,
    total: json.total,
  };
}

/** PATCH /shift-swap-requests/:id. `status` is 'approved' or 'denied'. */
export async function resolveShiftSwapRequest(requestId, status, version) {
  const json = await request('PATCH', `/shift-swap-requests/${requestId}`, { body: { status, version }, auth: true });
  return {
    requestId: json.request_id,
    status: json.status,
    resolvedAt: json.resolved_at,
    resolvedBy: json.resolved_by,
    shiftId: json.shift_id,
    targetUserId: json.target_user_id,
  };
}

/** @returns {Promise<{items:Array<object>, page:number, limit:number, total:number}>} */
export async function getFatigueFlags({ page, limit } = {}) {
  const json = await request('GET', '/shifts/fatigue-flags', { query: { page, limit }, auth: true });
  return {
    items: json.items.map((row) => ({
      flagId: row.flag_id,
      userId: row.user_id,
      shiftId: row.shift_id,
      hoursWorked7Day: row.hours_worked_7day,
      calculationBasis: row.calculation_basis,
      flaggedAt: row.flagged_at,
      acknowledgedAt: row.acknowledged_at,
    })),
    page: json.page,
    limit: json.limit,
    total: json.total,
  };
}

export async function acknowledgeFatigueFlag(flagId) {
  const json = await request('PATCH', `/fatigue-flags/${flagId}/acknowledge`, { body: {}, auth: true });
  return { flagId: json.flag_id, acknowledgedBy: json.acknowledged_by, acknowledgedAt: json.acknowledged_at };
}

// --- Reference / lookup (added 2026-09-02: real backing for the topbar
// search box and W19's barangay picker, replacing hardcoded UI content) ---

/** GET /barangays — public, no session required. Always the four real seeded rows. */
export async function getBarangays() {
  const json = await request('GET', '/barangays', { auth: false });
  return json.items.map((row) => ({
    barangayId: row.barangay_id, name: row.name, municipality: row.municipality, province: row.province,
  }));
}

/** GET /search?q= — topbar global search. Incidents only (see class doc in SearchController.php for why). */
export async function search(q) {
  const json = await request('GET', '/search', { query: { q }, auth: true });
  return json.items.map((row) => ({
    incidentId: row.incident_id, incidentType: row.incident_type, status: row.status,
    priority: row.priority, createdAt: row.created_at,
  }));
}

/** GET /system/health — Admin only. Coarse status per dependency; see SystemHealthController.php. */
export async function getSystemHealth() {
  const json = await request('GET', '/system/health', { auth: true });
  return {
    api: json.api, db: json.db, osrm: json.osrm, ollama: json.ollama,
    gsmIngestion: json.gsm_ingestion, notificationConfig: json.notification_config,
    fcm: json.fcm, smsSemaphore: json.sms_semaphore,
    backupLastSuccess: json.backup_last_success, restoreTestAt: json.restore_test_at,
  };
}

/**
 * GET /audit-log — §6, §9 W17 (Admin only, own barangay, newest-first).
 * Defaults to the last 7 days server-side when no range is given, per
 * W17's documented default view. `metadataJson` arrives already parsed.
 */
export async function getAuditLog({ action, dateFrom, dateTo, page, limit } = {}) {
  const json = await request('GET', '/audit-log', {
    query: { action, date_from: dateFrom, date_to: dateTo, page, limit },
    auth: true,
  });
  return {
    items: json.items.map((row) => ({
      auditId: row.audit_id,
      actorUserId: row.actor_user_id,
      actorUsername: row.actor_username,
      action: row.action,           // free-form VARCHAR, not an enum — passed through
      entityType: row.entity_type,
      entityId: row.entity_id,
      metadataJson: row.metadata_json,
      createdAt: row.created_at,
    })),
    page: json.page,
    limit: json.limit,
    total: json.total,
  };
}

/**
 * GET /reports/export — §6/§9 W9's Export button. Generates the file
 * server-side and returns where to fetch it; the download is a separate
 * authorized request (the file lives outside the web root).
 */
export async function exportReport({ dateFrom, dateTo, format = 'csv' } = {}) {
  const json = await request('GET', '/reports/export', {
    query: { date_from: dateFrom, date_to: dateTo, format },
    auth: true,
  });
  return { fileUrl: json.file_url, format: json.format, generatedAt: json.generated_at };
}

/**
 * Absolute URL for the generated export. Not a capability — the download
 * endpoint re-checks role and tenant, and derives the file from the
 * caller's own barangay rather than from anything in the URL.
 */
export function reportExportDownloadUrl() {
  return `${BASE_URL}/reports/export/download`;
}

// --- SMS Monitor conversations/compose/broadcast (2026-09-05 UX pass) ------
// See SmsController.php's own class doc for the deliberate rescoping this
// represents. `GET /sms/logs` below is UNCHANGED (still no phone numbers);
// these are new, separate endpoints built specifically for the
// conversation view.

/** @returns {Promise<Array<object>>} */
export async function getSmsConversations() {
  const json = await request('GET', '/sms/conversations', { auth: true });
  return json.items.map((row) => ({
    phoneNumber: row.phone_number,
    displayName: row.display_name,
    unreadCount: row.unread_count,
    lastMessage: row.last_message ? {
      logId: row.last_message.log_id,
      direction: row.last_message.direction,
      messageType: row.last_message.message_type,
      messageBody: row.last_message.message_body,
      status: row.last_message.status,
      createdAt: row.last_message.created_at,
      sentAt: row.last_message.sent_at,
      receivedAt: row.last_message.received_at,
    } : null,
  }));
}

/** @returns {Promise<Array<object>>} */
export async function getSmsConversationMessages(phoneNumber) {
  const json = await request('GET', `/sms/conversations/${encodeURIComponent(phoneNumber)}/messages`, { auth: true });
  return json.items.map((row) => ({
    logId: row.log_id,
    direction: row.direction,
    messageType: row.message_type,
    messageBody: row.message_body,
    status: row.status,
    failureReason: row.failure_reason,
    incidentId: row.incident_id,
    dispatchId: row.dispatch_id,
    reportId: row.report_id,
    createdAt: row.created_at,
    sentAt: row.sent_at,
    receivedAt: row.received_at,
  }));
}

export async function markSmsThreadResolved(phoneNumber) {
  const json = await request('PATCH', `/sms/conversations/${encodeURIComponent(phoneNumber)}/resolve`, { body: {}, auth: true });
  return { phoneNumber: json.phone_number, resolvedCount: json.resolved_count };
}

/**
 * POST /sms/send — exactly one of `recipientUserId`/`phoneNumber`. See
 * SmsController::send()'s own doc for why a raw phone number is only
 * accepted when it matches a real in-tenant contact already on file.
 */
export async function sendSms({ recipientUserId, phoneNumber, message, incidentId, dispatchId, reportId, idempotencyKey }) {
  const json = await request('POST', '/sms/send', {
    body: {
      recipient_user_id: recipientUserId,
      phone_number: phoneNumber,
      message,
      incident_id: incidentId,
      dispatch_id: dispatchId,
      report_id: reportId,
    },
    idempotencyKey,
    auth: true,
  });
  return { logId: json.log_id, status: json.status, failureReason: json.failure_reason };
}

/**
 * POST /sms/broadcast — `scope` is `'on_duty_tanods'` or `'role'` (+
 * `role`). Always scoped to the caller's own barangay server-side — see
 * SmsController::broadcast()'s own doc for why "All Barangays" isn't an
 * option here.
 */
export async function broadcastSms({ message, scope, role, idempotencyKey }) {
  const json = await request('POST', '/sms/broadcast', {
    body: { message, scope, role },
    idempotencyKey,
    auth: true,
  });
  return { recipientCount: json.recipient_count, sent: json.sent, failed: json.failed };
}

/**
 * GET /sms/logs — §6, §9 W14 (Admin only, read-only). No sender_number/
 * receiver_number field exists in the response at all — see
 * SmsController.php's own doc for why that's not an oversight.
 */
export async function getSmsLogs({ messageType, direction, status, dateFrom, dateTo, page, limit } = {}) {
  const json = await request('GET', '/sms/logs', {
    query: { message_type: messageType, direction, status, date_from: dateFrom, date_to: dateTo, page, limit },
    auth: true,
  });
  return {
    items: json.items.map((row) => ({
      logId: row.log_id,
      reportId: row.report_id,
      incidentId: row.incident_id,
      dispatchId: row.dispatch_id,
      transport: row.transport,
      messageType: row.message_type,
      direction: row.direction,
      status: row.status,
      correlationId: row.correlation_id,
      gatewayMessageId: row.gateway_message_id,
      modemMessageId: row.modem_message_id,
      sentAt: row.sent_at,
      receivedAt: row.received_at,
      createdAt: row.created_at,
      failureReason: row.failure_reason,
    })),
    page: json.page,
    limit: json.limit,
    total: json.total,
  };
}

// --- AI redaction review (§6 "AI processing", W8) ---------------------------

/**
 * GET /incidents/:id — the only endpoint that returns `raw_narrative`, and
 * only to a Secretary (§6/§3: the Secretary is the statutory records
 * custodian under RA 7160 §394(c), which is why Admin gets less here).
 * `rawNarrative` is simply absent from the response for every other role,
 * so callers must treat it as optional rather than assuming a string.
 */
export async function getIncident(incidentId) {
  const json = await request('GET', `/incidents/${incidentId}`, { auth: true });
  return {
    incidentId: json.incident_id,
    barangayId: json.barangay_id,
    reportedBy: json.reported_by,
    incidentType: json.incident_type, // enum value, unconverted
    priority: json.priority,          // enum value, unconverted
    status: json.status,              // enum value, unconverted
    source: json.source,
    latitude: json.latitude,
    longitude: json.longitude,
    createdAt: json.created_at,
    syncedAt: json.synced_at,
    locationDescription: json.location_description,
    displayId: json.display_id,
    rawNarrative: json.raw_narrative ?? null,
    redactedNarrative: json.redacted_narrative,
    redactionApprovedAt: json.redaction_approved_at,
    redactionApprovedBy: json.redaction_approved_by,
    // Secretary-only, same as raw_narrative above (extracted directly
    // from raw text — see IncidentsController::show()'s own comment on
    // why these don't get redactedNarrative's broader visibility).
    // Absent in the JSON entirely for any other role, same as raw_narrative.
    complainantName: json.complainant_name ?? null,
    respondentName: json.respondent_name ?? null,
    complainantContactNumber: json.complainant_contact_number ?? null,
    // Dispatch stages for W7's §9-mandated timeline. They live here rather
    // than on GET /dispatch because that endpoint is Admin/PB/Tanod only
    // and W7 is a Secretary screen — see IncidentsController::show().
    dispatchedAt: json.dispatched_at ?? null,
    arrivedAt: json.arrived_at ?? null,
    hasActiveDispatch: json.has_active_dispatch === true,
  };
}

/** Shared shape for the ai_processing_log draft row (§6 GET /incidents/:id/ai-draft). */
function mapAiDraft(json) {
  return {
    logId: json.log_id,
    incidentId: json.incident_id,
    pipelineRunId: json.pipeline_run_id,
    taskType: json.task_type,          // enum value, unconverted
    modelVersion: json.model_version,  // the REAL self-hosted model name (§8)
    draftRedactedNarrative: json.draft_redacted_narrative,
    draftSummary: json.draft_summary,
    draftSummaryStale: json.draft_summary_stale,
    draftVersion: json.draft_version,
    status: json.status,               // enum value, unconverted
    errorCode: json.error_code ?? null,
  };
}

/**
 * GET /incidents/:id/ai-draft — Secretary only. Returns null when no
 * pipeline has ever been run for this incident (the server answers 404),
 * which is an ordinary empty state for W8, not an error.
 */
export async function getAiDraft(incidentId) {
  try {
    const json = await request('GET', `/incidents/${incidentId}/ai-draft`, { auth: true });
    return mapAiDraft(json);
  } catch (error) {
    if (error instanceof ApiClientError && error.status === 404) return null;
    throw error;
  }
}

/**
 * POST /incidents/:id/redact — queues a redaction run. Returns
 * `status:"queued"`; the draft appears once the worker processes it, so
 * callers poll getAiDraft() rather than expecting content back here.
 */
export async function requestRedaction(incidentId) {
  const json = await request('POST', `/incidents/${incidentId}/redact`, { auth: true });
  return { incidentId: json.incident_id, pipelineRunId: json.pipeline_run_id, status: json.status };
}

/**
 * POST /incidents/:id/ai-draft/regenerate-summary — saves the Secretary's
 * edited narrative and queues a summary regeneration. `draftVersion` must
 * be the exact current version (§2 Rule 23); a stale value gets 409 and
 * the caller must reload.
 */
export async function regenerateSummary(incidentId, { draftRedactedNarrative, draftVersion }) {
  const json = await request('POST', `/incidents/${incidentId}/ai-draft/regenerate-summary`, {
    body: { draft_redacted_narrative: draftRedactedNarrative, draft_version: draftVersion },
    auth: true,
  });
  return mapAiDraft(json);
}

/**
 * POST /incidents/:id/ai-draft/approve — the ONLY call that commits
 * `incident.redacted_narrative` (§2 Rule 3). Requires exact version match
 * AND exact text equality with the current draft; anything else is 409.
 */
export async function approveAiDraft(incidentId, { approvedNarrative, draftVersion }) {
  const json = await request('POST', `/incidents/${incidentId}/ai-draft/approve`, {
    body: { approved_narrative: approvedNarrative, draft_version: draftVersion },
    auth: true,
  });
  return {
    incidentId: json.incident_id,
    redactionApprovedAt: json.redaction_approved_at,
    approvedBy: json.approved_by,
  };
}

/**
 * POST /incidents/:id/ai-draft/translate — post-approval only.
 * `languageValidated` is false for Bikol until a real evaluation run says
 * otherwise (§2 Rule 16) — surface it, don't hide it.
 */
export async function translateAiDraft(incidentId, targetLanguage) {
  const json = await request('POST', `/incidents/${incidentId}/ai-draft/translate`, {
    body: { target_language: targetLanguage },
    auth: true,
  });
  return {
    logId: json.log_id,
    translatedText: json.translated_text,
    sourceLanguage: json.source_language,
    targetLanguage: json.target_language,
    status: json.status,
    languageValidated: json.language_validated,
  };
}

/**
 * GET /incidents/:id/ai-draft/extraction — Electronic Blotter follow-up.
 * Independent of the redaction draft above (own endpoint, own
 * draft_version) — returns null on 404, an ordinary empty state (no
 * extraction has run yet), same convention as getAiDraft().
 */
export async function getExtractionDraft(incidentId) {
  try {
    const json = await request('GET', `/incidents/${incidentId}/ai-draft/extraction`, { auth: true });
    return {
      logId: json.log_id,
      incidentId: json.incident_id,
      pipelineRunId: json.pipeline_run_id,
      draftComplainantName: json.draft_complainant_name,
      draftRespondentName: json.draft_respondent_name,
      draftComplainantContactNumber: json.draft_complainant_contact_number,
      draftVersion: json.draft_version,
      status: json.status,
      errorCode: json.error_code ?? null,
    };
  } catch (error) {
    if (error instanceof ApiClientError && error.status === 404) return null;
    throw error;
  }
}

/**
 * POST /incidents/:id/ai-draft/extraction/approve — commits the
 * Secretary's reviewed/edited complainant/respondent/contact-number onto
 * the incident (the approved home, mirrored into blotter_record at
 * finalize time). All three fields are optional — pass `null`/empty for
 * one the Secretary cleared or the AI never drafted.
 */
export async function approveExtraction(incidentId, { complainantName, respondentName, complainantContactNumber, draftVersion }) {
  const json = await request('POST', `/incidents/${incidentId}/ai-draft/extraction/approve`, {
    body: {
      complainant_name: complainantName || null,
      respondent_name: respondentName || null,
      complainant_contact_number: complainantContactNumber || null,
      draft_version: draftVersion,
    },
    auth: true,
  });
  return {
    incidentId: json.incident_id,
    complainantName: json.complainant_name,
    respondentName: json.respondent_name,
    complainantContactNumber: json.complainant_contact_number,
  };
}

// --- Blotter finalization / amendment (§6 "Blotter", W7) --------------------

/**
 * POST /incidents/:id/finalize — Secretary only; requires an approved
 * redaction. `complainantName`/`respondentName`/`complainantContactNumber`
 * are all optional (§ migration 0008) — omit or pass null/empty for a
 * field the incident has none of.
 */
export async function finalizeBlotter(incidentId, { narrativeSummary, complainantName, respondentName, complainantContactNumber } = {}) {
  const json = await request('POST', `/incidents/${incidentId}/finalize`, {
    body: {
      narrative_summary: narrativeSummary,
      complainant_name: complainantName || null,
      respondent_name: respondentName || null,
      complainant_contact_number: complainantContactNumber || null,
    },
    auth: true,
  });
  return {
    blotterId: json.blotter_id,
    finalizedAt: json.finalized_at,
    revisionNo: json.revision_no,
    caseStatus: json.case_status,
    displayId: json.display_id,
    complainantName: json.complainant_name,
    respondentName: json.respondent_name,
    complainantContactNumber: json.complainant_contact_number,
  };
}

/**
 * POST /incidents/:id/blotter/amend — Secretary only; requires a finalized
 * record. The superseded text is preserved server-side in
 * `blotter_revision`, never discarded (§6).
 *
 * `caseStatus` (migration 0009, 2026-09-05 UX pass): optional, FORWARD
 * ONLY (`under_investigation`/`settled`) — see
 * BlotterController::amend()'s own comment for why `active`/`resolved`
 * are never accepted here.
 */
export async function amendBlotter(incidentId, { narrativeSummary, reason, complainantName, respondentName, complainantContactNumber, caseStatus }) {
  const body = { narrative_summary: narrativeSummary, reason };
  // Unlike finalize, an OMITTED key here keeps the record's current
  // value server-side (BlotterController::parsePartyFields()) — only
  // include a party field in the request when the caller actually means
  // to touch it, `undefined` meaning "leave alone" and anything else
  // (including empty string, meaning "clear it") meaning "set this".
  if (complainantName !== undefined) body.complainant_name = complainantName || null;
  if (respondentName !== undefined) body.respondent_name = respondentName || null;
  if (complainantContactNumber !== undefined) body.complainant_contact_number = complainantContactNumber || null;
  if (caseStatus) body.case_status = caseStatus;

  const json = await request('POST', `/incidents/${incidentId}/blotter/amend`, { body, auth: true });
  return {
    blotterId: json.blotter_id,
    revisionNo: json.revision_no,
    amendedAt: json.amended_at,
    caseStatus: json.case_status,
    complainantName: json.complainant_name,
    respondentName: json.respondent_name,
    complainantContactNumber: json.complainant_contact_number,
  };
}

/**
 * GET /blotter — Phase 6 of the mockup-driven UI round 2: the finalized
 * blotter RECORDS list (W6), distinct from `getIncidents()` (every
 * incident, any status — W3/W5/Incident Management). See
 * BlotterController::index() for why this endpoint exists.
 *
 * `q` (2026-09-05 UX pass): real server-side search — see
 * BlotterController::index()'s own doc for why this isn't client-side.
 */
export async function getBlotterList({ q, page, limit } = {}) {
  const json = await request('GET', '/blotter', { query: { q, page, limit }, auth: true });
  return {
    items: json.items.map((row) => ({
      blotterId: row.blotter_id,
      incidentId: row.incident_id,
      incidentType: row.incident_type,
      latitude: row.latitude,
      longitude: row.longitude,
      locationDescription: row.location_description,
      officerName: row.officer_name,
      recordedBy: row.recorded_by,
      approvedBy: row.approved_by,
      finalizedAt: row.finalized_at,
      revisionNo: row.revision_no,
      amendedAt: row.amended_at,
      amendedBy: row.amended_by,
      caseStatus: row.case_status,
      displayId: row.display_id,
      complainantName: row.complainant_name,
      respondentName: row.respondent_name,
      complainantContactNumber: row.complainant_contact_number,
    })),
    page: json.page,
    limit: json.limit,
    total: json.total,
  };
}

/**
 * GET /incidents/:id/blotter — §6's tenant-scoped convenience lookup.
 * Returns null when the incident has no blotter record yet (404), which is
 * the normal state for most incidents, not an error.
 */
export async function getBlotterForIncident(incidentId) {
  try {
    const json = await request('GET', `/incidents/${incidentId}/blotter`, { auth: true });
    return {
      blotterId: json.blotter_id,
      incidentId: json.incident_id,
      narrativeSummary: json.narrative_summary,
      recordedBy: json.recorded_by,
      approvedBy: json.approved_by,
      finalizedAt: json.finalized_at,
      revisionNo: json.revision_no,
      amendedAt: json.amended_at,
      amendedBy: json.amended_by,
      caseStatus: json.case_status,
      displayId: json.display_id,
      complainantName: json.complainant_name,
      respondentName: json.respondent_name,
      complainantContactNumber: json.complainant_contact_number,
    };
  } catch (error) {
    if (error instanceof ApiClientError && error.status === 404) return null;
    throw error;
  }
}

/**
 * POST /incidents/:id/lupon-packet — Secretary only; requires BOTH an
 * approved redaction and a finalized blotter. Returns an API-relative
 * `fileUrl`; the packet itself lives outside the web root and is served
 * only through the authorized download route.
 */
export async function generateLuponPacket(incidentId) {
  const json = await request('POST', `/incidents/${incidentId}/lupon-packet`, { auth: true });
  return { fileUrl: json.file_url };
}

/**
 * Absolute URL for a generated packet, for a download link. The download
 * endpoint re-checks role and tenant, so this URL is not a capability —
 * it still requires a valid session.
 */
export function luponPacketDownloadUrl(incidentId) {
  return `${BASE_URL}/incidents/${incidentId}/lupon-packet/download`;
}

/**
 * GET /incidents/:id/evidence — Secretary/Admin same barangay; Tanod only
 * with a reporter/dispatch relationship. §6: this NEVER returns filesystem
 * paths, so there is no `filePath` here by design — evidence bytes are a
 * separate authorized download (Sprint 7), not a link.
 */
export async function getIncidentEvidence(incidentId) {
  const json = await request('GET', `/incidents/${incidentId}/evidence`, { auth: true });
  return json.items.map((row) => ({
    attachmentId: row.attachment_id,
    incidentId: row.incident_id,
    type: row.type,              // enum value, unconverted
    uploadedBy: row.uploaded_by,
    uploadedAt: row.uploaded_at,
    sha256: row.sha256,
    byteSize: row.byte_size,
    mimeType: row.mime_type,
    originalFilename: row.original_filename,
  }));
}

/**
 * PATCH /incidents/:id/status — Admin only, and the body is exactly
 * `{status:"resolved"}` (§6). Deliberately not a general status setter:
 * 409 unless the incident is `dispatched` with no active dispatch left.
 */
export async function resolveIncident(incidentId) {
  const json = await request('PATCH', `/incidents/${incidentId}/status`, {
    body: { status: 'resolved' },
    auth: true,
  });
  return { incidentId: json.incident_id, status: json.status };
}

// --- Map packages (W18) ------------------------------------------------------

/**
 * GET /map-packages/:barangayId. A 404 ("no published package yet") is a
 * normal, expected state for this screen — callers should treat it as
 * `null`, not as an error state.
 */
export async function getMapPackage(barangayId) {
  try {
    const json = await request('GET', `/map-packages/${barangayId}`, { auth: true });
    return {
      version: json.version,
      checksumSha256: json.checksum_sha256,
      downloadUrl: json.download_url,
      isPublished: json.is_published,
    };
  } catch (err) {
    if (err instanceof ApiClientError && err.status === 404) return null;
    throw err;
  }
}

/**
 * POST /map-packages — multipart upload, so this can't go through the
 * shared `request()` helper above (it always JSON-stringifies the body
 * and sets Content-Type: application/json). Reuses the same session/
 * sliding-token/error-shape conventions by hand instead. No
 * Idempotency-Key: the endpoint's own UNIQUE(barangay_id, version)
 * already gives a clean 409 on a retried upload.
 */
export async function uploadMapPackage(version, file) {
  const session = readSession();
  if (!session) {
    throw new ApiClientError(401, 'UNAUTHORIZED', 'Not signed in.');
  }

  const formData = new FormData();
  formData.append('version', version);
  formData.append('file', file);

  let response;
  try {
    response = await fetch(`${BASE_URL}/map-packages`, {
      method: 'POST',
      headers: { Accept: 'application/json', Authorization: `Bearer ${session.token}` },
      body: formData,
    });
  } catch {
    throw new ApiClientError(0, 'NETWORK_ERROR', 'Could not reach the Baranguard server. Check your connection and try again.');
  }

  const renewed = response.headers.get('X-Renewed-Token');
  if (renewed) {
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
    if (response.status === 401) clearSession();
    throw new ApiClientError(response.status, errBody.code || 'UNKNOWN_ERROR', errBody.message || 'Something went wrong.');
  }

  return {
    packageId: json.package_id,
    version: json.version,
    checksumSha256: json.checksum_sha256,
    isPublished: json.is_published,
  };
}

// --- System Settings (2026-09-05 UX pass, W21) ------------------------------
// See SettingsController.php's own class doc for exactly which keys exist
// and why this is deliberately a small set, not the full mockup. Keys are
// passed through as-is (dotted strings like 'general.system_name') rather
// than mapped to camelCase fields — there's no fixed shape to map to, the
// server is the single source of truth for which keys are valid.

/** @returns {Promise<Record<string,string>>} */
export async function getSystemSettings() {
  const json = await request('GET', '/system-settings', { auth: true });
  return json.settings;
}

/**
 * @param {Record<string,string>} settings only the keys being changed —
 *   a secret field holding its own masked placeholder back (unchanged)
 *   is safe to include, the server treats that as "leave alone" (see
 *   SettingsController::update()'s own doc).
 * @returns {Promise<Record<string,string>>}
 */
export async function updateSystemSettings(settings) {
  const json = await request('PATCH', '/system-settings', { body: { settings }, auth: true });
  return json.settings;
}
