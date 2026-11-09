/**
 * trackingRate.ts — decides the GPS rate: FAST while on duty AND (an active
 * dispatch OR a recently raised SOS), otherwise NORMAL. Pure policy plus the
 * few inputs it needs; no imports, so any module may feed it without cycles.
 * `patrolLocationService.ts` registers the native sink and resets this on
 * patrol stop (duty end / sign-out), so FAST never outlives a shift.
 */

export const NORMAL_BROADCAST_INTERVAL_MS = 5000;
export const FAST_BROADCAST_INTERVAL_MS = 2000;
// shortcut: the phone cannot read its own SOS status (GET /tanod-sos is Admin/PB only), so an SOS counts as active for a fixed window covering the server repeat rounds (Rule 97, about 10 min); upgrade if a tanod-readable SOS status endpoint is added.
export const SOS_ACTIVE_WINDOW_MS = 15 * 60 * 1000;

const FAST_DISPATCH_STATUSES: readonly string[] = ['assigned', 'en_route', 'arrived'];

export interface TrackingInputs {
  dutyStatus: string | null;
  dispatchStatuses: readonly string[];
  sosRaisedAt: number | null;
  now: number;
}

export function isFastRate({ dutyStatus, dispatchStatuses, sosRaisedAt, now }: TrackingInputs): boolean {
  if (dutyStatus !== 'on_duty' && dutyStatus !== 'responding') return false;
  const sosActive = sosRaisedAt !== null && now - sosRaisedAt < SOS_ACTIVE_WINDOW_MS;
  return sosActive || dispatchStatuses.some((s) => FAST_DISPATCH_STATUSES.includes(s));
}

let dutyStatus: string | null = null;
let dispatchStatuses: readonly string[] = [];
let sosRaisedAt: number | null = null;
let sent = false;
let sink: ((fast: boolean) => void) | null = null;
let sosTimer: ReturnType<typeof setTimeout> | undefined;

/** Whether the GPS rate is FAST right now (also drives the foreground broadcast interval). */
export function isFastTracking(): boolean {
  return isFastRate({ dutyStatus, dispatchStatuses, sosRaisedAt, now: Date.now() });
}

export function broadcastIntervalMs(): number {
  return isFastTracking() ? FAST_BROADCAST_INTERVAL_MS : NORMAL_BROADCAST_INTERVAL_MS;
}

/** The native side; it handles its own failures (nothing is thrown from here). */
export function setFastModeSink(next: ((fast: boolean) => void) | null): void {
  sink = next;
}

function update(force = false): void {
  clearTimeout(sosTimer);
  if (sosRaisedAt !== null) {
    const remaining = SOS_ACTIVE_WINDOW_MS - (Date.now() - sosRaisedAt);
    if (remaining > 0) sosTimer = setTimeout(() => update(), remaining + 50);
    else sosRaisedAt = null;
  }
  const fast = isFastTracking();
  if (fast === sent && !force) return;
  sent = fast;
  sink?.(fast);
}

export function setTrackingDuty(status: string | null): void {
  dutyStatus = status;
  if (status !== 'on_duty' && status !== 'responding') sosRaisedAt = null; // duty end forgets the SOS
  update();
}

export function setTrackingDispatches(statuses: readonly string[]): void {
  dispatchStatuses = statuses;
  update();
}

export function noteSosRaised(): void {
  sosRaisedAt = Date.now();
  update();
}

/** Re-sends the current mode: the native service starts in NORMAL every time. */
export function reapplyTrackingRate(): void {
  update(true);
}

/** Duty end / sign-out: forget duty and SOS, so nothing can stay FAST. Dispatch rows are facts and stay. */
export function resetTrackingRate(): void {
  dutyStatus = null;
  sosRaisedAt = null;
  update();
}
