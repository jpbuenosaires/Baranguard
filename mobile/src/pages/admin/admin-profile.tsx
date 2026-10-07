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
      <MobileHeader title="Profile" subtitle="Chief Tanod Console" hideStatusIndicator />
      <IonContent className="ion-padding" style={{ '--background': 'var(--color-bg)' }}>
        <div className="app-column profile-layout">
          <div className="profile-officer-card">
            <div className="profile-officer-header">
              <div className="profile-avatar-circle">{initials}</div>
              <div className="profile-officer-meta">
                <div className="profile-officer-top-row">
                  <h2 className="profile-officer-name">{session?.fullName ?? 'Chief Tanod'}</h2>
                  <span className="profile-verified-badge">
                    <IonIcon icon={shieldCheckmarkOutline} />
                    Admin
                  </span>
                </div>
                <div className="profile-officer-role">Chief Tanod · Brgy {barangay}</div>
              </div>
            </div>
            <div className="profile-officer-stats">
              <div className="profile-stat-cell">
                <span className="profile-stat-label">Workstation</span>
                <span className="profile-stat-val">{reachable === null ? 'Checking…' : reachable ? 'Reachable' : 'Not reachable'}</span>
              </div>
              <div className="profile-stat-cell">
                <span className="profile-stat-label">Device</span>
                <span className="profile-stat-val admin-device-id">{deviceId ? deviceId.slice(0, 12) : '—'}</span>
              </div>
            </div>
          </div>

          <div className="wf-card" style={{ marginTop: 14 }}>
            <strong className="wf-card__title">What this phone can do</strong>
            <span className="wf-muted">
              Acknowledge SOS alerts, assign or cancel dispatches, open night-dispatch offers, and read incidents. Everything needs a
              connection and nothing is queued. Resolving an SOS, reports and settings stay on the web dashboard.
            </span>
          </div>

          <button type="button" className="wf-btn wf-btn--block" style={{ marginTop: 14 }} onClick={() => setConfirming(true)}>
            <IonIcon icon={logOutOutline} />
            Sign Out
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
