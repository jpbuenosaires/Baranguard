import { useEffect, useState } from 'react';
import { Navigate, Route, useLocation } from 'react-router-dom';
import { IonApp, IonRouterOutlet, IonSpinner, setupIonicReact } from '@ionic/react';
import { IonReactRouter } from '@ionic/react-router';
import HomePage from './pages/home';
import IncidentSubmittedPage from './pages/incident-submitted';
import LoginPage from './pages/login';
import NewIncidentPage from './pages/new-incident';
import { hasLiveSession } from './services/session';

/* Core CSS required for Ionic components to work properly */
import '@ionic/react/css/core.css';

/* Basic CSS for apps built with Ionic */
import '@ionic/react/css/normalize.css';
import '@ionic/react/css/structure.css';
import '@ionic/react/css/typography.css';

/* Optional CSS utils that can be commented out */
import '@ionic/react/css/padding.css';
import '@ionic/react/css/float-elements.css';
import '@ionic/react/css/text-alignment.css';
import '@ionic/react/css/text-transformation.css';
import '@ionic/react/css/flex-utils.css';
import '@ionic/react/css/display.css';

import '@ionic/react/css/palettes/dark.system.css';

/* Theme variables */
import './theme/variables.css';

setupIonicReact();

/**
 * Client-side session gate.
 *
 * §2 Rule 6 is explicit that this is UX only, never a security boundary —
 * every protected endpoint re-verifies role, tenant, and ownership
 * server-side regardless of what this component decides. Its only job is
 * to avoid showing a signed-out Tanod a screen that would immediately
 * 401.
 */
const RequireSession: React.FC<{ children: React.ReactNode }> = ({ children }) => {
  const [state, setState] = useState<'checking' | 'in' | 'out'>('checking');
  const location = useLocation();

  useEffect(() => {
    let active = true;
    hasLiveSession().then((live) => {
      if (active) setState(live ? 'in' : 'out');
    });
    return () => {
      active = false;
    };
  }, [location.pathname]);

  if (state === 'checking') {
    return (
      <div style={{ display: 'flex', justifyContent: 'center', paddingTop: 64 }}>
        <IonSpinner name="dots" />
      </div>
    );
  }
  return state === 'in' ? <>{children}</> : <Navigate to="/login" replace />;
};

const App: React.FC = () => (
  <IonApp>
    <IonReactRouter>
      <IonRouterOutlet>
        <Route path="/login" element={<LoginPage />} />
        <Route
          path="/home"
          element={
            <RequireSession>
              <HomePage />
            </RequireSession>
          }
        />
        {/* M3. Reachable while signed out is NOT desirable, but note that
            local capture itself must survive an expired session (§2 Rule
            9: "offline mobile capture is unaffected") — that durability
            lives in the local-database layer, not in this gate. */}
        <Route
          path="/incidents/new"
          element={
            <RequireSession>
              <NewIncidentPage />
            </RequireSession>
          }
        />
        {/* M4. Reads the stored row and derives its own state — it never
            trusts a "submitted" claim handed over from the previous screen. */}
        <Route
          path="/incidents/:localId/submitted"
          element={
            <RequireSession>
              <IncidentSubmittedPage />
            </RequireSession>
          }
        />
        <Route path="/" element={<Navigate to="/home" replace />} />
      </IonRouterOutlet>
    </IonReactRouter>
  </IonApp>
);

export default App;
