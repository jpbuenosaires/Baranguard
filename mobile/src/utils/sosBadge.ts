/** Pure helpers for the Chief Tanod SOS tab (badge count, list ordering). */
import type { AdminSosAlert } from '../services/apiService';

export function activeSosCount(alerts: Pick<AdminSosAlert, 'status'>[]): number {
  return alerts.filter((a) => a.status === 'active').length;
}

export function splitSosAlerts<T extends Pick<AdminSosAlert, 'status'>>(alerts: T[]): { current: T[]; earlier: T[] } {
  // Acknowledged-but-unresolved alerts stay visible (still open, and they carry the Mark resolved action).
  return {
    current: [...alerts.filter((a) => a.status === 'active'), ...alerts.filter((a) => a.status === 'acknowledged')],
    earlier: alerts.filter((a) => a.status !== 'active' && a.status !== 'acknowledged'),
  };
}

export function sosTabLabel(count: number): string {
  return count > 0 ? `SOS, ${count} active` : 'SOS';
}
