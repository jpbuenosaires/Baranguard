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

import { useCallback, useEffect, useMemo, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import {
  IonContent,
  IonIcon,
  IonPage,
  IonRefresher,
  IonRefresherContent,
} from '@ionic/react';
import type { RefresherEventDetail } from '@ionic/core';
import {
  alertCircleOutline,
  carOutline,
  closeCircleOutline,
  compassOutline,
  documentTextOutline,
  flameOutline,
  flashOutline,
  locationOutline,
  medkitOutline,
  navigateOutline,
  pawOutline,
  playOutline,
  radioOutline,
  refreshOutline,
  searchOutline,
  shieldCheckmarkOutline,
  timeOutline,
  warningOutline,
} from 'ionicons/icons';
import MobileHeader from '../components/MobileHeader';
import { LoadingBlock } from '../components/LoadingBlock';
import { ApiError, getDispatches } from '../services/apiService';
import { cacheDispatchesFromServer, isCacheStale, listActiveCachedDispatches } from '../services/db/dispatchRepository';
import type { DispatchLocalRow } from '../services/db/localSchema';
import { getCurrentPosition, watchPosition, type DevicePosition } from '../services/geolocation';
import { bearingLabel, distanceMeters, formatDistance } from '../utils/geo';
import tacticalFeedback from '../utils/tacticalFeedback';

const PRIORITY_PILL_CLASS: Record<string, string> = {
  normal: 'status-pill--info',
  high: 'status-pill--pending',
  critical: 'status-pill--critical is-urgent',
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

const PRIORITY_ORDER: Record<string, number> = {
  critical: 0,
  high: 1,
  normal: 2,
};

function getCategoryIcon(type?: string | null) {
  const normalized = (type ?? '').toLowerCase();
  if (normalized.includes('injury') || normalized.includes('medical') || normalized.includes('health')) {
    return medkitOutline;
  }
  if (normalized.includes('theft') || normalized.includes('vandalism') || normalized.includes('robbery')) {
    return shieldCheckmarkOutline;
  }
  if (normalized.includes('traffic') || normalized.includes('vehic') || normalized.includes('car')) {
    return carOutline;
  }
  if (normalized.includes('animal') || normalized.includes('dog')) {
    return pawOutline;
  }
  if (normalized.includes('fire') || normalized.includes('smoke')) {
    return flameOutline;
  }
  if (normalized.includes('disturbance') || normalized.includes('dispute') || normalized.includes('noise')) {
    return alertCircleOutline;
  }
  return documentTextOutline;
}

type FilterTab = 'all' | 'critical' | 'en_route' | 'assigned' | 'arrived';

const AssignmentsPage: React.FC = () => {
  const navigate = useNavigate();
  const [rows, setRows] = useState<DispatchLocalRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [offlineNote, setOfflineNote] = useState<string | null>(null);
  const [offlineDismissed, setOfflineDismissed] = useState(false);
  const [position, setPosition] = useState<DevicePosition | null>(null);
  const [activeFilter, setActiveFilter] = useState<FilterTab>('all');
  const [searchQuery, setSearchQuery] = useState('');

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
    try {
      const cached = await listActiveCachedDispatches();
      setRows(cached);
    } catch (dbErr) {
      console.warn('[Assignments] Failed to read local dispatch cache:', dbErr);
    }
  }, []);

  useEffect(() => {
    setLoading(true);
    load().finally(() => setLoading(false));
  }, [load]);

  async function handleRefresh(event: CustomEvent<RefresherEventDetail>) {
    tacticalFeedback.onTap();
    setOfflineDismissed(false);
    try {
      await Promise.race([
        load(),
        new Promise((resolve) => setTimeout(resolve, 5000)),
      ]);
    } catch (err) {
      console.warn('[Assignments] Refresh error:', err);
    } finally {
      event.detail.complete();
    }
  }

  // Calculate filter counts & closest assignment telemetry
  const telemetry = useMemo(() => {
    const counts = {
      all: rows.length,
      critical: 0,
      en_route: 0,
      assigned: 0,
      arrived: 0,
    };

    let closestDist = Infinity;
    let closestBearing = '';

    rows.forEach((r) => {
      if (r.priority === 'critical') counts.critical += 1;
      if (r.status === 'en_route') counts.en_route += 1;
      if (r.status === 'assigned') counts.assigned += 1;
      if (r.status === 'arrived') counts.arrived += 1;

      if (position && r.latitude !== null && r.longitude !== null) {
        const dist = distanceMeters(position.latitude, position.longitude, r.latitude, r.longitude);
        if (dist < closestDist) {
          closestDist = dist;
          closestBearing = bearingLabel(position.latitude, position.longitude, r.latitude, r.longitude);
        }
      }
    });

    return {
      counts,
      closestFormatted: closestDist !== Infinity ? `${formatDistance(closestDist)} · ${closestBearing}` : 'Searching…',
    };
  }, [rows, position]);

  // Filter and sort items: Critical dispatches always on top
  const filteredAndSortedRows = useMemo(() => {
    const query = searchQuery.trim().toLowerCase();

    const filtered = rows.filter((r) => {
      // Tab filter
      if (activeFilter === 'critical' && r.priority !== 'critical') return false;
      if (activeFilter === 'en_route' && r.status !== 'en_route') return false;
      if (activeFilter === 'assigned' && r.status !== 'assigned') return false;
      if (activeFilter === 'arrived' && r.status !== 'arrived') return false;

      // Text Search filter
      if (query) {
        const typeMatch = (r.redacted_incident_type ?? '').toLowerCase().includes(query);
        const idMatch = (r.server_dispatch_id ? `#${r.server_dispatch_id}` : `#${r.local_id}`).toLowerCase().includes(query);
        return typeMatch || idMatch;
      }

      return true;
    });

    return [...filtered].sort((a, b) => {
      const pA = PRIORITY_ORDER[a.priority] ?? 2;
      const pB = PRIORITY_ORDER[b.priority] ?? 2;
      if (pA !== pB) return pA - pB;

      // Distance secondary sorting if user position is known
      if (position && a.latitude !== null && a.longitude !== null && b.latitude !== null && b.longitude !== null) {
        const distA = distanceMeters(position.latitude, position.longitude, a.latitude, a.longitude);
        const distB = distanceMeters(position.latitude, position.longitude, b.latitude, b.longitude);
        return distA - distB;
      }
      return 0;
    });
  }, [rows, activeFilter, searchQuery, position]);

  const handleFilterChange = (filter: FilterTab) => {
    tacticalFeedback.onTap();
    setActiveFilter(filter);
  };

  return (
    <IonPage>
      <MobileHeader title="DISPATCHES" subtitle="Active Field Queue" />

      <IonContent className="ion-padding" style={{ '--background': 'var(--color-bg)' }}>
        <IonRefresher
          slot="fixed"
          onIonRefresh={handleRefresh}
          style={{ '--color': 'var(--color-primary, #3b82f6)' }}
        >
          <IonRefresherContent refreshingSpinner="crescent" />
        </IonRefresher>

        <div className="app-column dispatch-layout">
          {offlineNote && !offlineDismissed && (
            <div className="dispatch-offline-banner" role="status">
              <div className="dispatch-offline-banner-content">
                <IonIcon icon={warningOutline} className="dispatch-offline-icon" />
                <span className="dispatch-offline-text">{offlineNote}</span>
              </div>
              <div className="dispatch-offline-actions">
                <button
                  type="button"
                  className="dispatch-offline-btn"
                  onClick={() => {
                    tacticalFeedback.onTap();
                    void load();
                  }}
                  title="Retry connecting to workstation"
                >
                  <IonIcon icon={refreshOutline} style={{ marginRight: '3px', verticalAlign: '-1px' }} />
                  Retry
                </button>
                <button
                  type="button"
                  className="dispatch-offline-dismiss"
                  onClick={() => setOfflineDismissed(true)}
                  aria-label="Dismiss notice"
                >
                  <IonIcon icon={closeCircleOutline} />
                </button>
              </div>
            </div>
          )}

          {/* Operational Telemetry Summary Strip */}
          {!loading && rows.length > 0 && (
            <div className="dispatch-telemetry-strip">
              <div className="dispatch-telemetry-item">
                <span className="dispatch-telemetry-label">
                  <IonIcon icon={flashOutline} />
                  Urgent
                </span>
                <span className={`dispatch-telemetry-val ${telemetry.counts.critical > 0 ? 'dispatch-telemetry-val--urgent' : ''}`}>
                  {telemetry.counts.critical} CRIT
                </span>
              </div>

              <div className="dispatch-telemetry-item">
                <span className="dispatch-telemetry-label">
                  <IonIcon icon={compassOutline} />
                  Nearest
                </span>
                <span className="dispatch-telemetry-val" style={{ fontSize: '0.8rem' }}>
                  {telemetry.closestFormatted}
                </span>
              </div>

              <div className="dispatch-telemetry-item">
                <span className="dispatch-telemetry-label">
                  <IonIcon icon={navigateOutline} />
                  Responding
                </span>
                <span className="dispatch-telemetry-val dispatch-telemetry-val--active">
                  {telemetry.counts.en_route} Active
                </span>
              </div>
            </div>
          )}

          {/* Search Bar */}
          {!loading && rows.length > 0 && (
            <div className="dispatch-search-box">
              <IonIcon icon={searchOutline} />
              <input
                type="text"
                className="dispatch-search-input"
                placeholder="Search incident type or #ID..."
                value={searchQuery}
                onChange={(e) => setSearchQuery(e.target.value)}
              />
              {searchQuery && (
                <button
                  type="button"
                  className="dispatch-search-clear"
                  onClick={() => {
                    tacticalFeedback.onTap();
                    setSearchQuery('');
                  }}
                  aria-label="Clear search"
                >
                  <IonIcon icon={closeCircleOutline} />
                </button>
              )}
            </div>
          )}

          {/* Tactical Filter Chips Bar */}
          {!loading && rows.length > 0 && (
            <div className="dispatch-filter-bar">
              <button
                type="button"
                className={`dispatch-filter-chip ${activeFilter === 'all' ? 'dispatch-filter-chip--active' : ''}`}
                onClick={() => handleFilterChange('all')}
              >
                <span>All</span>
                <span className="dispatch-filter-count">{telemetry.counts.all}</span>
              </button>

              <button
                type="button"
                className={`dispatch-filter-chip dispatch-filter-chip--critical ${activeFilter === 'critical' ? 'dispatch-filter-chip--active' : ''}`}
                onClick={() => handleFilterChange('critical')}
              >
                <span>🚨 Critical</span>
                {telemetry.counts.critical > 0 && <span className="dispatch-filter-count">{telemetry.counts.critical}</span>}
              </button>

              <button
                type="button"
                className={`dispatch-filter-chip dispatch-filter-chip--enroute ${activeFilter === 'en_route' ? 'dispatch-filter-chip--active' : ''}`}
                onClick={() => handleFilterChange('en_route')}
              >
                <span>En Route</span>
                {telemetry.counts.en_route > 0 && <span className="dispatch-filter-count">{telemetry.counts.en_route}</span>}
              </button>

              <button
                type="button"
                className={`dispatch-filter-chip dispatch-filter-chip--assigned ${activeFilter === 'assigned' ? 'dispatch-filter-chip--active' : ''}`}
                onClick={() => handleFilterChange('assigned')}
              >
                <span>Assigned</span>
                {telemetry.counts.assigned > 0 && <span className="dispatch-filter-count">{telemetry.counts.assigned}</span>}
              </button>

              <button
                type="button"
                className={`dispatch-filter-chip dispatch-filter-chip--arrived ${activeFilter === 'arrived' ? 'dispatch-filter-chip--active' : ''}`}
                onClick={() => handleFilterChange('arrived')}
              >
                <span>Arrived</span>
                {telemetry.counts.arrived > 0 && <span className="dispatch-filter-count">{telemetry.counts.arrived}</span>}
              </button>
            </div>
          )}
          {loading ? (
            <LoadingBlock label="Loading dispatch assignments…" />
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
          ) : filteredAndSortedRows.length === 0 ? (
            <div
              className="card--elevated"
              style={{
                textAlign: 'center',
                padding: '36px 20px',
                display: 'flex',
                flexDirection: 'column',
                alignItems: 'center',
                marginTop: '12px',
              }}
            >
              <p style={{ margin: 0, color: 'var(--color-text-secondary)', fontSize: 'var(--font-size-sm)' }}>
                No dispatches found for this filter.
              </p>
              <button
                type="button"
                className="dispatch-filter-chip"
                style={{ marginTop: '12px' }}
                onClick={() => setActiveFilter('all')}
              >
                Reset Filter
              </button>
            </div>
          ) : (
            <div className="card-list">
              {filteredAndSortedRows.map((row) => {
                const stale = isCacheStale(row);
                const isCritical = row.priority === 'critical';
                const isHigh = row.priority === 'high';
                const cardModifier = isCritical
                  ? 'dispatch-card--critical'
                  : isHigh
                    ? 'dispatch-card--high'
                    : 'dispatch-card--normal';

                const iconModifier = isCritical
                  ? 'dispatch-icon-box--critical'
                  : isHigh
                    ? 'dispatch-icon-box--warning'
                    : row.status === 'arrived'
                      ? 'dispatch-icon-box--success'
                      : '';

                const pillClass = PRIORITY_PILL_CLASS[row.priority] ?? 'status-pill--info';
                const statusClass = STATUS_PILL_CLASS[row.status] ?? 'status-pill--neutral';

                // Explicit button text & styling
                const actionButtonText =
                  row.status === 'en_route'
                    ? 'NAVIGATE ROUTE →'
                    : row.status === 'assigned'
                      ? 'START ROUTE →'
                      : 'VIEW STATUS →';

                const actionButtonClass =
                  row.status === 'en_route'
                    ? 'dispatch-action-cta--navigate'
                    : row.status === 'assigned'
                      ? 'dispatch-action-cta--start'
                      : 'dispatch-action-cta--view';

                return (
                    <div
                      key={row.local_id}
                      className={`dispatch-card ${cardModifier}`}
                      onClick={() => {
                        tacticalFeedback.onTap();
                        navigate(`/tabs/assignments/${encodeURIComponent(row.local_id)}`);
                      }}
                      role="button"
                      tabIndex={0}
                      onKeyDown={(e) => {
                        if (e.key === 'Enter' || e.key === ' ') {
                          tacticalFeedback.onTap();
                          navigate(`/tabs/assignments/${encodeURIComponent(row.local_id)}`);
                        }
                      }}
                    >
                      {/* Top Row: Priority Pill + Status Pill + ID Badge */}
                      <div className="dispatch-card-meta">
                        <div className="dispatch-card-meta-left">
                          <span className={`status-pill ${pillClass}`}>
                            {row.priority.toUpperCase()}
                          </span>
                          <span className={`status-pill ${statusClass}`}>
                            {STATUS_LABEL[row.status] ?? row.status}
                          </span>
                        </div>
                        <span className="dispatch-id-badge">
                          #{row.server_dispatch_id ?? row.local_id.slice(0, 6)}
                        </span>
                      </div>

                      {/* Main Content: Category Icon + Title & Location */}
                      <div className="dispatch-card-main">
                        <div className={`dispatch-icon-box ${iconModifier}`}>
                          <IonIcon icon={getCategoryIcon(row.redacted_incident_type)} />
                        </div>

                        <div className="dispatch-card-content">
                          <h4 className="dispatch-card-type">
                            {row.redacted_incident_type
                              ? row.redacted_incident_type.replace(/_/g, ' ').toUpperCase()
                              : 'INCIDENT DETAILS RESTRICTED'}
                          </h4>

                          <div className="dispatch-card-geo">
                            <IonIcon icon={locationOutline} />
                            <span>
                              {row.latitude === null || row.longitude === null
                                ? 'Coordinates pending'
                                : position
                                  ? `${formatDistance(distanceMeters(position.latitude, position.longitude, row.latitude, row.longitude))} · ${bearingLabel(position.latitude, position.longitude, row.latitude, row.longitude)}`
                                  : 'Distance unknown — GPS acquiring'}
                            </span>
                          </div>

                          {stale && (
                            <div className="dispatch-card-stale">
                              <IonIcon icon={timeOutline} />
                              <span>Cached data</span>
                            </div>
                          )}
                        </div>
                      </div>

                      {/* Bottom Action Footer with 1-Tap Tactical CTA */}
                      <div className="dispatch-card-footer">
                        <span className="dispatch-status-note">
                          <IonIcon icon={radioOutline} />
                          {row.status === 'en_route' ? 'Active responder' : 'Barangay Dao Tanod'}
                        </span>

                        <button
                          type="button"
                          className={`dispatch-action-cta ${actionButtonClass}`}
                          onClick={(e) => {
                            e.stopPropagation();
                            tacticalFeedback.onTap();
                            navigate(`/tabs/assignments/${encodeURIComponent(row.local_id)}`);
                          }}
                        >
                          {row.status === 'en_route' && <IonIcon icon={navigateOutline} style={{ fontSize: '0.85rem' }} />}
                          {row.status === 'assigned' && <IonIcon icon={playOutline} style={{ fontSize: '0.85rem' }} />}
                          <span>{actionButtonText}</span>
                        </button>
                      </div>
                    </div>
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

