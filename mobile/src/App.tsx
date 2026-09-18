import { useEffect, useState } from 'react';
import { Navigate, Route, useLocation, useNavigate } from 'react-router-dom';
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
import {
  add,
  home,
  homeOutline,
  list,
  listOutline,
  map,
  mapOutline,
  person,
  personOutline,
} from 'ionicons/icons';
import CriticalAlertOverlay from './components/CriticalAlertOverlay';
import AssignmentDetailPage from './pages/assignment-detail';
import AssignmentsPage from './pages/assignments';
import HomePage from './pages/home';
import IncidentSubmittedPage from './pages/incident-submitted';
import LiveMapPage from './pages/live-map';
import LoginPage from './pages/login';
import MyReportsPage from './pages/my-reports';
import MyShiftsPage from './pages/my-shifts';
import NewIncidentPage from './pages/new-incident';
import ProfilePage from './pages/profile';
import { hasLiveSession, onSessionExpired } from './services/session';
import { registerCriticalAlertListeners, checkForPendingNativeAlert } from './services/criticalAlertStore';
import { startSyncScheduler } from './services/syncScheduler';
import { pruneOldSyncedEvidenceFiles } from './services/storageMaintenance';
import { initThemeListener } from './utils/theme';
import tacticalFeedback from './utils/tacticalFeedback';

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
 * Listens for `apiService.ts`'s `request()` reporting a dead session (a
 * 401 on an authenticated call — expired, revoked by logout-elsewhere, or
 * a password change) and leaves whatever screen is up for `/login`
 * immediately, instead of leaving a Tanod stuck on a screen that will
 * keep failing every request with no indication why. Renders nothing;
 * mounted once, inside the router, so `useNavigate()` works everywhere a
 * request can fire from. `request()` already cleared the stored session
 * before emitting, so a fresh `RequireSession` mount (below) correctly
 * finds nobody signed in.
 */
const SessionExpiryWatcher: React.FC = () => {
  const navigate = useNavigate();

  useEffect(() => {
    return onSessionExpired(() => {
      navigate('/login', { replace: true });
    });
  }, [navigate]);

  return null;
};

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
 * assignments.tsx/live-map.tsx. Profile (M10) is also built (profile.tsx)
 * and routed for real below — this comment previously said it still fell
 * back to `NotBuiltYetPage`, which stopped being true once profile.tsx
 * was wired in; corrected rather than left to mislead the next reader.
 *
 * ROUTE SHAPE (2026-09-15, closes REMAINING.md C6 — login leaving the old
 * screen stuck over Home): the shell is mounted at `/tabs/*` with
 * RELATIVE child paths — the exact shape Ionic's own React Router 6 docs
 * use — and NOT at a root-level catch-all `/*` with absolute children,
 * which is what it was until today. That is not a style preference:
 * `@ionic/react-router` 9.0.3's StackManager mishandles a root-level
 * `/*` container in two ways, both confirmed on a real device through
 * remote DevTools (DOM mutation log + the outlet's internal view stack),
 * not reasoned about:
 *
 *   1. `handleReadyEnteringView()` derives a container route's base as
 *      `path.replace(/\/\*$/, '')`, which for `/*` is the EMPTY string.
 *      Its "navigating within the same container?" check then reduces
 *      to `pathname.startsWith('/')` — true for every absolute path — so
 *      the `/login` -> `/home` transition was classified as an
 *      in-container tab change and skipped outright: the entering shell
 *      kept `ion-page-invisible` (opacity 0) and the leaving login page
 *      never received `ion-page-hidden`. The Tanod saw a frozen login
 *      form over a fully working Home. It only "sometimes" worked
 *      because a 300 ms wait-timeout fallback hides the old page itself
 *      when the shell mounts slowly — i.e. it failed on every FAST login.
 *   2. A root-level catch-all matches EVERY pathname, so at sign-out the
 *      outlet's view lookup returned the mounted tab-shell view as the
 *      "entering" view for `/login` and overwrote its route element with
 *      the login route (same view id, `childProps.path` still `/*`). It
 *      rendered, but as a corrupted same-view transition, not a page
 *      change.
 *
 * With a non-empty base (`/tabs`) neither lookup can match a sibling
 * route and the container check compares real prefixes. The tab bar
 * hrefs, every `navigate()` call site and every `defaultBackHref` moved
 * with it; `/login` and M4's `/incidents/:localId/submitted` stay OUTSIDE
 * the shell exactly as before. `/` redirects into `/tabs/home` (a cold
 * start always lands on `/`). There is deliberately NO `*` not-found
 * route: a mounted catch-all view is precisely what finding 2 is about.
 */
const TabbedShell: React.FC = () => {
  const location = useLocation();
  const currentPath = location.pathname;

  const isHome = currentPath === '/tabs/home';
  const isAssignments = currentPath.startsWith('/tabs/assignments');
  const isMap = currentPath === '/tabs/map';
  const isProfile = currentPath === '/tabs/profile';
  const isNewIncident = currentPath.startsWith('/tabs/incidents/new');
  const isAssignmentDetail = currentPath.startsWith('/tabs/assignments/') && currentPath !== '/tabs/assignments';

  return (
    <IonTabs>
      <IonRouterOutlet>
        <Route path="home" element={<HomePage />} />
        {/* M5. */}
        <Route path="assignments" element={<AssignmentsPage />} />
        {/* M6 — reached by tapping a card on M5, not a tab of its own. */}
        <Route path="assignments/:localId" element={<AssignmentDetailPage />} />
        {/* M3. */}
        <Route path="incidents/new" element={<NewIncidentPage />} />
        {/* M14 — reached from Profile and from M4's confirmation screen, not its own tab (a 6th bottom tab for a reference screen would crowd the four the Tanod actually needs dozens of times a shift). */}
        <Route path="reports" element={<MyReportsPage />} />
        {/* M8/M9 — reached from Profile, same "not a tab" reasoning as M14 above (used at most twice a week). */}
        <Route path="shifts" element={<MyShiftsPage />} />
        {/* M7. */}
        <Route path="map" element={<LiveMapPage />} />
        <Route path="profile" element={<ProfilePage />} />
        {/* Bare `/tabs` — nothing in the app navigates there; a safety net only. */}
        <Route index element={<Navigate to="/tabs/home" replace />} />
      </IonRouterOutlet>
      <IonTabBar slot="bottom" className={`mobile-tab-bar ${isAssignmentDetail || isNewIncident ? 'mobile-tab-bar--hidden' : ''}`}>
        <IonTabButton
          tab="home"
          href="/tabs/home"
          onClick={() => !isHome && tacticalFeedback.onTap()}
          className={isHome ? 'tab-item--active' : ''}
        >
          <IonIcon icon={isHome ? home : homeOutline} />
          <IonLabel>Home</IonLabel>
          <span className="tab-indicator-dot" aria-hidden="true" />
        </IonTabButton>

        <IonTabButton
          tab="assignments"
          href="/tabs/assignments"
          onClick={() => !isAssignments && tacticalFeedback.onTap()}
          className={isAssignments ? 'tab-item--active' : ''}
        >
          <IonIcon icon={isAssignments ? list : listOutline} />
          <IonLabel>Assignments</IonLabel>
          <span className="tab-indicator-dot" aria-hidden="true" />
        </IonTabButton>

        <IonTabButton
          tab="log-incident"
          href="/tabs/incidents/new"
          className="mobile-tab-button--fab"
          onClick={() => tacticalFeedback.onTap()}
        >
          <div className="tab-fab-btn" aria-label="Log Incident">
            <div className="tab-fab-ring" />
            <IonIcon icon={add} />
          </div>
          <IonLabel>Log Incident</IonLabel>
        </IonTabButton>

        <IonTabButton
          tab="map"
          href="/tabs/map"
          onClick={() => !isMap && tacticalFeedback.onTap()}
          className={isMap ? 'tab-item--active' : ''}
        >
          <IonIcon icon={isMap ? map : mapOutline} />
          <IonLabel>Map</IonLabel>
          <span className="tab-indicator-dot" aria-hidden="true" />
        </IonTabButton>

        <IonTabButton
          tab="profile"
          href="/tabs/profile"
          onClick={() => !isProfile && tacticalFeedback.onTap()}
          className={isProfile ? 'tab-item--active' : ''}
        >
          <IonIcon icon={isProfile ? person : personOutline} />
          <IonLabel>Profile</IonLabel>
          <span className="tab-indicator-dot" aria-hidden="true" />
        </IonTabButton>
      </IonTabBar>
    </IonTabs>
  );
};

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
 * session) is not silently missed. `startSyncScheduler()` (Mobile
 * Improvement Plan Phase 1.1) is registered the same way and for the same
 * reason — a Tanod regaining connectivity while sitting on the login
 * screen (signed out from a previous session, about to sign back in)
 * should not need to also happen to be on a screen that sets up its own
 * sync trigger. `checkForPendingNativeAlert()` (C4, 2026-09-15) runs
 * alongside it for the same "don't miss it" reason: `CriticalAlertActivity`'s
 * "Open Baranguard" button cold-launches the app with no Capacitor push
 * event to listen for, so this is the only way that handoff reaches the
 * overlay.
 */
const App: React.FC = () => {
  useEffect(() => {
    registerCriticalAlertListeners();
    void checkForPendingNativeAlert();
    startSyncScheduler();
    // Once per cold start, not per sync tick — Phase 3.3's cleanup rule
    // only matters on a 30-day timescale, so there is no benefit to
    // running it more often than the app actually restarts, and every run
    // is real file I/O over however many evidence rows exist.
    void pruneOldSyncedEvidenceFiles();
    const unbindTheme = initThemeListener();
    return () => {
      unbindTheme();
    };
  }, []);

  return (
    <IonApp>
      <CriticalAlertOverlay />
      <IonReactRouter>
        <SessionExpiryWatcher />
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
            path="/tabs/*"
            element={
              <RequireSession>
                <TabbedShell />
              </RequireSession>
            }
          />
          {/* A cold start (and a WebView restore) always lands on `/`. See
              TabbedShell's doc for why the shell is NOT a root catch-all. */}
          <Route path="/" element={<Navigate to="/tabs/home" replace />} />
        </IonRouterOutlet>
      </IonReactRouter>
    </IonApp>
  );
};

export default App;
