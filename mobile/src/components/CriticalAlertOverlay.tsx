/**
 * CriticalAlertOverlay.tsx — the Critical Alert Overlay: critical notifications request high-priority/
 * full-screen presentation where the OS permits, with a heads-up/banner fallback and local cached
 * rendering when the API cannot be reached.
 *
 * Mounted ONCE at the `App.tsx` root, outside `TabbedShell`'s router: an SOS or priority alert must
 * interrupt whichever screen a Tanod is on, not only Home. It renders nothing (`null`) whenever
 * `criticalAlertStore` has no current alert.
 *
 * "Local cached rendering" (see criticalAlertStore.ts) means this component reads ONLY what the push
 * payload already carried, never an API call to enrich the alert before showing it.
 *
 * Acknowledge calls `POST /notifications/:id/ack`. Its failure does NOT keep the overlay up (offline-first):
 * a Tanod dismissing an alert while the workstation is unreachable must still be able to dismiss it and
 * act. A failed ack is remembered and re-sent later by `alertAckRetry.ts` (the endpoint is idempotent for
 * an already-acknowledged target).
 */

import { useEffect, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { IonButton, IonIcon } from '@ionic/react';
import { warningOutline } from 'ionicons/icons';
import { subscribeToCriticalAlert, dismissCriticalAlert, setSosTapHandler, type CriticalAlert } from '../services/criticalAlertStore';
import { acknowledgeAlert } from '../services/alertAckRetry';
import { loadSession } from '../services/session';
import { incidentTypeLabel } from '../utils/dispatchOfferFormat';
import { formatManilaTime } from '../utils/manilaTime';

const TYPE_LABEL: Record<CriticalAlert['notificationType'], string> = {
  sos: 'SOS ALERT',
  priority_alert: 'PRIORITY ALERT',
  dispatch: 'NEW DISPATCH',
  dispatch_offer: 'DISPATCH OFFER',
};

const CriticalAlertOverlay: React.FC = () => {
  const [alert, setAlert] = useState<CriticalAlert | null>(null);
  const [waiting, setWaiting] = useState(0);
  const [acknowledging, setAcknowledging] = useState(false);
  const navigate = useNavigate();

  useEffect(
    () =>
      subscribeToCriticalAlert((next, more) => {
        setAlert(next);
        setWaiting(more);
      }),
    []
  );

  // Tapping an SOS notification in the tray opens the SOS tab for the Chief Tanod only.
  useEffect(() => {
    setSosTapHandler(() => {
      void loadSession().then((s) => {
        if (s?.role === 'admin') navigate('/tabs/sos');
      });
    });
    return () => setSosTapHandler(null);
  }, [navigate]);

  if (!alert) {
    return null;
  }

  const handleAcknowledge = async () => {
    setAcknowledging(true);
    try {
      await acknowledgeAlert(alert.notificationId);
    } catch {
      // Fire-and-forget on failure
    } finally {
      setAcknowledging(false);
      dismissCriticalAlert();
    }
  };

  const isOffer = alert.notificationType === 'dispatch_offer';
  const isSos = alert.notificationType === 'sos';

  // dispatch_offer shows ONLY incident type, barangay and time (never a
  // narrative); falls back to the server-composed body of the same facts.
  let bodyText = alert.body || alert.title;
  if (isOffer && alert.offer) {
    const when = alert.offer.createdAt ? formatManilaTime(alert.offer.createdAt) : '';
    bodyText = [incidentTypeLabel(alert.offer.incidentType), alert.offer.barangayName, when].filter(Boolean).join(' · ');
  }

  // Primary action for an offer: acknowledge (best-effort, as above) AND open
  // the offer card: Dispatches tab for a Tanod, Dispatch tab for the Chief
  // Tanod (Admin) console, the only other role this app serves.
  const handleOpenOffer = async () => {
    setAcknowledging(true);
    let target = '/tabs/assignments';
    try {
      const session = await loadSession();
      if (session?.role === 'admin') target = '/tabs/dispatch';
      await acknowledgeAlert(alert.notificationId);
    } catch {
      // Fire-and-forget on failure, same as handleAcknowledge
    } finally {
      setAcknowledging(false);
      dismissCriticalAlert();
      navigate(target);
    }
  };

  // SOS: acknowledge the notification (best-effort) and, for the Chief Tanod only, open the SOS tab.
  const handleOpenSos = async () => {
    setAcknowledging(true);
    let admin = false;
    try {
      admin = (await loadSession())?.role === 'admin';
      await acknowledgeAlert(alert.notificationId);
    } catch {
      // Fire-and-forget on failure, same as handleAcknowledge
    } finally {
      setAcknowledging(false);
      dismissCriticalAlert();
      if (admin) navigate('/tabs/sos');
    }
  };

  return (
    <div className="critical-alert-overlay" role="alertdialog" aria-live="assertive" aria-label={TYPE_LABEL[alert.notificationType]}>
      <div
        className="critical-alert-overlay__card critical-alert-overlay__card--sos"
      >
        <div className="critical-alert-overlay__head">
          <IonIcon icon={warningOutline} className="critical-alert-overlay__icon" />
          <p className="critical-alert-overlay__title critical-alert-overlay__title--flush">{TYPE_LABEL[alert.notificationType]}</p>
        </div>
        <p className="critical-alert-overlay__body">{bodyText}</p>
        {waiting > 0 && (
          <p className="critical-alert-overlay__body" role="status">
            {waiting} more alert{waiting === 1 ? '' : 's'} waiting. Acknowledge this one to see the next.
          </p>
        )}
        <div className="critical-alert-overlay__actions">
          {isOffer && (
            <IonButton
              expand="block"
              color="danger"
              disabled={acknowledging}
              onClick={handleOpenOffer}
              className="critical-alert-overlay__btn"
            >
              {acknowledging ? 'Opening…' : 'View Offer'}
            </IonButton>
          )}
          <IonButton
            expand="block"
            color="danger"
            fill={isOffer ? 'outline' : 'solid'}
            disabled={acknowledging}
            onClick={isSos ? handleOpenSos : handleAcknowledge}
            className="critical-alert-overlay__btn"
            aria-label={acknowledging ? undefined : 'Acknowledge alert'}
            // Ionic's md button uppercases its label; sentence case for this one button only.
            style={{ textTransform: 'none' }}
          >
            {acknowledging ? 'Acknowledging…' : 'Acknowledge'}
          </IonButton>
        </div>
      </div>
    </div>
  );
};

export default CriticalAlertOverlay;
