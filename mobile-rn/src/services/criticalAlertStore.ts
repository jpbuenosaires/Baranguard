/**
 * criticalAlertStore.ts — the data side of M12 Critical Alert Overlay (§9).
 * Port of ../mobile's criticalAlertStore.ts onto `modules/critical-alert`.
 *
 * "Local cached rendering when the local API cannot be reached" is the
 * load-bearing requirement here: the overlay renders from whatever the
 * push payload itself carried, never a follow-up API call — the only
 * network call in this whole flow is Acknowledge's `POST
 * /notifications/:id/ack`, and even that failing does not hide the alert
 * (see CriticalAlertOverlay.tsx).
 *
 * No state-management library exists anywhere in this app, so this is a
 * minimal hand-rolled subscribe/notify store, same as the old app.
 * `CriticalAlertOverlay` is mounted once, at the root layout, outside the
 * tab router, so it can react to an alert regardless of which screen a
 * Tanod is on.
 *
 * `registerPushListeners()` is a documented no-op for now: this rebuild has
 * not installed `@react-native-firebase/messaging` yet, since Firebase
 * cannot even initialize without a real `google-services.json`
 * (REMAINING.md A4, still open — same gate the old app was blocked on).
 * `checkForPendingNativeAlert()` and the native full-screen alert mechanism
 * itself (`modules/critical-alert`) are fully functional today and don't
 * need Firebase at all.
 */
import { Platform } from 'react-native';
import CriticalAlert from '../../modules/critical-alert';

export type CriticalNotificationType = 'sos' | 'priority_alert' | 'dispatch';

const CRITICAL_TYPES: readonly string[] = ['sos', 'priority_alert', 'dispatch'];

export interface CriticalAlertData {
  notificationId: number;
  notificationType: CriticalNotificationType;
  title: string;
  body: string;
  /** When this device received it — informational only, never sent to the server. */
  receivedAt: string;
}

type Listener = (alert: CriticalAlertData | null) => void;

let currentAlert: CriticalAlertData | null = null;
const listeners = new Set<Listener>();

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
  // notification (id 2001) — best-effort, never blocks the in-app dismiss.
  if (Platform.OS === 'android') {
    void CriticalAlert.dismiss().catch(() => undefined);
  }
}

function parseAlert(data: Record<string, unknown> | undefined, title: string, body: string): CriticalAlertData | null {
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
 * The third way an alert can reach this store, alongside the (not yet
 * wired) foreground/tapped-from-tray push listeners: `CriticalAlertActivity`'s
 * "Open Baranguard" button cold-launches the app with no push event at all,
 * so on every cold start this checks whether that native screen just
 * stashed one. Call once from the root layout's mount effect. A no-op on
 * web/if nothing's pending.
 */
export async function checkForPendingNativeAlert(): Promise<void> {
  if (Platform.OS !== 'android') return;
  try {
    const result = await CriticalAlert.getPendingAlert();
    if (!result.pending) return;
    const alert = parseAlert(
      { notification_id: result.notificationId, notification_type: result.notificationType },
      result.title ?? 'Critical alert',
      result.body ?? '',
    );
    if (alert) {
      currentAlert = alert;
      notify();
    }
  } catch {
    // Best-effort — a missing/failing native module never blocks startup.
  }
}

/** Manual diagnostic trigger (Profile's "Test Full-Screen Alert") — exercises the same native path a real critical push will use once FCM is wired. */
export async function triggerTestCriticalAlert(): Promise<void> {
  await CriticalAlert.showTest();
}
