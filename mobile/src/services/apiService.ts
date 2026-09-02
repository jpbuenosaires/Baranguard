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
  const json = await request<{ device_id: string; registered: boolean }>('/devices/register', {
    method: 'POST',
    body: {
      device_id: params.deviceId,
      fcm_token: params.fcmToken,
      platform: 'android', // §5 mobile_device.platform is ENUM('android')
      app_version: params.appVersion,
    },
  });
  return { deviceId: json.device_id, registered: json.registered };
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
