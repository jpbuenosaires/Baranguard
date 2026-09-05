/**
 * home.tsx — M2 Home (§9 Mobile).
 *
 * §9 M2: "Duty control remains primary. SOS supports the local/offline
 * fallback path ... The duty toggle must call POST /duty-status, not just
 * flip local UI state." That's the one hard requirement this screen must
 * satisfy, and it does: `handleToggleDuty` always round-trips through
 * `apiService.setDutyStatus`, and the displayed status is loaded from
 * `GET /duty-status?user_id=me` on mount rather than assumed — a Tanod
 * may have last toggled from a different device.
 *
 * SOS raises `POST /tanod-sos` (live since Sprint 4). Tapping it opens a
 * confirm step first — a false alarm dispatches real people, so this
 * follows the same confirm-before-fire pattern as sign-out below, just
 * for a materially higher-stakes action. Online-first: on success it
 * reports sent; on a network failure it stages the event in
 * `offline_queue_local` (§2 Rule 27's local/offline fallback path) via
 * `enqueueSosItem` and reports queued, never claims delivery it can't
 * back up (§2 Rule 6). Latitude/longitude are server-required — if
 * `getCurrentPosition()` fails, SOS is not sent and the reason is shown;
 * there is no fabricated fallback coordinate.
 *
 * No fabricated identity or stats (§9 M2's warning about the Figma
 * reference's fake "Juan Dela Cruz" / invented numbers): the greeting
 * name comes from the authenticated session, and nothing on this screen
 * claims a number that isn't backed by a real query.
 */

import { useEffect, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import {
  IonAlert,
  IonButton,
  IonContent,
  IonHeader,
  IonNote,
  IonPage,
  IonSpinner,
  IonTitle,
  IonToast,
  IonToolbar,
} from '@ionic/react';
import { getOwnDutyStatus, logout, postSos, setDutyStatus, type DutyStatus } from '../services/apiService';
import { ApiError } from '../services/apiService';
import { getCurrentPosition } from '../services/geolocation';
import { enqueueSosItem } from '../services/db/offlineQueueRepository';
import { clearSession, loadSession } from '../services/session';
import { uuid } from '../services/uuid';

const STATUS_LABEL: Record<DutyStatus, string> = {
  on_duty: 'On Duty',
  responding: 'Responding',
  off_duty: 'Off Duty',
};

const STATUS_PILL_CLASS: Record<DutyStatus, string> = {
  on_duty: 'status-pill--success',
  responding: 'status-pill--info',
  off_duty: 'status-pill--neutral',
};

const HomePage: React.FC = () => {
  const navigate = useNavigate();
  const [fullName, setFullName] = useState('');
  const [status, setStatus] = useState<DutyStatus | null>(null);
  const [loadingStatus, setLoadingStatus] = useState(true);
  const [toggling, setToggling] = useState(false);
  const [dutyError, setDutyError] = useState<string | null>(null);
  // §3.2 of the UI/UX review — sign-out had no confirmation at all before
  // this; a mis-tap during an active shift meant re-authenticating with
  // no warning.
  const [confirmingSignOut, setConfirmingSignOut] = useState(false);
  // §3.1 of the UI/UX review — the duty toggle previously had success
  // feedback ONLY in the form of the status pill quietly changing; a real,
  // transient confirmation (IonToast is the right pattern here, unlike
  // the app's existing inline app-error notes, which stay visible on
  // purpose for a form-validation-style error a Tanod needs to act on).
  const [dutyToast, setDutyToast] = useState<string | null>(null);
  const [confirmingSos, setConfirmingSos] = useState(false);
  const [raisingSos, setRaisingSos] = useState(false);
  const [sosError, setSosError] = useState<string | null>(null);
  const [sosToast, setSosToast] = useState<string | null>(null);

  useEffect(() => {
    loadSession().then((session) => setFullName(session?.fullName ?? ''));

    getOwnDutyStatus()
      .then((entry) => setStatus(entry?.status ?? 'off_duty'))
      .catch((error: unknown) => {
        // Own-status is a convenience, not a gate — a Tanod arriving here
        // offline can still see the screen; the toggle button itself will
        // surface the real error the moment it's actually used.
        setStatus(null);
        setDutyError(
          error instanceof ApiError && error.isOffline
            ? 'Offline — current duty status unknown until reconnected.'
            : 'Could not load current duty status.'
        );
      })
      .finally(() => setLoadingStatus(false));
  }, []);

  async function handleToggleDuty() {
    const next: DutyStatus = status === 'on_duty' ? 'off_duty' : 'on_duty';
    setDutyError(null);
    setToggling(true);
    try {
      const entry = await setDutyStatus(next, uuid());
      setStatus(entry.status);
      setDutyToast(entry.status === 'on_duty' ? "You're now on duty." : "You're now off duty.");
    } catch (error) {
      setDutyError(
        error instanceof ApiError && error.isOffline
          ? 'Cannot reach the barangay workstation — duty status was not changed.'
          : error instanceof Error
            ? error.message
            : 'Could not update duty status.'
      );
    } finally {
      setToggling(false);
    }
  }

  async function handleRaiseSos() {
    setSosError(null);
    setRaisingSos(true);
    const clientEventId = uuid();
    try {
      let position;
      try {
        position = await getCurrentPosition();
      } catch {
        setSosError('Could not get your location. SOS was not sent.');
        return;
      }
      const payload = { latitude: position.latitude, longitude: position.longitude };
      try {
        await postSos({ ...payload, clientEventId });
        setSosToast('SOS sent — Admin dispatch has been alerted.');
      } catch (error) {
        if (error instanceof ApiError && error.isOffline) {
          await enqueueSosItem(clientEventId, payload);
          setSosToast('SOS saved — it will send as soon as the connection is back.');
        } else {
          setSosError(error instanceof Error ? error.message : 'Could not raise SOS.');
        }
      }
    } finally {
      setRaisingSos(false);
    }
  }

  async function handleSignOut() {
    try {
      await logout();
    } catch {
      // §9 M10: logout must not leave the client stuck if the server is
      // unreachable. The local session is cleared either way; the server
      // session expires on its own within 15 minutes (§2 Rule 9).
    }
    await clearSession();
    navigate('/login', { replace: true });
  }

  return (
    <IonPage>
      <IonHeader>
        <IonToolbar>
          <IonTitle>Baranguard</IonTitle>
        </IonToolbar>
      </IonHeader>
      <IonContent className="ion-padding">
        {fullName && <h2 className="app-title">{fullName}</h2>}

        <div className="app-section">
          {loadingStatus ? (
            <IonSpinner name="dots" />
          ) : (
            <span className={`status-pill ${status ? STATUS_PILL_CLASS[status] : 'status-pill--neutral'}`}>
              {status ? STATUS_LABEL[status] : 'Unknown'}
            </span>
          )}
          <IonButton
            expand="block"
            className="app-stack"
            disabled={loadingStatus || toggling}
            onClick={handleToggleDuty}
          >
            {toggling ? (
              <IonSpinner name="dots" />
            ) : status === 'on_duty' ? (
              'Go Off Duty'
            ) : (
              'Go On Duty'
            )}
          </IonButton>
          {dutyError && (
            <IonNote className="app-error" role="alert">
              {dutyError}
            </IonNote>
          )}
        </div>

        <IonButton expand="block" className="app-section" onClick={() => navigate('/incidents/new')}>
          Log New Incident
        </IonButton>

        <IonButton
          expand="block"
          color="danger"
          className="app-section"
          disabled={raisingSos}
          onClick={() => setConfirmingSos(true)}
        >
          {raisingSos ? <IonSpinner name="dots" /> : 'SOS'}
        </IonButton>
        {sosError && (
          <IonNote className="app-error" role="alert">
            {sosError}
          </IonNote>
        )}

        <IonButton expand="block" fill="outline" color="medium" onClick={() => setConfirmingSignOut(true)} className="app-section">
          Sign out
        </IonButton>

        <IonToast
          isOpen={dutyToast !== null}
          message={dutyToast ?? ''}
          duration={3000}
          color="success"
          onDidDismiss={() => setDutyToast(null)}
        />

        <IonToast
          isOpen={sosToast !== null}
          message={sosToast ?? ''}
          duration={4000}
          color={sosToast?.startsWith('SOS sent') ? 'success' : 'warning'}
          onDidDismiss={() => setSosToast(null)}
        />

        <IonAlert
          isOpen={confirmingSos}
          onDidDismiss={() => setConfirmingSos(false)}
          header="Raise SOS?"
          message="This will immediately alert Admin dispatch that you need help."
          buttons={[
            { text: 'Cancel', role: 'cancel' },
            { text: 'Raise SOS', role: 'destructive', handler: handleRaiseSos },
          ]}
        />

        <IonAlert
          isOpen={confirmingSignOut}
          onDidDismiss={() => setConfirmingSignOut(false)}
          header="Sign out?"
          message="You'll need to sign in again to use the app."
          buttons={[
            { text: 'Cancel', role: 'cancel' },
            { text: 'Sign out', role: 'destructive', handler: handleSignOut },
          ]}
        />
      </IonContent>
    </IonPage>
  );
};

export default HomePage;
