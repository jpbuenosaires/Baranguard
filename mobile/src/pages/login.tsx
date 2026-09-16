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
  IonAlert,
  IonButton,
  IonContent,
  IonIcon,
  IonItem,
  IonList,
  IonPage,
  IonSpinner,
} from '@ionic/react';
import {
  eyeOffOutline,
  eyeOutline,
  lockClosedOutline,
  personOutline,
  settingsOutline,
  shield,
} from 'ionicons/icons';
import { TextField } from '../components/FormFields';
import {
  ApiError,
  getApiBaseUrl,
  hasApiBaseUrlOverride,
  login,
  registerDevice,
  setApiBaseUrlOverride,
} from '../services/apiService';
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
  const [serverUrlAlertOpen, setServerUrlAlertOpen] = useState(false);
  const [serverUrlValue, setServerUrlValue] = useState(getApiBaseUrl());
  const [serverUrlMessage, setServerUrlMessage] = useState(
    'Only change this if told to by an administrator.'
  );

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
      navigate('/tabs/home', { replace: true });
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
                <IonList inset className="ion-no-margin mobile-login-form">
                  <IonItem lines="full">
                    <IonIcon icon={personOutline} slot="start" color="medium" className="mobile-login-icon" />
                    <TextField
                      label="Username"
                      autocapitalize="off"
                      value={username}
                      onChange={setUsername}
                      disabled={busy}
                    />
                  </IonItem>
                  <IonItem lines="none" style={{ position: 'relative' }}>
                    <IonIcon icon={lockClosedOutline} slot="start" color="medium" className="mobile-login-icon" />
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
                      className="mobile-login-password-toggle"
                      aria-label={showPassword ? 'Hide password' : 'Show password'}
                    >
                      <IonIcon icon={showPassword ? eyeOffOutline : eyeOutline} style={{ fontSize: '1.25rem' }} />
                    </button>
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
                  {busy ? <IonSpinner name="dots" /> : 'Sign In to Console'}
                </IonButton>

                <IonButton
                  fill="clear"
                  size="small"
                  type="button"
                  expand="block"
                  disabled={busy}
                  onClick={() => {
                    setServerUrlValue(getApiBaseUrl());
                    setServerUrlMessage('Only change this if told to by an administrator.');
                    setServerUrlAlertOpen(true);
                  }}
                >
                  <IonIcon icon={settingsOutline} slot="start" />
                  Workstation address{hasApiBaseUrlOverride() ? ' (custom)' : ''}
                </IonButton>
              </form>
            </div>
          </div>
        </div>

        <IonAlert
          isOpen={serverUrlAlertOpen}
          onDidDismiss={() => setServerUrlAlertOpen(false)}
          header="Workstation Address"
          message={serverUrlMessage}
          inputs={[
            {
              name: 'url',
              type: 'url',
              placeholder: 'https://server:8081/api/v1',
              value: serverUrlValue,
            },
          ]}
          buttons={[
            { text: 'Cancel', role: 'cancel' },
            {
              text: 'Reset to default',
              handler: () => {
                void setApiBaseUrlOverride(null);
              },
            },
            {
              text: 'Save',
              handler: (data: { url?: string }) => {
                const trimmed = (data.url ?? '').trim();
                if (!trimmed) return false;
                if (!/^https?:\/\//i.test(trimmed)) {
                  setServerUrlMessage('Enter a full address starting with http:// or https://');
                  return false;
                }
                void setApiBaseUrlOverride(trimmed);
                return true;
              },
            },
          ]}
        />
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
