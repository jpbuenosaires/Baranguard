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
  chevronForwardOutline,
  closeCircleOutline,
  compassOutline,
  documentTextOutline,
  flameOutline,
  flashOutline,
  locationOutline,
  mapOutline,
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
import DispatchOfferCards from '../components/DispatchOfferCards';
import MobileHeader from '../components/MobileHeader';
import { LoadingBlock } from '../components/LoadingBlock';
import { ApiError, getDispatches } from '../services/apiService';
import { cacheDispatchesFromServer, isCacheStale, listActiveCachedDispatches } from '../services/db/dispatchRepository';
import type { DispatchLocalRow } from '../services/db/localSchema';
import { getCurrentPosition, watchPosition, type DevicePosition } from '../services/geolocation';
import { bearingLabel, distanceMeters, formatDistance, formatRelativeAge } from '../utils/geo';
import tacticalFeedback from '../utils/tacticalFeedback';

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

type FilterTab = 'all' | 'critical' | 'en_route' | 'assigned';

const AssignmentsPage: React.FC = () => {
  const navigate = useNavigate();
  const [rows, setRows] = useState<DispatchLocalRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [offlineNote, setOfflineNote] = useState<string | null>(null);
  const [offlineDismissed, setOfflineDismissed] = useState(false);
  const [position, setPosition] = useState<DevicePosition | null>(null);
  const [activeFilter, setActiveFilter] = useState<FilterTab>('all');
  const [showSearch, setShowSearch] = useState(false);
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
        // Non-fatal watch failure treatment
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
      // TEMP DIAGNOSTIC — remove before committing.
      setOfflineNote(
        error instanceof ApiError
          ? `DEBUG status=${error.status} code=${error.code} msg=${error.message}`
          : `DEBUG non-ApiError: ${String(error)}`
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
    };

    let closestDist = Infinity;
    let closestBearing = '';

    rows.forEach((r) => {
      if (r.priority === 'critical') counts.critical += 1;
      if (r.status === 'en_route') counts.en_route += 1;
      if (r.status === 'assigned') counts.assigned += 1;

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
      closestFormatted: closestDist !== Infinity ? `${formatDistance(closestDist)} · ${closestBearing}` : null,
    };
  }, [rows, position]);

  // Filter and sort items: Critical dispatches always on top
  const filteredAndSortedRows = useMemo(() => {
    const query = searchQuery.trim().toLowerCase();

    const filtered = rows.filter((r) => {
      if (activeFilter === 'critical' && r.priority !== 'critical') return false;
      if (activeFilter === 'en_route' && r.status !== 'en_route') return false;
      if (activeFilter === 'assigned' && r.status !== 'assigned') return false;

      if (query) {
        const typeMatch = (r.redacted_incident_type ?? '').toLowerCase().includes(query);
        const idMatch = (r.server_dispatch_id ? `#${r.server_dispatch_id}` : `#${r.local_id}`).toLowerCase().includes(query);
        const summaryMatch = (r.redacted_incident_summary ?? '').toLowerCase().includes(query);
        return typeMatch || idMatch || summaryMatch;
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

  const openDirections = (e: React.MouseEvent, row: DispatchLocalRow) => {
    e.stopPropagation();
    tacticalFeedback.onTap();
    if (row.latitude !== null && row.longitude !== null) {
      const url = `https://www.google.com/maps/dir/?api=1&destination=${row.latitude},${row.longitude}`;
      window.open(url, '_system');
    }
  };

  return (
    <IonPage>
      <MobileHeader title="Dispatches" />

      {/* No ion-padding to prevent outer white border bug */}
      <IonContent style={{ '--background': 'var(--color-bg)' }}>
        <IonRefresher
          slot="fixed"
          onIonRefresh={handleRefresh}
          style={{ '--color': 'var(--color-primary, #3b82f6)' }}
        >
          <IonRefresherContent refreshingSpinner="crescent" />
        </IonRefresher>

        <div className="dispatch-container">
          {/* Offline / Cache Banner */}
          {offlineNote && !offlineDismissed && (
            <div className="dispatch-offline-banner" role="status">
              <div className="dispatch-offline-banner-content">
                <IonIcon icon={warningOutline} className="dispatch-offline-icon" aria-hidden="true" />
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
                  <IonIcon icon={refreshOutline} style={{ marginRight: '4px' }} aria-hidden="true" />
                  Retry
                </button>
                <button
                  type="button"
                  className="dispatch-offline-dismiss"
                  onClick={() => setOfflineDismissed(true)}
                  aria-label="Dismiss notice"
                >
                  <IonIcon icon={closeCircleOutline} aria-hidden="true" />
                </button>
              </div>
            </div>
          )}

          {/* Night-dispatch offers waiting for this tanod (online-only; see DispatchOfferCards). */}
          <DispatchOfferCards />

          {/* Unified Tactical Segmented Filter Bar */}
          {!loading && rows.length > 0 && (
            <div className="dispatch-control-bar">
              <div className="dispatch-segmented-control" role="tablist" aria-label="Filter dispatches">
                <button
                  type="button"
                  role="tab"
                  aria-selected={activeFilter === 'all'}
                  className={`dispatch-segment-btn ${activeFilter === 'all' ? 'dispatch-segment-btn--active' : ''}`}
                  onClick={() => handleFilterChange('all')}
                >
                  <span>All</span>
                  <span className="dispatch-segment-badge">{telemetry.counts.all}</span>
                </button>

                <button
                  type="button"
                  role="tab"
                  aria-selected={activeFilter === 'critical'}
                  className={`dispatch-segment-btn dispatch-segment-btn--critical ${activeFilter === 'critical' ? 'dispatch-segment-btn--active' : ''}`}
                  onClick={() => handleFilterChange('critical')}
                >
                  <span>Critical</span>
                  {telemetry.counts.critical > 0 && (
                    <span className="dispatch-segment-badge dispatch-segment-badge--urgent">
                      {telemetry.counts.critical}
                    </span>
                  )}
                </button>

                <button
                  type="button"
                  role="tab"
                  aria-selected={activeFilter === 'en_route'}
                  className={`dispatch-segment-btn ${activeFilter === 'en_route' ? 'dispatch-segment-btn--active' : ''}`}
                  onClick={() => handleFilterChange('en_route')}
                >
                  <span>En Route</span>
                  {telemetry.counts.en_route > 0 && (
                    <span className="dispatch-segment-badge">{telemetry.counts.en_route}</span>
                  )}
                </button>

                <button
                  type="button"
                  role="tab"
                  aria-selected={activeFilter === 'assigned'}
                  className={`dispatch-segment-btn ${activeFilter === 'assigned' ? 'dispatch-segment-btn--active' : ''}`}
                  onClick={() => handleFilterChange('assigned')}
                >
                  <span>Assigned</span>
                  {telemetry.counts.assigned > 0 && (
                    <span className="dispatch-segment-badge">{telemetry.counts.assigned}</span>
                  )}
                </button>
              </div>

              {/* On-demand Search Toggle */}
              <button
                type="button"
                className={`dispatch-search-toggle ${showSearch ? 'dispatch-search-toggle--active' : ''}`}
                onClick={() => {
                  tacticalFeedback.onTap();
                  setShowSearch(!showSearch);
                  if (showSearch) setSearchQuery('');
                }}
                aria-label={showSearch ? 'Close search' : 'Open search'}
                title={showSearch ? 'Close search' : 'Search dispatches'}
              >
                <IonIcon icon={showSearch ? closeCircleOutline : searchOutline} />
              </button>
            </div>
          )}

          {/* Expandable Search Input */}
          {showSearch && !loading && rows.length > 0 && (
            <div className="dispatch-search-bar" role="search">
              <IonIcon icon={searchOutline} className="dispatch-search-icon" aria-hidden="true" />
              <input
                type="text"
                autoFocus
                className="dispatch-search-field"
                placeholder="Search by incident type, summary, or ID…"
                value={searchQuery}
                onChange={(e) => setSearchQuery(e.target.value)}
                aria-label="Search dispatches"
              />
              {searchQuery && (
                <button
                  type="button"
                  className="dispatch-search-clear-btn"
                  onClick={() => setSearchQuery('')}
                  aria-label="Clear search input"
                >
                  <IonIcon icon={closeCircleOutline} />
                </button>
              )}
            </div>
          )}

          {/* Queue Triage Status Strip (High-Contrast Tactical Overview) */}
          {!loading && rows.length > 0 && (
            <div className="dispatch-triage-strip" role="status">
              <div className="dispatch-triage-left">
                <span className="dispatch-triage-dot" aria-hidden="true" />
                <span>Active Dispatches &bull; {rows.length} {rows.length === 1 ? 'Call' : 'Calls'}</span>
              </div>
              {telemetry.closestFormatted && (
                <div className="dispatch-triage-right">
                  <IonIcon icon={compassOutline} aria-hidden="true" />
                  <span>Nearest: {telemetry.closestFormatted}</span>
                </div>
              )}
            </div>
          )}

          {/* Content States */}
          {loading ? (
            <LoadingBlock label="Updating dispatches…" />
          ) : rows.length === 0 ? (
            <div className="dispatch-empty-card" role="region" aria-label="No dispatches">
              <div className="dispatch-empty-icon-ring" aria-hidden="true">
                <IonIcon icon={shieldCheckmarkOutline} />
              </div>
              <h3 className="dispatch-empty-title">All Clear</h3>
              <p className="dispatch-empty-desc">
                No active calls for your unit right now. Continue your regular patrol or stand by for updates from the Barangay Desk.
              </p>
              <button
                type="button"
                className="dispatch-refresh-btn"
                onClick={() => {
                  tacticalFeedback.onTap();
                  setLoading(true);
                  void load().finally(() => setLoading(false));
                }}
              >
                <IonIcon icon={refreshOutline} aria-hidden="true" />
                <span>Refresh</span>
              </button>
            </div>
          ) : filteredAndSortedRows.length === 0 ? (
            <div className="dispatch-empty-card" role="region" aria-label="No results">
              <p className="dispatch-empty-desc" style={{ marginTop: '8px' }}>
                No active dispatches found for the selected filter or search.
              </p>
              <button
                type="button"
                className="dispatch-refresh-btn"
                onClick={() => {
                  tacticalFeedback.onTap();
                  setActiveFilter('all');
                  setSearchQuery('');
                  setShowSearch(false);
                }}
              >
                Reset Filters
              </button>
            </div>
          ) : (
            <div className="dispatch-card-list">
              {filteredAndSortedRows.map((row) => {
                const stale = isCacheStale(row);
                const isCritical = row.priority === 'critical';
                const isHigh = row.priority === 'high';

                const cardUrgencyClass = isCritical
                  ? 'dispatch-card--critical'
                  : isHigh
                    ? 'dispatch-card--high'
                    : 'dispatch-card--routine';

                const hasCoords = row.latitude !== null && row.longitude !== null;
                const distanceStr =
                  hasCoords && position
                    ? `${formatDistance(distanceMeters(position.latitude, position.longitude, row.latitude!, row.longitude!))} · ${bearingLabel(position.latitude, position.longitude, row.latitude!, row.longitude!)}`
                    : hasCoords
                      ? 'Location available'
                      : 'Location not set';

                const elapsedSeconds = row.dispatched_at
                  ? Math.max(0, Math.floor((Date.now() - new Date(row.dispatched_at).getTime()) / 1000))
                  : null;

                const primaryActionLabel =
                  row.status === 'assigned'
                    ? 'Accept & Respond'
                    : row.status === 'en_route'
                      ? 'Mark Arrived'
                      : 'View Details';

                const primaryActionIcon =
                  row.status === 'assigned'
                    ? playOutline
                    : row.status === 'en_route'
                      ? navigateOutline
                      : chevronForwardOutline;

                return (
                  <article
                    key={row.local_id}
                    className={`dispatch-card ${cardUrgencyClass}`}
                    onClick={() => {
                      tacticalFeedback.onTap();
                      navigate(`/tabs/assignments/${encodeURIComponent(row.local_id)}`);
                    }}
                    role="button"
                    tabIndex={0}
                    aria-label={`Dispatch #${row.server_dispatch_id ?? row.local_id.slice(0, 6)}: ${row.redacted_incident_type ?? 'Incident'}, priority ${row.priority}, status ${row.status}`}
                    onKeyDown={(e) => {
                      if (e.key === 'Enter' || e.key === ' ') {
                        tacticalFeedback.onTap();
                        navigate(`/tabs/assignments/${encodeURIComponent(row.local_id)}`);
                      }
                    }}
                  >
                    {/* Top Scannable Header */}
                    <div className="dispatch-card__header">
                      <div className="dispatch-card__badge-row">
                        {isCritical ? (
                          <span className="dispatch-badge dispatch-badge--critical">
                            <IonIcon icon={flashOutline} aria-hidden="true" />
                            <span>Critical</span>
                          </span>
                        ) : isHigh ? (
                          <span className="dispatch-badge dispatch-badge--high">
                            <IonIcon icon={alertCircleOutline} aria-hidden="true" />
                            <span>High Priority</span>
                          </span>
                        ) : (
                          <span className="dispatch-badge dispatch-badge--routine">
                            <span>Normal</span>
                          </span>
                        )}

                        <span className={`dispatch-badge dispatch-badge--status dispatch-badge--status-${row.status}`}>
                          {STATUS_LABEL[row.status] ?? row.status}
                        </span>
                      </div>

                      <div className="dispatch-card__id-age">
                        <span className="dispatch-card__id">
                          #{row.server_dispatch_id ?? row.local_id.slice(0, 6)}
                        </span>
                        {elapsedSeconds !== null && (
                          <span className="dispatch-card__age">
                            {formatRelativeAge(elapsedSeconds)}
                          </span>
                        )}
                      </div>
                    </div>

                    {/* Incident Type & Category Title */}
                    <div className="dispatch-card__body">
                      <div className="dispatch-card__type-row">
                        <div className="dispatch-card__category-icon" aria-hidden="true">
                          <IonIcon icon={getCategoryIcon(row.redacted_incident_type)} />
                        </div>
                        <div className="dispatch-card__title-group">
                          <h4 className="dispatch-card__title">
                            {row.redacted_incident_type
                              ? row.redacted_incident_type.replace(/_/g, ' ')
                              : 'Incident Dispatch'}
                          </h4>
                          <span className="dispatch-card__location-sub">
                            <IonIcon icon={locationOutline} style={{ color: 'var(--color-primary)' }} aria-hidden="true" />
                            <span>Barangay Dao &bull; {distanceStr}</span>
                          </span>
                        </div>
                      </div>

                      {/* Rich Incident Situation Excerpt */}
                      <p className="dispatch-card__summary">
                        {row.redacted_incident_summary ||
                          'Patrol dispatched to check the area and assist with the incident.'}
                      </p>

                      {stale && (
                        <div className="dispatch-card__telemetry-row" style={{ marginTop: '6px' }}>
                          <div className="dispatch-card__stale-chip">
                            <IonIcon icon={timeOutline} aria-hidden="true" />
                            <span>Saved offline</span>
                          </div>
                        </div>
                      )}
                    </div>

                    {/* 1-Tap Tactical Action Bar */}
                    <div className="dispatch-card__actions">
                      {hasCoords && row.status !== 'arrived' && (
                        <button
                          type="button"
                          className="dispatch-card__btn-directions"
                          onClick={(e) => openDirections(e, row)}
                          aria-label={`Open turn-by-turn directions to incident #${row.server_dispatch_id ?? row.local_id.slice(0, 6)}`}
                        >
                          <IonIcon icon={mapOutline} aria-hidden="true" />
                          <span>Directions</span>
                        </button>
                      )}

                      <button
                        type="button"
                        className="dispatch-card__btn-primary"
                        onClick={(e) => {
                          e.stopPropagation();
                          tacticalFeedback.onTap();
                          navigate(`/tabs/assignments/${encodeURIComponent(row.local_id)}`);
                        }}
                        aria-label={`${primaryActionLabel} for dispatch #${row.server_dispatch_id ?? row.local_id.slice(0, 6)}`}
                      >
                        <IonIcon icon={primaryActionIcon} aria-hidden="true" />
                        <span>{primaryActionLabel}</span>
                      </button>
                    </div>
                  </article>
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

