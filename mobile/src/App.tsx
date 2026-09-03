import { useEffect, useState } from 'react';
import { Navigate, Route } from 'react-router-dom';
import {
  IonApp,
  IonIcon,
  IonLabel,
  IonRouterOutlet,
  IonSpinner,
  IonTabBar,
  IonTabButton,
  IonTabs,
  setupIonicReact,
} from '@ionic/react';
import { IonReactRouter } from '@ionic/react-router';
import { addCircle, homeOutline, listOutline, mapOutline, personOutline } from 'ionicons/icons';
import NotBuiltYetPage from './components/NotBuiltYetPage';
import CriticalAlertOverlay from './components/CriticalAlertOverlay';
import NotificationDiagnostics from './components/NotificationDiagnostics';
import AssignmentDetailPage from './pages/assignment-detail';
import AssignmentsPage from './pages/assignments';
import HomePage from './pages/home';
import IncidentSubmittedPage from './pages/incident-submitted';
import LiveMapPage from './pages/live-map';
import LoginPage from './pages/login';
import NewIncidentPage from './pages/new-incident';
import { hasLiveSession } from './services/session';
import { registerCriticalAlertListeners } from './services/criticalAlertStore';

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

/* NOTE: the scaffold imported '@ionic/react/css/palettes/dark.system.css'
   here, which made the app follow the OS into dark mode while the web
   dashboard is light. §8 defines exactly one palette and it is light, so
   that import is deliberately removed — see theme/variables.css. */

/* Theme variables (§8 design tokens) + shared utility classes */
import './theme/variables.css';
import './theme/app.css';

setupIonicReact();

/**
 * Client-side session gate.
 *
 * §2 Rule 6 is explicit that this is UX only, never a security boundary —
 * every protected endpoint re-verifies role, tenant, and ownership
 * server-side regardless of what this component decides. Its only job is
 * to avoid showing a signed-out Tanod a screen that would immediately
 * 401.
 *
 * Checks ONCE per mount, not on every navigation. Before the bottom-nav
 * tabs existed, each protected route had its own separate `RequireSession`
 * instance, so a location-keyed effect only re-ran on an actual top-level
 * route change. Now `TabbedShell` (below) is wrapped by a SINGLE
 * `RequireSession` for its whole lifetime, so keying off `location.pathname`
 * would re-run this check — and flash the spinner — on every tab switch,
 * which is a real UX regression a Tanod would hit dozens of times a shift.
 * A fresh mount (login -> tabs, or sign-out -> back in) still checks again.
 */
const RequireSession: React.FC<{ children: React.ReactNode }> = ({ children }) => {
  const [state, setState] = useState<'checking' | 'in' | 'out'>('checking');

  useEffect(() => {
    let active = true;
    hasLiveSession().then((live) => {
      if (active) setState(live ? 'in' : 'out');
    });
    return () => {
      active = false;
    };
  }, []);

  if (state === 'checking') {
    return (
      <div style={{ display: 'flex', justifyContent: 'center', paddingTop: 64 }}>
        <IonSpinner name="dots" />
      </div>
    );
  }
  return state === 'in' ? <>{children}</> : <Navigate to="/login" replace />;
};

/**
 * Bottom-nav tabs.
 *
 * DECISION (2026-09-03, confirmed with the user; §8 flagged this as an
 * open question rather than resolved): Log Incident takes the persistent
 * tab slot, on the Figma reference's reasoning that a field emergency app
 * should put its most time-critical action one tap away at all times.
 * Schedule (M8) drops out of the persistent bar — it isn't built yet, and
 * when it is, it's reachable from Profile rather than occupying a tab a
 * Tanod needs dozens of times a shift for something used at most twice a
 * week. Tabs: Home / Assignments / Log Incident / Map / Profile.
 *
 * Assignments (M5) and Map (M7) are Sprint 3 scope, now built — see
 * assignments.tsx/live-map.tsx. Profile (M10) is not built yet and still
 * routes to `NotBuiltYetPage` rather than being hidden.
 */
const TabbedShell: React.FC = () => (
  <IonTabs>
    <IonRouterOutlet>
      <Route path="/home" element={<HomePage />} />
      {/* M5. */}
      <Route path="/assignments" element={<AssignmentsPage />} />
      {/* M6 — reached by tapping a card on M5, not a tab of its own. */}
      <Route path="/assignments/:localId" element={<AssignmentDetailPage />} />
      {/* M3. */}
      <Route path="/incidents/new" element={<NewIncidentPage />} />
      {/* M7. */}
      <Route path="/map" element={<LiveMapPage />} />
      <Route
        path="/profile"
        element={
          <NotBuiltYetPage
            title="Profile"
            detail="M10 Profile is not built yet. Sign out is still available from Home for now."
          >
            <NotificationDiagnostics />
          </NotBuiltYetPage>
        }
      />
      <Route path="/" element={<Navigate to="/home" replace />} />
    </IonRouterOutlet>
    <IonTabBar slot="bottom">
      <IonTabButton tab="home" href="/home">
        <IonIcon icon={homeOutline} />
        <IonLabel>Home</IonLabel>
      </IonTabButton>
      <IonTabButton tab="assignments" href="/assignments">
        <IonIcon icon={listOutline} />
        <IonLabel>Assignments</IonLabel>
      </IonTabButton>
      <IonTabButton tab="log-incident" href="/incidents/new">
        <IonIcon icon={addCircle} />
        <IonLabel>Log Incident</IonLabel>
      </IonTabButton>
      <IonTabButton tab="map" href="/map">
        <IonIcon icon={mapOutline} />
        <IonLabel>Map</IonLabel>
      </IonTabButton>
      <IonTabButton tab="profile" href="/profile">
        <IonIcon icon={personOutline} />
        <IonLabel>Profile</IonLabel>
      </IonTabButton>
    </IonTabBar>
  </IonTabs>
);

/**
 * M12's overlay is mounted here, OUTSIDE `IonReactRouter`/`IonRouterOutlet`
 * entirely, so it can render above whatever screen is active — including
 * the login page, since an already-registered device could theoretically
 * still receive a push while signed out (the overlay itself does not
 * gate on session state; `POST /notifications/:id/ack` will 401 if the
 * session has expired, which is caught and swallowed exactly like every
 * other failure mode there).
 *
 * `registerCriticalAlertListeners()` is called once, at the app's own
 * mount — not inside `RequireSession` or any per-tab component — so a
 * push arriving before login (device already registered from a previous
 * session) is not silently missed.
 */
const App: React.FC = () => {
  useEffect(() => {
    registerCriticalAlertListeners();
  }, []);

  return (
    <IonApp>
      <CriticalAlertOverlay />
      <IonReactRouter>
        <IonRouterOutlet>
          <Route path="/login" element={<LoginPage />} />
          {/* M4. Reads the stored row and derives its own state — it never
              trusts a "submitted" claim handed over from the previous screen.
              Deliberately OUTSIDE the tab bar: it's a one-shot confirmation
              reached only right after M3's Save, not a nav destination. */}
          <Route
            path="/incidents/:localId/submitted"
            element={
              <RequireSession>
                <IncidentSubmittedPage />
              </RequireSession>
            }
          />
          <Route
            path="/*"
            element={
              <RequireSession>
                <TabbedShell />
              </RequireSession>
            }
          />
        </IonRouterOutlet>
      </IonReactRouter>
    </IonApp>
  );
};

export default App;
