import { IonIcon } from '@ionic/react';
import { calendarOutline, locationOutline, swapHorizontalOutline } from 'ionicons/icons';
import type { ShiftEntry, ShiftSwapRequestEntry } from '../../services/apiService';
import tacticalFeedback from '../../utils/tacticalFeedback';
import { parseShiftTiming } from '../../utils/shiftTiming';

interface ShiftCardProps {
  shift: ShiftEntry;
  pendingSwap: ShiftSwapRequestEntry | undefined;
  isNext: boolean;
  /** False for shifts that already ended: no swap button. */
  canSwap?: boolean;
  onRequestSwap: (shift: ShiftEntry) => void;
}

export function ShiftCard({ shift, pendingSwap, isNext, canSwap = true, onRequestSwap }: ShiftCardProps) {
  const timing = parseShiftTiming(shift.startAt, shift.endAt);
  const isPendingReapproval = shift.pendingReapproval;

  return (
    <article
          className={`roster-card ${isPendingReapproval ? 'roster-card--pending-reapproval' : ''}`}
      aria-label={`Shift on ${timing.dateLabel}${isPendingReapproval ? ', pending re-approval' : ''}`}
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
            <span className="status-indicator__label">Next duty</span>
          </div>
        )}
        {isPendingReapproval && (
          <div className="status-indicator status-indicator--pending">
            <span className="status-indicator__dot" aria-hidden="true" />
            <span className="status-indicator__label">Pending re-approval</span>
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
        {isPendingReapproval ? (
          <span className="roster-card__zone-row">
            This shift is waiting for the desk to re-publish it before it counts as confirmed duty.
          </span>
        ) : !canSwap && !pendingSwap ? null : pendingSwap ? (
          <div className="status-indicator status-indicator--pending">
            <span className="status-indicator__dot" aria-hidden="true" />
            <span className="status-indicator__label">Swap pending approval</span>
          </div>
        ) : (
          <button
            type="button"
            className="roster-card__swap-link"
            onClick={() => {
              tacticalFeedback.onTap();
              onRequestSwap(shift);
            }}
            aria-label={`Request shift swap for ${timing.dateLabel}`}
          >
            <IonIcon icon={swapHorizontalOutline} className="icon-primary" />
            <span>Request swap</span>
          </button>
        )}
      </div>
    </article>
  );
}
