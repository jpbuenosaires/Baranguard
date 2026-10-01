/**
 * my-shifts.tsx — M8 Shift Schedule + M9 Shift Swap Request (§9 Mobile).
 *
 * COMPLETE GROUND-UP REDESIGN:
 * Clean, ergonomic duty roster and swap tracker built from scratch for field responders.
 *
 * UX & ACCESSIBILITY ENHANCEMENTS:
 * 1. Clean Duty Roster Cards:
 *    - Eliminated box-in-a-box nesting (inner grey container) and thick blue outlines.
 *    - Established clear visual hierarchy: Date Header -> Bold Patrol Hours -> Assigned Zone -> Contextual Action.
 * 2. Roster Glance Metric Banner:
 *    - Immediate top overview showing when the next patrol begins and total scheduled weekly hours.
 * 3. Two-Segment Navigation (Schedule vs Swap Requests):
 *    - Segment toggle ensuring pending swap approvals are never lost below a long schedule list.
 * 4. Contextual Shift Swap Actions:
 *    - Replaced heavy repetitive buttons with a clean, ergonomic action link and bottom sheet modal.
 */

import { useCallback, useEffect, useMemo, useState } from 'react';
import {
  IonAlert,
  IonButton,
  IonContent,
  IonIcon,
  IonModal,
  IonPage,
  IonSpinner,
} from '@ionic/react';
import {
  calendarOutline,
  closeOutline,
  informationCircleOutline,
  locationOutline,
  swapHorizontalOutline,
  timeOutline,
  checkmarkCircleOutline,
  closeCircleOutline,
  hourglassOutline,
  alertCircleOutline,
} from 'ionicons/icons';
import { useNavigate } from 'react-router-dom';
import MobileHeader from '../components/MobileHeader';
import { LoadingBlock } from '../components/LoadingBlock';
import {
  ApiError,
  cancelShiftSwapRequest,
  getMyShiftSwapRequests,
  getMyShifts,
  requestShiftSwap,
  type ShiftEntry,
  type ShiftSwapRequestEntry,
} from '../services/apiService';
import { uuid } from '../services/uuid';
import tacticalFeedback from '../utils/tacticalFeedback';


interface FormattedShiftTime {
  dateLabel: string;
  isToday: boolean;
  isTomorrow: boolean;
  timeRange: string;
  durationLabel: string;
}

function parseShiftTiming(startAt: string, endAt: string): FormattedShiftTime {
  const start = new Date(startAt);
  const end = new Date(endAt);

  const now = new Date();
  const todayStr = now.toDateString();
  const tomorrow = new Date(now);
  tomorrow.setDate(tomorrow.getDate() + 1);
  const tomorrowStr = tomorrow.toDateString();

  const isToday = start.toDateString() === todayStr;
  const isTomorrow = start.toDateString() === tomorrowStr;

  const dateOptions: Intl.DateTimeFormatOptions = {
    weekday: 'long',
    month: 'short',
    day: 'numeric',
  };
  const baseDate = start.toLocaleDateString(undefined, dateOptions);
  const dateLabel = isToday ? `Today · ${baseDate}` : isTomorrow ? `Tomorrow · ${baseDate}` : baseDate;

  const startTimeStr = start.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
  const endTimeStr = end.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
  const diffHours = Math.round((end.getTime() - start.getTime()) / (1000 * 60 * 60));
  const durationLabel = diffHours > 0 ? `${diffHours}h` : '';

  return {
    dateLabel,
    isToday,
    isTomorrow,
    timeRange: `${startTimeStr} – ${endTimeStr}`,
    durationLabel,
  };
}

const MyShiftsPage: React.FC = () => {
  const navigate = useNavigate();
  const [shifts, setShifts] = useState<ShiftEntry[]>([]);
  const [swapRequests, setSwapRequests] = useState<ShiftSwapRequestEntry[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [activeTab, setActiveTab] = useState<'schedule' | 'swaps'>('schedule');
  const [swapTarget, setSwapTarget] = useState<ShiftEntry | null>(null);
  const [swapReason, setSwapReason] = useState<string>('');
  const [submittingSwap, setSubmittingSwap] = useState(false);
  const [withdrawingId, setWithdrawingId] = useState<number | null>(null);
  const [confirmWithdrawTarget, setConfirmWithdrawTarget] = useState<ShiftSwapRequestEntry | null>(null);
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
          ? 'Offline — Connect to the internet or Barangay Wi-Fi to refresh schedule.'
          : 'Could not load your duty schedule.'
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
      tacticalFeedback.onSuccess();
      setNote('Swap request sent to the Desk Officer for review.');
      setSwapTarget(null);
      await load();
    } catch (err) {
      tacticalFeedback.onWarning();
      setNote(err instanceof Error ? err.message : 'Could not submit the swap request.');
    } finally {
      setSubmittingSwap(false);
    }
  }

  async function handleWithdraw(requestId: number) {
    setWithdrawingId(requestId);
    try {
      await cancelShiftSwapRequest(requestId);
      tacticalFeedback.onSuccess();
      setNote('Swap request cancelled.');
      await load();
    } catch (err) {
      tacticalFeedback.onWarning();
      setNote(err instanceof Error ? err.message : 'Could not cancel the swap request.');
    } finally {
      setWithdrawingId(null);
      setConfirmWithdrawTarget(null);
    }
  }

  // Calculate schedule summary metrics
  const { nextShift, totalScheduledHours } = useMemo(() => {
    const now = Date.now();
    const upcoming = shifts.filter((s) => new Date(s.endAt).getTime() >= now);
    const next = upcoming[0] ?? shifts[0] ?? null;

    let hours = 0;
    for (const s of shifts) {
      const start = new Date(s.startAt).getTime();
      const end = new Date(s.endAt).getTime();
      hours += Math.max(0, Math.round((end - start) / (1000 * 60 * 60)));
    }

    return { nextShift: next, totalScheduledHours: hours };
  }, [shifts]);

  const nextShiftTiming = nextShift ? parseShiftTiming(nextShift.startAt, nextShift.endAt) : null;

  // Calculate swap metrics
  const { pendingSwapCount, resolvedSwapCount } = useMemo(() => {
    let pending = 0;
    let resolved = 0;
    for (const r of swapRequests) {
      if (r.status === 'pending') pending++;
      else resolved++;
    }
    return { pendingSwapCount: pending, resolvedSwapCount: resolved };
  }, [swapRequests]);

  return (
    <IonPage>
      <MobileHeader title="My Shifts" showBack defaultBackHref="/tabs/profile" />

      <IonContent className="ion-padding" style={{ '--background': 'var(--color-bg)' }}>
        <div className="roster-container">
          {/* Availability entry point — the desk builds the roster from what Tanods submit here. */}
          <button
            type="button"
            className="profile-nav-card"
            onClick={() => {
              tacticalFeedback.onTap();
              navigate('/tabs/availability');
            }}
          >
            <div className="profile-nav-card__icon-box profile-nav-card__icon-box--green">
              <IonIcon icon={calendarOutline} />
            </div>
            <div className="profile-nav-card__body">
              <div className="profile-nav-card__title-row">
                <h3 className="profile-nav-card__title">My Availability</h3>
              </div>
              <p className="profile-nav-card__sub">
                Tell the desk which days and hours you can serve. Only shifts the desk has published appear below.
              </p>
            </div>
          </button>

          {/* Roster Glance Overview Metric Banner (Dynamic for Schedule vs Swaps) */}
          {!loading && !error && (
            activeTab === 'schedule' ? (
              shifts.length > 0 && nextShiftTiming && (
                <div className="roster-glance-banner" role="region" aria-label="Schedule Overview">
                  <div className="roster-glance-left">
                    <div className="roster-glance-icon" aria-hidden="true">
                      <IonIcon icon={timeOutline} />
                    </div>
                    <div>
                      <div className="roster-glance-headline">
                        Next: {nextShiftTiming.isToday ? 'Today' : nextShiftTiming.isTomorrow ? 'Tomorrow' : nextShiftTiming.dateLabel.split('·')[0].trim()} at {nextShiftTiming.timeRange.split('–')[0].trim()}
                      </div>
                      <div className="roster-glance-sub">
                        {shifts.length} upcoming shift{shifts.length > 1 ? 's' : ''}
                      </div>
                    </div>
                  </div>
                </div>
              )
            ) : (
              <div className="roster-glance-banner" role="region" aria-label="Swap Overview">
                <div className="roster-glance-left">
                  <div
                    className="roster-glance-icon"
                    aria-hidden="true"
                    style={{
                      color: pendingSwapCount > 0 ? 'var(--color-warning)' : 'var(--color-primary)',
                      background: pendingSwapCount > 0 ? 'var(--tint-warning-bg)' : 'var(--tint-info-bg)',
                    }}
                  >
                    <IonIcon icon={pendingSwapCount > 0 ? hourglassOutline : swapHorizontalOutline} />
                  </div>
                  <div>
                    <div className="roster-glance-headline">
                      {pendingSwapCount > 0
                        ? `${pendingSwapCount} Swap Request${pendingSwapCount > 1 ? 's' : ''} Awaiting Review`
                        : swapRequests.length > 0
                          ? 'All Swap Requests Resolved'
                          : 'No Swap Requests'}
                    </div>
                    <div className="roster-glance-sub">
                      {pendingSwapCount > 0
                        ? 'The Desk Officer is reviewing your request for coverage.'
                        : swapRequests.length > 0
                          ? `${swapRequests.length} total request${swapRequests.length > 1 ? 's' : ''} on file`
                          : 'Select an upcoming shift to request coverage.'}
                    </div>
                  </div>
                </div>
              </div>
            )
          )}

          {/* Two-Segment Navigation Bar */}
          {!loading && !error && (
            <div className="roster-segment-bar" role="tablist" aria-label="Roster view switcher">
              <button
                type="button"
                role="tab"
                aria-selected={activeTab === 'schedule'}
                className={`roster-segment-tab ${activeTab === 'schedule' ? 'roster-segment-tab--active' : ''}`}
                onClick={() => {
                  tacticalFeedback.onTap();
                  setActiveTab('schedule');
                }}
              >
                <span>Upcoming Schedule</span>
                <span className="roster-segment-count">{shifts.length}</span>
              </button>

              <button
                type="button"
                role="tab"
                aria-selected={activeTab === 'swaps'}
                className={`roster-segment-tab ${activeTab === 'swaps' ? 'roster-segment-tab--active' : ''}`}
                onClick={() => {
                  tacticalFeedback.onTap();
                  setActiveTab('swaps');
                }}
              >
                <span>Swap Requests</span>
                <span className="roster-segment-count">{swapRequests.length}</span>
              </button>
            </div>
          )}

          {/* Loading Block */}
          {loading ? (
            <LoadingBlock label="Loading duty schedule…" />
          ) : error ? (
            <div
              style={{
                background: 'var(--tint-warning-bg)',
                border: '1px solid var(--color-warning)',
                borderRadius: 'var(--radius-md)',
                padding: 'var(--spacing-md)',
                color: 'var(--pill-warning-text)',
                fontSize: 'var(--font-size-sm)',
                fontWeight: 600,
              }}
              role="alert"
            >
              {error}
            </div>
          ) : activeTab === 'schedule' ? (
            /* Tab 1: Upcoming Schedule */
            shifts.length === 0 ? (
              <div
                className="card--elevated"
                style={{
                  textAlign: 'center',
                  padding: 'var(--spacing-2xl) var(--spacing-lg)',
                  display: 'flex',
                  flexDirection: 'column',
                  alignItems: 'center',
                  marginTop: 'var(--spacing-md)',
                }}
              >
                <div
                  style={{
                    width: '56px',
                    height: '56px',
                    borderRadius: '50%',
                    background: 'var(--tint-neutral-bg)',
                    color: 'var(--color-text-secondary)',
                    display: 'flex',
                    alignItems: 'center',
                    justifyContent: 'center',
                    fontSize: '1.5rem',
                    marginBottom: 'var(--spacing-md)',
                  }}
                >
                  <IonIcon icon={calendarOutline} />
                </div>
                <h3 style={{ margin: '0 0 var(--spacing-xs)', fontSize: 'var(--font-size-lg)', fontWeight: 700 }}>
                  No Upcoming Shifts
                </h3>
                <p style={{ margin: 0, color: 'var(--color-text-secondary)', fontSize: 'var(--font-size-sm)', maxWidth: '280px' }}>
                  No published duties right now. Submit your availability, then check back once the desk publishes the roster.
                </p>
              </div>
            ) : (
              <div style={{ display: 'flex', flexDirection: 'column', gap: 'var(--spacing-sm)' }}>
                {shifts.map((shift) => {
                  const pendingSwap = pendingSwapForShift(shift.shiftId);
                  const timing = parseShiftTiming(shift.startAt, shift.endAt);
                  const isNext = shift.shiftId === nextShift?.shiftId;

                  return (
                    <article
                      key={shift.shiftId}
                      className="roster-card"
                      aria-label={`Shift on ${timing.dateLabel}`}
                    >
                      {/* Top: Date & Next Up Indicator */}
                      <div className="roster-card__top">
                        <div className="roster-card__date-group">
                          <IonIcon icon={calendarOutline} className="roster-card__cal-icon" />
                          <span className="roster-card__date">{timing.dateLabel}</span>
                        </div>
                        {isNext && (
                          <div className="status-indicator status-indicator--info">
                            <span className="status-indicator__dot" aria-hidden="true" />
                            <span className="status-indicator__label">Next Duty</span>
                          </div>
                        )}
                      </div>

                      {/* Middle: Hours & Duration */}
                      <div className="roster-card__hours-row">
                        <span className="roster-card__hours">{timing.timeRange}</span>
                        {timing.durationLabel && (
                          <span className="roster-card__duration">({timing.durationLabel} shift)</span>
                        )}
                      </div>

                      {/* Patrol Zone */}
                      {shift.patrolZone && (
                        <div className="roster-card__zone-row">
                          <IonIcon icon={locationOutline} className="roster-card__zone-icon" />
                          <span>{shift.patrolZone}</span>
                        </div>
                      )}

                      <div className="roster-card__divider" aria-hidden="true" />

                      {/* Footer: Contextual Swap Action */}
                      <div className="roster-card__footer">
                        {pendingSwap ? (
                          <div className="status-indicator status-indicator--pending">
                            <span className="status-indicator__dot" aria-hidden="true" />
                            <span className="status-indicator__label">Swap Pending Approval</span>
                          </div>
                        ) : (
                          <button
                            type="button"
                            className="roster-card__swap-link"
                            onClick={() => {
                              tacticalFeedback.onTap();
                              setSwapReason('');
                              setSwapTarget(shift);
                            }}
                            aria-label={`Request shift swap for ${timing.dateLabel}`}
                          >
                            <IonIcon icon={swapHorizontalOutline} style={{ color: 'var(--color-primary)' }} />
                            <span>Request Swap</span>
                          </button>
                        )}
                      </div>
                    </article>
                  );
                })}
              </div>
            )
          ) : (
            /* Tab 2: Swap Requests */
            swapRequests.length === 0 ? (
              <div className="roster-empty-card" role="region" aria-label="No Swap Requests">
                <div className="roster-empty-icon" aria-hidden="true">
                  <IonIcon icon={swapHorizontalOutline} />
                </div>
                <h3 className="roster-empty-title">No Swap Requests</h3>
                <p className="roster-empty-desc">
                  You haven't requested any shift coverage. If you have an upcoming conflict, select a shift from your duty schedule to request coverage.
                </p>
                <button
                  type="button"
                  className="roster-empty-cta"
                  onClick={() => {
                    tacticalFeedback.onTap();
                    setActiveTab('schedule');
                  }}
                >
                  <IonIcon icon={calendarOutline} />
                  <span>View Duty Schedule</span>
                </button>
              </div>
            ) : (
              <div style={{ display: 'flex', flexDirection: 'column', gap: 'var(--spacing-md)' }}>
                {swapRequests.map((r) => {
                  const targetShift = shifts.find((s) => s.shiftId === r.shiftId);
                  const targetTiming = targetShift ? parseShiftTiming(targetShift.startAt, targetShift.endAt) : null;
                  const isPending = r.status === 'pending';
                  const isApproved = r.status === 'approved';
                  const isDenied = r.status === 'denied';

                  return (
                    <article
                      key={r.requestId}
                      className="roster-swap-card"
                      aria-label={`Swap request for ${targetTiming ? targetTiming.dateLabel : `Shift #${r.shiftId}`}`}
                    >
                      {/* Top: Status Indicator + Submission Date */}
                      <div className="roster-swap-card__top">
                        <div className={`status-indicator status-indicator--${isPending ? 'pending' : isApproved ? 'success' : 'critical'}`}>
                          <span className="status-indicator__dot" aria-hidden="true" />
                          <span className="status-indicator__label">
                            {isPending ? 'Pending Desk Review' : isApproved ? 'Swap Approved' : 'Swap Denied'}
                          </span>
                        </div>
                        <span className="roster-swap-card__date">
                          <IonIcon icon={timeOutline} />
                          <span>Requested on {new Date(r.requestedAt).toLocaleDateString([], { month: 'short', day: 'numeric', year: 'numeric' })}</span>
                        </span>
                      </div>

                      {/* Affected Duty Shift Box */}
                      <div className="roster-swap-card__shift-box">
                        <span className="roster-swap-card__box-label">DUTY TO SWAP</span>
                        {targetShift && targetTiming ? (
                          <div className="roster-swap-card__shift-content">
                            <div className="roster-swap-card__shift-date-row">
                              <IonIcon icon={calendarOutline} className="roster-swap-card__cal-icon" />
                              <span className="roster-swap-card__shift-date">{targetTiming.dateLabel}</span>
                            </div>
                            <div className="roster-swap-card__shift-hours-row">
                              <IonIcon icon={timeOutline} className="roster-swap-card__time-icon" />
                              <span className="roster-swap-card__shift-hours">{targetTiming.timeRange}</span>
                              {targetTiming.durationLabel && (
                                <span className="roster-swap-card__shift-duration">({targetTiming.durationLabel} shift)</span>
                              )}
                            </div>
                            {targetShift.patrolZone && (
                              <div className="roster-swap-card__shift-zone-row">
                                <IonIcon icon={locationOutline} className="roster-swap-card__zone-icon" />
                                <span>{targetShift.patrolZone}</span>
                              </div>
                            )}
                          </div>
                        ) : (
                          <div className="roster-swap-card__shift-fallback">
                            <IonIcon icon={calendarOutline} />
                            <span>Shift Record #{r.shiftId}</span>
                          </div>
                        )}
                      </div>

                      {/* Reason Provided Box */}
                      <div className="roster-swap-card__reason-box">
                        <span className="roster-swap-card__box-label">REASON</span>
                        {r.reason ? (
                          <p className="roster-swap-card__reason-text">"{r.reason}"</p>
                        ) : (
                          <p className="roster-swap-card__reason-text roster-swap-card__reason-text--empty">
                            No reason note provided.
                          </p>
                        )}
                      </div>

                      {/* Resolution Notices */}
                      {isApproved && (
                        <div className="roster-swap-card__resolution roster-swap-card__resolution--approved">
                          <IonIcon icon={checkmarkCircleOutline} style={{ fontSize: '1.1rem', flexShrink: 0 }} />
                          <span>Approved by Desk — You are excused from this duty. A replacement Tanod has been assigned.</span>
                        </div>
                      )}

                      {isDenied && (
                        <div className="roster-swap-card__resolution roster-swap-card__resolution--denied">
                          <IonIcon icon={alertCircleOutline} style={{ fontSize: '1.1rem', flexShrink: 0 }} />
                          <span>Denied by Desk — You are still scheduled to report for this duty.</span>
                        </div>
                      )}

                      {/* Footer Action: Withdraw for Pending Requests */}
                      {isPending && (
                        <div className="roster-swap-card__footer">
                          <button
                            type="button"
                            className="roster-swap-card__withdraw-btn"
                            disabled={withdrawingId === r.requestId}
                            onClick={() => {
                              tacticalFeedback.onTap();
                              setConfirmWithdrawTarget(r);
                            }}
                            aria-label={`Cancel swap request for ${targetTiming ? targetTiming.dateLabel : `Shift #${r.shiftId}`}`}
                          >
                            {withdrawingId === r.requestId ? (
                              <>
                                <IonSpinner name="dots" style={{ width: '16px', height: '16px' }} />
                                <span>Cancelling…</span>
                              </>
                            ) : (
                              <>
                                <IonIcon icon={closeOutline} />
                                <span>Cancel Swap Request</span>
                              </>
                            )}
                          </button>
                        </div>
                      )}
                    </article>
                  );
                })}
              </div>
            )
          )}
        </div>

        <IonAlert
          isOpen={note !== null}
          onDidDismiss={() => setNote(null)}
          header="Duty Schedule"
          message={note ?? ''}
          buttons={['OK']}
        />

        <IonAlert
          isOpen={confirmWithdrawTarget !== null}
          onDidDismiss={() => setConfirmWithdrawTarget(null)}
          header="Cancel Swap Request"
          message="Cancel this coverage request? You will remain scheduled to report for this duty."
          buttons={[
            {
              text: 'Keep Request',
              role: 'cancel',
              handler: () => {
                tacticalFeedback.onTap();
                setConfirmWithdrawTarget(null);
              },
            },
            {
              text: 'Cancel Swap',
              role: 'destructive',
              handler: () => {
                if (confirmWithdrawTarget) {
                  handleWithdraw(confirmWithdrawTarget.requestId);
                }
              },
            },
          ]}
        />
      </IonContent>

      {/* Shift Swap Bottom Sheet Modal */}
      <IonModal
        isOpen={swapTarget !== null}
        onDidDismiss={() => {
          if (!submittingSwap) setSwapTarget(null);
        }}
        initialBreakpoint={0.72}
        breakpoints={[0, 0.72, 1.0]}
        className="tactical-swap-modal"
      >
        {swapTarget && (() => {
          const modalTiming = parseShiftTiming(swapTarget.startAt, swapTarget.endAt);
          return (
            <div className="tactical-swap-sheet">
              <div className="tactical-swap-modal__header">
                <h3 className="tactical-swap-modal__title">Request Shift Swap</h3>
                <button
                  type="button"
                  className="tactical-swap-modal__close-btn"
                  onClick={() => setSwapTarget(null)}
                  disabled={submittingSwap}
                  aria-label="Close swap modal"
                >
                  <IonIcon icon={closeOutline} />
                </button>
              </div>

              {/* Target Shift Recap Card */}
              <div className="tactical-swap-recap">
                <span className="tactical-swap-recap__label">Shift Details</span>
                <div className="tactical-swap-recap__date">
                  <IonIcon icon={calendarOutline} style={{ color: 'var(--color-primary)' }} />
                  <span>{modalTiming.dateLabel}</span>
                </div>
                <div className="tactical-swap-recap__details">
                  <div className="tactical-swap-recap__detail-item">
                    <IonIcon icon={timeOutline} />
                    <span>{modalTiming.timeRange}</span>
                    {modalTiming.durationLabel && <span>({modalTiming.durationLabel} shift)</span>}
                  </div>
                  {swapTarget.patrolZone && (
                    <div className="tactical-swap-recap__detail-item">
                      <IonIcon icon={locationOutline} />
                      <span>{swapTarget.patrolZone}</span>
                    </div>
                  )}
                </div>
              </div>

              {/* Reason / Notes Textarea */}
              <div className="tactical-swap-input-group">
                <label
                  htmlFor="swap-reason-input"
                  style={{
                    fontSize: 'var(--font-size-label)',
                    fontWeight: 700,
                    textTransform: 'uppercase',
                    letterSpacing: '0.04em',
                    color: 'var(--color-text-secondary)',
                  }}
                >
                  Reason for Swap (Optional)
                </label>
                <textarea
                  id="swap-reason-input"
                  className="tactical-swap-textarea"
                  placeholder="Explain why you need coverage (e.g. family emergency, illness, schedule conflict)…"
                  value={swapReason}
                  onChange={(e) => setSwapReason(e.target.value)}
                  maxLength={300}
                  rows={3}
                />
              </div>

              {/* Desk Routing Notice */}
              <div className="tactical-swap-notice">
                <IonIcon icon={informationCircleOutline} className="tactical-swap-notice__icon" />
                <span>
                  Your request will be sent to the <strong>Desk Officer</strong> to find an available replacement Tanod.
                </span>
              </div>

              {/* Actions */}
              <div className="tactical-swap-actions">
                <button
                  type="button"
                  className="tactical-swap-btn-submit"
                  disabled={submittingSwap}
                  onClick={() => handleSubmitSwap(swapTarget, swapReason)}
                >
                  {submittingSwap ? (
                    <IonSpinner name="dots" style={{ width: '20px', height: '20px' }} />
                  ) : (
                    <>
                      <IonIcon icon={swapHorizontalOutline} style={{ fontSize: '1.2rem' }} />
                      <span>Submit Swap Request</span>
                    </>
                  )}
                </button>

                <button
                  type="button"
                  className="tactical-swap-btn-cancel"
                  disabled={submittingSwap}
                  onClick={() => setSwapTarget(null)}
                >
                  Cancel
                </button>
              </div>
            </div>
          );
        })()}
      </IonModal>
    </IonPage>
  );
};

export default MyShiftsPage;
