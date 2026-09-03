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
  IonItem,
  IonList,
  IonNote,
  IonPage,
  IonSpinner,
  IonText,
} from '@ionic/react';
import { TextField } from '../components/FormFields';
import { ApiError, getMapPackage, login, registerDevice } from '../services/apiService';
import { getDeviceId, getFcmToken } from '../services/deviceIdentity';
import { storeMessageEncryptionKey } from '../services/messageEncryptionKey';

const GENERIC_FAILURE = 'Unable to sign in with those credentials.';

const LoginPage: React.FC = () => {
  const navigate = useNavigate();
  const [username, setUsername] = useState('');
  const [password, setPassword] = useState('');
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
      <IonContent className="ion-padding">
        <div className="app-column">
          <IonText>
            <h1 className="app-title">Baranguard</h1>
            <p className="app-subtitle">Tanod sign in</p>
          </IonText>

          <form onSubmit={handleSubmit}>
            <IonList inset>
              <IonItem>
                <TextField
                  label="Username"
                  autocapitalize="off"
                  value={username}
                  onChange={setUsername}
                  disabled={busy}
                />
              </IonItem>
              <IonItem>
                <TextField
                  label="Password"
                  type="password"
                  value={password}
                  onChange={setPassword}
                  disabled={busy}
                />
              </IonItem>
            </IonList>

            {error && (
              <IonNote className="app-error" role="alert">
                {error}
              </IonNote>
            )}

            <IonButton type="submit" expand="block" disabled={busy}>
              {busy ? <IonSpinner name="dots" /> : 'Sign in'}
            </IonButton>
          </form>
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
    if (fcmToken) {
      const registration = await registerDevice({ deviceId: await getDeviceId(), fcmToken });
      // Sprint 4 Phase 3: present ONLY on this device_id's first-ever
      // registration — see DevicesController.php's own doc. Stored once,
      // never re-fetched (there is nowhere else to get it from — the
      // server does not re-return it on later calls, deliberately).
      if (registration.messageEncryptionKey) {
        await storeMessageEncryptionKey(registration.messageEncryptionKey);
      }
    }
    // When fcmToken is null the device is deliberately NOT registered —
    // see getFcmToken()'s comment. Registering with a placeholder token
    // would tell the server this device is push-reachable when it isn't.
  } catch {
    // Non-fatal by design.
  }

  try {
    // Result intentionally unused for now: M1's contract is only to CHECK
    // the version. Actually downloading and SHA-256-verifying the package
    // is the offline-basemap box, not this one.
    await getMapPackage(barangayId);
  } catch {
    // Non-fatal by design.
  }
}

export default LoginPage;
