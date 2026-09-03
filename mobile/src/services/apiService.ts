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

import {
  loadSession,
  readTokenExpiry,
  saveSession,
  storeRenewedToken,
  type StoredSession,
} from './session';

/**
 * The workstation's API base URL on the LAN. §2 Rule 7: locally hosted,
 * no public internet exposure assumed — so this is a deployment-time
 * value, not a build-time constant baked in for everyone. Override with
 * VITE_API_BASE_URL at build time.
 */
const API_BASE_URL: string =
  (import.meta.env?.VITE_API_BASE_URL as string | undefined) ?? 'http://192.168.1.10/baranguard-api/api/v1';

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
}

async function request<T>(path: string, options: RequestOptions = {}): Promise<T> {
  const { method = 'GET', body, auth = true } = options;

  const headers: Record<string, string> = {};
  if (body !== undefined) headers['Content-Type'] = 'application/json';

  if (auth) {
    const session = await loadSession();
    if (!session) {
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
    });
  } catch {
    // §2 Rule 15: the workstation is a known single point of failure and
    // the app must degrade, not crash, when it is unavailable.
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
    throw new ApiError(
      response.status,
      error?.code ?? 'SERVER_ERROR',
      error?.message ?? 'Something went wrong.'
    );
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
  const json = await request<LoginResponse>('/auth/login', {
    method: 'POST',
    body: { username, password },
    auth: false,
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
 */
export async function registerDevice(params: {
  deviceId: string;
  fcmToken: string;
  appVersion?: string;
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

// --- Dispatch (§6, Sprint 1 web + Sprint 3 mobile: M5/M6) -------------------

/** §5 dispatch.status enum. */
export type DispatchStatus = 'assigned' | 'en_route' | 'arrived' | 'completed' | 'cancelled';
/** §5 dispatch.route_status enum. */
export type RouteStatus = 'available' | 'unavailable' | 'stale';

export interface DispatchEntry {
  dispatchId: number;
  incidentId: number;
  tanodId: number;
  priority: string;
  routeJson: unknown | null;
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
    routeJson: json.route_json,
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
  const json = await request<{ dispatch_id: number; status: DispatchStatus; updated_at: string }>(
    `/dispatch/${dispatchId}/status`,
    { method: 'PATCH', body: { status } }
  );
  return { dispatchId: json.dispatch_id, status: json.status, updatedAt: json.updated_at };
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
  const json = await request<{ track_id: number; received_at: string }>('/gps', {
    method: 'POST',
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

// --- Sync (§6 "Sync" section, Sprint 3) -------------------------------------

/** One item's shape for POST /sync/batch's `incidents[]` array (mirrors POST /incidents mobile body). */
export interface SyncIncidentItem {
  incident_type: string;
  raw_narrative: string;
  latitude: number | null;
  longitude: number | null;
  device_offline_created_at?: string | null;
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
}): Promise<SyncBatchResult[]> {
  const json = await request<{
    results: { client_event_id: string; server_id: number | null; status: string; reason?: string }[];
  }>('/sync/batch', {
    method: 'POST',
    body: {
      device_id: params.deviceId,
      incidents: params.incidents ?? [],
      gps_tracks: params.gpsTracks ?? [],
      duty_status_updates: params.dutyStatusUpdates ?? [],
      dispatch_status_updates: params.dispatchStatusUpdates ?? [],
      sos: [],
    },
  });
  return json.results.map((r) => ({
    clientEventId: r.client_event_id,
    serverId: r.server_id,
    status: r.status as SyncBatchResult['status'],
    reason: r.reason,
  }));
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
