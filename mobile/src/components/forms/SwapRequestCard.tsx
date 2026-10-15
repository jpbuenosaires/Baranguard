import { IonIcon, IonSpinner } from '@ionic/react';
import {
  alertCircleOutline,
  calendarOutline,
  checkmarkCircleOutline,
  closeOutline,
  locationOutline,
  timeOutline,
} from 'ionicons/icons';
import type { ShiftEntry, ShiftSwapRequestEntry } from '../../services/apiService';
import tacticalFeedback from '../../utils/tacticalFeedback';
import { parseShiftTiming } from '../../utils/shiftTiming';

interface SwapRequestCardProps {
  request: ShiftSwapRequestEntry;
  targetShift: ShiftEntry | undefined;
  withdrawing: boolean;
  onAskWithdraw: (request: ShiftSwapRequestEntry) => void;
}

export function SwapRequestCard({ request: r, targetShift, withdrawing, onAskWithdraw }: SwapRequestCardProps) {
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
        <span className="roster-swap-card__box-label">Duty to swap</span>
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
        <span className="roster-swap-card__box-label">Reason</span>
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
          <IonIcon icon={checkmarkCircleOutline} className="icon-sm" />
          <span>Approved by Desk — You are excused from this duty. A replacement Tanod has been assigned.</span>
        </div>
      )}

      {isDenied && (
        <div className="roster-swap-card__resolution roster-swap-card__resolution--denied">
          <IonIcon icon={alertCircleOutline} className="icon-sm" />
          <span>Denied by Desk — You are still scheduled to report for this duty.</span>
        </div>
      )}

      {/* Footer Action: Withdraw for Pending Requests */}
      {isPending && (
        <div className="roster-swap-card__footer">
          <button
            type="button"
            className="roster-swap-card__withdraw-btn"
            disabled={withdrawing}
            onClick={() => {
              tacticalFeedback.onTap();
              onAskWithdraw(r);
            }}
            aria-label={`Cancel swap request for ${targetTiming ? targetTiming.dateLabel : `Shift #${r.shiftId}`}`}
          >
            {withdrawing ? (
              <>
                <IonSpinner name="dots" className="spinner-16" />
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
}
