/**
 * admin-profile.tsx — Chief Tanod console, Profile tab. Identity, the
 * device id (what the server verifies signed writes against), connection
 * state, and sign-out. No Tanod diagnostics (no offline queue, evidence
 * storage or duty state exists for this role).
 */

import { useEffect, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { IonAlert, IonContent, IonIcon, IonPage } from '@ionic/react';
import { logOutOutline, shieldCheckmarkOutline } from 'ionicons/icons';
import MobileHeader from '../../components/MobileHeader';
import { checkHealth, logout } from '../../services/apiService';
import { getDeviceId } from '../../services/deviceIdentity';
import { clearSession, loadSession, type StoredSession } from '../../services/session';

const BARANGAY_NAMES: Record<number, string> = { 1: 'Dao', 2: 'Binanuahan', 3: 'Marifosque', 4: 'Banuyo' };

const AdminProfilePage: React.FC = () => {
  const navigate = useNavigate();
  const [session, setSession] = useState<StoredSession | null>(null);
  const [deviceId, setDeviceId] = useState('');
  const [reachable, setReachable] = useState<boolean | null>(null);
  const [confirming, setConfirming] = useState(false);

  useEffect(() => {
    void loadSession().then(setSession);
    void getDeviceId().then(setDeviceId);
    void checkHealth().then(setReachable);
  }, []);

  async function handleSignOut() {
    try {
      await logout();
    } catch {
      // Offline sign-out: the local session is still cleared.
    }
    await clearSession();
    navigate('/login', { replace: true });
  }

  const barangay = session ? BARANGAY_NAMES[session.barangayId] ?? `Barangay ${session.barangayId}` : '—';
  const initials = session?.fullName
    ? session.fullName
        .split(' ')
        .map((n) => n[0])
        .slice(0, 2)
        .join('')
        .toUpperCase()
    : 'CT';

  return (
    <IonPage>
      <MobileHeader title="Profile" hideStatusIndicator />
      <IonContent className="ion-padding content-bg">
        <div className="app-column profile-layout">
          <section className="profile-identity" aria-label="Your account">
            <div className="profile-avatar-circle" aria-hidden="true">{initials}</div>
            <div className="profile-identity__body">
              <h2 className="profile-identity__name">{session?.fullName ?? 'Chief Tanod'}</h2>
              <p className="profile-identity__role">Chief Tanod, Brgy {barangay}</p>
              <span className="profile-verified-badge">
                <IonIcon icon={shieldCheckmarkOutline} aria-hidden="true" />
                Admin
              </span>
              <p className="profile-identity__line">
                Workstation: {reachable === null ? 'Checking…' : reachable ? 'Reachable' : 'Not reachable'}
              </p>
              <p className="profile-identity__line">Device: <span className="admin-device-id">{deviceId ? deviceId.slice(0, 12) : '—'}</span></p>
            </div>
          </section>

          <div className="wf-card mt-14">
            <strong className="wf-card__title">What this phone can do</strong>
            <span className="wf-muted">
              Acknowledge and resolve SOS alerts, assign or cancel dispatches, open night-dispatch offers, and read incidents. Everything
              needs a connection and nothing is queued. Reports and settings stay on the web dashboard.
            </span>
          </div>

          <button type="button" className="profile-signout-btn" onClick={() => setConfirming(true)}>
            <IonIcon icon={logOutOutline} className="icon-md" aria-hidden="true" />
            <span>Sign out</span>
          </button>
        </div>

        <IonAlert
          isOpen={confirming}
          onDidDismiss={() => setConfirming(false)}
          header="Confirm Sign Out?"
          message="You will stop receiving SOS and escalation alerts on this phone until you sign in again."
          buttons={[
            { text: 'Cancel', role: 'cancel' },
            { text: 'Sign Out', role: 'destructive', handler: handleSignOut },
          ]}
        />
      </IonContent>
    </IonPage>
  );
};

export default AdminProfilePage;
