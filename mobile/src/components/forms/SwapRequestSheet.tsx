import { IonIcon, IonModal } from '@ionic/react';
import {
  calendarOutline,
  closeOutline,
  informationCircleOutline,
  locationOutline,
  swapHorizontalOutline,
  timeOutline,
} from 'ionicons/icons';
import type { ShiftEntry } from '../../services/apiService';
import { parseShiftTiming } from '../../utils/shiftTiming';
import { Button } from '../ui';

interface SwapRequestSheetProps {
  target: ShiftEntry | null;
  reason: string;
  submitting: boolean;
  error: string | null;
  onReasonChange: (value: string) => void;
  onSubmit: (target: ShiftEntry, reason: string) => void;
  onClose: () => void;
}

export function SwapRequestSheet({ target, reason, submitting, error, onReasonChange, onSubmit, onClose }: SwapRequestSheetProps) {
  return (
<IonModal
  isOpen={target !== null}
  onDidDismiss={() => {
    if (!submitting) onClose();
  }}
  initialBreakpoint={0.72}
  breakpoints={[0, 0.72, 1.0]}
  className="tactical-swap-modal"
>
  {target && (() => {
    const modalTiming = parseShiftTiming(target.startAt, target.endAt);
    return (
      <div className="tactical-swap-sheet">
        <div className="tactical-swap-modal__header">
          <h3 className="tactical-swap-modal__title">Request Shift Swap</h3>
          <button
            type="button"
            className="tactical-swap-modal__close-btn"
            onClick={onClose}
            disabled={submitting}
            aria-label="Close swap modal"
          >
            <IonIcon icon={closeOutline} />
          </button>
        </div>

        {/* Target Shift Recap Card */}
        <div className="tactical-swap-recap">
          <span className="tactical-swap-recap__label">Shift Details</span>
          <div className="tactical-swap-recap__date">
            <IonIcon icon={calendarOutline} className="icon-primary" />
            <span>{modalTiming.dateLabel}</span>
          </div>
          <div className="tactical-swap-recap__details">
            <div className="tactical-swap-recap__detail-item">
              <IonIcon icon={timeOutline} />
              <span>{modalTiming.timeRange}</span>
              {modalTiming.durationLabel && <span>({modalTiming.durationLabel} shift)</span>}
            </div>
            {target.patrolZone && (
              <div className="tactical-swap-recap__detail-item">
                <IonIcon icon={locationOutline} />
                <span>{target.patrolZone}</span>
              </div>
            )}
          </div>
        </div>

        {/* Reason / Notes Textarea */}
        <div className="tactical-swap-input-group">
          <label htmlFor="swap-reason-input" className="swap-reason-label">
            Reason for Swap (Optional)
          </label>
          <textarea
            id="swap-reason-input"
            className="tactical-swap-textarea"
            placeholder="Explain why you need coverage (e.g. family emergency, illness, schedule conflict)…"
            value={reason}
            onChange={(e) => onReasonChange(e.target.value)}
            maxLength={300}
            rows={3}
            disabled={submitting}
          />
          <span className="wf-hint">Optional. Up to 300 characters ({reason.length}/300).</span>
        </div>

        {/* Desk Routing Notice */}
        <div className="tactical-swap-notice">
          <IonIcon icon={informationCircleOutline} className="tactical-swap-notice__icon" />
          <span>
            Your request will be sent to the <strong>Desk Officer</strong> to find an available replacement Tanod.
          </span>
        </div>

        {/* Actions */}
        {error && <p className="p4w-error" role="alert">{error}</p>}

        <div className="tactical-swap-actions">
          <Button
            variant="primary"
            size="lg"
            fullWidth
            icon={swapHorizontalOutline}
            loading={submitting}
            onClick={() => onSubmit(target, reason)}
          >
            Send swap request
          </Button>
          <Button variant="ghost" fullWidth disabled={submitting} onClick={onClose}>
            Cancel
          </Button>
        </div>
      </div>
    );
  })()}
</IonModal>
  );
}
