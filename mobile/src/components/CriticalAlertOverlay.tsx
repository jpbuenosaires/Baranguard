/**
 * CriticalAlertOverlay.tsx — M12 Critical Alert Overlay (§9): "Critical
 * notifications request high-priority/full-screen presentation where the
 * OS permits. The app must also support heads-up/banner fallback and
 * local cached rendering when the local API cannot be reached."
 *
 * Mounted ONCE at the `App.tsx` root, outside `TabbedShell`'s router —
 * that placement is deliberate: an SOS or priority alert must interrupt
 * whichever screen a Tanod is on, not only appear if they happen to be on
 * Home. It renders nothing (`null`) whenever `criticalAlertStore` has no
 * current alert, so it costs nothing on every other screen.
 *
 * "Local cached rendering" (see criticalAlertStore.ts's own doc) means
 * this component reads ONLY what the push payload already carried —
 * never an API call to enrich the alert before showing it.
 *
 * Acknowledge calls `POST /notifications/:id/ack` (already real,
 * already verified server-side in Phase 1/2). Its failure does NOT keep
 * the overlay up — §2 Rule 7/15's offline-first stance applies here too:
 * a Tanod dismissing an alert while the workstation is unreachable must
 * still be able to dismiss it and act. The ack is fire-and-forget in that
 * case; nothing about the alert's own record is lost, since acknowledgment
 * is a distinct, idempotent, always-retriable call the server already
 * supports (§6 "the endpoint is idempotent for an already-acknowledged
 * target") — a background retry is straightforward follow-up work, not
 * something this overlay needs to solve.
 *
 * NOT DEVICE-VERIFIED — see criticalAlertStore.ts's own note.
 */

import { useEffect, useState } from 'react';
import { IonButton } from '@ionic/react';
import { subscribeToCriticalAlert, dismissCriticalAlert, type CriticalAlert } from '../services/criticalAlertStore';
import { acknowledgeNotification } from '../services/apiService';

const TYPE_LABEL: Record<CriticalAlert['notificationType'], string> = {
  sos: 'SOS ALERT',
  priority_alert: 'PRIORITY ALERT',
  dispatch: 'NEW DISPATCH',
};

const CriticalAlertOverlay: React.FC = () => {
  const [alert, setAlert] = useState<CriticalAlert | null>(null);
  const [acknowledging, setAcknowledging] = useState(false);

  useEffect(() => subscribeToCriticalAlert(setAlert), []);

  if (!alert) {
    return null;
  }

  const handleAcknowledge = async () => {
    setAcknowledging(true);
    try {
      await acknowledgeNotification(alert.notificationId);
    } catch {
      // Fire-and-forget on failure — see class doc. The alert still
      // dismisses; the ack itself is idempotent and can be retried by any
      // later mechanism without risk.
    } finally {
      setAcknowledging(false);
      dismissCriticalAlert();
    }
  };

  return (
    <div className="critical-alert-overlay" role="alertdialog" aria-live="assertive" aria-label={TYPE_LABEL[alert.notificationType]}>
      <div className="critical-alert-overlay__card">
        <p className="critical-alert-overlay__title">{TYPE_LABEL[alert.notificationType]}</p>
        <p className="critical-alert-overlay__body">{alert.body || alert.title}</p>
        <div className="critical-alert-overlay__actions">
          <IonButton expand="block" color="danger" disabled={acknowledging} onClick={handleAcknowledge}>
            {acknowledging ? 'Acknowledging…' : 'Acknowledge'}
          </IonButton>
        </div>
      </div>
    </div>
  );
};

export default CriticalAlertOverlay;
