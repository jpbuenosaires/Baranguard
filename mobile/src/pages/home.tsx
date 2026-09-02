/**
 * home.tsx — MINIMAL post-login landing screen.
 *
 * This is NOT M2 Home. M2 ("duty status control + SOS entry point", with
 * a greeting card, quick-stat row, and 2x2 quick-actions grid) is its own
 * unbuilt Sprint 2 box, and its SOS half is additionally Sprint-4-blocked
 * (`POST /tanod-sos` doesn't exist). This screen exists only because M1
 * has to navigate somewhere and M3 has to be reachable — the same
 * "necessary plumbing" precedent as the minimal login page built for W2
 * in Sprint 1.
 *
 * Deliberately absent: duty toggle, SOS button, and any performance
 * stats. §9 M2 warns that the Figma reference bakes in a fake identity
 * and fabricated stats; §8 forbids shipping controls that look functional
 * but aren't wired to anything. A duty toggle here would be exactly that,
 * since `POST /duty-status` is not built. The name below comes from the
 * authenticated session, never a placeholder.
 */

import { useEffect, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import {
  IonButton,
  IonContent,
  IonHeader,
  IonNote,
  IonPage,
  IonTitle,
  IonToolbar,
} from '@ionic/react';
import { logout } from '../services/apiService';
import { clearSession, loadSession } from '../services/session';

const HomePage: React.FC = () => {
  const navigate = useNavigate();
  const [fullName, setFullName] = useState('');

  useEffect(() => {
    loadSession().then((session) => setFullName(session?.fullName ?? ''));
  }, []);

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
        {fullName && <h2 style={{ marginTop: 0 }}>{fullName}</h2>}

        <IonButton expand="block" onClick={() => navigate('/incidents/new')}>
          Log New Incident
        </IonButton>

        <IonNote style={{ display: 'block', marginTop: 24, lineHeight: 1.5 }}>
          Duty status and SOS are not built yet — they are part of the M2 Home
          screen, and SOS additionally needs the Sprint 4 alert backend. They
          are left out rather than shown as buttons that would do nothing.
        </IonNote>

        <IonButton expand="block" fill="outline" color="medium" onClick={handleSignOut} style={{ marginTop: 32 }}>
          Sign out
        </IonButton>
      </IonContent>
    </IonPage>
  );
};

export default HomePage;
