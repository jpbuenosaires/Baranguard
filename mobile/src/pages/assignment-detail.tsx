/**
 * assignment-detail.tsx — M6 Assignment Detail / Navigation (§9 Mobile).
 *
 * §9 M6: "Status changes may be made offline and queue into
 * dispatch_status_updates[]; they reconcile using idempotent client event
 * IDs and the dispatch transition matrix. A client must not locally skip
 * states. Cached route is labeled cached/last known. New OSRM routing is
 * unavailable offline."
 *
 * The status button always advances by exactly ONE step
 * (`dispatchRepository.nextStatusFor`) — there is no way to jump states
 * from this UI, matching "must not locally skip states" structurally
 * rather than by convention. Tapping it:
 *   1. Applies the change to `dispatch_local` immediately (optimistic —
 *      the Tanod sees the new status right away regardless of
 *      connectivity), minting a fresh client_event_id.
 *   2. Tries `PATCH /dispatch/:id/status` immediately.
 *   3. On success, marks the local row synced. On ANY failure (offline,
 *      or a genuine server rejection), the SAME event id is queued into
 *      `offline_queue_local` for `syncService.ts` to retry later via
 *      `/sync/batch` — never a second, different event id for the same
 *      change (§5 sync invariants).
 *
 * NAVIGATE (revised 2026-09-13): used to hand off to the device's own map
 * app via a `geo:` URI — that intent always leaves Baranguard, and a
 * Tanod reported exactly that ("goes to another software... supposed not
 * to be focus on this one"). Now that M7 has a real in-app basemap
 * (`LiveMapCanvas.tsx`), this screen embeds it instead, showing the
 * Tanod's own position and the assignment's destination on Baranguard's
 * OWN map. "Navigate" now RECENTERS that embedded map (via
 * `LiveMapCanvasHandle.recenter()`); a separate, explicitly-opt-in "Open
 * in external navigation app" link below the map still reaches the old
 * `geo:` behavior for a Tanod who wants a second opinion or their
 * phone's own offline maps.
 *
 * REAL TURN-BY-TURN ROUTING (2026-09-13, same day, later): the "no
 * routing engine exists in this stack" limitation above is closed — see
 * `apiService.getDispatchRoute()`/`OrsClient.php`'s own doc block for the
 * architecture (OpenRouteService, a free cloud API, chosen after a
 * self-hosted OSRM build and a Google Routes API build were each tried
 * and abandoned the same day). "Get Route" below is an EXPLICIT tap, not
 * auto-fetched on screen mount — same battery/data reasoning every other
 * network action on this screen already follows, and ORS's free tier is
 * request-limited. A fetched route draws as a real line on the embedded
 * map and a plain turn-by-turn step list; `ROUTE_STATUS_LABEL` below
 * needed no change — it was already honest about `available`/
 * `unavailable`/`stale`, and now reflects real values instead of always
 * `unavailable`. The external-navigation-app link is UNCHANGED and stays
 * — this was an explicit non-regression requirement, not an oversight.
 */

import { useEffect, useRef, useState, useCallback } from 'react';
import { useNavigate, useParams } from 'react-router-dom';
import {
  IonButton,
  IonContent,
  IonIcon,
  IonPage,
  IonSpinner,
} from '@ionic/react';
import {
  checkmarkCircleOutline,
  documentTextOutline,
  locateOutline,
  locationOutline,
  navigateOutline,
  openOutline,
  refreshOutline,
  stopOutline,
  syncOutline,
} from 'ionicons/icons';
import LiveMapCanvas, { type FocusTarget, type LiveMapCanvasHandle } from '../components/LiveMapCanvas';
import ActiveStepCard from '../components/ActiveStepCard';
import MobileHeader from '../components/MobileHeader';
import { LoadingBlock } from '../components/LoadingBlock';
import { ApiError, getDispatchRoute, updateDispatchStatus, type NearbyIncident, type RouteData } from '../services/apiService';
import {
  applyLocalStatusChange,
  cacheRouteFetch,
  getCachedDispatch,
  isCacheStale,
  markStatusSynced,
  nextStatusFor,
} from '../services/db/dispatchRepository';
import { enqueueDispatchStatusChange } from '../services/db/offlineQueueRepository';
import type { DispatchLocalRow } from '../services/db/localSchema';
import { getCurrentPosition, watchPosition, type DevicePosition } from '../services/geolocation';
import { loadSession } from '../services/session';
import tacticalFeedback from '../utils/tacticalFeedback';
import {
  computeNavigationState,
  formatRemainingTime,
  formatNavDistance,
  type NavigationState,
} from '../utils/routeProgress';
import { distanceMeters, formatDistance } from '../utils/geo';

const STATUS_LABEL: Record<string, string> = {
  assigned: 'Assigned',
  en_route: 'En Route',
  arrived: 'Arrived',
  completed: 'Completed',
};

const NEXT_ACTION_LABEL: Record<string, string> = {
  en_route: 'Mark En Route',
  arrived: 'Mark Arrived',
  completed: 'Mark Completed',
};

const ROUTE_STATUS_LABEL: Record<string, string> = {
  available: 'Route available',
  unavailable: 'No route available',
  stale: 'Route may be out of date',
};

const STAGES = ['assigned', 'en_route', 'arrived', 'completed'];

const AssignmentDetailPage: React.FC = () => {
  const { localId = '' } = useParams<{ localId: string }>();
  const navigate = useNavigate();
  const [row, setRow] = useState<DispatchLocalRow | null>(null);
  const [loading, setLoading] = useState(true);
  const [updating, setUpdating] = useState(false);
  const [note, setNote] = useState<string | null>(null);
  const [position, setPosition] = useState<DevicePosition | null>(null);
  const [barangayId, setBarangayId] = useState<number | null>(null);
  const [route, setRoute] = useState<RouteData | null>(null);
  const [fetchingRoute, setFetchingRoute] = useState(false);
  const [navigationActive, setNavigationActive] = useState(false);
  const [navState, setNavState] = useState<NavigationState | null>(null);
  /** Prevents the arrival prompt from firing more than once per navigation session. */
  const arrivalPromptedRef = useRef(false);
  const mapRef = useRef<LiveMapCanvasHandle>(null);

  // Auto-dismiss transient note notifications after 4 seconds
  useEffect(() => {
    if (!note) return;
    const timer = setTimeout(() => {
      setNote(null);
    }, 4000);
    return () => clearTimeout(timer);
  }, [note]);

  useEffect(() => {
    setLoading(true);
    getCachedDispatch(localId)
      .then(setRow)
      .finally(() => setLoading(false));
  }, [localId]);

  // Hydrates the on-screen route from whatever is already cached
  // (a prior fetch this session, or one carried in from GET /dispatch's
  // own list refresh) so a Tanod reopening this screen sees the last
  // known route immediately.
  useEffect(() => {
    if (!row?.route_json) {
      setRoute(null);
      return;
    }
    try {
      setRoute(JSON.parse(row.route_json) as RouteData);
    } catch {
      setRoute(null);
    }
  }, [row?.route_json]);

  // Auto-activate Navigation Mode if the assignment is already en_route
  useEffect(() => {
    if (row?.status === 'en_route') {
      setNavigationActive(true);
    }
  }, [row?.status]);

  // Foreground-only self position, purely for the embedded map — same
  // "starts on mount, stops on unmount" contract geolocation.ts already
  // documents for live-map.tsx.
  useEffect(() => {
    let stopWatch: (() => void) | undefined;
    let cancelled = false;

    loadSession().then((session) => {
      if (!cancelled && session) setBarangayId(session.barangayId);
    });

    getCurrentPosition()
      .then((p) => {
        if (!cancelled) setPosition(p);
      })
      .catch(() => {
        // No fix yet — the embedded map still frames on the destination alone.
      });

    watchPosition((p) => {
      if (!cancelled) setPosition(p);
    })
      .then((stop) => {
        if (cancelled) stop();
        else stopWatch = stop;
      })
      .catch(() => {
        // Same non-fatal treatment as live-map.tsx's own watch failure.
      });

    return () => {
      cancelled = true;
      stopWatch?.();
    };
  }, []);

  // Auto-fetch route once GPS position & server dispatch ID are ready,
  // so the user never has to search for and manually tap "Get Route".
  const autoFetchedRef = useRef(false);
  useEffect(() => {
    if (
      !autoFetchedRef.current &&
      row &&
      row.server_dispatch_id !== null &&
      position &&
      (!route || row.route_status === 'stale')
    ) {
      autoFetchedRef.current = true;
      void handleGetRoute();
    }
    // `handleGetRoute`/`row` intentionally excluded: `autoFetchedRef` already
    // makes this fire-once, and the effect only needs to react to these
    // specific primitive fields, not every `row` object re-fetch.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [row?.server_dispatch_id, position, route, row?.route_status]);

  // --- Navigation engine: compute NavigationState on every GPS update ---
  useEffect(() => {
    if (!navigationActive || !route || !position) {
      setNavState(null);
      return;
    }
    const state = computeNavigationState(position, route);
    setNavState(state);

    // Arrival detection: haptic feedback + note, once per session.
    if (state?.hasArrived && !arrivalPromptedRef.current) {
      arrivalPromptedRef.current = true;
      tacticalFeedback.vibrate([80, 100, 80, 100, 80]);
      // If the Tanod is still en_route, prompt to advance.
      if (row?.status === 'en_route') {
        setNote('You have arrived at the destination — tap "Mark Arrived" to update your status.');
      } else {
        setNote('You have arrived at the destination.');
      }
    }
  }, [navigationActive, route, position, row?.status]);

  /** Toggle navigation on/off. */
  const handleToggleNavigation = useCallback(() => {
    setNavigationActive((prev) => {
      if (prev) {
        // Stopping navigation — clear state.
        setNavState(null);
        arrivalPromptedRef.current = false;
      }
      return !prev;
    });
  }, []);

  /** Called when user manually pans the map during navigation — we just let auto-follow pause naturally. */
  const handleUserPan = useCallback(() => {
    // The LiveMapCanvas handles pausing auto-follow internally via userPannedRef.
    // The recenter FAB (already in the map) reactivates it.
  }, []);

  async function handleAdvanceStatus() {
    if (!row) return;
    const next = nextStatusFor(row.status);
    if (!next) return;
    if (row.server_dispatch_id === null) {
      setNote('This assignment has no server id yet — cannot change status.');
      return;
    }

    setUpdating(true);
    setNote(null);
    try {
      const { clientEventId } = await applyLocalStatusChange(row.local_id, next);
      tacticalFeedback.vibrate([40, 50, 40]);
      const refreshed = await getCachedDispatch(row.local_id);
      setRow(refreshed);

      try {
        await updateDispatchStatus(row.server_dispatch_id, next);
        await markStatusSynced(row.local_id);
        setRow(await getCachedDispatch(row.local_id));
        setNote(`Status updated to ${STATUS_LABEL[next]}.`);
      } catch (error) {
        // Offline or the server rejected it right now — queue the SAME
        // event id for syncService.ts to retry; the local status stays
        // updated either way (§9 M6: changes may be made offline).
        await enqueueDispatchStatusChange(clientEventId, {
          dispatchLocalId: row.local_id,
          serverDispatchId: row.server_dispatch_id,
          status: next,
        });
        setNote(
          error instanceof ApiError && error.isOffline
            ? `Offline — status set to ${STATUS_LABEL[next]} locally and queued to sync.`
            : `Workstation unreachable — status set to ${STATUS_LABEL[next]} locally and queued to sync.`
        );
      }
    } finally {
      setUpdating(false);
    }
  }

  /** Recenters the embedded in-app map — replaces the old external `geo:` hand-off (see header comment). */
  function handleNavigate() {
    mapRef.current?.recenter();
  }

  /** The explicit, opt-in escape hatch for a Tanod who wants their phone's own external maps app. */
  function handleOpenExternalMaps() {
    if (!row || row.latitude === null || row.longitude === null) return;
    window.location.href = `geo:${row.latitude},${row.longitude}?q=${row.latitude},${row.longitude}`;
  }

  /**
   * Fetches a real road-snapped route from the Tanod's CURRENT position
   * (reusing this screen's own `position` state — no second GPS call) to
   * the assignment's destination, via `GET /dispatch/:id/route`. Explicit
   * tap only — see this file's header comment for why. Caches the result
   * onto `dispatch_local` regardless of outcome (`route_status` alone
   * carries whether it's fresh, stale, or unavailable), mirroring
   * `handleAdvanceStatus()`'s own "update local state, note the outcome,
   * never throw past this handler" shape.
   */
  async function handleGetRoute() {
    if (!row || row.server_dispatch_id === null || !position) {
      setNote(position ? 'This assignment has no server id yet — cannot fetch a route.' : 'Waiting for a GPS fix — try again in a moment.');
      return;
    }

    setFetchingRoute(true);
    setNote(null);
    try {
      const result = await getDispatchRoute(row.server_dispatch_id, {
        latitude: position.latitude,
        longitude: position.longitude,
      });
      await cacheRouteFetch(row.local_id, result.routeJson, result.routeStatus);
      setRow(await getCachedDispatch(row.local_id));
      setNote(
        result.routeStatus === 'available'
          ? 'Route updated.'
          : result.routeStatus === 'stale'
            ? 'Could not refresh — showing the last known route.'
            : 'No route available right now.'
      );
    } catch (error) {
      setNote(
        error instanceof ApiError && error.isOffline
          ? 'Offline — cannot fetch a route right now.'
          : 'Workstation unreachable — cannot fetch a route right now.'
      );
    } finally {
      setFetchingRoute(false);
    }
  }

  const stale = row ? isCacheStale(row) : false;
  const next = row ? nextStatusFor(row.status) : null;
  const currentStageIndex = row ? STAGES.indexOf(row.status) : 0;

  const focusTarget: FocusTarget | null =
    row && row.latitude !== null && row.longitude !== null ? { latitude: row.latitude, longitude: row.longitude } : null;
  const destinationIncidents: NearbyIncident[] =
    row && focusTarget
      ? [
          {
            incidentId: row.server_incident_id,
            incidentType: row.redacted_incident_type ?? 'incident',
            priority: row.priority,
            status: row.status,
            latitude: focusTarget.latitude,
            longitude: focusTarget.longitude,
            ageSeconds: Math.max(0, Math.floor((Date.now() - new Date(row.dispatched_at).getTime()) / 1000)),
          },
        ]
      : [];

  return (
    <IonPage>
      <MobileHeader
        title={row ? `DISPATCH #${row.server_dispatch_id ?? row.local_id.slice(0, 6)}` : 'DISPATCH'}
        subtitle={navigationActive ? 'Turn-by-Turn Guidance' : 'Field Assignment Detail'}
        showBack
        defaultBackHref="/tabs/assignments"
        rightSlot={
          row && navigationActive ? (
            <button
              type="button"
              onClick={() => setNavigationActive(false)}
              style={{
                background: 'rgba(255, 255, 255, 0.15)',
                border: '1px solid rgba(255, 255, 255, 0.25)',
                borderRadius: '999px',
                color: '#ffffff',
                padding: '4px 10px',
                fontSize: '0.72rem',
                fontWeight: 700,
                cursor: 'pointer',
                display: 'flex',
                alignItems: 'center',
                gap: '4px',
              }}
              title="View Assignment Briefing"
            >
              <IonIcon icon={documentTextOutline} />
              Briefing
            </button>
          ) : undefined
        }
      />

      <IonContent
        scrollY={!navigationActive}
        className={navigationActive ? undefined : 'ion-padding'}
        style={{ '--background': 'var(--color-bg)' }}
      >
        {loading ? (
          <LoadingBlock />
        ) : !row ? (
          <div className="card--elevated" style={{ textAlign: 'center', padding: '32px 16px', marginTop: '24px' }}>
            <p style={{ color: 'var(--color-text-secondary)', marginBottom: '16px' }}>
              This assignment is not found in the local device cache.
            </p>
            <IonButton expand="block" onClick={() => navigate('/tabs/assignments')}>
              Back to Assignments
            </IonButton>
          </div>
        ) : navigationActive ? (
          /* ====================================================================
             ACTIVE TACTICAL NAVIGATION MODE (Full-Bleed Edge-to-Edge)
             ==================================================================== */
          <div className="nav-viewport-container">
            {/* Full-Bleed MapLibre Basemap */}
            {focusTarget && (
              <LiveMapCanvas
                ref={mapRef}
                barangayId={barangayId}
                position={position}
                incidents={destinationIncidents}
                tanods={[]}
                focusTarget={focusTarget}
                routeGeometry={route?.geometry ?? null}
                navigationMode={true}
                fullScreen={true}
                hideRecenterFab={true}
                height="100%"
                routeProgress={
                  navState
                    ? {
                        snappedPoint: navState.snappedPoint,
                        routeBearing: navState.routeBearing,
                        snappedSegmentIndex: navState.snappedSegmentIndex,
                        progressFraction: navState.progressFraction,
                      }
                    : null
                }
                onUserPan={handleUserPan}
              />
            )}

            {/* Automotive-Grade Turn HUD Banner */}
            {navState && route && (
              <ActiveStepCard
                navState={navState}
                steps={route.steps}
                mode={route.mode}
                onReroute={handleGetRoute}
              />
            )}

            {/* Floating Tactical Controls Rail */}
            <div className="nav-floating-controls">
              <button
                type="button"
                className="nav-floating-btn"
                onClick={handleNavigate}
                title="Recenter Camera on GPS"
                aria-label="Recenter map"
              >
                <IonIcon icon={locateOutline} style={{ color: 'var(--color-primary)' }} />
              </button>

              <button
                type="button"
                className="nav-floating-btn"
                onClick={handleGetRoute}
                disabled={fetchingRoute || !position}
                title="Recalculate Route"
                aria-label="Recalculate route"
              >
                {fetchingRoute ? (
                  <IonSpinner name="dots" style={{ width: '16px', height: '16px' }} />
                ) : (
                  <IonIcon icon={refreshOutline} />
                )}
              </button>

              <button
                type="button"
                className="nav-floating-btn"
                onClick={handleOpenExternalMaps}
                title="Open in External Maps"
                aria-label="External maps"
              >
                <IonIcon icon={openOutline} />
              </button>

              <button
                type="button"
                className="nav-floating-btn"
                onClick={() => {
                  tacticalFeedback.onTap();
                  handleToggleNavigation();
                }}
                title="Stop Navigation"
                aria-label="Stop navigation"
              >
                <IonIcon icon={stopOutline} style={{ color: 'var(--color-danger)' }} />
              </button>
            </div>

            {/* Floating Tactical Toast Notification */}
            {note && (
              <div className="toast--tactical" role="status">
                <span>{note}</span>
              </div>
            )}

            {/* Floating Tactical Bottom Sheet */}
            <div className="nav-bottom-sheet">
              <div className="nav-bottom-sheet__drag-handle" />

              <div className="nav-bottom-sheet__header">
                <div className="nav-bottom-sheet__title-row">
                  <span
                    className={`status-pill ${
                      row.priority === 'critical'
                        ? 'status-pill--critical is-urgent'
                        : row.priority === 'high'
                          ? 'status-pill--pending'
                          : 'status-pill--info'
                    }`}
                    style={{ fontSize: '0.68rem', padding: '2px 8px' }}
                  >
                    {row.priority.toUpperCase()}
                  </span>
                  <span className="nav-bottom-sheet__title">
                    {row.redacted_incident_type
                      ? row.redacted_incident_type.replace(/_/g, ' ').toUpperCase()
                      : 'INCIDENT'}
                  </span>
                </div>

                <span
                  style={{
                    fontSize: '0.74rem',
                    fontWeight: 700,
                    color: 'var(--color-primary)',
                    background: 'var(--color-surface-blue)',
                    padding: '2px 8px',
                    borderRadius: '999px',
                  }}
                >
                  {STATUS_LABEL[row.status] ?? row.status}
                </span>
              </div>

              <div className="nav-bottom-sheet__stats-row">
                {navState ? (
                  <>
                    <span className="nav-bottom-sheet__eta">
                      {formatRemainingTime(navState.remainingTimeS)}
                    </span>
                    <span className="nav-bottom-sheet__meta">
                      ({formatNavDistance(navState.remainingDistanceM)} remaining)
                    </span>
                  </>
                ) : (
                  <span className="nav-bottom-sheet__meta">
                    {position && focusTarget
                      ? `${formatDistance(distanceMeters(position.latitude, position.longitude, focusTarget.latitude, focusTarget.longitude))} away`
                      : 'Calculating distance…'}
                  </span>
                )}
              </div>

              {/* Primary Action Button */}
              {next ? (
                <IonButton
                  expand="block"
                  disabled={updating}
                  onClick={handleAdvanceStatus}
                  style={{
                    fontWeight: 800,
                    height: '48px',
                    fontSize: '0.95rem',
                    '--background':
                      row.priority === 'critical'
                        ? 'linear-gradient(135deg, #b91c1c 0%, #dc2626 100%)'
                        : 'linear-gradient(135deg, var(--color-navy) 0%, var(--color-primary) 100%)',
                    '--border-radius': '12px',
                  }}
                >
                  {updating ? <IonSpinner name="dots" /> : NEXT_ACTION_LABEL[next]}
                </IonButton>
              ) : (
                <div style={{ textAlign: 'center', padding: '8px 0', color: 'var(--color-success)', fontWeight: 700 }}>
                  <IonIcon icon={checkmarkCircleOutline} style={{ marginRight: '6px' }} />
                  Dispatch assignment completed
                </div>
              )}

              {row.synced === 0 && (
                <div
                  style={{
                    marginTop: '8px',
                    fontSize: '0.72rem',
                    color: 'var(--color-warning)',
                    display: 'flex',
                    alignItems: 'center',
                    justifyContent: 'center',
                    gap: '6px',
                  }}
                >
                  <IonIcon icon={syncOutline} />
                  <span>Pending synchronization with Barangay HQ</span>
                </div>
              )}
            </div>
          </div>
        ) : (
          /* ====================================================================
             ASSIGNMENT BRIEFING & OVERVIEW MODE (Snug, Structured Layout)
             ==================================================================== */
          <div className="app-column dispatch-detail-layout">
            {/* Tactical Briefing Card */}
            <div className="card--tactical card--elevated" style={{ marginBottom: '14px', padding: '14px 16px' }}>
              <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '8px' }}>
                <span
                  className={`status-pill ${
                    row.priority === 'critical'
                      ? 'status-pill--critical is-urgent'
                      : row.priority === 'high'
                        ? 'status-pill--pending'
                        : 'status-pill--info'
                  }`}
                >
                  {row.priority.toUpperCase()} PRIORITY
                </span>

                <span className="status-pill status-pill--info">
                  {STATUS_LABEL[row.status] ?? row.status}
                </span>
              </div>

              <h2 style={{ fontSize: 'var(--font-size-lg)', fontWeight: 800, margin: '0 0 6px', color: 'var(--color-text-primary)' }}>
                {row.redacted_incident_type
                  ? row.redacted_incident_type.replace(/_/g, ' ').toUpperCase()
                  : 'INCIDENT BRIEFING'}
              </h2>

              <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', fontSize: '0.8rem', color: 'var(--color-text-secondary)' }}>
                <div style={{ display: 'flex', alignItems: 'center', gap: '6px' }}>
                  <IonIcon icon={locationOutline} style={{ color: 'var(--color-primary)' }} />
                  <span>
                    {position && focusTarget
                      ? `${formatDistance(distanceMeters(position.latitude, position.longitude, focusTarget.latitude, focusTarget.longitude))} away`
                      : row.latitude !== null && row.longitude !== null
                        ? `${row.latitude.toFixed(4)}, ${row.longitude.toFixed(4)}`
                        : 'Target location set'}
                  </span>
                </div>

                <div style={{ display: 'flex', alignItems: 'center', gap: '4px', color: 'var(--color-text-tertiary)', fontSize: '0.72rem' }}>
                  <span>{ROUTE_STATUS_LABEL[row.route_status] ?? row.route_status}</span>
                  {stale && <span style={{ color: 'var(--color-warning)' }}>(Cached)</span>}
                </div>
              </div>
            </div>

            {/* 4-Stage Workflow Stepper */}
            <div className="card--elevated" style={{ padding: '14px 12px', marginBottom: '14px' }}>
              <div style={{ marginBottom: '10px', fontSize: 'var(--font-size-sm)', fontWeight: 700, color: 'var(--color-text-secondary)' }}>
                DISPATCH WORKFLOW
              </div>
              <div className="stepper-container" style={{ margin: '8px 0' }}>
                {STAGES.map((stageName, idx) => {
                  const isDone = idx < currentStageIndex;
                  const isActive = idx === currentStageIndex;
                  return (
                    <div key={stageName} className="stepper-step">
                      <div
                        className={`stepper-node ${
                          isDone ? 'stepper-node--completed' : isActive ? 'stepper-node--active' : ''
                        }`}
                      >
                        {isDone ? <IonIcon icon={checkmarkCircleOutline} /> : idx + 1}
                      </div>
                      <span className={`stepper-text ${isActive ? 'stepper-text--active' : ''}`}>
                        {STATUS_LABEL[stageName]}
                      </span>
                    </div>
                  );
                })}
              </div>
            </div>

            {/* In-App Route Map Preview */}
            {focusTarget && (
              <div style={{ marginBottom: '16px' }}>
                <LiveMapCanvas
                  ref={mapRef}
                  barangayId={barangayId}
                  position={position}
                  incidents={destinationIncidents}
                  tanods={[]}
                  focusTarget={focusTarget}
                  routeGeometry={route?.geometry ?? null}
                  navigationMode={false}
                  height="240px"
                />

                <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginTop: '6px', padding: '0 4px' }}>
                  <button
                    type="button"
                    onClick={handleNavigate}
                    style={{
                      background: 'none',
                      border: 'none',
                      padding: '4px 0',
                      color: 'var(--color-primary)',
                      fontSize: '0.75rem',
                      fontWeight: 700,
                      display: 'flex',
                      alignItems: 'center',
                      gap: '4px',
                      cursor: 'pointer',
                    }}
                  >
                    <IonIcon icon={locateOutline} />
                    Center Map
                  </button>

                  <div style={{ display: 'flex', alignItems: 'center', gap: '12px' }}>
                    <button
                      type="button"
                      onClick={handleGetRoute}
                      disabled={fetchingRoute || !position}
                      style={{
                        background: 'none',
                        border: 'none',
                        padding: '4px 0',
                        color: 'var(--color-primary)',
                        fontSize: '0.75rem',
                        fontWeight: 700,
                        display: 'flex',
                        alignItems: 'center',
                        gap: '4px',
                        cursor: 'pointer',
                      }}
                    >
                      {fetchingRoute ? <IonSpinner name="dots" style={{ width: '14px', height: '14px' }} /> : <IonIcon icon={refreshOutline} />}
                      Re-route
                    </button>

                    <button
                      type="button"
                      onClick={handleOpenExternalMaps}
                      style={{
                        background: 'none',
                        border: 'none',
                        padding: '4px 0',
                        color: 'var(--color-text-secondary)',
                        fontSize: '0.75rem',
                        display: 'flex',
                        alignItems: 'center',
                        gap: '4px',
                        cursor: 'pointer',
                      }}
                    >
                      <IonIcon icon={openOutline} />
                      External Maps
                    </button>
                  </div>
                </div>
              </div>
            )}

            {/* Inline Note / Status Alert */}
            {note && (
              <div
                style={{
                  background: 'var(--tint-info-bg)',
                  border: '1px solid color-mix(in srgb, var(--color-primary) 30%, transparent)',
                  borderRadius: 'var(--radius-md)',
                  padding: '10px 14px',
                  color: 'var(--pill-info-text)',
                  fontSize: 'var(--font-size-sm)',
                  marginBottom: '12px',
                }}
                role="status"
              >
                {note}
              </div>
            )}

            {row.synced === 0 && (
              <div
                style={{
                  background: 'var(--tint-warning-bg)',
                  border: '1px solid var(--color-warning)',
                  borderRadius: 'var(--radius-md)',
                  padding: '10px 14px',
                  color: 'var(--pill-warning-text)',
                  fontSize: 'var(--font-size-sm)',
                  marginBottom: '12px',
                  display: 'flex',
                  alignItems: 'center',
                  gap: '8px',
                }}
                role="status"
              >
                <IonIcon icon={syncOutline} />
                <span>Pending synchronization with Barangay HQ.</span>
              </div>
            )}

            {/* Primary Action Buttons */}
            <div style={{ display: 'flex', flexDirection: 'column', gap: '10px', marginTop: '8px' }}>
              <IonButton
                expand="block"
                onClick={() => {
                  tacticalFeedback.onTap();
                  if (row.status === 'assigned') {
                    void handleAdvanceStatus();
                  }
                  setNavigationActive(true);
                }}
                style={{
                  fontWeight: 800,
                  height: '48px',
                  '--background': 'linear-gradient(135deg, var(--color-navy) 0%, var(--color-primary) 100%)',
                  '--border-radius': '12px',
                }}
              >
                <IonIcon icon={navigateOutline} slot="start" />
                {row.status === 'assigned' ? 'Start Navigation & En Route' : 'Resume Navigation'}
              </IonButton>

              {next && row.status !== 'assigned' && (
                <IonButton
                  expand="block"
                  fill="outline"
                  disabled={updating}
                  onClick={handleAdvanceStatus}
                  style={{
                    fontWeight: 700,
                    height: '44px',
                    '--border-radius': '12px',
                  }}
                >
                  {updating ? <IonSpinner name="dots" /> : NEXT_ACTION_LABEL[next]}
                </IonButton>
              )}
            </div>
          </div>
        )}
      </IonContent>
    </IonPage>
  );
};

export default AssignmentDetailPage;
