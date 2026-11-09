import { beforeEach, describe, expect, it, vi } from 'vitest';

type Push = { data?: Record<string, unknown>; title?: string; body?: string };
const handlers: Record<string, (p: Push | { notification: Push }) => void> = {};

vi.mock('@capacitor/core', () => ({ Capacitor: { getPlatform: () => 'android' } }));
vi.mock('@capacitor/push-notifications', () => ({
  PushNotifications: { addListener: (name: string, fn: (p: never) => void) => (handlers[name] = fn as never) },
}));
vi.mock('./fullScreenAlert', () => ({ default: { dismiss: vi.fn().mockResolvedValue(undefined), getPendingAlert: vi.fn() } }));
vi.mock('./dispatchOfferStore', () => ({ isDispatchOfferPush: () => false, requestDispatchOfferRefresh: vi.fn() }));
vi.mock('./adminSosCount', () => ({ refreshActiveSosCount: vi.fn() }));

const push = (id: number, type: string) =>
  handlers.pushNotificationReceived({ data: { notification_id: String(id), notification_type: type }, title: `t${id}`, body: '' });

describe('critical alert queue', () => {
  let store: typeof import('./criticalAlertStore');
  let seen: { id: number | null; waiting: number };

  beforeEach(async () => {
    vi.resetModules();
    store = await import('./criticalAlertStore');
    store.registerCriticalAlertListeners();
    store.subscribeToCriticalAlert((a, waiting) => (seen = { id: a?.notificationId ?? null, waiting }));
  });

  it('shows an SOS ahead of a dispatch that arrived first', () => {
    push(1, 'dispatch');
    push(2, 'sos');
    expect(seen).toEqual({ id: 2, waiting: 1 });
  });

  it('does not let a later dispatch bury an unacknowledged SOS', () => {
    push(1, 'sos');
    push(2, 'dispatch');
    expect(seen.id).toBe(1);
  });

  it('shows the next alert only after the current one is dismissed', () => {
    push(1, 'sos');
    push(2, 'priority_alert');
    store.dismissCriticalAlert();
    expect(seen).toEqual({ id: 2, waiting: 0 });
    store.dismissCriticalAlert();
    expect(seen.id).toBeNull();
  });

  it('replaces a repeat of the same notification id instead of queueing it twice', () => {
    push(1, 'sos');
    push(1, 'sos');
    expect(seen).toEqual({ id: 1, waiting: 0 });
  });

  it('ignores a push that is not a critical type or has no id', () => {
    push(1, 'report_update');
    handlers.pushNotificationReceived({ data: { notification_type: 'sos' } });
    expect(seen.id).toBeNull();
  });
});
