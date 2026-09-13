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
 * `geo:` behavior for a Tanod who genuinely wants road-snapped turn-by-
 * turn — full in-app routing needs an offline routing engine + real road
 * data that don't exist anywhere in this stack (REMAINING.md C4), so this
 * screen is honest about giving distance/bearing on a real map rather
 * than pretending to route.
 */

import { useEffect, useRef, useState } from 'react';
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
  locateOutline,
  locationOutline,
  navigateOutline,
  syncOutline,
  timeOutline,
} from 'ionicons/icons';
import LiveMapCanvas, { type FocusTarget, type LiveMapCanvasHandle } from '../components/LiveMapCanvas';
import MobileHeader from '../components/MobileHeader';
import { ApiError, updateDispatchStatus, type NearbyIncident } from '../services/apiService';
import {
  applyLocalStatusChange,
  getCachedDispatch,
  isCacheStale,
  markStatusSynced,
  nextStatusFor,
} from '../services/db/dispatchRepository';
import { enqueueDispatchStatusChange } from '../services/db/offlineQueueRepository';
import type { DispatchLocalRow } from '../services/db/localSchema';
import { getCurrentPosition, watchPosition, type DevicePosition } from '../services/geolocation';
import { loadSession } from '../services/session';

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
  const mapRef = useRef<LiveMapCanvasHandle>(null);

  useEffect(() => {
    setLoading(true);
    getCachedDispatch(localId)
      .then(setRow)
      .finally(() => setLoading(false));
  }, [localId]);

  // Foreground-only self position, purely for the embedded map — same
  // "starts on mount, stops on unmount" contract geolocation.ts already
  // documents for live-map.tsx (this screen never calls postGps(); GPS
  // broadcast stays exclusively Live Map's job).
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

  /** The explicit, opt-in escape hatch for a Tanod who wants real road-snapped turn-by-turn. */
  function handleOpenExternalMaps() {
    if (!row || row.latitude === null || row.longitude === null) return;
    window.location.href = `geo:${row.latitude},${row.longitude}?q=${row.latitude},${row.longitude}`;
  }

  if (!row && !loading) {
    return (
      <IonPage>
        <MobileHeader title="ASSIGNMENT" showBack defaultBackHref="/assignments" />
        <IonContent className="ion-padding">
          <div className="card--elevated" style={{ textAlign: 'center', padding: '32px 16px', marginTop: '24px' }}>
            <p style={{ color: 'var(--color-text-secondary)', marginBottom: '16px' }}>
              This assignment is not found in the local device cache.
            </p>
            <IonButton expand="block" onClick={() => navigate('/assignments')}>
              Back to Assignments
            </IonButton>
          </div>
        </IonContent>
      </IonPage>
    );
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
        subtitle="Field Assignment Detail"
        showBack
        defaultBackHref="/assignments"
      />

      <IonContent className="ion-padding" style={{ '--background': 'var(--color-bg)' }}>
        <div className="app-column">
          {loading ? (
            <div style={{ display: 'flex', justifyContent: 'center', paddingTop: 64 }}>
              <IonSpinner name="dots" />
            </div>
          ) : row ? (
            <>
              {/* Tactical Briefing Card */}
              <div className="card--tactical card--elevated" style={{ marginBottom: '16px' }}>
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
                    {row.priority} PRIORITY
                  </span>

                  <span className="status-pill status-pill--info">
                    {STATUS_LABEL[row.status] ?? row.status}
                  </span>
                </div>

                <h2 style={{ fontSize: 'var(--font-size-xl)', fontWeight: 800, margin: '0 0 6px', color: 'var(--color-text-primary)' }}>
                  {row.redacted_incident_type
                    ? row.redacted_incident_type.replace(/_/g, ' ').toUpperCase()
                    : 'INCIDENT BRIEFING'}
                </h2>

                <div style={{ display: 'flex', alignItems: 'center', gap: '6px', color: 'var(--color-text-secondary)', fontSize: 'var(--font-size-sm)', marginBottom: '8px' }}>
                  <IonIcon icon={locationOutline} style={{ color: 'var(--color-primary)' }} />
                  <span>
                    {row.latitude !== null && row.longitude !== null
                      ? `${row.latitude.toFixed(5)}, ${row.longitude.toFixed(5)}`
                      : 'Coordinates not specified'}
                  </span>
                </div>

                <div style={{ display: 'flex', alignItems: 'center', gap: '6px', color: 'var(--color-text-tertiary)', fontSize: '0.75rem' }}>
                  <IonIcon icon={navigateOutline} />
                  <span>{ROUTE_STATUS_LABEL[row.route_status] ?? row.route_status}</span>
                  {stale && <span style={{ color: 'var(--color-warning)' }}>(Cached)</span>}
                </div>
              </div>

              {/* In-app destination map — replaces the old external geo: hand-off */}
              {focusTarget && (
                <div style={{ marginBottom: '8px' }}>
                  <LiveMapCanvas
                    ref={mapRef}
                    barangayId={barangayId}
                    position={position}
                    incidents={destinationIncidents}
                    tanods={[]}
                    focusTarget={focusTarget}
                  />
                  <div style={{ textAlign: 'right', marginTop: '4px' }}>
                    <button
                      type="button"
                      onClick={handleOpenExternalMaps}
                      style={{
                        background: 'none',
                        border: 'none',
                        padding: '4px 0',
                        color: 'var(--color-text-tertiary)',
                        fontSize: '0.72rem',
                        textDecoration: 'underline',
                      }}
                    >
                      Open in external navigation app
                    </button>
                  </div>
                </div>
              )}

              {/* 4-Stage Status Stepper */}
              <div className="card--elevated" style={{ padding: '16px 8px', marginBottom: '16px' }}>
                <div style={{ paddingLeft: '8px', marginBottom: '12px', fontSize: 'var(--font-size-sm)', fontWeight: 700, color: 'var(--color-text-secondary)' }}>
                  DISPATCH WORKFLOW
                </div>
                <div className="stepper-container">
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

              {/* Notification / Sync Status */}
              {note && (
                <div
                  style={{
                    background: 'var(--tint-info-bg)',
                    border: '1px solid color-mix(in srgb, var(--color-primary) 30%, transparent)',
                    borderRadius: 'var(--radius-md)',
                    padding: '10px 14px',
                    color: 'var(--pill-info-text)',
                    fontSize: 'var(--font-size-sm)',
                    marginBottom: '16px',
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
                    marginBottom: '16px',
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

              {/* Sticky Action Controls */}
              <div className="sticky-action-bar">
                <IonButton
                  expand="block"
                  fill="outline"
                  disabled={row.latitude === null || row.longitude === null}
                  onClick={handleNavigate}
                  style={{ flex: 1, fontWeight: 700 }}
                >
                  <IonIcon icon={locateOutline} slot="start" />
                  Center Map
                </IonButton>

                {next && (
                  <IonButton
                    expand="block"
                    disabled={updating}
                    onClick={handleAdvanceStatus}
                    style={{
                      flex: 1.5,
                      fontWeight: 700,
                      '--background': 'linear-gradient(135deg, var(--color-navy) 0%, var(--color-primary) 100%)',
                    }}
                  >
                    {updating ? <IonSpinner name="dots" /> : NEXT_ACTION_LABEL[next]}
                  </IonButton>
                )}
              </div>
            </>
          ) : null}
        </div>
      </IonContent>
    </IonPage>
  );
};

export default AssignmentDetailPage;
