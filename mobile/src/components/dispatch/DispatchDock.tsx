/** Sticky bottom action dock of the assignment detail page (Phase 6 split; markup unchanged). */
import { IonFooter, IonIcon } from '@ionic/react';
import { checkmarkCircle, navigateOutline } from 'ionicons/icons';

export default function DispatchDock({
  status,
  onOpenNavigation,
  onBack,
}: {
  status: string;
  onOpenNavigation: () => void;
  onBack: () => void;
}) {
  return (
  <IonFooter className="ion-no-border dispatch-sticky-dock">
    {(status === 'en_route' || status === 'arrived') && (
      <button
        type="button"
        className="dispatch-secondary-cta"
        onClick={onOpenNavigation}
      >
        <IonIcon icon={navigateOutline} aria-hidden="true" />
        <span>{status === 'en_route' ? 'Resume navigation' : 'Open tactical map'}</span>
      </button>
    )}

    {status === 'completed' && (
      <div className="dock-completed-group">
        <div className="dispatch-completed-banner">
          <IonIcon icon={checkmarkCircle} className="dispatch-completed-banner__icon" />
          <span>Dispatch Completed</span>
        </div>

        <button
          type="button"
          className="dispatch-secondary-cta"
          onClick={onBack}
        >
          <span>Back to Dispatches</span>
        </button>
      </div>
    )}
  </IonFooter>
  );
}
