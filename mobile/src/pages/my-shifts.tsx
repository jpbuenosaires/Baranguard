/**
 * my-shifts.tsx — M8 Shift Schedule + M9 Shift Swap Request (Mobile
 * Improvement Plan Phase 4.4, previously unbuilt — see App.tsx's own
 * comment on why Schedule dropped out of the persistent bottom tab bar
 * back in Sprint 3: used at most twice a week, not dozens of times a
 * shift, so it lives inside Profile instead of a tab slot).
 *
 * `GET /shifts` already forces a tanod caller to their own rows
 * server-side (§6) — no `?user_id=me` needed, and nothing here could
 * widen that scope even if it tried. Swap requests are raised WITHOUT a
 * `target_user_id`: picking a specific substitute needs `GET /users` to
 * know who else is a tanod in this barangay, and that endpoint is
 * Admin-only (§7) — a Tanod has no API to safely populate that picker
 * from, so this deliberately asks the desk to assign a substitute when
 * reviewing the request, rather than asking for a raw numeric user id
 * nobody would actually know.
 */

import { useCallback, useEffect, useState } from 'react';
import {
  IonAlert,
  IonButton,
  IonContent,
  IonIcon,
  IonPage,
  IonSpinner,
} from '@ionic/react';
import { calendarOutline, locationOutline, swapHorizontalOutline, timeOutline } from 'ionicons/icons';
import MobileHeader from '../components/MobileHeader';
import { ApiError, getMyShiftSwapRequests, getMyShifts, requestShiftSwap, type ShiftEntry, type ShiftSwapRequestEntry } from '../services/apiService';
import { uuid } from '../services/uuid';

const SWAP_STATUS_PILL: Record<string, string> = {
  pending: 'status-pill--pending',
  approved: 'status-pill--success',
  denied: 'status-pill--critical',
};

function formatRange(startAt: string, endAt: string): string {
  const start = new Date(startAt);
  const end = new Date(endAt);
  return `${start.toLocaleDateString()} · ${start.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}–${end.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}`;
}

const MyShiftsPage: React.FC = () => {
  const [shifts, setShifts] = useState<ShiftEntry[]>([]);
  const [swapRequests, setSwapRequests] = useState<ShiftSwapRequestEntry[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [swapTarget, setSwapTarget] = useState<ShiftEntry | null>(null);
  const [submittingSwap, setSubmittingSwap] = useState(false);
  const [note, setNote] = useState<string | null>(null);

  const load = useCallback(async () => {
    try {
      const [shiftItems, swapItems] = await Promise.all([getMyShifts(), getMyShiftSwapRequests()]);
      setShifts(shiftItems);
      setSwapRequests(swapItems);
      setError(null);
    } catch (err) {
      setError(
        err instanceof ApiError && err.isOffline
          ? 'Offline — shift schedule needs a connection to the barangay workstation.'
          : 'Could not load your shift schedule.'
      );
    }
  }, []);

  useEffect(() => {
    setLoading(true);
    load().finally(() => setLoading(false));
  }, [load]);

  function pendingSwapForShift(shiftId: number): ShiftSwapRequestEntry | undefined {
    return swapRequests.find((r) => r.shiftId === shiftId && r.status === 'pending');
  }

  async function handleSubmitSwap(target: ShiftEntry, reason: string) {
    setSubmittingSwap(true);
    try {
      await requestShiftSwap(target.shiftId, reason.trim() || undefined, uuid());
      setNote('Swap request sent — the desk will assign a substitute.');
      setSwapTarget(null);
      await load();
    } catch (err) {
      setNote(err instanceof Error ? err.message : 'Could not submit the swap request.');
    } finally {
      setSubmittingSwap(false);
    }
  }

  return (
    <IonPage>
      <MobileHeader title="MY SHIFTS" subtitle="Schedule & Swap Requests" showBack defaultBackHref="/profile" />

      <IonContent className="ion-padding" style={{ '--background': 'var(--color-bg)' }}>
        <div className="app-column">
          {loading ? (
            <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', paddingTop: 64, gap: 12 }}>
              <IonSpinner name="dots" />
              <span style={{ fontSize: 'var(--font-size-sm)', color: 'var(--color-text-secondary)' }}>Loading your schedule…</span>
            </div>
          ) : error ? (
            <div
              style={{
                background: 'var(--tint-warning-bg)',
                border: '1px solid var(--color-warning)',
                borderRadius: 'var(--radius-md)',
                padding: '10px 14px',
                color: 'var(--pill-warning-text)',
                fontSize: 'var(--font-size-sm)',
              }}
              role="status"
            >
              {error}
            </div>
          ) : shifts.length === 0 ? (
            <div className="card--elevated" style={{ textAlign: 'center', padding: '32px 16px', marginTop: '16px' }}>
              <p style={{ color: 'var(--color-text-secondary)', margin: 0 }}>No upcoming shifts have been scheduled for you yet.</p>
            </div>
          ) : (
            <div className="card-list">
              {shifts.map((shift) => {
                const pendingSwap = pendingSwapForShift(shift.shiftId);
                return (
                  <div key={shift.shiftId} className="card" style={{ padding: '14px' }}>
                    <div style={{ display: 'flex', alignItems: 'center', gap: '6px', marginBottom: '6px' }}>
                      <IonIcon icon={calendarOutline} style={{ color: 'var(--color-primary)' }} />
                      <span style={{ fontWeight: 700, color: 'var(--color-text-primary)' }}>{formatRange(shift.startAt, shift.endAt)}</span>
                    </div>
                    {shift.patrolZone && (
                      <div style={{ display: 'flex', alignItems: 'center', gap: '6px', fontSize: 'var(--font-size-sm)', color: 'var(--color-text-secondary)', marginBottom: '10px' }}>
                        <IonIcon icon={locationOutline} />
                        <span>{shift.patrolZone}</span>
                      </div>
                    )}

                    {pendingSwap ? (
                      <span className={`status-pill ${SWAP_STATUS_PILL[pendingSwap.status]}`}>SWAP REQUEST PENDING</span>
                    ) : (
                      <IonButton fill="outline" size="small" onClick={() => setSwapTarget(shift)}>
                        <IonIcon icon={swapHorizontalOutline} slot="start" />
                        Request Swap
                      </IonButton>
                    )}
                  </div>
                );
              })}
            </div>
          )}

          {swapRequests.length > 0 && (
            <>
              <h3 style={{ fontSize: 'var(--font-size-md)', fontWeight: 700, margin: '20px 0 10px', color: 'var(--color-text-primary)' }}>
                Swap Request History
              </h3>
              <div className="card-list">
                {swapRequests.map((r) => (
                  <div key={r.requestId} className="card" style={{ padding: '12px 14px' }}>
                    <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '4px' }}>
                      <span className={`status-pill ${SWAP_STATUS_PILL[r.status]}`}>{r.status.toUpperCase()}</span>
                      <span style={{ fontSize: '0.72rem', color: 'var(--color-text-tertiary)', display: 'flex', alignItems: 'center', gap: '4px' }}>
                        <IonIcon icon={timeOutline} />
                        {new Date(r.requestedAt).toLocaleDateString()}
                      </span>
                    </div>
                    {r.reason && <p style={{ margin: 0, fontSize: 'var(--font-size-sm)', color: 'var(--color-text-secondary)' }}>{r.reason}</p>}
                  </div>
                ))}
              </div>
            </>
          )}
        </div>

        <IonAlert
          isOpen={note !== null}
          onDidDismiss={() => setNote(null)}
          header="Shift Swap"
          message={note ?? ''}
          buttons={['OK']}
        />
      </IonContent>

      <IonAlert
        isOpen={swapTarget !== null}
        onDidDismiss={() => setSwapTarget(null)}
        header="Request a Shift Swap"
        message={swapTarget ? `${formatRange(swapTarget.startAt, swapTarget.endAt)}${swapTarget.patrolZone ? ` · ${swapTarget.patrolZone}` : ''}` : ''}
        inputs={[{ name: 'reason', type: 'textarea', placeholder: 'Reason (optional)' }]}
        buttons={[
          { text: 'Cancel', role: 'cancel' },
          {
            text: submittingSwap ? 'Sending…' : 'Send Request',
            handler: (data: { reason?: string }) => {
              if (swapTarget) void handleSubmitSwap(swapTarget, data.reason ?? '');
            },
          },
        ]}
      />
    </IonPage>
  );
};

export default MyShiftsPage;
