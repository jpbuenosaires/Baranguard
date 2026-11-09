import { Suspense, lazy, useEffect, useRef, useState } from 'react';
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
  useIonRouter,
} from '@ionic/react';
import { App as CapacitorApp } from '@capacitor/app';
import { Capacitor } from '@capacitor/core';
import { alertController } from '@ionic/core';
import { IonReactRouter } from '@ionic/react-router';
import {
  add,
  alertCircle,
  alertCircleOutline,
  documentText,
  documentTextOutline,
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
import { SosInHeaderContext } from './components/sosHeaderContext';
const AccomplishmentsPage = lazy(() => import('./pages/accomplishments'));
const AssignmentDetailPage = lazy(() => import('./pages/assignment-detail'));
const AssignmentsPage = lazy(() => import('./pages/assignments'));
const AvailabilityPage = lazy(() => import('./pages/availability'));
const AdminDispatchPage = lazy(() => import('./pages/admin/admin-dispatch'));
const AdminIncidentsPage = lazy(() => import('./pages/admin/admin-incidents'));
const AdminProfilePage = lazy(() => import('./pages/admin/admin-profile'));
const AdminLogIncidentPage = lazy(() => import('./pages/admin/admin-log-incident'));
import AdminSosPage from './pages/admin/admin-sos';
import HomePage from './pages/home';
const IncidentSubmittedPage = lazy(() => import('./pages/incident-submitted'));
const LiveMapPage = lazy(() => import('./pages/live-map'));
import LoginPage from './pages/login';
const MyReportsPage = lazy(() => import('./pages/my-reports'));
const MyShiftsPage = lazy(() => import('./pages/my-shifts'));
const NewIncidentPage = lazy(() => import('./pages/new-incident'));
const PrivacyPage = lazy(() => import('./pages/privacy'));
const ProfilePage = lazy(() => import('./pages/profile'));
const SchoolCheckinPage = lazy(() => import('./pages/school-checkin'));
import { getSessionRole, type AppRole } from './services/role';
import { hasStoredSession, onSessionExpired } from './services/session';
import { registerCriticalAlertListeners, checkForPendingNativeAlert } from './services/criticalAlertStore';
import { startPendingAckRetry } from './services/alertAckRetry';
import { startSyncScheduler } from './services/syncScheduler';
import { useDispatchOffers } from './services/useDispatchOffers';
import { useActiveSosCount } from './services/adminSosCount';
import { decideBack, homePathForRole, isTabRoot } from './utils/backNavigation';
import { sosTabLabel } from './utils/sosBadge';
import { startSosFallbackContactResumeRefresh } from './services/sosFallbackContact';
import { startSchoolCacheResumeRefresh } from './services/workflowRefresh';
import { pruneOldSyncedEvidenceFiles } from './services/storageMaintenance';
import { initThemeListener } from './utils/theme';
import tacticalFeedback from './utils/tacticalFeedback';

/** Shown for the instant a route chunk loads; the shell (tab bar, SOS dock) is already on screen. */
function PageFallback() {
  return (
    <div className="page-fallback" role="status" aria-label="Loading">
      <IonSpinner name="dots" />
    </div>
  );
}

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

/* Ionic's '@ionic/react/css/palettes/dark.system.css' is deliberately not imported: theming is driven by
   the `data-theme` attribute index.html stamps (see theme/variables.css), not the OS-following palette. */

/* Theme variables (design tokens) + shared utility classes */
import './theme/variables.css';
import './theme/app.css';
import './theme/tanod-workflow.css';
import './theme/admin-console.css';
import './theme/screens-base.css';
import './theme/ui.css';
import './theme/screens.css';
import './theme/x-map.css';
import './theme/x-dispatch.css';
import './theme/x-home.css';
import './theme/x-forms.css';
import './theme/x-profile.css';
import './theme/layout.css';

setupIonicReact();

/**
 * Leaves whatever screen is up for `/login` when `apiService.ts`'s `request()` reports a dead session
 * (a 401 on an authenticated call: expired, revoked elsewhere, or a password change), instead of
 * leaving a Tanod stuck on a screen that keeps failing. Renders nothing; mounted inside the router so
 * `useNavigate()` works. `request()` clears the stored session before emitting, so a fresh
 * `RequireSession` mount finds nobody signed in.
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
 * Client-side session gate. UX only, never a security boundary: every protected endpoint re-verifies
 * role, tenant, and ownership server-side. Its job is to avoid showing a signed-out Tanod a screen
 * that would immediately 401.
 *
 * Gates on a session EXISTING, not on it being locally unexpired (`hasStoredSession`, not
 * `hasLiveSession`; see session.ts). An expired token means the first authenticated call that reaches
 * the workstation gets a 401, which `request()` turns into a cleared session plus the
 * `SessionExpiryWatcher` redirect above; until then the Tanod keeps their cached view, the point of an
 * offline-first app.
 *
 * Checks ONCE per mount, not on every navigation: `TabbedShell` is wrapped by a SINGLE
 * `RequireSession` for its whole lifetime, so keying off `location.pathname` would re-run the check
 * and flash the spinner on every tab switch. A fresh mount (login -> tabs, or sign-out -> back in)
 * still checks again.
 */
const RequireSession: React.FC<{ children: React.ReactNode }> = ({ children }) => {
  const [state, setState] = useState<'checking' | 'in' | 'out'>('checking');

  useEffect(() => {
    let active = true;
    hasStoredSession().then((stored) => {
      if (active) setState(stored ? 'in' : 'out');
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
 * Bottom-nav tabs: Home / Assignments / Log Incident / Map / Profile. Log Incident takes a persistent
 * slot because a field emergency app should keep its most time-critical action one tap away. Schedule
 * is reached from Profile rather than occupying a tab.
 *
 * ROUTE SHAPE: the shell is mounted at `/tabs/*` with RELATIVE child paths (the shape Ionic's React
 * Router 6 docs use), NOT at a root-level catch-all `/*` with absolute children.
 * `@ionic/react-router` 9.0.3's StackManager mishandles a root-level `/*` container in two ways, both
 * confirmed on a real device:
 *
 *   1. `handleReadyEnteringView()` derives a container route's base as `path.replace(/\/\*$/, '')`,
 *      which for `/*` is the EMPTY string. Its "navigating within the same container?" check then
 *      reduces to `pathname.startsWith('/')`, true for every absolute path, so the `/login` -> `/home`
 *      transition was classified as an in-container tab change and skipped: the entering shell kept
 *      `ion-page-invisible` and the leaving login page never received `ion-page-hidden`. The Tanod saw
 *      a frozen login form over a working Home. It only "sometimes" worked because a 300 ms
 *      wait-timeout fallback hides the old page when the shell mounts slowly, so it failed on every
 *      FAST login.
 *   2. A root-level catch-all matches EVERY pathname, so at sign-out the outlet's view lookup returned
 *      the mounted tab-shell view as the "entering" view for `/login` and overwrote its route element
 *      with the login route (same view id, `childProps.path` still `/*`): a corrupted same-view
 *      transition, not a page change.
 *
 * With a non-empty base (`/tabs`) neither lookup can match a sibling route and the container check
 * compares real prefixes. `/login` and the incident-submitted route stay OUTSIDE the shell. `/`
 * redirects into `/tabs/home` (a cold start always lands on `/`). There is deliberately NO `*`
 * not-found route: a mounted catch-all view is exactly what problem 2 is about.
 */
const TabbedShell: React.FC = () => {
  const location = useLocation();
  const currentPath = location.pathname;
  // Open night-dispatch offers for the Dispatches tab badge (shares the store the cards use).
  const offerCount = useDispatchOffers().offers.length;

  const isHome = currentPath === '/tabs/home';
  const isAssignments = currentPath.startsWith('/tabs/assignments');
  const isMap = currentPath === '/tabs/map';
  const isProfile = currentPath === '/tabs/profile';
  const isNewIncident = currentPath.startsWith('/tabs/incidents/new');
  const isAssignmentDetail = currentPath.startsWith('/tabs/assignments/') && currentPath !== '/tabs/assignments';

  return (
    <>
    <SosInHeaderContext.Provider value={true}>
    <IonTabs>
      <IonRouterOutlet>
        <Route path="home" element={<HomePage />} />
        <Route path="assignments" element={<Suspense fallback={<PageFallback />}><AssignmentsPage /></Suspense>} />
        {/* Reached by tapping a card on the assignments list, not a tab of its own. */}
        <Route path="assignments/:localId" element={<Suspense fallback={<PageFallback />}><AssignmentDetailPage /></Suspense>} />
        <Route path="incidents/new" element={<Suspense fallback={<PageFallback />}><NewIncidentPage /></Suspense>} />
        {/* Reached from Profile and from the incident confirmation screen, not its own tab (a 6th bottom tab for a reference screen would crowd the four the Tanod actually needs dozens of times a shift). */}
        <Route path="reports" element={<Suspense fallback={<PageFallback />}><MyReportsPage /></Suspense>} />
        {/* Reached from Profile, same "not a tab" reasoning as above (used at most twice a week). */}
        <Route path="shifts" element={<Suspense fallback={<PageFallback />}><MyShiftsPage /></Suspense>} />
        {/* Tanod workflow screens: reached from My Shifts / Profile, same "not a tab" reasoning. */}
        <Route path="availability" element={<Suspense fallback={<PageFallback />}><AvailabilityPage /></Suspense>} />
        <Route path="accomplishments" element={<Suspense fallback={<PageFallback />}><AccomplishmentsPage /></Suspense>} />
        <Route path="school" element={<Suspense fallback={<PageFallback />}><SchoolCheckinPage /></Suspense>} />
        <Route path="map" element={<Suspense fallback={<PageFallback />}><LiveMapPage /></Suspense>} />
        <Route path="profile" element={<Suspense fallback={<PageFallback />}><ProfilePage /></Suspense>} />
        {/* Bare `/tabs` — nothing in the app navigates there; a safety net only. */}
        <Route index element={<Navigate to="/tabs/home" replace />} />
      </IonRouterOutlet>

      <IonTabBar slot="bottom" className={`mobile-tab-bar ${isAssignmentDetail || isNewIncident ? 'mobile-tab-bar--hidden' : ''}`}>
        <IonTabButton
          tab="home"
          href="/tabs/home"
          onClick={() => !isHome && tacticalFeedback.onTap()}
          className={isHome ? 'tab-item--active' : ''}
          aria-label="Home"
        >
          <div className="tab-pill-container">
            <IonIcon icon={isHome ? home : homeOutline} />
            <IonLabel>Home</IonLabel>
          </div>
        </IonTabButton>

        <IonTabButton
          tab="assignments"
          href="/tabs/assignments"
          onClick={() => !isAssignments && tacticalFeedback.onTap()}
          className={isAssignments ? 'tab-item--active' : ''}
          aria-label="Dispatches"
        >
          <div className="tab-pill-container tab-pill-container--has-badge">
            <IonIcon icon={isAssignments ? list : listOutline} />
            <IonLabel>Dispatches</IonLabel>
            {offerCount > 0 && (
              <span className="tab-offer-badge" role="status" aria-label={`${offerCount} dispatch offer${offerCount === 1 ? '' : 's'} waiting`}>
                {offerCount}
              </span>
            )}
          </div>
        </IonTabButton>

        <IonTabButton
          tab="log-incident"
          href="/tabs/incidents/new"
          className="mobile-tab-button--center"
          onClick={() => tacticalFeedback.onTap()}
          aria-label="Report"
        >
          <div className="tab-center-fab" aria-hidden="true">
            <IonIcon icon={add} />
          </div>
          <IonLabel>Report</IonLabel>
        </IonTabButton>

        <IonTabButton
          tab="map"
          href="/tabs/map"
          onClick={() => !isMap && tacticalFeedback.onTap()}
          className={isMap ? 'tab-item--active' : ''}
          aria-label="Map"
        >
          <div className="tab-pill-container">
            <IonIcon icon={isMap ? map : mapOutline} />
            <IonLabel>Map</IonLabel>
          </div>
        </IonTabButton>

        <IonTabButton
          tab="profile"
          href="/tabs/profile"
          onClick={() => !isProfile && tacticalFeedback.onTap()}
          className={isProfile ? 'tab-item--active' : ''}
          aria-label="Profile"
        >
          <div className="tab-pill-container">
            <IonIcon icon={isProfile ? person : personOutline} />
            <IonLabel>Profile</IonLabel>
          </div>
        </IonTabButton>
      </IonTabBar>
    </IonTabs>
    </SosInHeaderContext.Provider>
    </>
  );
};

/**
 * Chief Tanod (Admin) shell. Tabs: SOS / Dispatch /
 * Incidents / Profile, mounted at the same `/tabs/*` prefix as the Tanod
 * shell (so the StackManager notes on TabbedShell above apply unchanged).
 * No Tanod-only screens exist here: no duty toggle, accomplishments,
 * availability, school check-in, patrol GPS, or offline queue. `home` is a
 * redirect so a cold start's `/tabs/home` lands on the SOS tab.
 */
const ADMIN_TABS = [
  { tab: 'sos', label: 'SOS', path: '/tabs/sos', icon: alertCircleOutline, activeIcon: alertCircle },
  { tab: 'dispatch', label: 'Dispatch', path: '/tabs/dispatch', icon: listOutline, activeIcon: list },
  { tab: 'incidents', label: 'Incidents', path: '/tabs/incidents', icon: documentTextOutline, activeIcon: documentText },
  { tab: 'profile', label: 'Profile', path: '/tabs/profile', icon: personOutline, activeIcon: person },
];

const AdminShell: React.FC = () => {
  const currentPath = useLocation().pathname;
  const activeSos = useActiveSosCount();

  return (
    <IonTabs>
      <IonRouterOutlet>
        <Route path="sos" element={<AdminSosPage />} />
        <Route path="dispatch" element={<Suspense fallback={<PageFallback />}><AdminDispatchPage /></Suspense>} />
        <Route path="incidents" element={<Suspense fallback={<PageFallback />}><AdminIncidentsPage /></Suspense>} />
        <Route path="incidents/new" element={<Suspense fallback={<PageFallback />}><AdminLogIncidentPage /></Suspense>} />
        <Route path="profile" element={<Suspense fallback={<PageFallback />}><AdminProfilePage /></Suspense>} />
        <Route path="home" element={<Navigate to="/tabs/sos" replace />} />
        <Route index element={<Navigate to="/tabs/sos" replace />} />
      </IonRouterOutlet>

      <IonTabBar slot="bottom" className="mobile-tab-bar">
        {ADMIN_TABS.map((t) => {
          const active = currentPath === t.path;
          const badge = t.tab === 'sos' ? activeSos : 0;
          return (
            <IonTabButton
              key={t.tab}
              tab={t.tab}
              href={t.path}
              onClick={() => !active && tacticalFeedback.onTap()}
              className={active ? 'tab-item--active' : ''}
              aria-label={t.tab === 'sos' ? sosTabLabel(activeSos) : t.label}
            >
              <div className={`tab-pill-container${badge > 0 ? ' tab-pill-container--has-badge' : ''}`}>
                <IonIcon icon={active ? t.activeIcon : t.icon} />
                <IonLabel>{t.label}</IonLabel>
                {badge > 0 && (
                  <span className="tab-offer-badge" aria-hidden="true">
                    {badge}
                  </span>
                )}
              </div>
            </IonTabButton>
          );
        })}
      </IonTabBar>
    </IonTabs>
  );
};

/** Picks the shell from the stored session's role (UX only; the server enforces scope). */
const RoleShell: React.FC = () => {
  const [role, setRole] = useState<AppRole | null | undefined>(undefined);
  // Re-read on navigation (no spinner reset) so a sign-out followed by a
  // sign-in as the other role can never leave the previous shell mounted.
  const locationKey = useLocation().key;

  useEffect(() => {
    let active = true;
    void getSessionRole().then((r) => {
      if (active) setRole(r);
    });
    return () => {
      active = false;
    };
  }, [locationKey]);

  if (role === undefined) {
    return (
      <div style={{ display: 'flex', justifyContent: 'center', paddingTop: 64 }}>
        <IonSpinner name="dots" />
      </div>
    );
  }
  if (role === 'admin') return <AdminShell />;
  // A stored session with a role this app does not support goes back to login.
  return role === 'tanod' ? <TabbedShell /> : <Navigate to="/login" replace />;
};

/**
 * Android hardware back button. Registered once; the decision order lives in
 * utils/backNavigation.ts (overlay, router back, home tab, confirm exit).
 * Renders nothing; mounted inside the router so useIonRouter works.
 */
const OVERLAY_SELECTOR = 'ion-modal, ion-alert, ion-action-sheet, ion-popover';

const HardwareBackHandler: React.FC = () => {
  const router = useIonRouter();
  const routerRef = useRef(router);
  routerRef.current = router;

  useEffect(() => {
    if (Capacitor.getPlatform() !== 'android') return undefined;
    let confirming = false;
    const handle = CapacitorApp.addListener('backButton', async () => {
      const overlays = Array.from(document.querySelectorAll<HTMLElement>(OVERLAY_SELECTOR));
      const role = await getSessionRole().catch(() => null);
      const pathname = window.location.pathname;
      const action = decideBack(
        {
          overlayOpen: overlays.length > 0 || confirming,
          blockingOverlayOpen: document.querySelector('ion-loading') !== null,
          canGoBack: routerRef.current.canGoBack(),
          pathname,
          homePath: homePathForRole(role),
        },
        isTabRoot(pathname, role)
      );
      // A screen with an in-page editor (or a request in flight) may claim back.
      if (
        (action === 'router-back' || action === 'go-home' || action === 'confirm-exit') &&
        !window.dispatchEvent(new CustomEvent('baranguard:hardware-back', { cancelable: true }))
      ) {
        return;
      }
      if (action === 'dismiss-overlay') {
        const top = overlays[overlays.length - 1] as (HTMLElement & { dismiss?: (d?: unknown, r?: string) => Promise<boolean> }) | undefined;
        await top?.dismiss?.(undefined, 'backdrop');
      } else if (action === 'router-back') {
        routerRef.current.goBack();
      } else if (action === 'go-home') {
        routerRef.current.push(homePathForRole(role) ?? '/tabs/home', 'root', 'replace');
      } else if (action === 'confirm-exit') {
        confirming = true;
        const dialog = await alertController.create({
          header: 'Exit Baranguard?',
          buttons: [
            { text: 'Stay', role: 'cancel' },
            { text: 'Exit', role: 'confirm', handler: () => void CapacitorApp.exitApp() },
          ],
        });
        dialog.onDidDismiss().then(() => {
          confirming = false;
        });
        await dialog.present();
      }
    });
    return () => {
      void handle.then((h) => h.remove());
    };
  }, []);

  return null;
};

/**
 * The critical-alert overlay is mounted here, OUTSIDE `IonRouterOutlet` (inside `IonReactRouter` so the
 * dispatch_offer overlay can navigate), so it renders above whatever screen is active, including the
 * login page: an already-registered device can still receive a push while signed out (the overlay does
 * not gate on session state; `POST /notifications/:id/ack` will 401 if the session has expired, which
 * is caught and swallowed like every other failure there).
 *
 * `registerCriticalAlertListeners()` is called once, at the app's own mount, not inside
 * `RequireSession` or any per-tab component, so a push arriving before login is not missed.
 * `startSyncScheduler()` is registered the same way: a Tanod regaining connectivity on the login
 * screen should not need to be on a screen that sets up its own sync trigger.
 * `checkForPendingNativeAlert()` runs alongside for the same reason: `CriticalAlertActivity`'s "Open
 * Baranguard" button cold-launches the app with no Capacitor push event to listen for, so this is the
 * only way that handoff reaches the overlay.
 */
const App: React.FC = () => {
  useEffect(() => {
    registerCriticalAlertListeners();
    void checkForPendingNativeAlert();
    startPendingAckRetry();
    startSyncScheduler();
    startSosFallbackContactResumeRefresh();
    startSchoolCacheResumeRefresh();
    // Once per cold start, not per sync tick: the 30-day evidence cleanup only matters on a 30-day
    // timescale, and every run is real file I/O over however many evidence rows exist.
    void pruneOldSyncedEvidenceFiles();
    const unbindTheme = initThemeListener();
    return () => {
      unbindTheme();
    };
  }, []);

  return (
    <IonApp>
      <IonReactRouter>
        {/* Inside the router (outside the outlet) so the dispatch_offer overlay can navigate. */}
        <CriticalAlertOverlay />
        <SessionExpiryWatcher />
        <HardwareBackHandler />
        <IonRouterOutlet>
          <Route path="/login" element={<LoginPage />} />
          <Route path="/privacy" element={<Suspense fallback={<PageFallback />}><PrivacyPage /></Suspense>} />
          {/* Incident-submitted confirmation. Reads the stored row and derives its own state; it never
              trusts a "submitted" claim handed over from the previous screen. Deliberately OUTSIDE the
              tab bar: a one-shot confirmation reached right after Save, not a nav destination. */}
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
                <RoleShell />
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
