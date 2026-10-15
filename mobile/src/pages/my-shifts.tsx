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
  IonContent,
  IonIcon,
  IonPage,
} from '@ionic/react';
import {
  calendarOutline,
  swapHorizontalOutline,
  timeOutline,
  hourglassOutline,
} from 'ionicons/icons';
import { useNavigate } from 'react-router-dom';
import MobileHeader from '../components/MobileHeader';
import { LoadingBlock } from '../components/LoadingBlock';
import { Banner, Button, EmptyState, ErrorState } from '../components/ui';
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
import { parseShiftTiming } from '../utils/shiftTiming';
import { ShiftCard } from '../components/forms/ShiftCard';
import { SwapRequestCard } from '../components/forms/SwapRequestCard';
import { SwapRequestSheet } from '../components/forms/SwapRequestSheet';


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
  const [swapError, setSwapError] = useState<string | null>(null);

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
    setSwapError(null);
    try {
      await requestShiftSwap(target.shiftId, reason.trim() || undefined, uuid());
      tacticalFeedback.onSuccess();
      setNote('Swap request sent to the Desk Officer for review.');
      setSwapTarget(null);
      await load();
    } catch (err) {
      tacticalFeedback.onWarning();
      setSwapError(
        err instanceof ApiError && err.isOffline
          ? 'A swap request needs a connection. Try again when you are online.'
          : err instanceof Error
            ? err.message
            : 'Could not submit the swap request.'
      );
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

  // Calculate schedule summary metrics. A shift flagged `pendingReapproval` (legacy: a swap
  // approved before 2026-10-12, awaiting re-publish) is NOT confirmed duty, so it never counts
  // toward "next duty" or hours. An approved swap now keeps the shift published.
  const { nextShift, confirmedCount, pendingReapprovalCount } = useMemo(() => {
    const now = Date.now();
    const confirmed = shifts.filter((s) => !s.pendingReapproval);
    const upcoming = confirmed.filter((s) => new Date(s.endAt).getTime() >= now);
    const next = upcoming[0] ?? confirmed[0] ?? null;

    return {
      nextShift: next,
      confirmedCount: confirmed.length,
      pendingReapprovalCount: shifts.length - confirmed.length,
    };
  }, [shifts]);

  const nextShiftTiming = nextShift ? parseShiftTiming(nextShift.startAt, nextShift.endAt) : null;

  // Calculate swap metrics
  const { pendingSwapCount } = useMemo(() => {
    let pending = 0;
    for (const r of swapRequests) {
      if (r.status === 'pending') pending++;
    }
    return { pendingSwapCount: pending };
  }, [swapRequests]);

  return (
    <IonPage>
      <MobileHeader title="My Shifts" showBack defaultBackHref="/tabs/profile" />

      <IonContent className="ion-padding content-bg">
        <div className="roster-container">
          {note && <Banner tone="info">{note}</Banner>}
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
              shifts.length > 0 && (
                <div className="roster-glance-banner" role="region" aria-label="Schedule Overview">
                  <div className="roster-glance-left">
                    <div className="roster-glance-icon" aria-hidden="true">
                      <IonIcon icon={timeOutline} />
                    </div>
                    <div>
                      <div className="roster-glance-headline">
                        {nextShiftTiming
                          ? `Next: ${nextShiftTiming.isToday ? 'Today' : nextShiftTiming.isTomorrow ? 'Tomorrow' : nextShiftTiming.dateLabel.split('·')[0].trim()} at ${nextShiftTiming.timeRange.split('–')[0].trim()}`
                          : 'No confirmed duty'}
                      </div>
                      <div className="roster-glance-sub">
                        {confirmedCount} confirmed shift{confirmedCount === 1 ? '' : 's'}
                        {pendingReapprovalCount > 0 ? ` · ${pendingReapprovalCount} pending re-approval` : ''}
                      </div>
                    </div>
                  </div>
                </div>
              )
            ) : (
              <div className="roster-glance-banner" role="region" aria-label="Swap Overview">
                <div className="roster-glance-left">
                  <div
                    className={`roster-glance-icon ${pendingSwapCount > 0 ? 'roster-glance-icon--warning' : 'roster-glance-icon--info'}`}
                    aria-hidden="true"
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
            <ErrorState
              message={error}
              onRetry={() => {
                setLoading(true);
                void load().finally(() => setLoading(false));
              }}
            />
          ) : activeTab === 'schedule' ? (
            /* Tab 1: Upcoming Schedule */
            shifts.length === 0 ? (
              <EmptyState
                icon={calendarOutline}
                title="No upcoming shifts"
                body="Only shifts the desk has published appear here. Submit your availability, then check back once the roster is published."
              />
            ) : (
              <div className="col-gap-sm">
                {shifts.map((shift) => {
                  const pendingSwap = pendingSwapForShift(shift.shiftId);
                  const isPendingReapproval = shift.pendingReapproval;
                  const isNext = !isPendingReapproval && shift.shiftId === nextShift?.shiftId;

                  return (
                    <ShiftCard
                      key={shift.shiftId}
                      shift={shift}
                      pendingSwap={pendingSwap}
                      isNext={isNext}
                      onRequestSwap={(s) => {
                        setSwapReason('');
                        setSwapError(null);
                        setSwapTarget(s);
                      }}
                    />
                  );
                })}
              </div>
            )
          ) : (
            /* Tab 2: Swap Requests */
            swapRequests.length === 0 ? (
              <EmptyState
                icon={swapHorizontalOutline}
                title="No swap requests"
                body="You haven't requested any shift coverage. If you have an upcoming conflict, select a shift from your duty schedule to request coverage."
                action={
                  <Button
                    variant="secondary"
                    icon={calendarOutline}
                    onClick={() => {
                      tacticalFeedback.onTap();
                      setActiveTab('schedule');
                    }}
                  >
                    View duty schedule
                  </Button>
                }
              />
            ) : (
              <div className="col-gap-md">
                {swapRequests.map((r) => {
                  const targetShift = shifts.find((s) => s.shiftId === r.shiftId);

                  return (
                    <SwapRequestCard
                      key={r.requestId}
                      request={r}
                      targetShift={targetShift}
                      withdrawing={withdrawingId === r.requestId}
                      onAskWithdraw={setConfirmWithdrawTarget}
                    />
                  );
                })}
              </div>
            )
          )}
        </div>

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

      <SwapRequestSheet
        target={swapTarget}
        reason={swapReason}
        submitting={submittingSwap}
        error={swapError}
        onReasonChange={setSwapReason}
        onSubmit={handleSubmitSwap}
        onClose={() => setSwapTarget(null)}
      />
    </IonPage>
  );
};

export default MyShiftsPage;
