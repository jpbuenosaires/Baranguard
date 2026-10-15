import { IonIcon, IonModal, IonSpinner } from '@ionic/react';
import { radioOutline, warningOutline } from 'ionicons/icons';

interface Props {
  isOpen: boolean;
  raisingSos: boolean;
  barangayName: string;
  onClose: () => void;
  onConfirm: () => void;
}

/** Red tactical emergency SOS confirmation sheet. */
const SosConfirmSheet: React.FC<Props> = ({ isOpen, raisingSos, barangayName, onClose, onConfirm }) => (
  <IonModal
    isOpen={isOpen}
    onDidDismiss={() => {
      if (!raisingSos) onClose();
    }}
    className="tactical-sos-modal"
  >
    <div className="tactical-sos-sheet">
      <div className="tactical-sos-sheet__handle" />
      <div className="tactical-sos-sheet__icon-box">
        <IonIcon icon={warningOutline} />
      </div>

      <h2 className="tactical-sos-sheet__title">Transmit Emergency SOS?</h2>

      <p className="tactical-sos-sheet__desc">
        This will immediately broadcast high-priority distress coordinates to Barangay HQ and nearby patrol officers in Sector {barangayName}.
      </p>

      <div className="tactical-sos-sheet__actions">
        <button type="button" className="tactical-sos-btn-confirm" disabled={raisingSos} onClick={onConfirm}>
          {raisingSos ? (
            <IonSpinner name="dots" className="tactical-sos-spinner" />
          ) : (
            <>
              <IonIcon icon={radioOutline} />
              <span>Confirm &amp; Broadcast SOS</span>
            </>
          )}
        </button>

        <button type="button" className="tactical-sos-btn-cancel" disabled={raisingSos} onClick={onClose}>
          Cancel / Stand Down
        </button>
      </div>
    </div>
  </IonModal>
);

export default SosConfirmSheet;
