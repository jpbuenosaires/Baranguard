/**
 * criticalAlertStore.ts — the data side of M12 Critical Alert Overlay
 * (§9: "Critical notifications request high-priority/full-screen
 * presentation where the OS permits. The app must also support heads-up/
 * banner fallback and local cached rendering when the local API cannot be
 * reached.").
 *
 * "Local cached rendering when the local API cannot be reached" is the
 * load-bearing requirement here: the overlay must render from whatever
 * the push payload itself carried, NEVER by making a follow-up API call
 * to fetch more detail first — a Tanod on a bad connection needs to see
 * the alert the instant it arrives, not after a request that might never
 * resolve. So `PushNotifications`' `data` payload is treated as the
 * complete, authoritative content for the overlay; the only API call this
 * whole flow makes is the Acknowledge button's `POST
 * /notifications/:id/ack` (§6 "Notification acknowledgment"), and even
 * that failing does not hide the alert — see CriticalAlertOverlay.tsx.
 *
 * No state-management library exists anywhere in this app (§1's stack is
 * React + Ionic, nothing else), so this is a minimal hand-rolled
 * subscribe/notify store — the same "smallest thing that solves the
 * actual problem" instinct as this codebase's hand-rolled JWT/autoloader
 * on the backend side. `CriticalAlertOverlay` is mounted once, at the
 * `App.tsx` root (outside the tab router), specifically so it can react
 * to an alert regardless of which screen a Tanod is currently on.
 *
 * NOT DEVICE-VERIFIED. `PushNotifications.addListener` is real API surface
 * per the plugin's docs, but nothing here has ever received a real push —
 * see deviceIdentity.ts's `getFcmToken()` for the two stacked
 * prerequisites (Android SDK, a real Firebase project) neither of which
 * exist in this environment yet.
 */

import { PushNotifications, type PushNotificationSchema, type ActionPerformed } from '@capacitor/push-notifications';
import { Capacitor } from '@capacitor/core';
import FullScreenAlert from './fullScreenAlert';

export type CriticalNotificationType = 'sos' | 'priority_alert' | 'dispatch';

const CRITICAL_TYPES: readonly string[] = ['sos', 'priority_alert', 'dispatch'];

export interface CriticalAlert {
  notificationId: number;
  notificationType: CriticalNotificationType;
  title: string;
  body: string;
  /** When this device received it — informational only, never sent to the server (§2 Rule 31: client timestamps are informational). */
  receivedAt: string;
}

type Listener = (alert: CriticalAlert | null) => void;

let currentAlert: CriticalAlert | null = null;
const listeners = new Set<Listener>();
let listenersRegistered = false;

function notify(): void {
  for (const listener of listeners) listener(currentAlert);
}

/** M12's overlay subscribes here; returns an unsubscribe function. */
export function subscribeToCriticalAlert(listener: Listener): () => void {
  listeners.add(listener);
  listener(currentAlert);
  return () => listeners.delete(listener);
}

/** Called after a successful (or explicitly abandoned) acknowledge, or a manual dismiss. */
export function dismissCriticalAlert(): void {
  currentAlert = null;
  notify();
  // The overlay dismissing does not by itself clear the system heads-up
  // notification (id 2001) — `setAutoCancel` only fires on a direct tap,
  // so an in-app ACKNOWLEDGE otherwise left it in the tray (found on the
  // Infinix X6840, 2026-09-19). Best-effort: never block the in-app
  // dismiss on this, and no-op on web/if nothing was ever posted.
  if (Capacitor.getPlatform() === 'android') {
    void FullScreenAlert.dismiss().catch(() => {});
  }
}

function parseAlert(data: Record<string, unknown> | undefined, title: string, body: string): CriticalAlert | null {
  const notificationType = String(data?.notification_type ?? '');
  const notificationIdRaw = data?.notification_id;
  const notificationId = typeof notificationIdRaw === 'string' ? parseInt(notificationIdRaw, 10) : Number(notificationIdRaw);
  if (!CRITICAL_TYPES.includes(notificationType) || !Number.isFinite(notificationId)) {
    return null;
  }
  return {
    notificationId,
    notificationType: notificationType as CriticalNotificationType,
    title,
    body,
    receivedAt: new Date().toISOString(),
  };
}

/**
 * Registers the foreground/tapped-from-tray listeners exactly once for
 * the app's lifetime. Call from `App.tsx` on mount. A no-op on the web
 * platform or if push isn't available — same "never fake it" stance as
 * `getFcmToken()`.
 */
export function registerCriticalAlertListeners(): void {
  if (listenersRegistered || Capacitor.getPlatform() !== 'android') {
    return;
  }
  listenersRegistered = true;

  // App is open and in the foreground when the push arrives — this is the
  // "heads-up/banner fallback" path §9 describes, rendered entirely by
  // CriticalAlertOverlay rather than relying on the OS's own heads-up
  // notification UI (which this app does not control the styling of).
  PushNotifications.addListener('pushNotificationReceived', (notification: PushNotificationSchema) => {
    const alert = parseAlert(
      notification.data as Record<string, unknown> | undefined,
      notification.title ?? 'Critical alert',
      notification.body ?? ''
    );
    if (alert) {
      currentAlert = alert;
      notify();
    }
  });

  // Tapped from the OS notification tray (app was backgrounded/closed) —
  // the same overlay renders once the app resumes, rather than a
  // separate deep-link screen, so Acknowledge behaves identically either
  // way.
  PushNotifications.addListener('pushNotificationActionPerformed', (action: ActionPerformed) => {
    const notification = action.notification;
    const alert = parseAlert(
      notification.data as Record<string, unknown> | undefined,
      notification.title ?? 'Critical alert',
      notification.body ?? ''
    );
    if (alert) {
      currentAlert = alert;
      notify();
    }
  });
}

/**
 * C4 (2026-09-15): the third way an alert can reach this store, alongside
 * the two listeners above. `CriticalAlertActivity`'s "Open Baranguard"
 * button cold-launches the app with no Capacitor push event at all — the
 * OS never re-delivers the push that triggered it — so on every cold
 * start this checks whether that native screen just stashed one, and if
 * so feeds it through the exact same `parseAlert()` shape-guard the two
 * push listeners use, rather than trusting the native side's shape
 * unchecked. Call once from `App.tsx`'s mount effect, next to
 * `registerCriticalAlertListeners()`. A no-op on web/if nothing's
 * pending, same stance as the listener registration above.
 */
export async function checkForPendingNativeAlert(): Promise<void> {
  if (Capacitor.getPlatform() !== 'android') {
    return;
  }
  const result = await FullScreenAlert.getPendingAlert();
  if (!result.pending) {
    return;
  }
  const alert = parseAlert(
    { notification_id: result.notificationId, notification_type: result.notificationType },
    result.title,
    result.body
  );
  if (alert) {
    currentAlert = alert;
    notify();
  }
}
