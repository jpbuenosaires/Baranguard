import { useRef, useState } from 'react';
import { IonIcon, IonModal, IonSpinner } from '@ionic/react';
import { checkmarkCircleOutline, cloudOfflineOutline, radioOutline, warningOutline } from 'ionicons/icons';
import { isSosSilent, setSosSilent } from '../../utils/tacticalFeedback';
import { shouldDismissOnDrag, sosResultHeadline, type SosResult } from '../../utils/sosSheet';

interface Props {
  isOpen: boolean;
  raisingSos: boolean;
  /** Set once the send attempt finished: 'sent' only when the server confirmed. */
  result: SosResult | null;
  error: string | null;
  onClose: () => void;
  onConfirm: () => void;
}

/** SOS confirmation sheet: one tap to send, then a visible result inside the sheet. */
const SosConfirmSheet: React.FC<Props> = ({ isOpen, raisingSos, result, error, onClose, onConfirm }) => {
  const [dragY, setDragY] = useState(0);
  const startY = useRef<number | null>(null);
  const [silent, setSilent] = useState(isSosSilent);

  function onTouchStart(e: React.TouchEvent) {
    if (raisingSos) return;
    startY.current = e.touches[0].clientY;
  }
  function onTouchMove(e: React.TouchEvent) {
    if (startY.current === null) return;
    setDragY(Math.max(0, e.touches[0].clientY - startY.current));
  }
  function onTouchEnd() {
    if (startY.current === null) return;
    const dy = dragY;
    startY.current = null;
    setDragY(0);
    if (shouldDismissOnDrag(dy, raisingSos)) onClose();
  }

  const done = result !== null || error !== null;

  return (
    <IonModal
      isOpen={isOpen}
      canDismiss={!raisingSos}
      onDidDismiss={() => {
        if (!raisingSos) onClose();
      }}
      className="tactical-sos-modal"
    >
      <div
        className="tactical-sos-sheet sos-sheet"
        style={dragY > 0 ? { transform: `translateY(${dragY}px)` } : undefined}
      >
        <div
          className="sos-sheet__grab"
          onTouchStart={onTouchStart}
          onTouchMove={onTouchMove}
          onTouchEnd={onTouchEnd}
          onTouchCancel={onTouchEnd}
        >
          <div className="tactical-sos-sheet__handle sos-sheet__handle" />
        </div>

        {result ? (
          <div className="sos-sheet__result" role="status">
            <IonIcon
              className="sos-sheet__result-icon"
              icon={result.kind === 'sent' ? checkmarkCircleOutline : cloudOfflineOutline}
              aria-hidden="true"
            />
            <h2 className="sos-sheet__title">{sosResultHeadline(result.kind)}</h2>
            {result.detail && <p className="sos-sheet__desc">{result.detail}</p>}
          </div>
        ) : error ? (
          <div className="sos-sheet__result" role="alert">
            <IonIcon className="sos-sheet__result-icon sos-sheet__result-icon--error" icon={warningOutline} aria-hidden="true" />
            <h2 className="sos-sheet__title">SOS could not be sent</h2>
            <p className="sos-sheet__desc">{error} Call the barangay desk or your backup contact.</p>
          </div>
        ) : (
          <>
            <div className="sos-sheet__icon" aria-hidden="true">
              <IonIcon icon={warningOutline} />
            </div>
            <h2 className="sos-sheet__title">Send SOS to HQ and nearby tanods?</h2>
            <p className="sos-sheet__desc">
              Your location goes to Barangay HQ and the tanods near you. If there is no signal, the SOS is saved on this
              phone and sent when you are online.
            </p>
            <label className="sos-sheet__silent">
              <input
                type="checkbox"
                checked={silent}
                onChange={(e) => {
                  setSilent(e.target.checked);
                  setSosSilent(e.target.checked);
                }}
              />
              <span>Silent SOS (vibrate only, no siren)</span>
            </label>
          </>
        )}

        <div className="sos-sheet__actions">
          {done ? (
            <button type="button" className="sos-sheet__btn-cancel" onClick={onClose}>
              Done
            </button>
          ) : (
            <>
              <button type="button" className="sos-sheet__btn-confirm" disabled={raisingSos} onClick={onConfirm}>
                {raisingSos ? (
                  <>
                    <IonSpinner name="dots" className="sos-sheet__spinner" />
                    <span>Sending…</span>
                  </>
                ) : (
                  <>
                    <IonIcon icon={radioOutline} aria-hidden="true" />
                    <span>Confirm: send SOS</span>
                  </>
                )}
              </button>
              <button type="button" className="sos-sheet__btn-cancel" disabled={raisingSos} onClick={onClose}>
                Cancel
              </button>
            </>
          )}
        </div>
      </div>
    </IonModal>
  );
};

export default SosConfirmSheet;
