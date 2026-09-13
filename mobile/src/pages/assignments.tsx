/**
 * assignments.tsx — M5 Assignments List (§9 Mobile).
 *
 * §9 M5: "Reads cached assignments so the screen still works when the
 * workstation/API is unreachable. Shows stale/cached indicator." On mount,
 * this tries a real `GET /dispatch` refresh (which also repopulates
 * `dispatch_local` via `dispatchRepository.cacheDispatchesFromServer`); if
 * that fails (offline), it falls straight back to whatever is already
 * cached — the screen never blanks just because the workstation is
 * unreachable.
 *
 * UI reference (§9): "card per assignment (priority dot, ID, priority
 * pill, type, location, distance)" with Navigate/Call Dispatch/Mark as
 * Arrived actions, and an explicit "No Active Assignments" empty state.
 * Call Dispatch is still not built: there is no phone number field
 * anywhere in §5/§6 to call. Navigate/Mark-as-Arrived live on M6's detail
 * screen instead, reached by tapping a card.
 *
 * DISTANCE/BEARING (Mobile Improvement Plan Phase 2.3): this screen now
 * runs its own foreground-only self-position watch (same
 * starts-on-mount/stops-on-unmount contract `geolocation.ts` already
 * documents for M7) purely to compute a live straight-line distance and
 * compass bearing per card (`utils/geo.ts` — haversine, NOT road-routed,
 * same honesty as everywhere else this figure is shown). This screen
 * still never calls `postGps()`; GPS broadcast to the server stays
 * exclusively Live Map's job. When no fix is available yet, or a card's
 * own dispatch has no coordinates, the card says so in words rather than
 * showing a stale or fabricated number (§8: no demo-tell).
 */

import { useCallback, useEffect, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import {
  IonContent,
  IonIcon,
  IonPage,
  IonRefresher,
  IonRefresherContent,
  IonSpinner,
} from '@ionic/react';
import type { RefresherEventDetail } from '@ionic/core';
import {
  chevronForwardOutline,
  locationOutline,
  radioOutline,
  shieldCheckmarkOutline,
  timeOutline,
  warningOutline,
} from 'ionicons/icons';
import MobileHeader from '../components/MobileHeader';
import { ApiError, getDispatches } from '../services/apiService';
import { cacheDispatchesFromServer, isCacheStale, listActiveCachedDispatches } from '../services/db/dispatchRepository';
import type { DispatchLocalRow } from '../services/db/localSchema';
import { getCurrentPosition, watchPosition, type DevicePosition } from '../services/geolocation';
import { bearingLabel, distanceMeters, formatDistance } from '../utils/geo';

const PRIORITY_PILL_CLASS: Record<string, string> = {
  normal: 'status-pill--info',
  high: 'status-pill--pending',
  critical: 'status-pill--critical is-urgent',
};

const PRIORITY_ACCENT_CLASS: Record<string, string> = {
  normal: 'card--info-accent',
  high: 'card--warning-accent',
  critical: 'card--critical-accent',
};

const STATUS_PILL_CLASS: Record<string, string> = {
  assigned: 'status-pill--pending',
  en_route: 'status-pill--info',
  arrived: 'status-pill--success',
};

const STATUS_LABEL: Record<string, string> = {
  assigned: 'Assigned',
  en_route: 'En Route',
  arrived: 'Arrived',
};

const AssignmentsPage: React.FC = () => {
  const navigate = useNavigate();
  const [rows, setRows] = useState<DispatchLocalRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [offlineNote, setOfflineNote] = useState<string | null>(null);
  const [position, setPosition] = useState<DevicePosition | null>(null);

  useEffect(() => {
    let stopWatch: (() => void) | undefined;
    let cancelled = false;

    getCurrentPosition()
      .then((p) => {
        if (!cancelled) setPosition(p);
      })
      .catch(() => {
        // No fix yet — cards fall back to "Distance unknown" below.
      });

    watchPosition((p) => {
      if (!cancelled) setPosition(p);
    })
      .then((stop) => {
        if (cancelled) stop();
        else stopWatch = stop;
      })
      .catch(() => {
        // Same non-fatal treatment as every other screen's watch failure.
      });

    return () => {
      cancelled = true;
      stopWatch?.();
    };
  }, []);

  const load = useCallback(async () => {
    try {
      const entries = await getDispatches();
      await cacheDispatchesFromServer(entries);
      setOfflineNote(null);
    } catch (error) {
      setOfflineNote(
        error instanceof ApiError && error.isOffline
          ? 'Offline — showing the last cached assignments.'
          : 'Could not refresh from the workstation — showing cached records.'
      );
    }
    const cached = await listActiveCachedDispatches();
    setRows(cached);
  }, []);

  useEffect(() => {
    setLoading(true);
    load().finally(() => setLoading(false));
  }, [load]);

  async function handleRefresh(event: CustomEvent<RefresherEventDetail>) {
    await load();
    event.detail.complete();
  }

  return (
    <IonPage>
      <MobileHeader title="DISPATCHES" subtitle="Active Field Queue" />

      <IonContent className="ion-padding" style={{ '--background': 'var(--color-bg)' }}>
        <IonRefresher slot="fixed" onIonRefresh={handleRefresh}>
          <IonRefresherContent />
        </IonRefresher>

        <div className="app-column">
          {offlineNote && (
            <div
              style={{
                background: 'var(--tint-warning-bg)',
                border: '1px solid var(--color-warning)',
                borderRadius: 'var(--radius-md)',
                padding: '10px 14px',
                marginBottom: '16px',
                display: 'flex',
                alignItems: 'center',
                gap: '8px',
                color: 'var(--pill-warning-text)',
                fontSize: 'var(--font-size-sm)',
              }}
              role="status"
            >
              <IonIcon icon={warningOutline} style={{ fontSize: '1.2rem', flexShrink: 0 }} />
              <span>{offlineNote}</span>
            </div>
          )}

          {loading ? (
            <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', paddingTop: 64, gap: 12 }}>
              <IonSpinner name="dots" />
              <span style={{ fontSize: 'var(--font-size-sm)', color: 'var(--color-text-secondary)' }}>
                Loading dispatch assignments…
              </span>
            </div>
          ) : rows.length === 0 ? (
            <div
              className="card--elevated"
              style={{
                textAlign: 'center',
                padding: '48px 24px',
                display: 'flex',
                flexDirection: 'column',
                alignItems: 'center',
                marginTop: '16px',
              }}
            >
              <div
                style={{
                  width: '64px',
                  height: '64px',
                  borderRadius: '50%',
                  background: 'var(--tint-success-bg)',
                  color: 'var(--color-success)',
                  display: 'flex',
                  alignItems: 'center',
                  justifyContent: 'center',
                  fontSize: '2rem',
                  marginBottom: '16px',
                }}
              >
                <IonIcon icon={shieldCheckmarkOutline} />
              </div>
              <h3 style={{ margin: '0 0 6px', fontSize: 'var(--font-size-lg)', fontWeight: 700 }}>
                No Active Dispatches
              </h3>
              <p style={{ margin: 0, color: 'var(--color-text-secondary)', fontSize: 'var(--font-size-sm)', maxWidth: '280px' }}>
                You have no pending assignments. Stand by or maintain active patrol.
              </p>
            </div>
          ) : (
            <div className="card-list">
              {rows.map((row) => {
                const stale = isCacheStale(row);
                const accentClass = PRIORITY_ACCENT_CLASS[row.priority] ?? 'card--info-accent';
                const pillClass = PRIORITY_PILL_CLASS[row.priority] ?? 'status-pill--info';
                const statusClass = STATUS_PILL_CLASS[row.status] ?? 'status-pill--neutral';

                return (
                  <button
                    key={row.local_id}
                    type="button"
                    className={`card ${accentClass}`}
                    style={{
                      display: 'flex',
                      alignItems: 'center',
                      justifyContent: 'space-between',
                      padding: '16px',
                      cursor: 'pointer',
                    }}
                    onClick={() => navigate(`/assignments/${encodeURIComponent(row.local_id)}`)}
                  >
                    <div style={{ flex: 1, paddingRight: '12px' }}>
                      <div className="card__header" style={{ marginBottom: '6px' }}>
                        <span className={`status-pill ${pillClass}`}>{row.priority}</span>
                        <span className={`status-pill ${statusClass}`}>{STATUS_LABEL[row.status] ?? row.status}</span>
                        <span style={{ fontSize: 'var(--font-size-label)', color: 'var(--color-text-tertiary)', marginLeft: 'auto', fontFamily: 'var(--font-mono)' }}>
                          #{row.server_dispatch_id ?? row.local_id.slice(0, 6)}
                        </span>
                      </div>

                      <div style={{ fontSize: 'var(--font-size-md)', fontWeight: 700, color: 'var(--color-text-primary)', marginBottom: '4px' }}>
                        {row.redacted_incident_type
                          ? row.redacted_incident_type.replace(/_/g, ' ').toUpperCase()
                          : 'Incident Details Restricted'}
                      </div>

                      <div style={{ display: 'flex', alignItems: 'center', gap: '4px', fontSize: 'var(--font-size-sm)', color: 'var(--color-text-secondary)' }}>
                        <IonIcon icon={locationOutline} style={{ fontSize: '1rem', color: 'var(--color-primary)' }} />
                        <span>
                          {row.latitude === null || row.longitude === null
                            ? 'Coordinates pending'
                            : position
                              ? `${formatDistance(distanceMeters(position.latitude, position.longitude, row.latitude, row.longitude))} · ${bearingLabel(position.latitude, position.longitude, row.latitude, row.longitude)}`
                              : 'Distance unknown — GPS acquiring'}
                        </span>
                      </div>

                      {stale && (
                        <div style={{ display: 'flex', alignItems: 'center', gap: '4px', marginTop: '6px', fontSize: '0.72rem', color: 'var(--color-warning)' }}>
                          <IonIcon icon={timeOutline} />
                          <span>Cached — not updated live</span>
                        </div>
                      )}
                    </div>

                    <IonIcon icon={chevronForwardOutline} style={{ fontSize: '1.25rem', color: 'var(--color-text-tertiary)' }} />
                  </button>
                );
              })}
            </div>
          )}
        </div>
      </IonContent>
    </IonPage>
  );
};

export default AssignmentsPage;
