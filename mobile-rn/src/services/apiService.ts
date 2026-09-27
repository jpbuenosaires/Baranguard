/**
 * THE single mobile API boundary (§4): every server call goes through this
 * file, and it alone converts snake_case <-> camelCase. Conversion is
 * hand-written per endpoint, never a recursive key walker — a blind
 * converter would rewrite enum VALUES used as keys (`physical_injury`).
 *
 * Ported from ../mobile/src/services/apiService.ts. The wire contract —
 * paths, bodies, headers, idempotency keys — is unchanged on purpose (zero
 * backend changes). Deliberate differences, all React Native runtime
 * concerns except the first:
 *   - C-01: `postSos`/`SyncSosItem` accept a missing location. The server
 *     has taken fix-less SOS since migration 0026; the old client refused.
 *   - No `new URL()` / `URLSearchParams` / `AbortSignal.timeout`: RN's
 *     polyfills have historically lacked `URL.pathname` and
 *     `URLSearchParams.set`, and a wrong signed path would make the server
 *     reject every H-09 signature.
 *   - Evidence upload takes a file URI (RN FormData), not a Blob.
 *   - Map package download moves to the file-transfer layer (Phase 5).
 *
 * Offline: a transport failure is `ApiError` code `NETWORK_ERROR`, distinct
 * from any server error code. Nothing here writes the local store.
 */
import { getDeviceId, signDeviceRequest } from './deviceIdentity';
import {
  clearSession,
  emitSessionExpired,
  loadSession,
  readTokenExpiry,
  saveSession,
  storeRenewedToken,
  type StoredSession,
} from './session';
import { prefs } from './storage';

/**
 * Build-time default: the Cloudflare-tunnelled API (C-03), so a release
 * build works off barangay WiFi with zero setup. Local dev overrides it in
 * a gitignored `.env.local`: `EXPO_PUBLIC_API_BASE_URL=http://<lan-ip>:8081/api/v1`.
 * A Tanod can still change it at runtime from Profile.
 */
const DEFAULT_API_BASE_URL: string = process.env.EXPO_PUBLIC_API_BASE_URL ?? 'https://api.baranguardph.win/api/v1';

const API_BASE_URL_OVERRIDE_KEY = 'baranguard.apiBaseUrlOverride';

let API_BASE_URL: string = DEFAULT_API_BASE_URL;

/**
 * Loaded once at module import. Every call reads `API_BASE_URL` fresh, so a
 * request that races this just uses the default for that one call.
 */
const overrideLoaded: Promise<void> = (async () => {
  try {
    const value = await prefs.get(API_BASE_URL_OVERRIDE_KEY);
    if (value) API_BASE_URL = value;
  } catch {
    // Keep the build-time default.
  }
})();

/** Resolves once any saved override has been applied (for callers that must not race it). */
export function apiBaseUrlReady(): Promise<void> {
  return overrideLoaded;
}

export function getApiBaseUrl(): string {
  return API_BASE_URL;
}

export function hasApiBaseUrlOverride(): boolean {
  return API_BASE_URL !== DEFAULT_API_BASE_URL;
}

/** Applies a new base URL immediately; `null` reverts to the build-time default. */
export async function setApiBaseUrlOverride(url: string | null): Promise<void> {
  if (url) {
    const trimmed = url.trim().replace(/\/+$/, '');
    await prefs.set(API_BASE_URL_OVERRIDE_KEY, trimmed);
    API_BASE_URL = trimmed;
  } else {
    await prefs.remove(API_BASE_URL_OVERRIDE_KEY);
    API_BASE_URL = DEFAULT_API_BASE_URL;
  }
}

export class ApiError extends Error {
  readonly status: number;
  readonly code: string;

  constructor(status: number, code: string, message: string) {
    super(message);
    this.name = 'ApiError';
    this.status = status;
    this.code = code;
  }

  /** True when the workstation could not be reached at all. */
  get isOffline(): boolean {
    return this.code === 'NETWORK_ERROR';
  }
}

/** `?a=1&b=2` from defined values only — no URLSearchParams (see file doc). */
function queryString(params: Record<string, string | number | undefined | null>): string {
  const parts = Object.entries(params)
    .filter(([, value]) => value !== undefined && value !== null && value !== '')
    .map(([key, value]) => `${encodeURIComponent(key)}=${encodeURIComponent(String(value))}`);
  return parts.length ? `?${parts.join('&')}` : '';
}

/**
 * Path part of the base URL (`/api/v1`), without `new URL()`. The server
 * signs against the FULL request path it saw, so signatures must include it.
 */
export function basePathOf(baseUrl: string): string {
  const match = /^[a-z][a-z0-9+.-]*:\/\/[^/?#]+([^?#]*)/i.exec(baseUrl);
  return (match ? match[1] : '').replace(/\/+$/, '');
}

/**
 * 15s bound: on a weak connection fetch can otherwise hang with nothing to
 * catch, which reads as a frozen app rather than "workstation unreachable".
 */
const REQUEST_TIMEOUT_MS = 15000;

async function fetchWithTimeout(url: string, init: RequestInit, timeoutMs: number | null): Promise<Response> {
  if (timeoutMs === null) return fetch(url, init);
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    return await fetch(url, { ...init, signal: controller.signal });
  } finally {
    clearTimeout(timer);
  }
}

interface RequestOptions {
  method?: 'GET' | 'POST' | 'PATCH' | 'DELETE';
  body?: unknown;
  auth?: boolean;
  headers?: Record<string, string>;
}

async function request<T>(path: string, options: RequestOptions = {}): Promise<T> {
  const { method = 'GET', body, auth = true, headers: extraHeaders = {} } = options;

  const headers: Record<string, string> = { ...extraHeaders };
  if (body !== undefined) headers['Content-Type'] = 'application/json';

  if (auth) {
    const session = await loadSession();
    if (!session) {
      emitSessionExpired();
      throw new ApiError(401, 'UNAUTHORIZED', 'You are signed out.');
    }
    headers['Authorization'] = `Bearer ${session.token}`;
  }

  let response: Response;
  try {
    response = await fetchWithTimeout(
      `${API_BASE_URL}${path}`,
      { method, headers, body: body === undefined ? undefined : JSON.stringify(body) },
      REQUEST_TIMEOUT_MS,
    );
  } catch {
    // §2 Rule 15: the workstation is a known single point of failure; degrade, don't crash.
    throw new ApiError(0, 'NETWORK_ERROR', 'Cannot reach the barangay workstation.');
  }

  return handleResponse<T>(response, auth, 'Something went wrong.');
}

async function handleResponse<T>(response: Response, auth: boolean, fallbackMessage: string): Promise<T> {
  const renewed = response.headers.get('X-Renewed-Token');
  if (renewed) await storeRenewedToken(renewed);

  const text = await response.text();
  const payload = text ? safeJsonParse(text) : null;

  if (!response.ok) {
    const error = (payload as { error?: { code?: string; message?: string } } | null)?.error;
    // A 401 on a call that SENT a token = the session died server-side
    // (expired, revoked, password changed). Login's own 401 means bad
    // credentials, hence the `auth` guard.
    if (auth && response.status === 401) {
      await clearSession();
      emitSessionExpired();
    }
    throw new ApiError(response.status, error?.code ?? 'SERVER_ERROR', error?.message ?? fallbackMessage);
  }

  return payload as T;
}

function safeJsonParse(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
}

/**
 * H-09 headers for a high-value mobile write. `routePath` is the route's
 * own path (`/gps`); the signed path gets the base URL's mount prefix
 * because the server signs `REQUEST_URI`. Signing failure degrades to
 * `X-Device-Id` alone — never blocks the request.
 */
export async function deviceAuthHeaders(method: string, routePath: string, deviceId: string): Promise<Record<string, string>> {
  const fullPath = basePathOf(API_BASE_URL) + routePath;
  const signed = await signDeviceRequest(method, fullPath, deviceId);
  const headers: Record<string, string> = { 'X-Device-Id': deviceId };
  if (signed) {
    headers['X-Device-Timestamp'] = signed.timestamp;
    headers['X-Device-Signature'] = signed.signature;
  }
  return headers;
}

// --- Auth ------------------------------------------------------------------

interface LoginResponse {
  token: string;
  expires_at?: string;
  user: { user_id: number; barangay_id: number; role: string; full_name: string };
}

/** POST /auth/login. `X-Device-Id` earns the Tanod a device session (24h sliding, 7-day cap). */
export async function login(username: string, password: string): Promise<StoredSession> {
  const json = await request<LoginResponse>('/auth/login', {
    method: 'POST',
    body: { username, password },
    auth: false,
    headers: { 'X-Device-Id': await getDeviceId() },
  });

  const session: StoredSession = {
    token: json.token,
    expiresAt: readTokenExpiry(json.token),
    userId: json.user.user_id,
    barangayId: json.user.barangay_id,
    role: json.user.role,
    fullName: json.user.full_name,
  };
  await saveSession(session);
  return session;
}

export async function logout(): Promise<void> {
  await request<{ success: boolean }>('/auth/logout', { method: 'POST' });
}

// --- Device lifecycle ------------------------------------------------------

export interface DeviceRegistration {
  deviceId: string;
  registered: boolean;
  /** Present ONLY on this device_id's first-ever registration (base64). */
  messageEncryptionKey?: string;
}

/** POST /devices/register (Tanod-only). `fcmToken` may be null; the server accepts that. */
export async function registerDevice(params: {
  deviceId: string;
  fcmToken: string | null;
  appVersion?: string;
  devicePublicKeyPem?: string | null;
}): Promise<DeviceRegistration> {
  const json = await request<{ device_id: string; registered: boolean; message_encryption_key?: string }>(
    '/devices/register',
    {
      method: 'POST',
      body: {
        device_id: params.deviceId,
        fcm_token: params.fcmToken,
        platform: 'android',
        app_version: params.appVersion,
        device_public_key_pem: params.devicePublicKeyPem ?? null,
      },
    },
  );
  return { deviceId: json.device_id, registered: json.registered, messageEncryptionKey: json.message_encryption_key };
}

export async function deactivateDevice(deviceId: string): Promise<void> {
  await request<{ success: boolean }>(`/devices/${encodeURIComponent(deviceId)}/deactivate`, { method: 'PATCH' });
}

// --- Map packages ------------------------------------------------------------

export interface MapPackageMetadata {
  version: string;
  checksumSha256: string;
  downloadUrl: string;
  isPublished: boolean;
}

/** GET /map-packages/:barangayId. Null when nothing is published (404) — never blocks login. */
export async function getMapPackage(barangayId: number): Promise<MapPackageMetadata | null> {
  try {
    const json = await request<{ version: string; checksum_sha256: string; download_url: string; is_published: boolean }>(
      `/map-packages/${barangayId}`,
    );
    return {
      version: json.version,
      checksumSha256: json.checksum_sha256,
      downloadUrl: json.download_url,
      isPublished: json.is_published,
    };
  } catch (error) {
    if (error instanceof ApiError && error.status === 404) return null;
    throw error;
  }
}

export function mapPackageDownloadUrl(barangayId: number): string {
  return `${API_BASE_URL}/map-packages/${barangayId}/download`;
}

// --- Duty status -------------------------------------------------------------

export type DutyStatus = 'on_duty' | 'responding' | 'off_duty';

export interface DutyStatusEntry {
  statusId: number;
  status: DutyStatus;
  channel: string;
  changedAt: string;
}

/** POST /duty-status. Reuse the same `clientEventId` when retrying the same toggle. */
export async function setDutyStatus(status: DutyStatus, clientEventId: string): Promise<DutyStatusEntry> {
  const json = await request<{ status_id: number; status: DutyStatus; channel: string; changed_at: string }>('/duty-status', {
    method: 'POST',
    body: { status, client_event_id: clientEventId },
  });
  return { statusId: json.status_id, status: json.status, channel: json.channel, changedAt: json.changed_at };
}

/** GET /duty-status?user_id=me&limit=1 — the true current status, not a local guess. */
export async function getOwnDutyStatus(): Promise<DutyStatusEntry | null> {
  const json = await request<{ items: { status_id: number; status: DutyStatus; channel: string; changed_at: string }[] }>(
    '/duty-status?user_id=me&limit=1',
  );
  const latest = json.items[0];
  if (!latest) return null;
  return { statusId: latest.status_id, status: latest.status, channel: latest.channel, changedAt: latest.changed_at };
}

// --- SOS (§2 Rule 27) --------------------------------------------------------

export interface SosResult {
  sosId: number;
  status: string;
  receivedAt: string;
}

export interface SosLocation {
  latitude: number;
  longitude: number;
}

/**
 * POST /tanod-sos. `clientEventId` is the idempotency key — a retry returns
 * the original row instead of raising a second alarm.
 *
 * C-01: `location` is optional. Without it the server falls back to the
 * Tanod's last `gps_track` fix (`last_known`) or records `no_fix` — an SOS
 * is never blocked on GPS. Coordinates travel as a pair or not at all
 * (sending only one is a server 400).
 *
 * Device signature headers are best-effort audit only; the server never
 * rejects an SOS over them.
 */
export async function postSos(params: {
  location: SosLocation | null;
  clientEventId: string;
  dispatchId?: number | null;
  fallbackChannel?: 'app' | 'sms';
}): Promise<SosResult> {
  const deviceId = await getDeviceId();
  const headers = await deviceAuthHeaders('POST', '/tanod-sos', deviceId);
  const json = await request<{ sos_id: number; status: string; received_at: string }>('/tanod-sos', {
    method: 'POST',
    headers,
    body: {
      ...(params.location ? { latitude: params.location.latitude, longitude: params.location.longitude } : {}),
      client_event_id: params.clientEventId,
      dispatch_id: params.dispatchId ?? undefined,
      fallback_channel: params.fallbackChannel ?? undefined,
    },
  });
  return { sosId: json.sos_id, status: json.status, receivedAt: json.received_at };
}

/** GET /tanod-sos/fallback-contact. Null when no backup contact is configured. */
export async function getSosFallbackContact(): Promise<string | null> {
  const json = await request<{ backup_contact_number: string | null }>('/tanod-sos/fallback-contact');
  return json.backup_contact_number;
}

// --- Dispatch ----------------------------------------------------------------

export type DispatchStatus = 'assigned' | 'en_route' | 'arrived' | 'completed' | 'cancelled';
export type RouteStatus = 'available' | 'unavailable' | 'stale';
export type RouteMode = 'car' | 'foot';

export interface RouteStep {
  instruction: string;
  /** ORS's `type` isn't a text enum (see OrsClient.php); carries the road name when known. */
  maneuver: string;
  distanceM: number;
  durationS: number;
}

export interface RouteData {
  mode: RouteMode;
  /** Already-decoded GeoJSON LineString. */
  geometry: { type: string; coordinates: [number, number][] };
  distanceM: number;
  durationS: number;
  steps: RouteStep[];
}

type RawRouteJson = {
  mode: RouteMode;
  geometry: { type: string; coordinates: [number, number][] };
  distance_m: number;
  duration_s: number;
  steps: { instruction: string; maneuver: string; distance_m: number; duration_s: number }[];
} | null;

/** One camelCase shape for `route_json`, whichever endpoint delivered it. */
export function mapRouteJson(raw: unknown): RouteData | null {
  const json = raw as RawRouteJson;
  if (!json) return null;
  return {
    mode: json.mode,
    geometry: json.geometry,
    distanceM: json.distance_m,
    durationS: json.duration_s,
    steps: (json.steps ?? []).map((s) => ({
      instruction: s.instruction,
      maneuver: s.maneuver,
      distanceM: s.distance_m,
      durationS: s.duration_s,
    })),
  };
}

export interface DispatchEntry {
  dispatchId: number;
  incidentId: number;
  tanodId: number;
  priority: string;
  routeJson: RouteData | null;
  routeStatus: RouteStatus;
  status: DispatchStatus;
  incidentType: string | null;
  latitude: number | null;
  longitude: number | null;
  dispatchedAt: string;
  enRouteAt: string | null;
  arrivedAt: string | null;
  completedAt: string | null;
  cancelledAt: string | null;
}

interface RawDispatch {
  dispatch_id: number;
  incident_id: number;
  tanod_id: number;
  priority: string;
  route_json: unknown | null;
  route_status: RouteStatus;
  status: DispatchStatus;
  incident_type?: string | null;
  latitude?: number | null;
  longitude?: number | null;
  dispatched_at: string;
  en_route_at: string | null;
  arrived_at: string | null;
  completed_at: string | null;
  cancelled_at: string | null;
}

function mapDispatch(json: RawDispatch): DispatchEntry {
  return {
    dispatchId: json.dispatch_id,
    incidentId: json.incident_id,
    tanodId: json.tanod_id,
    priority: json.priority,
    routeJson: mapRouteJson(json.route_json),
    routeStatus: json.route_status,
    status: json.status,
    incidentType: json.incident_type ?? null,
    latitude: json.latitude ?? null,
    longitude: json.longitude ?? null,
    dispatchedAt: json.dispatched_at,
    enRouteAt: json.en_route_at,
    arrivedAt: json.arrived_at,
    completedAt: json.completed_at,
    cancelledAt: json.cancelled_at,
  };
}

/** GET /dispatch — a Tanod is forced server-side to their own dispatches. */
export async function getDispatches(params: { status?: DispatchStatus } = {}): Promise<DispatchEntry[]> {
  const json = await request<{ items: RawDispatch[] }>(`/dispatch${queryString({ status: params.status })}`);
  return json.items.map(mapDispatch);
}

/** PATCH /dispatch/:id/status — forward-only (assigned→en_route→arrived→completed). */
export async function updateDispatchStatus(
  dispatchId: number,
  status: 'en_route' | 'arrived' | 'completed',
): Promise<{ dispatchId: number; status: DispatchStatus; updatedAt: string }> {
  const path = `/dispatch/${dispatchId}/status`;
  const deviceId = await getDeviceId();
  const headers = await deviceAuthHeaders('PATCH', path, deviceId);
  const json = await request<{ dispatch_id: number; status: DispatchStatus; updated_at: string }>(path, {
    method: 'PATCH',
    headers,
    body: { status },
  });
  return { dispatchId: json.dispatch_id, status: json.status, updatedAt: json.updated_at };
}

/**
 * GET /dispatch/:id/route — road-snapped route from the caller's position.
 * Explicit-tap only (ORS's free tier is request-limited). `unavailable` /
 * `stale` are normal results, not errors.
 */
export async function getDispatchRoute(
  dispatchId: number,
  position: { latitude: number; longitude: number },
  mode: RouteMode = 'car',
): Promise<{ dispatchId: number; routeStatus: RouteStatus; routeJson: RouteData | null }> {
  const query = queryString({ latitude: position.latitude, longitude: position.longitude, mode });
  const json = await request<{ dispatch_id: number; route_status: RouteStatus; route_json: unknown | null }>(
    `/dispatch/${dispatchId}/route${query}`,
  );
  return { dispatchId: json.dispatch_id, routeStatus: json.route_status, routeJson: mapRouteJson(json.route_json) };
}

// --- GPS -----------------------------------------------------------------------

/**
 * POST /gps. `recordedAt` is the device capture time; the server's own
 * `received_at` stays authoritative. Callers generate ONE `clientEventId`
 * per fix and reuse it for any local-queue fallback (Rule 3 — the old app
 * minted a second id there).
 */
export async function postGps(point: {
  latitude: number;
  longitude: number;
  accuracyM: number;
  recordedAt: string;
  dispatchId?: number | null;
  clientEventId: string;
}): Promise<{ trackId: number; receivedAt: string }> {
  const deviceId = await getDeviceId();
  const headers = await deviceAuthHeaders('POST', '/gps', deviceId);
  const json = await request<{ track_id: number; received_at: string }>('/gps', {
    method: 'POST',
    headers,
    body: {
      latitude: point.latitude,
      longitude: point.longitude,
      accuracy_m: point.accuracyM,
      recorded_at: point.recordedAt,
      dispatch_id: point.dispatchId ?? undefined,
      client_event_id: point.clientEventId,
    },
  });
  return { trackId: json.track_id, receivedAt: json.received_at };
}

export interface NearbyIncident {
  incidentId: number;
  incidentType: string;
  priority: string;
  status: string;
  latitude: number;
  longitude: number;
  ageSeconds: number;
}

/** GET /incidents/nearby — Tanod only; never raw narrative/contact data. */
export async function getNearbyIncidents(params: { latitude: number; longitude: number; radiusM?: number }): Promise<NearbyIncident[]> {
  const query = queryString({ latitude: params.latitude, longitude: params.longitude, radius_m: params.radiusM });
  const json = await request<{
    items: { incident_id: number; incident_type: string; priority: string; status: string; latitude: number; longitude: number; age_seconds: number }[];
  }>(`/incidents/nearby${query}`);
  return json.items.map((row) => ({
    incidentId: row.incident_id,
    incidentType: row.incident_type,
    priority: row.priority,
    status: row.status,
    latitude: row.latitude,
    longitude: row.longitude,
    ageSeconds: row.age_seconds,
  }));
}

export interface NearbyTanod {
  userId: number;
  fullName: string;
  dispatchId: number | null;
  latitude: number;
  longitude: number;
  accuracyM: number;
  recordedAt: string;
  ageSeconds: number;
  isStale: boolean;
}

/** GET /gps/live — same-barangay peers; the caller's own row is filtered out. */
export async function getNearbyTanods(): Promise<NearbyTanod[]> {
  const session = await loadSession();
  if (!session) return [];
  const json = await request<{
    items: {
      user_id: number;
      full_name: string;
      dispatch_id: number | null;
      latitude: number;
      longitude: number;
      accuracy_m: number;
      recorded_at: string;
      age_seconds: number;
      is_stale: boolean;
    }[];
  }>(`/gps/live${queryString({ barangay_id: session.barangayId })}`);
  return json.items
    .filter((row) => row.user_id !== session.userId)
    .map((row) => ({
      userId: row.user_id,
      fullName: row.full_name,
      dispatchId: row.dispatch_id,
      latitude: row.latitude,
      longitude: row.longitude,
      accuracyM: row.accuracy_m,
      recordedAt: row.recorded_at,
      ageSeconds: row.age_seconds,
      isStale: row.is_stale,
    }));
}

// --- Evidence upload -----------------------------------------------------------

export interface EvidenceUploadItem {
  type: 'photo' | 'voice';
  sha256: string;
  mimeType: string;
  originalFilename?: string;
  /** The evidence row's local_id doubles as the server's idempotency key. */
  clientRequestId: string;
}

export interface UploadedEvidence {
  attachmentId: number;
  incidentId: number;
  type: string;
  uploadedBy: number;
  uploadedAt: string;
  sha256: string;
  byteSize: number;
  mimeType: string;
  originalFilename: string;
}

/**
 * POST /incidents/:id/evidence (multipart). React Native's FormData takes a
 * `{uri, name, type}` file part and streams it from disk. No timeout: a
 * large voice note on a weak link legitimately takes long. The server
 * recomputes sha256 over the received bytes and rejects a mismatch.
 */
export async function uploadEvidence(
  incidentServerId: number,
  deviceId: string,
  fileUri: string,
  item: EvidenceUploadItem,
): Promise<UploadedEvidence> {
  const session = await loadSession();
  if (!session) throw new ApiError(401, 'UNAUTHORIZED', 'You are signed out.');

  const form = new FormData();
  form.append('file', { uri: fileUri, name: item.originalFilename || 'evidence', type: item.mimeType } as unknown as Blob);
  form.append('type', item.type);
  form.append('sha256', item.sha256);
  form.append('mime_type', item.mimeType);
  form.append('client_request_id', item.clientRequestId);
  if (item.originalFilename) form.append('original_filename', item.originalFilename);

  const path = `/incidents/${incidentServerId}/evidence`;
  const deviceHeaders = await deviceAuthHeaders('POST', path, deviceId);

  let response: Response;
  try {
    response = await fetchWithTimeout(
      `${API_BASE_URL}${path}`,
      { method: 'POST', headers: { Authorization: `Bearer ${session.token}`, ...deviceHeaders }, body: form },
      null,
    );
  } catch {
    throw new ApiError(0, 'NETWORK_ERROR', 'Cannot reach the barangay workstation.');
  }

  const json = await handleResponse<{
    attachment_id: number;
    incident_id: number;
    type: string;
    uploaded_by: number;
    uploaded_at: string;
    sha256: string;
    byte_size: number;
    mime_type: string;
    original_filename: string;
  }>(response, true, 'Evidence upload failed.');
  return {
    attachmentId: json.attachment_id,
    incidentId: json.incident_id,
    type: json.type,
    uploadedBy: json.uploaded_by,
    uploadedAt: json.uploaded_at,
    sha256: json.sha256,
    byteSize: json.byte_size,
    mimeType: json.mime_type,
    originalFilename: json.original_filename,
  };
}

// --- Sync ------------------------------------------------------------------------

export interface SyncIncidentItem {
  incident_type: string;
  raw_narrative: string;
  latitude: number | null;
  longitude: number | null;
  device_offline_created_at?: string | null;
  client_event_id: string;
}

export interface SyncGpsItem {
  latitude: number;
  longitude: number;
  accuracy_m: number;
  recorded_at: string;
  dispatch_id?: number | null;
  client_event_id: string;
}

export interface SyncDutyStatusItem {
  status: DutyStatus;
  client_event_id: string;
}

export interface SyncDispatchStatusItem {
  dispatch_id: number;
  status: 'en_route' | 'arrived' | 'completed';
  client_event_id: string;
}

/** Same body as POST /tanod-sos; coordinates optional as a pair (C-01). */
export interface SyncSosItem {
  latitude?: number;
  longitude?: number;
  dispatch_id?: number | null;
  fallback_channel?: 'app' | 'sms';
  client_event_id: string;
}

export interface SyncBatchResult {
  clientEventId: string;
  serverId: number | null;
  status: 'success' | 'duplicate' | 'failed';
  reason?: string;
}

/** POST /sync/batch. One device signature covers the whole batch. */
export async function syncBatch(params: {
  deviceId: string;
  incidents?: SyncIncidentItem[];
  gpsTracks?: SyncGpsItem[];
  dutyStatusUpdates?: SyncDutyStatusItem[];
  dispatchStatusUpdates?: SyncDispatchStatusItem[];
  sosItems?: SyncSosItem[];
}): Promise<SyncBatchResult[]> {
  const headers = await deviceAuthHeaders('POST', '/sync/batch', params.deviceId);
  const json = await request<{ results: { client_event_id: string; server_id: number | null; status: string; reason?: string }[] }>(
    '/sync/batch',
    {
      method: 'POST',
      headers,
      body: {
        device_id: params.deviceId,
        incidents: params.incidents ?? [],
        gps_tracks: params.gpsTracks ?? [],
        duty_status_updates: params.dutyStatusUpdates ?? [],
        dispatch_status_updates: params.dispatchStatusUpdates ?? [],
        sos: params.sosItems ?? [],
      },
    },
  );
  return json.results.map((r) => ({
    clientEventId: r.client_event_id,
    serverId: r.server_id,
    status: r.status as SyncBatchResult['status'],
    reason: r.reason,
  }));
}

// --- Shifts & swap requests --------------------------------------------------

export interface ShiftEntry {
  shiftId: number;
  patrolZone: string | null;
  startAt: string;
  endAt: string;
  version: number;
}

/** GET /shifts — a tanod is forced server-side to their own rows. */
export async function getMyShifts(): Promise<ShiftEntry[]> {
  const json = await request<{
    items: { shift_id: number; user_id: number | null; patrol_zone: string | null; start_at: string; end_at: string; version: number }[];
  }>('/shifts?limit=100');
  return json.items.map((row) => ({
    shiftId: row.shift_id,
    patrolZone: row.patrol_zone,
    startAt: row.start_at,
    endAt: row.end_at,
    version: row.version,
  }));
}

export type ShiftSwapStatus = 'pending' | 'approved' | 'denied';

export interface ShiftSwapRequestEntry {
  requestId: number;
  requestingUserId: number;
  shiftId: number;
  targetUserId: number | null;
  reason: string | null;
  status: ShiftSwapStatus;
  requestedAt: string;
  resolvedAt: string | null;
}

interface RawSwapRequest {
  request_id: number;
  requesting_user_id: number;
  shift_id: number;
  target_user_id: number | null;
  reason: string | null;
  status: ShiftSwapStatus;
  requested_at: string;
  resolved_at: string | null;
}

function mapSwapRequest(json: RawSwapRequest): ShiftSwapRequestEntry {
  return {
    requestId: json.request_id,
    requestingUserId: json.requesting_user_id,
    shiftId: json.shift_id,
    targetUserId: json.target_user_id,
    reason: json.reason,
    status: json.status,
    requestedAt: json.requested_at,
    resolvedAt: json.resolved_at,
  };
}

export async function getMyShiftSwapRequests(): Promise<ShiftSwapRequestEntry[]> {
  const json = await request<{ items: RawSwapRequest[] }>('/shift-swap-requests?limit=100');
  return json.items.map(mapSwapRequest);
}

/**
 * POST /shift-swap-requests — un-targeted on purpose: choosing a substitute
 * needs GET /users, which is Admin-only, so the desk assigns one on review.
 */
export async function requestShiftSwap(shiftId: number, reason: string | undefined, clientRequestId: string): Promise<ShiftSwapRequestEntry> {
  const json = await request<RawSwapRequest>('/shift-swap-requests', {
    method: 'POST',
    body: { shift_id: shiftId, reason: reason || undefined, client_request_id: clientRequestId },
  });
  return mapSwapRequest(json);
}

// --- Notifications -------------------------------------------------------------

/** POST /notifications/:id/ack — idempotent, safe to retry. */
export async function acknowledgeNotification(notificationId: number): Promise<{ acknowledgedAt: string }> {
  const json = await request<{ success: boolean; notification_id: number; acknowledged_at: string }>(
    `/notifications/${notificationId}/ack`,
    { method: 'POST', body: {} },
  );
  return { acknowledgedAt: json.acknowledged_at };
}

/**
 * Reachability probe via GET /barangays — the one public, no-auth, cheap
 * route, so an expired session isn't misread as "workstation unreachable".
 */
export async function checkHealth(): Promise<boolean> {
  try {
    const res = await fetchWithTimeout(`${API_BASE_URL}/barangays`, { method: 'GET' }, 3000);
    return res.ok;
  } catch {
    return false;
  }
}
