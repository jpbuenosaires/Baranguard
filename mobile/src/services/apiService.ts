/**
 * apiService.ts — THE single mobile API boundary.
 *
 * §4's boundary rule is explicit: "exactly ONE central API client file
 * per platform (`apiClient.js` web, `apiService.ts` mobile) does
 * snake_case → camelCase conversion. Never convert ad-hoc inside a
 * component." Every server call in this app goes through this file.
 *
 * Conversion is hand-written per endpoint, not a recursive key walker —
 * the same resolved decision the web client already made and documented:
 * a blind converter would rewrite enum-valued keys (`physical_injury` →
 * `physicalInjury`), corrupting data identity rather than merely
 * reformatting a field name. Structural keys convert; enum VALUES are
 * passed through untouched.
 *
 * Sliding renewal (§2 Rule 9): every authenticated response is checked
 * for `X-Renewed-Token`, and the newer token is persisted through
 * session.ts, which itself refuses to move the expiry backwards.
 *
 * Offline behaviour: a network failure surfaces as an ApiError with
 * `code: 'NETWORK_ERROR'`, distinct from any server-sent error code, so
 * callers can tell "the workstation is unreachable" (expected, and
 * routine under §2 Rule 7/15) apart from "the server rejected this".
 * Nothing here writes to the local store — offline durability is the
 * local-database layer's job, and §2 Rule 9 requires capture to keep
 * working regardless of session/API state.
 */

import { Preferences } from '@capacitor/preferences';
import type { AvailabilityStatus, AvailabilityWindow, ReferralTarget } from './db/localSchema';
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

/**
 * The API base URL every install talks to. Not configurable on-device —
 * removed by explicit decision 2026-09-27 (the "Workstation address" UI
 * on Login and Profile, and the `setApiBaseUrlOverride()` Preferences
 * override, both used to let a Tanod point the app at a different
 * address). Now that C-03's Cloudflare Named Tunnel gives the workstation
 * a real, stable, Cloudflare-DNS-backed hostname, there is no longer a
 * legitimate reason for a per-device address to differ — a DHCP-
 * reassigned LAN IP was the whole reason the override existed, and that
 * class of problem doesn't apply to a fixed public hostname.
 *
 * Local development still needs the workstation directly: create
 * `mobile/.env.local` (gitignored, never committed, never shipped) with
 * `VITE_API_BASE_URL=http://localhost:8081/api/v1` to override this
 * default for your own dev builds only — see that file's own comment.
 * This is the only remaining override mechanism, and it is build-time
 * only (never reachable from the running app).
 */
const API_BASE_URL: string =
  (import.meta.env?.VITE_API_BASE_URL as string | undefined) ?? 'https://api.baranguardph.win/api/v1';

/**
 * Mirrors `API_BASE_URL` into Preferences so `PatrolLocationService.java`
 * (Mobile Improvement Plan Phase 4.1) can read it from the same
 * "CapacitorStorage" SharedPreferences file to know where to POST
 * background GPS points — a Vite build-time constant baked into the JS
 * bundle is invisible to native code. Fired once at module load; the
 * value itself is now fixed for the life of the install (see
 * `API_BASE_URL`'s own doc), so this only needs to run once, not on
 * every launch, but doing so is cheap and keeps this file the single
 * source of truth for what native code reads.
 */
const EFFECTIVE_API_BASE_URL_KEY = 'baranguard.effectiveApiBaseUrl';
(async () => {
  try {
    await Preferences.set({ key: EFFECTIVE_API_BASE_URL_KEY, value: API_BASE_URL });
  } catch {
    // Best-effort — worst case, the native service falls back to its own hardcoded default.
  }
})();

/** The URL every request in this file uses. */
export function getApiBaseUrl(): string {
  return API_BASE_URL;
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

interface RequestOptions {
  method?: 'GET' | 'POST' | 'PATCH' | 'DELETE';
  body?: unknown;
  auth?: boolean;
  /** Extra request headers (e.g. `X-Device-Id` on login). */
  headers?: Record<string, string>;
  /** Overrides `REQUEST_TIMEOUT_MS` for a call that must fail over fast (SOS). */
  timeoutMs?: number;
}

/**
 * No previous version of this function ever bounded how long a request
 * could take — on a genuinely bad connection (weak WiFi, far from the
 * router) `fetch()` can sit unresolved for a very long time with nothing
 * for the caller to catch, which reads to a Tanod as the app simply being
 * stuck rather than "the workstation is slow to reach right now." 15s is
 * generous for a real LAN hop (or a remote tunnel, when one is in use)
 * but short enough that a bad
 * connection fails honestly instead of hanging the caller indefinitely —
 * same spirit as deviceIdentity.ts's 8s FCM-registration bound.
 */
const REQUEST_TIMEOUT_MS = 15000;

/**
 * SOS is the one call where waiting is itself the failure: on a dead link a
 * 15s hang delays the SMS fallback tier by the same 15s. 5s is still enough
 * for a healthy hop, and a false "timeout" is safe — the SOS is queued with
 * the same `client_event_id`, so a late-arriving original dedupes (Rule 3).
 */
const SOS_TIMEOUT_MS = 5000;

async function request<T>(path: string, options: RequestOptions = {}): Promise<T> {
  const { method = 'GET', body, auth = true, headers: extraHeaders = {}, timeoutMs = REQUEST_TIMEOUT_MS } = options;

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
    response = await fetch(`${API_BASE_URL}${path}`, {
      method,
      headers,
      body: body === undefined ? undefined : JSON.stringify(body),
      signal: AbortSignal.timeout(timeoutMs),
    });
  } catch {
    // §2 Rule 15: the workstation is a known single point of failure and
    // the app must degrade, not crash, when it is unavailable. Covers both
    // an outright connection failure and this now timing out.
    throw new ApiError(0, 'NETWORK_ERROR', 'Cannot reach the barangay workstation.');
  }

  const renewed = response.headers.get('X-Renewed-Token');
  if (renewed) {
    await storeRenewedToken(renewed);
  }

  // 204 and empty bodies are valid responses; don't try to parse them.
  const text = await response.text();
  const payload = text ? safeJsonParse(text) : null;

  if (!response.ok) {
    const error = (payload as { error?: { code?: string; message?: string } } | null)?.error;

    // A 401 on a call that DID send a token means the server no longer
    // honors it (expired, revoked by logout-elsewhere, or a password
    // change) — this is a session dying, not "workstation unreachable."
    // `auth === false` calls (namely /auth/login itself) are excluded:
    // their 401 means wrong credentials, not an expired session.
    if (auth && response.status === 401) {
      await clearSession();
      emitSessionExpired();
    }

    throw new ApiError(
      response.status,
      error?.code ?? 'SERVER_ERROR',
      error?.message ?? 'Something went wrong.'
    );
  }

  return payload as T;
}

/**
 * H-09: builds the X-Device-Id/-Timestamp/-Signature headers for a
 * high-value mobile write (GPS/SOS/dispatch-status/evidence/sync-batch).
 *
 * `routePath` is the route's OWN path (e.g. `/gps`), with no `/api/v1`
 * mount prefix — but the server signs against `$_SERVER['REQUEST_URI']`
 * (`DeviceSignature::verifyOrReject()`), which is the FULL request path
 * the webserver actually saw, prefix included. Deriving that prefix from
 * `API_BASE_URL`'s own pathname (rather than hardcoding `/api/v1`) keeps
 * this correct if a local dev build's `.env.local` ever mounts the API
 * under a different path than the production `/api/v1`.
 *
 * Signing failure (or a pre-upgrade device with no Keystore key) yields a
 * device-id-only header set, same as before H-09 — see
 * `signDeviceRequest()`'s own doc for why this never blocks the request.
 */
async function deviceAuthHeaders(method: string, routePath: string, deviceId: string): Promise<Record<string, string>> {
  let fullPath = routePath;
  try {
    fullPath = new URL(API_BASE_URL).pathname.replace(/\/+$/, '') + routePath;
  } catch {
    // A malformed VITE_API_BASE_URL from a local .env.local — fall back to
    // the bare route path rather than throwing on a mobile write.
  }
  const signed = await signDeviceRequest(method, fullPath, deviceId);
  const headers: Record<string, string> = { 'X-Device-Id': deviceId };
  if (signed) {
    headers['X-Device-Timestamp'] = signed.timestamp;
    headers['X-Device-Signature'] = signed.signature;
  }
  return headers;
}

function safeJsonParse(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
}

// --- Auth ------------------------------------------------------------------

interface LoginResponse {
  token: string;
  expires_at?: string;
  user: {
    user_id: number;
    barangay_id: number;
    role: string;
    full_name: string;
  };
}

/** POST /auth/login. Returns the session it stored, for the caller to route on. */
export async function login(username: string, password: string): Promise<StoredSession> {
  // `X-Device-Id` on login is what earns a DEVICE session (24h sliding,
  // 7-day cap — backend SessionPolicy, decided 2026-09-19) instead of the
  // dashboard's 15-minute one. The id is minted on first launch, before any
  // login, so it always exists here; the server still only grants the
  // longer session to the tanod role.
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
    role: json.user.role, // enum value — never camelCased
    fullName: json.user.full_name,
  };
  await saveSession(session);
  return session;
}

/** POST /auth/logout. */
export async function logout(): Promise<void> {
  await request<{ success: boolean }>('/auth/logout', { method: 'POST' });
}

// --- Device lifecycle (§6, M1) ---------------------------------------------

export interface DeviceRegistration {
  deviceId: string;
  registered: boolean;
  /**
   * §6/Rule 26 — Sprint 4 Phase 3 addition. Present ONLY on this
   * device_id's first-ever registration; absent on every later call
   * (ordinary FCM-token-refresh re-registration). Base64, ready to hand
   * straight to `messageEncryptionKey.ts`'s `storeMessageEncryptionKey()`.
   * See DevicesController.php's own doc for why the server never
   * re-returns it once issued.
   */
  messageEncryptionKey?: string;
}

/**
 * POST /devices/register. Tanod-only server-side.
 * The server returns no FCM token by design (§6) — do not expect one.
 *
 * `fcmToken` is nullable — explicit decision, 2026-09-13 (see
 * DevicesController.php's class doc): this deployment has no real Firebase
 * project, so `getFcmToken()` always resolves null, and a device must
 * still register (and become sync-capable) without one. `null` is sent
 * through as-is rather than coerced to `''` here — the server's own
 * validation already treats null/missing/empty identically.
 */
export async function registerDevice(params: {
  deviceId: string;
  fcmToken: string | null;
  appVersion?: string;
  /** H-09: this install's Keystore public key, or undefined/null on a device that can't generate one (never blocks registration). */
  devicePublicKeyPem?: string | null;
}): Promise<DeviceRegistration> {
  const json = await request<{ device_id: string; registered: boolean; message_encryption_key?: string }>(
    '/devices/register',
    {
      method: 'POST',
      body: {
        device_id: params.deviceId,
        fcm_token: params.fcmToken,
        platform: 'android', // §5 mobile_device.platform is ENUM('android')
        app_version: params.appVersion,
        device_public_key_pem: params.devicePublicKeyPem ?? null,
      },
    }
  );
  return { deviceId: json.device_id, registered: json.registered, messageEncryptionKey: json.message_encryption_key };
}

/** PATCH /devices/:id/deactivate — own device only, server-enforced. */
export async function deactivateDevice(deviceId: string): Promise<void> {
  await request<{ success: boolean }>(`/devices/${encodeURIComponent(deviceId)}/deactivate`, {
    method: 'PATCH',
  });
}

// --- Map packages (§6, M1) -------------------------------------------------

export interface MapPackageMetadata {
  version: string;
  checksumSha256: string;
  downloadUrl: string;
  isPublished: boolean;
}

/**
 * GET /map-packages/:barangayId.
 *
 * Returns null when the server has no published package (the endpoint
 * answers 404). §9 M1 requires the map check to be NON-BLOCKING — the app
 * enters M2 regardless — so "nothing published yet" is an ordinary
 * outcome here, not an error worth failing login over.
 */
export async function getMapPackage(barangayId: number): Promise<MapPackageMetadata | null> {
  try {
    const json = await request<{
      version: string;
      checksum_sha256: string;
      download_url: string;
      is_published: boolean;
    }>(`/map-packages/${barangayId}`);
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

/** The absolute URL for a package download, for the file-transfer layer to fetch. */
export function mapPackageDownloadUrl(barangayId: number): string {
  return `${API_BASE_URL}/map-packages/${barangayId}/download`;
}

/**
 * GET /map-packages/:barangayId/download. Streams the published MBTiles
 * package's raw bytes — bypasses `request()`'s JSON handling (this is a
 * binary transfer, sometimes tens of MB), but is still the one place in
 * the app allowed to `fetch()` the API directly, per this file's own
 * single-boundary rule. Auth/renewal follow the same rules as every other
 * call here. Checksum verification is the CALLER's job
 * (`mapPackageService.ts`) — §2 Rule 14 / §6: "client verifies SHA-256
 * before activation", and this function has no opinion on what "before
 * activation" means for local storage.
 */
export async function downloadMapPackage(barangayId: number): Promise<Uint8Array> {
  const session = await loadSession();
  if (!session) {
    throw new ApiError(401, 'UNAUTHORIZED', 'You are signed out.');
  }

  let response: Response;
  try {
    response = await fetch(mapPackageDownloadUrl(barangayId), {
      headers: { Authorization: `Bearer ${session.token}` },
    });
  } catch {
    throw new ApiError(0, 'NETWORK_ERROR', 'Cannot reach the barangay workstation.');
  }

  const renewed = response.headers.get('X-Renewed-Token');
  if (renewed) await storeRenewedToken(renewed);

  if (!response.ok) {
    throw new ApiError(response.status, 'SERVER_ERROR', 'Could not download the map package.');
  }
  return new Uint8Array(await response.arrayBuffer());
}

// --- Duty status (§6, M2 Home) ----------------------------------------------

/** §5 duty_status.status enum — the only accepted values. */
export type DutyStatus = 'on_duty' | 'responding' | 'off_duty';

export interface DutyStatusEntry {
  statusId: number;
  status: DutyStatus;
  channel: string;
  changedAt: string;
}

/**
 * POST /duty-status. `clientEventId` must be a fresh UUID per real toggle
 * (a retry of the SAME toggle should reuse the same id so the server's
 * idempotent-retry path returns the original row instead of creating a
 * duplicate status change).
 */
export async function setDutyStatus(status: DutyStatus, clientEventId: string): Promise<DutyStatusEntry> {
  const json = await request<{ status_id: number; status: DutyStatus; channel: string; changed_at: string }>(
    '/duty-status',
    { method: 'POST', body: { status, client_event_id: clientEventId } }
  );
  return { statusId: json.status_id, status: json.status, channel: json.channel, changedAt: json.changed_at };
}

/**
 * GET /duty-status?user_id=me — the caller's own most recent toggle, for
 * M2 to show the TRUE current status on load rather than an optimistic
 * local guess (a Tanod may have toggled from a different device, or via
 * the SMS fallback channel once Sprint 4 exists).
 */
export async function getOwnDutyStatus(): Promise<DutyStatusEntry | null> {
  const json = await request<{
    items: { status_id: number; status: DutyStatus; channel: string; changed_at: string }[];
  }>('/duty-status?user_id=me&limit=1');
  const latest = json.items[0];
  if (!latest) return null;
  return { statusId: latest.status_id, status: latest.status, channel: latest.channel, changedAt: latest.changed_at };
}

// --- SOS (§6 `POST /tanod-sos`, §2 Rule 27) --------------------------------

export interface SosResult {
  sosId: number;
  status: string;
  receivedAt: string;
}

/**
 * POST /tanod-sos. `clientEventId` is the idempotency key
 * (UNIQUE(user_id, client_event_id) server-side) — a retry with the same
 * id returns the original row rather than raising a second alarm, the
 * same guarantee an SMS-fallback-correlated SOS relies on (§2 Rule 27).
 * `latitude`/`longitude` are OPTIONAL (migration 0026, C-01) — §2 Rule 27
 * says SOS must never be blocked on a missing GPS fix, so a caller that
 * couldn't get a location must still call this, just without coordinates.
 * The server falls back to the Tanod's last known `gps_track` fix, or
 * creates the SOS with null coordinates (`location_source='no_fix'`) if
 * there is none at all — it never rejects for a missing fix. Sending only
 * one of the two is still a 400 (a different failure mode from neither).
 */
export async function postSos(params: {
  latitude?: number;
  longitude?: number;
  clientEventId: string;
  dispatchId?: number | null;
  fallbackChannel?: 'app' | 'sms';
}): Promise<SosResult> {
  // H-09: best-effort device auth headers — the server NEVER rejects an
  // SOS over a missing/bad signature (TanodSosController's own doc:
  // "a real emergency signal must never be lost to a secondary
  // authenticity check"), it only logs the anomaly. Attaching these here
  // is purely additive audit value, never a condition for the SOS itself.
  const deviceId = await getDeviceId();
  const headers = await deviceAuthHeaders('POST', '/tanod-sos', deviceId);
  const json = await request<{ sos_id: number; status: string; received_at: string }>('/tanod-sos', {
    method: 'POST',
    headers,
    timeoutMs: SOS_TIMEOUT_MS,
    body: {
      latitude: params.latitude,
      longitude: params.longitude,
      client_event_id: params.clientEventId,
      dispatch_id: params.dispatchId ?? undefined,
      fallback_channel: params.fallbackChannel ?? undefined,
    },
  });
  return { sosId: json.sos_id, status: json.status, receivedAt: json.received_at };
}

/**
 * GET /tanod-sos/fallback-contact — G1's third SOS fallback tier (Mobile
 * Improvement Plan Phase 4.3). Deliberately NOT `GET /system-settings`
 * (Admin-only, and it would also hand a Tanod's phone the SMS gateway
 * API key). Returns null when no backup contact has been configured —
 * a legitimate, non-error outcome (§7's W21 note: this key defaults
 * empty until an Admin sets it).
 */
export async function getSosFallbackContact(): Promise<string | null> {
  const json = await request<{ backup_contact_number: string | null }>('/tanod-sos/fallback-contact');
  return json.backup_contact_number;
}

// --- Dispatch (§6, Sprint 1 web + Sprint 3 mobile: M5/M6) -------------------

/** §5 dispatch.status enum. */
export type DispatchStatus = 'assigned' | 'en_route' | 'arrived' | 'completed' | 'cancelled';
/** §5 dispatch.route_status enum. */
export type RouteStatus = 'available' | 'unavailable' | 'stale';
export type RouteMode = 'car' | 'foot';

export interface RouteStep {
  instruction: string;
  /** ORS's `type` code isn't a text enum (see OrsClient.php) — this carries the road name instead, when known. */
  maneuver: string;
  distanceM: number;
  durationS: number;
}

/** `dispatch.route_json`'s decoded shape once `route_status` is `available`/`stale` — see DispatchController::route(). */
export interface RouteData {
  mode: RouteMode;
  /** Already-decoded GeoJSON LineString — no polyline-decoder library needed, see OrsClient.php's own doc block. */
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

/**
 * Normalizes the server's snake_case `route_json` into the same
 * camelCase `RouteData` shape everywhere it enters the app — both
 * `GET /dispatch` (via `mapDispatch`) and `GET /dispatch/:id/route`
 * (below) carry this field, and a caller (assignment-detail.tsx) must
 * not need to know which endpoint last populated it.
 */
function mapRouteJson(raw: unknown): RouteData | null {
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
  /** Redacted-safe fields joined in from the incident (Sprint 3 addition — see DispatchController.php's class doc). */
  incidentType: string | null;
  latitude: number | null;
  longitude: number | null;
  dispatchedAt: string;
  enRouteAt: string | null;
  arrivedAt: string | null;
  completedAt: string | null;
  cancelledAt: string | null;
}

function mapDispatch(json: {
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
}): DispatchEntry {
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

/**
 * GET /dispatch — §6: Tanod is forced server-side to their own dispatches.
 * M5's Assignments List refreshes its `dispatch_local` cache from this.
 */
export async function getDispatches(params: { status?: DispatchStatus } = {}): Promise<DispatchEntry[]> {
  const query = params.status ? `?status=${encodeURIComponent(params.status)}` : '';
  const json = await request<{ items: Parameters<typeof mapDispatch>[0][] }>(`/dispatch${query}`);
  return json.items.map(mapDispatch);
}

/**
 * PATCH /dispatch/:id/status — §6 forward-only transition matrix
 * (assigned->en_route->arrived->completed). M6 calls this immediately when
 * online; when offline, the status change is queued locally instead (see
 * `offlineQueueRepository.ts`) and this same endpoint is reached later via
 * `syncBatch()`'s `dispatch_status_updates[]`.
 */
export async function updateDispatchStatus(
  dispatchId: number,
  status: 'en_route' | 'arrived' | 'completed'
): Promise<{ dispatchId: number; status: DispatchStatus; updatedAt: string }> {
  // H-09: server verifies this only for a Tanod-initiated call (never an
  // Admin override) and only when this device has a key on file — see
  // DispatchController::applyStatusTransition()'s own doc.
  const path = `/dispatch/${dispatchId}/status`;
  const deviceId = await getDeviceId();
  const headers = await deviceAuthHeaders('PATCH', path, deviceId);
  const json = await request<{ dispatch_id: number; status: DispatchStatus; updated_at: string }>(
    path,
    { method: 'PATCH', headers, body: { status } }
  );
  return { dispatchId: json.dispatch_id, status: json.status, updatedAt: json.updated_at };
}

/**
 * GET /dispatch/:id/route — computes (and caches server-side) a
 * road-snapped route from the CALLER'S CURRENT position to the
 * dispatch's incident. Explicit-tap only (assignment-detail.tsx's "Get
 * Route" button) — never auto-fetched on screen mount — both for
 * battery/data reasons and because ORS's free tier is request-limited
 * (see backend/.env.example's ORS_API_KEY block).
 *
 * `routeStatus` can be `unavailable` (never fetched, or ORS
 * unreachable/unconfigured with nothing cached yet) or `stale` (a
 * refresh failed but a PRIOR good route is still being returned,
 * `routeJson` not null) — never throws for either; only a genuine
 * network/auth failure throws (`ApiError`), same as every other call
 * through `request()`.
 */
export async function getDispatchRoute(
  dispatchId: number,
  position: { latitude: number; longitude: number },
  mode: RouteMode = 'car'
): Promise<{ dispatchId: number; routeStatus: RouteStatus; routeJson: RouteData | null }> {
  const query = new URLSearchParams({
    latitude: String(position.latitude),
    longitude: String(position.longitude),
    mode,
  });
  const json = await request<{ dispatch_id: number; route_status: RouteStatus; route_json: unknown | null }>(
    `/dispatch/${dispatchId}/route?${query.toString()}`
  );

  return {
    dispatchId: json.dispatch_id,
    routeStatus: json.route_status,
    routeJson: mapRouteJson(json.route_json),
  };
}

// --- GPS (§6, Sprint 3: M7 Live Map) ----------------------------------------

/**
 * POST /gps. `recordedAt` is the device's own capture time (ISO 8601) —
 * distinct from the server's authoritative `received_at` (Rule 31).
 */
export async function postGps(point: {
  latitude: number;
  longitude: number;
  accuracyM: number;
  recordedAt: string;
  dispatchId?: number | null;
  clientEventId: string;
}): Promise<{ trackId: number; receivedAt: string }> {
  // H-09: signature verification applies here AND to syncBatch()'s replay
  // of queued points (both go through GpsController::createItem()) — see
  // syncBatch() below for why it attaches the same headers to that call.
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

/** GET /incidents/nearby — Tanod only (§6); never raw narrative/contact data. */
export async function getNearbyIncidents(params: {
  latitude: number;
  longitude: number;
  radiusM?: number;
}): Promise<NearbyIncident[]> {
  const query = new URLSearchParams({
    latitude: String(params.latitude),
    longitude: String(params.longitude),
  });
  if (params.radiusM) query.set('radius_m', String(params.radiusM));
  const json = await request<{
    items: {
      incident_id: number;
      incident_type: string;
      priority: string;
      status: string;
      latitude: number;
      longitude: number;
      age_seconds: number;
    }[];
  }>(`/incidents/nearby?${query.toString()}`);
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

/**
 * GET /gps/live?barangay_id=me — same-barangay on-duty-or-not active Tanod
 * roster (2026-09-12: opened to the `tanod` role alongside admin/PB, an
 * explicit user decision — see GpsController::live()'s own doc comment).
 * Returns every OTHER active Tanod in the caller's own barangay who has
 * ever recorded a position; the caller's own row is filtered out here
 * since "nearby Tanods" means peers, not a duplicate of the position this
 * screen already shows from the device's own GPS.
 */
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
  }>(`/gps/live?barangay_id=${session.barangayId}`);
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

// --- Evidence upload (§6, closes F4 — Mobile Improvement Plan Phase 3.2) ---

export interface EvidenceUploadItem {
  type: 'photo' | 'voice';
  sha256: string;
  mimeType: string;
  originalFilename?: string;
  /** The evidence row's own local_id doubles as the server's idempotency key — see evidenceRepository.ts. */
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
 * POST /incidents/:incidentServerId/evidence — multipart upload. Bypasses
 * `request()`'s JSON handling (binary transfer via `FormData`), the same
 * single-boundary exception `downloadMapPackage()` already is.
 * `X-Device-Id` is required server-side (`assertDeviceOwnership()`),
 * matching every other mobile write's §2 Rule 3 contract. The server
 * computes its OWN sha256 over the received bytes and rejects a mismatch
 * against `item.sha256` — this function does not pre-verify that itself,
 * trusting the server's check rather than duplicating it.
 */
export async function uploadEvidence(
  incidentServerId: number,
  deviceId: string,
  fileBytes: Blob,
  item: EvidenceUploadItem
): Promise<UploadedEvidence> {
  const session = await loadSession();
  if (!session) {
    throw new ApiError(401, 'UNAUTHORIZED', 'You are signed out.');
  }

  const form = new FormData();
  form.append('file', fileBytes, item.originalFilename || 'evidence');
  form.append('type', item.type);
  form.append('sha256', item.sha256);
  form.append('mime_type', item.mimeType);
  form.append('client_request_id', item.clientRequestId);
  if (item.originalFilename) form.append('original_filename', item.originalFilename);

  // H-09: same headers every other high-value write attaches — see
  // deviceAuthHeaders()'s own doc for the /api/v1-prefix reasoning.
  const deviceHeaders = await deviceAuthHeaders('POST', `/incidents/${incidentServerId}/evidence`, deviceId);

  let response: Response;
  try {
    response = await fetch(`${API_BASE_URL}/incidents/${incidentServerId}/evidence`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${session.token}`, ...deviceHeaders },
      body: form,
    });
  } catch {
    throw new ApiError(0, 'NETWORK_ERROR', 'Cannot reach the barangay workstation.');
  }

  const renewed = response.headers.get('X-Renewed-Token');
  if (renewed) await storeRenewedToken(renewed);

  const text = await response.text();
  const payload = text ? safeJsonParse(text) : null;
  if (!response.ok) {
    const error = (payload as { error?: { code?: string; message?: string } } | null)?.error;
    throw new ApiError(response.status, error?.code ?? 'SERVER_ERROR', error?.message ?? 'Evidence upload failed.');
  }

  const json = payload as {
    attachment_id: number;
    incident_id: number;
    type: string;
    uploaded_by: number;
    uploaded_at: string;
    sha256: string;
    byte_size: number;
    mime_type: string;
    original_filename: string;
  };
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

// --- Sync (§6 "Sync" section, Sprint 3) -------------------------------------

/** One item's shape for POST /sync/batch's `incidents[]` array (mirrors POST /incidents mobile body). */
export interface SyncIncidentItem {
  incident_type: string;
  raw_narrative: string;
  latitude: number | null;
  longitude: number | null;
  device_offline_created_at?: string | null;
  client_event_id: string;
  /** Safer School Zones link + Annex C-1 fields (contract §7) — omitted entirely when not set. */
  school_id?: number;
  c1_summary?: string;
  c1_action_taken?: string;
  c1_status_notes?: string;
}

/**
 * One item's shape for `referrals[]` (contract §5/§6 — same as the POST
 * /incidents/:id/referrals body). A referral to an incident that only exists
 * on this phone carries `incident_client_event_id` instead of `incident_id`.
 */
export interface SyncReferralItem {
  incident_id?: number;
  incident_client_event_id?: string;
  referred_to: ReferralTarget;
  other_text?: string;
  contact_name?: string;
  referred_at: string;
  reference_no?: string;
  client_event_id: string;
}

/** One item's shape for `availability[]` (contract §3 POST /availability body). */
export interface SyncAvailabilityItem {
  period_start: string;
  period_end: string;
  windows: AvailabilityWindow[];
  client_event_id: string;
}

/** One item's shape for `accomplishment_entries[]` (contract §4 POST /accomplishment-entries body). */
export interface SyncAccomplishmentItem {
  work_date: string;
  accomplishment_text: string;
  start_time?: string;
  end_time?: string;
  duration_minutes: number;
  client_event_id: string;
}

/**
 * One item's shape for `school_checkins[]` (contract §7). A CREATE item
 * carries `school_id` + `checked_in_at` (+ `checked_out_at` when the check-out
 * was merged in before the first sync). A CLOSE item for an already-synced
 * check-in carries a NEW `client_event_id`, `closes_client_event_id` (the
 * check-in's own event id) and `checked_out_at` — no school/checked-in fields.
 */
export interface SyncSchoolCheckinItem {
  school_id?: number;
  checked_in_at?: string;
  checked_out_at?: string;
  closes_client_event_id?: string;
  client_event_id: string;
}

/** One item's shape for `gps_tracks[]` (mirrors POST /gps body). */
export interface SyncGpsItem {
  latitude: number;
  longitude: number;
  accuracy_m: number;
  recorded_at: string;
  dispatch_id?: number | null;
  client_event_id: string;
}

/** One item's shape for `duty_status_updates[]` (mirrors POST /duty-status body). */
export interface SyncDutyStatusItem {
  status: DutyStatus;
  client_event_id: string;
}

/** One item's shape for `dispatch_status_updates[]` (§6: no override_reason from a sync item). */
export interface SyncDispatchStatusItem {
  dispatch_id: number;
  status: 'en_route' | 'arrived' | 'completed';
  client_event_id: string;
}

/**
 * One item's shape for `sos[]` (mirrors POST /tanod-sos body). §6:
 * SyncController.php passes this straight into
 * TanodSosController::createItem() — same idempotency key, same Rule 27
 * fan-out as a live SOS.
 */
export interface SyncSosItem {
  latitude?: number;
  longitude?: number;
  dispatch_id?: number | null;
  fallback_channel?: 'app' | 'sms';
  client_event_id: string;
  /** Optional extra: when the Tanod pressed SOS on the device (ISO 8601 UTC). The backend may ignore it. */
  created_offline_at?: string;
}

export interface SyncBatchResult {
  clientEventId: string;
  serverId: number | null;
  status: 'success' | 'duplicate' | 'failed';
  reason?: string;
}

/**
 * POST /sync/batch. §6: "Device ownership must match authenticated Tanod" —
 * `deviceId` must be THIS device's own id (`deviceIdentity.ts`). Every array
 * is optional; omit or pass `[]` for anything with nothing to sync.
 */
export async function syncBatch(params: {
  deviceId: string;
  incidents?: SyncIncidentItem[];
  gpsTracks?: SyncGpsItem[];
  dutyStatusUpdates?: SyncDutyStatusItem[];
  dispatchStatusUpdates?: SyncDispatchStatusItem[];
  sosItems?: SyncSosItem[];
  referrals?: SyncReferralItem[];
  availability?: SyncAvailabilityItem[];
  accomplishmentEntries?: SyncAccomplishmentItem[];
  schoolCheckins?: SyncSchoolCheckinItem[];
}): Promise<SyncBatchResult[]> {
  // H-09: one signature covers the whole batch — GpsController::
  // createItem()/DispatchController::applyStatusTransition()/
  // TanodSosController::createItem() all read X-Device-Id/-Signature off
  // this single /sync/batch request's headers, not per-item.
  const headers = await deviceAuthHeaders('POST', '/sync/batch', params.deviceId);
  const json = await request<{
    results: { client_event_id: string; server_id: number | null; status: string; reason?: string }[];
  }>('/sync/batch', {
    method: 'POST',
    headers,
    body: {
      device_id: params.deviceId,
      incidents: params.incidents ?? [],
      gps_tracks: params.gpsTracks ?? [],
      duty_status_updates: params.dutyStatusUpdates ?? [],
      dispatch_status_updates: params.dispatchStatusUpdates ?? [],
      sos: params.sosItems ?? [],
      referrals: params.referrals ?? [],
      availability: params.availability ?? [],
      accomplishment_entries: params.accomplishmentEntries ?? [],
      school_checkins: params.schoolCheckins ?? [],
    },
  });
  return json.results.map((r) => ({
    clientEventId: r.client_event_id,
    serverId: r.server_id,
    status: r.status as SyncBatchResult['status'],
    reason: r.reason,
  }));
}

// --- Shifts & swap requests (§6 "Shifts and fatigue" — M8/M9, Phase 4.4) ---

export interface ShiftEntry {
  shiftId: number;
  patrolZone: string | null;
  startAt: string;
  endAt: string;
  version: number;
  /** Contract §3: a Tanod only ever receives `published` rows; null from a server that predates the field. */
  approvalStatus: 'draft' | 'published' | null;
  /**
   * Wave 1-A: an approved swap on a published shift sends it back to `draft` with this flag set — the
   * server then shows it to its owner only, as "awaiting re-publish". It is NOT confirmed duty: UI must
   * badge it and keep it out of next-duty/hours logic. `false` from a server that predates the field.
   */
  pendingReapproval: boolean;
}

/**
 * GET /shifts — §6: a tanod caller is forced server-side to their own rows, so this is already "my shifts", no ?user_id=me needed.
 * Contract §3: the server also hides `draft` shifts from a Tanod; the client filter below is a second line
 * of defence so a draft can never be displayed as a real duty, not a security boundary.
 */
export async function getMyShifts(): Promise<ShiftEntry[]> {
  const json = await request<{
    items: {
      shift_id: number;
      user_id: number | null;
      patrol_zone: string | null;
      start_at: string;
      end_at: string;
      version: number;
      approval_status?: 'draft' | 'published' | null;
      pending_reapproval?: boolean | number | null;
    }[];
  }>('/shifts?limit=100');
  return json.items
    .map((row) => ({
      shiftId: row.shift_id,
      patrolZone: row.patrol_zone,
      startAt: row.start_at,
      endAt: row.end_at,
      version: row.version,
      approvalStatus: row.approval_status ?? null,
      pendingReapproval: row.pending_reapproval === true || Number(row.pending_reapproval) === 1,
    }))
    // A plain draft is never shown; a draft the server flagged `pending_reapproval` IS (as a badged,
    // non-confirmed row) because the owner needs to see that their swap changed the roster.
    .filter((shift) => shift.approvalStatus !== 'draft' || shift.pendingReapproval);
}

// --- Tanod workflow (contract docs/FEATURE_CONTRACT_2026-10.md §3-§7) --------

export interface SchoolEntry {
  schoolId: number;
  name: string;
  schoolType: string | null;
  level: string | null;
  address: string | null;
  latitude: number | null;
  longitude: number | null;
  isActive: boolean;
}

interface RawSchool {
  school_id: number;
  name: string;
  school_type?: string | null;
  level?: string | null;
  address?: string | null;
  latitude?: number | string | null;
  longitude?: number | string | null;
  is_active?: number | boolean | null;
}

function numberOrNull(value: unknown): number | null {
  if (value === null || value === undefined || value === '') return null;
  const n = Number(value);
  return Number.isFinite(n) ? n : null;
}

/** Accepts either the paginated `{items: [...]}` envelope every list route uses, or a bare array. */
function listItems<T>(json: unknown): T[] {
  if (Array.isArray(json)) return json as T[];
  const items = (json as { items?: unknown } | null)?.items;
  return Array.isArray(items) ? (items as T[]) : [];
}

/**
 * GET /schools — every role incl. tanod, own barangay (contract §7). Staff
 * contact fields (`focal_person`/`focal_contact`) and remarks are deliberately
 * NOT mapped: the mobile cache has no use for them. `?active=` is not sent —
 * the caller filters on `isActive` itself, so a server default can't hide an
 * entry the cache should know is deactivated.
 */
export async function getSchools(): Promise<SchoolEntry[]> {
  const json = await request<unknown>('/schools?limit=100');
  return listItems<RawSchool>(json).map((row) => ({
    schoolId: row.school_id,
    name: row.name,
    schoolType: row.school_type ?? null,
    level: row.level ?? null,
    address: row.address ?? null,
    latitude: numberOrNull(row.latitude),
    longitude: numberOrNull(row.longitude),
    isActive: row.is_active === undefined || row.is_active === null ? true : Boolean(Number(row.is_active)),
  }));
}

export interface AvailabilityEntry {
  availId: number;
  periodStart: string;
  periodEnd: string;
  windows: AvailabilityWindow[];
  status: AvailabilityStatus;
  reviewNote: string | null;
  version: number;
  clientEventId: string | null;
}

interface RawAvailability {
  avail_id: number;
  period_start: string;
  period_end: string;
  windows_json?: AvailabilityWindow[] | string | null;
  windows?: AvailabilityWindow[] | null;
  status: AvailabilityStatus;
  review_note?: string | null;
  version?: number;
  client_event_id?: string | null;
}

function parseWindows(row: RawAvailability): AvailabilityWindow[] {
  const raw = row.windows ?? row.windows_json;
  if (Array.isArray(raw)) return raw;
  if (typeof raw === 'string') {
    try {
      const parsed = JSON.parse(raw) as unknown;
      return Array.isArray(parsed) ? (parsed as AvailabilityWindow[]) : [];
    } catch {
      return [];
    }
  }
  return [];
}

/** GET /availability — a tanod caller sees their own rows only (contract §3). */
export async function getMyAvailability(): Promise<AvailabilityEntry[]> {
  const json = await request<unknown>('/availability?limit=100');
  return listItems<RawAvailability>(json).map((row) => ({
    availId: row.avail_id,
    periodStart: row.period_start,
    periodEnd: row.period_end,
    windows: parseWindows(row),
    status: row.status,
    reviewNote: row.review_note ?? null,
    version: row.version ?? 1,
    clientEventId: row.client_event_id ?? null,
  }));
}

/** Contract §4 `accomplishment_report.status`. */
export type AccomplishmentReportStatus = 'open' | 'prepared' | 'noted' | 'approved' | 'returned';

export interface AccomplishmentReportSummary {
  reportId: number;
  month: string;
  status: AccomplishmentReportStatus;
  /** Why an approver sent it back — shown to the Tanod as-is when status is `returned`. */
  returnReason: string | null;
  totalMinutes: number | null;
  flaggedEntries: number | null;
}

interface RawReport {
  report_id: number;
  month: string;
  status: AccomplishmentReportStatus;
  return_reason?: string | null;
  total_minutes?: number | null;
  total_minutes_confirmed?: number | null;
  flagged_entries?: number | null;
  entries?: RawReportEntry[];
}

interface RawReportEntry {
  entry_id: number;
  duration_minutes?: number | null;
  suggested_duration_minutes?: number | null;
  duration_flag?: number | boolean | null;
}

function mapReport(row: RawReport): AccomplishmentReportSummary {
  return {
    reportId: row.report_id,
    month: row.month,
    status: row.status,
    returnReason: row.return_reason ?? null,
    totalMinutes: numberOrNull(row.total_minutes ?? row.total_minutes_confirmed),
    flaggedEntries: numberOrNull(row.flagged_entries),
  };
}

/** GET /accomplishment-reports?month= — a tanod caller sees their own reports only (contract §4). */
export async function getMyAccomplishmentReports(month?: string): Promise<AccomplishmentReportSummary[]> {
  const query = month ? `?month=${encodeURIComponent(month)}&limit=100` : '?limit=100';
  const json = await request<unknown>(`/accomplishment-reports${query}`);
  return listItems<RawReport>(json).map(mapReport);
}

export interface AccomplishmentEntryServerView {
  entryId: number;
  durationMinutes: number | null;
  suggestedDurationMinutes: number | null;
  durationFlag: boolean;
}

/**
 * GET /accomplishment-reports/:id — only the per-entry duration fields are
 * mapped (the entry text is returned to approvers only, per contract §4; the
 * Tanod's own text stays in `accomplishment_entry_local`).
 */
export async function getAccomplishmentReport(
  reportId: number
): Promise<{ report: AccomplishmentReportSummary; entries: AccomplishmentEntryServerView[] }> {
  const json = await request<RawReport>(`/accomplishment-reports/${reportId}`);
  return {
    report: mapReport(json),
    entries: (json.entries ?? []).map((entry) => ({
      entryId: entry.entry_id,
      durationMinutes: numberOrNull(entry.duration_minutes),
      suggestedDurationMinutes: numberOrNull(entry.suggested_duration_minutes),
      durationFlag: Boolean(Number(entry.duration_flag ?? 0)),
    })),
  };
}

/**
 * POST /accomplishment-reports/:id/submit — ONLINE-ONLY by contract §4 (not a
 * sync kind): there is deliberately no offline queue behind this. A second
 * submit after success is an illegal transition (409), which the caller turns
 * into a refresh rather than an error.
 *
 * The server REQUIRES an `Idempotency-Key` (a UUID) on every report
 * transition. The caller mints it once per user action and passes the SAME
 * key on a retry of that action, so a lost response replays the original
 * outcome instead of colliding; a resubmit after a return is a new action and
 * gets a new key.
 */
export async function submitAccomplishmentReport(reportId: number, idempotencyKey: string): Promise<AccomplishmentReportSummary> {
  const path = `/accomplishment-reports/${reportId}/submit`;
  const headers = await deviceAuthHeaders('POST', path, await getDeviceId());
  headers['Idempotency-Key'] = idempotencyKey;
  const json = await request<RawReport>(path, { method: 'POST', headers, body: {} });
  return mapReport(json);
}

/**
 * PATCH /accomplishment-entries/:id — tanod own, only while the report is
 * open/returned (contract §4). The contract does not spell out the PATCH body;
 * this sends only the editable subset of the POST body's fields. Online only —
 * an entry that has not synced yet is edited locally instead
 * (`accomplishmentRepository.updateUnsyncedEntry`). The server requires
 * `start_time`/`end_time` together or not at all, so a lopsided pair is
 * refused here rather than sent to be answered with a 400.
 */
export async function updateAccomplishmentEntry(
  entryId: number,
  fields: {
    accomplishment_text: string;
    start_time: string | null;
    end_time: string | null;
    duration_minutes: number;
  }
): Promise<void> {
  if ((fields.start_time === null) !== (fields.end_time === null)) {
    throw new Error('Enter both a start and an end time, or leave both blank.');
  }
  const path = `/accomplishment-entries/${entryId}`;
  const headers = await deviceAuthHeaders('PATCH', path, await getDeviceId());
  await request<unknown>(path, { method: 'PATCH', headers, body: fields });
}

/** §5 shift_swap_request.status enum. */
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

function mapSwapRequest(json: {
  request_id: number;
  requesting_user_id: number;
  shift_id: number;
  target_user_id: number | null;
  reason: string | null;
  status: ShiftSwapStatus;
  requested_at: string;
  resolved_at: string | null;
}): ShiftSwapRequestEntry {
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

/** GET /shift-swap-requests — a tanod caller sees only requests THEY raised (§6, mirrors GET /shifts' own scoping). */
export async function getMyShiftSwapRequests(): Promise<ShiftSwapRequestEntry[]> {
  const json = await request<{ items: Parameters<typeof mapSwapRequest>[0][] }>('/shift-swap-requests?limit=100');
  return json.items.map(mapSwapRequest);
}

/**
 * POST /shift-swap-requests. No `target_user_id` here on purpose: picking
 * a specific substitute needs `GET /users` to know who else is a tanod in
 * this barangay, and that endpoint is Admin-only (§7) — a Tanod has no
 * API to safely populate that picker from, so this raises an
 * un-targeted request (the desk/Admin assigns a substitute when
 * reviewing it) rather than asking for a raw numeric user id nobody would
 * actually know.
 */
export async function requestShiftSwap(shiftId: number, reason: string | undefined, clientRequestId: string): Promise<ShiftSwapRequestEntry> {
  const json = await request<Parameters<typeof mapSwapRequest>[0]>('/shift-swap-requests', {
    method: 'POST',
    body: { shift_id: shiftId, reason: reason || undefined, client_request_id: clientRequestId },
  });
  return mapSwapRequest(json);
}

/**
 * DELETE /shift-swap-requests/:id.
 * Allows a responder to withdraw their pending shift swap request.
 */
export async function cancelShiftSwapRequest(requestId: number): Promise<{ success: boolean; requestId: number }> {
  const json = await request<{ success: boolean; request_id: number }>(`/shift-swap-requests/${requestId}`, {
    method: 'DELETE',
  });
  return { success: json.success, requestId: json.request_id };
}

// --- Dispatch offers (Wave 2: night dispatch broadcast; ONLINE-ONLY) -------------
//
// An offer is a broadcast "who can take this call" to on-duty tanods holding a
// published shift. The alert content is deliberately NON-IDENTIFYING (incident
// type, barangay name, time) — no narrative, names, contacts, coordinates or
// location text — and nothing here is ever written to the offline queue or
// SQLite: accepting needs the server to arbitrate "first accept wins", so it
// cannot be deferred or claimed locally.

export interface DispatchOfferEntry {
  offerId: number;
  incidentId: number;
  /** Raw `incident_type` enum value (e.g. `medical_emergency`) — label it for display. */
  incidentType: string;
  priority: string | null;
  barangayName: string;
  createdAt: string;
  expiresAt: string;
  status: string;
}

interface RawDispatchOffer {
  offer_id: number;
  incident_id: number;
  incident_type: string;
  priority?: string | null;
  barangay_name: string;
  created_at: string;
  expires_at: string;
  status: string;
}

/** GET /dispatch-offers — a tanod caller gets only their own still-`offered` open offers. */
export async function getOpenDispatchOffers(): Promise<DispatchOfferEntry[]> {
  const json = await request<unknown>('/dispatch-offers');
  return listItems<RawDispatchOffer>(json).map((row) => ({
    offerId: row.offer_id,
    incidentId: row.incident_id,
    incidentType: row.incident_type,
    priority: row.priority ?? null,
    barangayName: row.barangay_name,
    createdAt: row.created_at,
    expiresAt: row.expires_at,
    status: row.status,
  }));
}

/**
 * POST /dispatch-offers/:id/accept. Requires the device session headers (same signed
 * set the other tanod writes use) and a fresh `request_id` per tap: the server replays
 * the original result for a repeated id, so a retry after a dropped response is safe.
 * 409 `OFFER_CLOSED` (someone else won / expired / cancelled) surfaces as an ApiError.
 */
export async function acceptDispatchOffer(
  offerId: number,
  requestId: string
): Promise<{ dispatchId: number; status: string; incidentId: number }> {
  const path = `/dispatch-offers/${offerId}/accept`;
  const headers = await deviceAuthHeaders('POST', path, await getDeviceId());
  const json = await request<{ dispatch_id: number; status: string; incident_id: number }>(path, {
    method: 'POST',
    headers,
    body: { request_id: requestId },
  });
  return { dispatchId: json.dispatch_id, status: json.status, incidentId: json.incident_id };
}

// --- Notifications (§6 "Notification acknowledgment", M12) -----------------

/**
 * POST /notifications/:id/ack. §6: "Tanod only for a target notification
 * assigned to that user ... idempotent for an already-acknowledged
 * target." M12's overlay calls this on Acknowledge; a second tap (or a
 * retry after a flaky connection) is safe.
 */
export async function acknowledgeNotification(notificationId: number): Promise<{ acknowledgedAt: string }> {
  const json = await request<{ success: boolean; notification_id: number; acknowledged_at: string }>(
    `/notifications/${notificationId}/ack`,
    { method: 'POST', body: {} }
  );
  return { acknowledgedAt: json.acknowledged_at };
}

/**
 * Lightweight probe to check if the workstation API is reachable.
 * Returns true if reachable, false otherwise.
 */
export async function checkHealth(): Promise<boolean> {
  try {
    // `/health` was never a real route (this call 404'd silently — no
    // endpoint by that name exists anywhere in backend/routes/). `/barangays`
    // is the one genuinely public, no-auth, always-cheap GET in this API
    // (built for W19's pre-login picker — see BarangaysController's own
    // doc), which is exactly what a reachability probe needs: it works
    // identically before and after login, unlike an authenticated route
    // that would also fail on a merely-expired session and be
    // misread as "workstation unreachable".
    const res = await fetch(`${API_BASE_URL}/barangays`, { method: 'GET', signal: AbortSignal.timeout(3000) });
    return res.ok;
  } catch {
    return false;
  }
}

