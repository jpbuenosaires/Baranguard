/**
 * login.tsx — M1 Login (§9 Mobile): "After successful authentication the
 * app validates the device, registers FCM, checks map package version,
 * and enters M2 without blocking on map download."
 *
 * kebab-case filename per §4 (pages/routes); the component itself is
 * PascalCase.
 *
 * Rules this screen honors:
 *   - **No role selector** (§9 W1's rule, and the same reasoning applies
 *     here): the server derives role from the account. §8 lists a login
 *     role-selector among the Figma patterns explicitly NOT adopted.
 *   - **Generic failure message.** §2 Rule 9 requires unknown-user,
 *     wrong-password, and locked-account to be externally
 *     indistinguishable; the server already collapses them, and this
 *     client must not re-introduce the distinction. A genuinely
 *     unreachable workstation gets its own honest message, because that
 *     is a different fact — not a credential problem.
 *   - **Submit disabled while authenticating.**
 *   - **Post-login steps never block entry.** §9 M1 is explicit that the
 *     map-package check must not gate reaching the home screen, and §2
 *     Rule 7/15 treat the workstation as routinely unavailable.
 */

import { useState } from 'react';
import { useNavigate } from 'react-router-dom';
import {
  IonButton,
  IonContent,
  IonIcon,
  IonItem,
  IonList,
  IonNote,
  IonPage,
  IonSpinner,
} from '@ionic/react';
import { eyeOffOutline, eyeOutline, lockClosedOutline, personOutline, shield } from 'ionicons/icons';
import { TextField } from '../components/FormFields';
import { ApiError, login, registerDevice } from '../services/apiService';
import { getDeviceId, getFcmToken } from '../services/deviceIdentity';
import { ensureMapPackageDownloaded } from '../services/mapPackageService';
import { storeMessageEncryptionKey } from '../services/messageEncryptionKey';
import { refreshSosFallbackContact } from '../services/sosFallbackContact';

const GENERIC_FAILURE = 'Unable to sign in with those credentials.';

const LoginPage: React.FC = () => {
  const navigate = useNavigate();
  const [username, setUsername] = useState('');
  const [password, setPassword] = useState('');
  const [showPassword, setShowPassword] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  async function handleSubmit(event: React.FormEvent) {
    event.preventDefault();
    setError(null);

    if (!username.trim() || !password) {
      setError('Enter your username and password.');
      return;
    }

    setBusy(true);
    try {
      const session = await login(username.trim(), password);
      // Authentication succeeded. Everything below is best-effort setup —
      // §9 M1: "enters M2 without blocking on map download".
      await runPostLoginSetup(session.barangayId);
      navigate('/home', { replace: true });
    } catch (err) {
      if (err instanceof ApiError && err.isOffline) {
        // A different fact from bad credentials — say so honestly rather
        // than blaming the user's password.
        setError('Cannot reach the barangay workstation. Check your connection to the barangay network.');
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
        <div className="mobile-login-bg">
          <div className="app-column" style={{ width: '100%', padding: '0 8px' }}>
            <div className="mobile-login-card">
              <div className="mobile-login-brand">
                <div className="mobile-login-emblem">
                  <IonIcon icon={shield} />
                </div>
                <h1 className="mobile-login-title">BARANGUARD</h1>
                <p className="mobile-login-subtitle">Field Responder Console</p>
              </div>

              <form onSubmit={handleSubmit}>
                <IonList inset className="ion-no-margin" style={{ borderRadius: 'var(--radius-md)', overflow: 'hidden' }}>
                  <IonItem lines="full">
                    <IonIcon icon={personOutline} slot="start" color="medium" style={{ fontSize: '1.2rem', marginRight: '8px' }} />
                    <TextField
                      label="Username"
                      autocapitalize="off"
                      value={username}
                      onChange={setUsername}
                      disabled={busy}
                    />
                  </IonItem>
                  <IonItem lines="none" style={{ position: 'relative' }}>
                    <IonIcon icon={lockClosedOutline} slot="start" color="medium" style={{ fontSize: '1.2rem', marginRight: '8px' }} />
                    <TextField
                      label="Password"
                      type={showPassword ? 'text' : 'password'}
                      value={password}
                      onChange={setPassword}
                      disabled={busy}
                    />
                    <button
                      type="button"
                      onClick={() => setShowPassword(!showPassword)}
                      style={{
                        position: 'absolute',
                        right: '12px',
                        top: '50%',
                        transform: 'translateY(-50%)',
                        background: 'transparent',
                        border: 'none',
                        color: 'var(--color-text-tertiary)',
                        padding: '4px',
                        cursor: 'pointer',
                        zIndex: 10,
                        display: 'flex',
                        alignItems: 'center',
                      }}
                      aria-label={showPassword ? 'Hide password' : 'Show password'}
                    >
                      <IonIcon icon={showPassword ? eyeOffOutline : eyeOutline} style={{ fontSize: '1.25rem' }} />
                    </button>
                  </IonItem>
                </IonList>

                {error && (
                  <div style={{ marginTop: '12px' }}>
                    <div
                      style={{
                        background: 'var(--tint-critical-bg)',
                        border: '1px solid color-mix(in srgb, var(--color-critical) 30%, transparent)',
                        borderRadius: 'var(--radius-md)',
                        padding: '10px 14px',
                        color: 'var(--pill-critical-text)',
                        fontSize: 'var(--font-size-sm)',
                        lineHeight: '1.4',
                      }}
                      role="alert"
                    >
                      {error}
                    </div>
                  </div>
                )}

                <IonButton
                  type="submit"
                  expand="block"
                  disabled={busy}
                  style={{
                    marginTop: '20px',
                    '--background': 'linear-gradient(135deg, var(--color-navy) 0%, var(--color-primary) 100%)',
                    '--border-radius': 'var(--radius-md)',
                    fontWeight: '700',
                    height: '48px',
                    boxShadow: 'var(--shadow-fab)',
                  }}
                >
                  {busy ? <IonSpinner name="dots" /> : 'Sign In to Console'}
                </IonButton>
              </form>
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
 * Every failure here is swallowed on purpose: the Tanod is already
 * authenticated, and §9 M1 requires entering the app regardless. Failing
 * login because a basemap was unreachable would strand a responder over
 * something that has no bearing on their ability to capture an incident
 * offline (§2 Rule 2).
 */
async function runPostLoginSetup(barangayId: number): Promise<void> {
  try {
    const fcmToken = await getFcmToken();
    // Registration always happens now, even when fcmToken is null —
    // explicit decision, 2026-09-13 (DevicesController.php's class doc).
    // A device with no push capability must still become the ACTIVE,
    // sync-capable row POST /sync/batch requires; skipping registration
    // entirely (the old behavior) left every device on this no-Firebase
    // deployment permanently unregistered, which only surfaced once the
    // sync scheduler started calling /sync/batch automatically. This is
    // NOT "faking" push reachability — null is sent honestly, and the
    // server stores it as an empty token, which NotificationDispatcher
    // already reads as "fall through to SMS" (Rule 12).
    const registration = await registerDevice({ deviceId: await getDeviceId(), fcmToken });
    // Sprint 4 Phase 3: present ONLY on this device_id's first-ever
    // registration — see DevicesController.php's own doc. Stored once,
    // never re-fetched (there is nowhere else to get it from — the
    // server does not re-return it on later calls, deliberately).
    if (registration.messageEncryptionKey) {
      await storeMessageEncryptionKey(registration.messageEncryptionKey);
    }
  } catch {
    // Non-fatal by design.
  }

  // Deliberately NOT awaited: §9 M1's contract is that the map check must
  // never block entry to M2, and a multi-MB package download even less
  // so. mapPackageService.ts itself never throws (offline/server-error
  // just means "keep whatever's already installed"), and live-map.tsx
  // re-checks on its own mount as a safety net for a session that never
  // reaches this point (e.g. resumed from a background service worker).
  void ensureMapPackageDownloaded(barangayId);

  // G1's SOS fallback contact (Phase 4.3) — cached now, while online,
  // because the moment it's actually needed is the moment the server is
  // confirmed unreachable. Same non-blocking, non-fatal treatment.
  void refreshSosFallbackContact();
}

export default LoginPage;
