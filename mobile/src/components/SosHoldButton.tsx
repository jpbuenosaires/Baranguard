import { useRef, useState } from 'react';
import { IonIcon, IonToast } from '@ionic/react';
import { warningOutline } from 'ionicons/icons';
import SosConfirmSheet from './home/SosConfirmSheet';
import { useSosFlow } from './home/useSosFlow';

const HOLD_MS = 800;

/** Compact SOS control for every Tanod screen except Home (which has its own dock). Hold to open the same confirm sheet. */
const SosHoldButton: React.FC<{ raised?: boolean }> = ({ raised }) => {
  const sos = useSosFlow();
  const timer = useRef<number | null>(null);
  const [holding, setHolding] = useState(false);
  const [hint, setHint] = useState(false);

  function cancelHold() {
    if (timer.current !== null) window.clearTimeout(timer.current);
    timer.current = null;
    setHolding(false);
  }
  function startHold() {
    setHolding(true);
    timer.current = window.setTimeout(() => {
      timer.current = null;
      setHolding(false);
      navigator.vibrate?.(40);
      sos.handleOpenSosModal();
    }, HOLD_MS);
  }

  return (
    <>
      <button
        type="button"
        className={`sos-hold-btn${holding ? ' sos-hold-btn--holding' : ''}${raised ? ' sos-hold-btn--raised' : ''}`}
        aria-label="Emergency SOS. Hold to open confirmation."
        disabled={sos.raisingSos}
        onPointerDown={startHold}
        onPointerUp={cancelHold}
        onPointerLeave={cancelHold}
        onPointerCancel={cancelHold}
        onContextMenu={(e) => e.preventDefault()}
        onClick={(e) => {
          // A screen-reader or keyboard activation has no pointer hold; the confirm sheet still guards it.
          if (e.detail === 0) sos.handleOpenSosModal();
          else setHint(true);
        }}
      >
        <IonIcon icon={warningOutline} aria-hidden="true" />
        <span>SOS</span>
      </button>
      <IonToast isOpen={hint} message="Hold the SOS button to send an alert." duration={2000} onDidDismiss={() => setHint(false)} />
      <IonToast
        isOpen={sos.sosToast !== null}
        message={sos.sosToast ?? ''}
        duration={4000}
        color={sos.sosToast?.startsWith('EMERGENCY') ? 'danger' : 'warning'}
        onDidDismiss={() => sos.setSosToast(null)}
      />
      <SosConfirmSheet
        isOpen={sos.confirmingSos}
        raisingSos={sos.raisingSos}
        result={sos.sosResult}
        error={sos.sosError}
        onClose={() => sos.setConfirmingSos(false)}
        onConfirm={() => void sos.handleRaiseSos()}
      />
    </>
  );
};

export default SosHoldButton;
