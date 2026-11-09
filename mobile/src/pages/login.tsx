/**
 * login.tsx — Login. After authentication the app validates the device, registers FCM, checks the map
 * package version, and enters Home without blocking on the map download.
 *
 * Rules this screen honors:
 *   - `tanod` and `admin` (Chief Tanod) sign in here; secretary / punong_barangay are refused with an
 *     honest "wrong app" message and their just-opened session is ended.
 *   - No role selector: the server derives role from the account.
 *   - Generic failure message: unknown-user, wrong-password, and locked-account must be externally
 *     indistinguishable; the server already collapses them and this client must not re-introduce the
 *     distinction. A genuinely unreachable workstation gets its own honest message (a different fact).
 *   - Submit disabled while authenticating.
 *   - Post-login steps never block entry: the map-package check must not gate reaching Home, and the
 *     workstation is routinely unavailable.
 */

import { useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { IonButton, IonContent, IonIcon, IonItem, IonList, IonPage, IonSpinner } from '@ionic/react';
import { lockClosedOutline, personOutline, shield } from 'ionicons/icons';
import { TextField } from '../components/FormFields';
import { useOnline } from '../components/useOnline';
import tacticalFeedback from '../utils/tacticalFeedback';
import { ApiError, login, logout, registerDevice } from '../services/apiService';
import { clearSession } from '../services/session';
import { isMobileRole } from '../services/role';
import { getDeviceId, getDevicePublicKeyPem, getFcmToken } from '../services/deviceIdentity';
import { ensureMapPackageDownloaded } from '../services/mapPackageService';
import { storeMessageEncryptionKey } from '../services/messageEncryptionKey';
import { refreshSosFallbackContact } from '../services/sosFallbackContact';
import { refreshSchoolCache } from '../services/workflowRefresh';
import { clearSyncDeviceBlocked, markSyncDeviceBlocked, notifyLoggedIn } from '../services/syncScheduler';

const GENERIC_FAILURE = 'Unable to sign in with those credentials.';
const WRONG_APP =
  'This app is for Tanods and the Chief Tanod. Please use the Baranguard web dashboard with this account.';

const LoginPage: React.FC = () => {
  const navigate = useNavigate();
  const isOnline = useOnline();
  const [username, setUsername] = useState('');
  const [password, setPassword] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  async function handleSubmit(event: React.FormEvent) {
    event.preventDefault();
    setError(null);

    if (!username.trim() || !password) {
      tacticalFeedback.onWarning();
      setError('Enter your username and password.');
      return;
    }

    setBusy(true);
    tacticalFeedback.onTap();
    try {
      const session = await login(username.trim(), password);
      if (!isMobileRole(session.role)) {
        // Secretary / Punong Barangay are web-only: end the session we just
        // opened instead of dropping them into a console that is not theirs.
        try {
          await logout();
        } catch {
          // Best-effort; the local session is cleared regardless.
        }
        await clearSession();
        setError(WRONG_APP);
        setPassword('');
        tacticalFeedback.onWarning();
        return;
      }
      // Authentication succeeded. Everything below is best-effort setup; it must not block entry.
      tacticalFeedback.onSuccess();
      await runPostLoginSetup(session.barangayId, session.role === 'admin');
      navigate(session.role === 'admin' ? '/tabs/sos' : '/tabs/home', { replace: true });
    } catch (err) {
      tacticalFeedback.onWarning();
      if (err instanceof ApiError && err.isOffline) {
        // A different fact from bad credentials — say so honestly rather
        // than blaming the user's password.
        setError('Cannot reach the Baranguard server. Check your internet connection.');
      } else {
        setError(GENERIC_FAILURE);
      }
      setPassword('');
    } finally {
      setBusy(false);
    }
  }

  return (
    <IonPage>
      <IonContent fullscreen className="ion-no-padding">
        <div className="mobile-login-shell">
          {/* 1. Atmospheric Top Brand Hero */}
          <div className="mobile-login-hero">
            <div className="mobile-login-emblem-wrap">
              <IonIcon icon={shield} />
            </div>
            <h1 className="mobile-login-title">BARANGUARD</h1>
            <p className="mobile-login-subtitle">Field Responder Console · Barangay Peacekeeping Action Team</p>
          </div>

          {/* 2. Integrated Bottom Input Card */}
          <div className="mobile-login-content-wrap">
            <div>
              <div className="mobile-login-card-header">
                <h2 className="mobile-login-welcome-title">Sign In to Your Shift</h2>
                <p className="mobile-login-welcome-desc">Enter your assigned officer credentials</p>
              </div>

              <form onSubmit={handleSubmit}>
                <IonList inset className="ion-no-margin mobile-login-form">
                  <IonItem lines="full">
                    <IonIcon icon={personOutline} slot="start" className="mobile-login-icon" />
                    <TextField
                      label="Username"
                      autocapitalize="off"
                      autoComplete="username"
                      autoCorrect="off"
                      enterKeyHint="next"
                      value={username}
                      onChange={setUsername}
                      disabled={busy}
                    />
                  </IonItem>
                  <IonItem lines="none" style={{ position: 'relative' }}>
                    <IonIcon icon={lockClosedOutline} slot="start" className="mobile-login-icon" />
                    <TextField
                      label="Password"
                      type="password"
                      passwordToggle
                      autoComplete="current-password"
                      enterKeyHint="go"
                      value={password}
                      onChange={setPassword}
                      disabled={busy}
                    />
                  </IonItem>
                </IonList>

                {error && (
                  <div className="mobile-login-error" role="alert">
                    {error}
                  </div>
                )}

                <IonButton
                  type="submit"
                  expand="block"
                  disabled={busy}
                  className="mobile-login-submit"
                >
                  {busy ? <IonSpinner name="dots" /> : 'Sign in'}
                </IonButton>
              </form>
            </div>

            {/* 3. Diagnostic & Network Footer */}
            <div className="mobile-login-footer">
              {/* The phone's network state only (useOnline), not a server probe, so it never claims the server is reachable. */}
              <div className="mobile-login-network-pill" role="status">
                <span className={`mobile-login-dot ${isOnline ? 'mobile-login-dot--online' : 'mobile-login-dot--offline'}`} aria-hidden="true" />
                <span>{isOnline ? 'Connected to a network' : 'No connection · check mobile data or Wi-Fi'}</span>
              </div>
              <p className="mobile-login-help-text">Tanod &amp; Chief Tanod Field Personnel Only</p>
            </div>
          </div>
        </div>
      </IonContent>
    </IonPage>
  );
};

/**
 * Device registration + map-package version check.
 *
 * Every failure here is swallowed on purpose: the Tanod is already authenticated, and failing login
 * because a basemap was unreachable would strand a responder over something that has no bearing on
 * capturing an incident offline.
 */
async function runPostLoginSetup(barangayId: number, isAdmin: boolean): Promise<void> {
  try {
    const fcmToken = await getFcmToken();
    // Registration always happens, even when fcmToken is null: a device with no push capability must
    // still become the ACTIVE, sync-capable row POST /sync/batch requires. null is sent honestly and the
    // server stores it as an empty token, which NotificationDispatcher reads as "fall through to SMS".
    // Best-effort device key: a device that can't generate/read a Keystore key (or isn't Android) still
    // registers and works, just without the stronger per-request signature guarantee.
    const devicePublicKeyPem = await getDevicePublicKeyPem();
    const registration = await registerDevice({ deviceId: await getDeviceId(), fcmToken, devicePublicKeyPem });
    clearSyncDeviceBlocked();
    // Present ONLY on this device_id's first-ever registration (see DevicesController.php). Stored
    // once, never re-fetched: the server does not re-return it on later calls, deliberately.
    if (registration.messageEncryptionKey) {
      await storeMessageEncryptionKey(registration.messageEncryptionKey);
    }
  } catch (registerError) {
    // Non-fatal by design, EXCEPT that a 409 means this phone's device id
    // belongs to a different account: nothing this user saves here can sync
    // (the server refuses the whole batch). Say so instead of failing silently.
    if (registerError instanceof ApiError && registerError.status === 409) {
      markSyncDeviceBlocked();
    }
  }

  // Chief Tanod (admin): only the SOS fallback number is useful here.
  // The map package, school cache and the offline sync queue are Tanod-only
  // (and outside an admin device session's server-side allow-list).
  if (isAdmin) {
    void refreshSosFallbackContact();
    return;
  }

  // Deliberately NOT awaited: the map check must never block entry, and a multi-MB package download
  // even less so. mapPackageService.ts itself never throws (offline/server-error just means "keep
  // whatever's already installed"), and live-map.tsx re-checks on its own mount as a safety net.
  void ensureMapPackageDownloaded(barangayId);

  // The SOS fallback contact: cached now, while online, because the moment it's needed is the moment
  // the server is confirmed unreachable. Same non-blocking, non-fatal treatment.
  void refreshSosFallbackContact();

  // School list for the check-in/incident pickers — same reasoning: cached now,
  // while online, so it works offline. Best-effort and non-blocking.
  void refreshSchoolCache({ force: true });

  // Anything queued while signed out (a 401 mid-shift) can go now.
  notifyLoggedIn();
}

export default LoginPage;
