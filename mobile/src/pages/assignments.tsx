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

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { IonContent, IonIcon, IonPage, IonRefresher, IonRefresherContent, useIonViewWillEnter } from '@ionic/react';
import type { RefresherEventDetail } from '@ionic/core';
import { compassOutline, refreshOutline, shieldCheckmarkOutline } from 'ionicons/icons';
import DispatchOfferCards from '../components/DispatchOfferCards';
import MobileHeader from '../components/MobileHeader';
import { LoadingBlock } from '../components/LoadingBlock';
import DispatchCard from '../components/dispatch/DispatchCard';
import DispatchFilterBar, { type FilterTab } from '../components/dispatch/DispatchFilterBar';
import DispatchHistory from '../components/dispatch/DispatchHistory';
import { Banner, Button, EmptyState } from '../components/ui';
import { ApiError, getDispatches } from '../services/apiService';
import {
  cacheDispatchesFromServer,
  listActiveCachedDispatches,
  listRecentFinishedDispatches,
} from '../services/db/dispatchRepository';
import type { DispatchLocalRow } from '../services/db/localSchema';
import { bearingLabel, distanceMeters, formatDistance } from '../utils/geo';
import { sortDispatches } from '../utils/dispatchList';
import { updatedLine } from '../utils/manilaFormat';
import { useSelfPosition } from '../utils/useSelfPosition';
import tacticalFeedback from '../utils/tacticalFeedback';





const AssignmentsPage: React.FC = () => {
  const navigate = useNavigate();
  const [rows, setRows] = useState<DispatchLocalRow[]>([]);
  const [history, setHistory] = useState<DispatchLocalRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [offlineNote, setOfflineNote] = useState<string | null>(null);
  const [offlineDismissed, setOfflineDismissed] = useState(false);
  const [lastLoadedMs, setLastLoadedMs] = useState<number | null>(null);
  const position = useSelfPosition();
  const [activeFilter, setActiveFilter] = useState<FilterTab>('all');
  const [showSearch, setShowSearch] = useState(false);
  const [searchQuery, setSearchQuery] = useState('');



  const load = useCallback(async () => {
    try {
      const entries = await getDispatches();
      await cacheDispatchesFromServer(entries);
      setOfflineNote(null);
      setLastLoadedMs(Date.now());
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
      setHistory(await listRecentFinishedDispatches(20));
    } catch (dbErr) {
      console.warn('[Assignments] Failed to read local dispatch cache:', dbErr);
    }
  }, []);

  const initialLoadingRef = useRef(true);
  useEffect(() => {
    setLoading(true);
    initialLoadingRef.current = true;
    load().finally(() => {
      initialLoadingRef.current = false;
      setLoading(false);
    });
  }, [load]);

  // Re-read on every page enter so a status changed in the detail view shows
  // without a pull-to-refresh. Skipped while the first load is still running.
  useIonViewWillEnter(() => {
    if (!initialLoadingRef.current) void load();
  });

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

    return sortDispatches(filtered, position);
  }, [rows, activeFilter, searchQuery, position]);

  const handleFilterChange = (filter: FilterTab) => {
    tacticalFeedback.onTap();
    setActiveFilter(filter);
  };

  const openDetail = (row: DispatchLocalRow) => {
    tacticalFeedback.onTap();
    navigate(`/tabs/assignments/${encodeURIComponent(row.local_id)}`);
  };

  const handleToggleSearch = () => {
    tacticalFeedback.onTap();
    setShowSearch(!showSearch);
    if (showSearch) setSearchQuery('');
  };


  const openDirections = (row: DispatchLocalRow) => {
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
      <IonContent className="dispatch-content">
        <IonRefresher slot="fixed" onIonRefresh={handleRefresh} className="dispatch-refresher">
          <IonRefresherContent refreshingSpinner="crescent" />
        </IonRefresher>

        <div className="dispatch-container">
          {lastLoadedMs !== null && <p className="dispatch-updated">{updatedLine(lastLoadedMs)}</p>}

          {/* Offline / Cache Banner */}
          {offlineNote && !offlineDismissed && (
            <Banner
              tone="warning"
              role="status"
              onDismiss={() => setOfflineDismissed(true)}
              dismissLabel="Dismiss notice"
              action={
                <Button
                  variant="secondary"
                  icon={refreshOutline}
                  onClick={() => {
                    tacticalFeedback.onTap();
                    void load();
                  }}
                >
                  Retry
                </Button>
              }
            >
              {offlineNote}
            </Banner>
          )}

          {/* Night-dispatch offers waiting for this tanod (online-only; see DispatchOfferCards). */}
          <DispatchOfferCards />

          {/* Unified Tactical Segmented Filter Bar */}
          {!loading && rows.length > 0 && (
            <DispatchFilterBar
              activeFilter={activeFilter}
              counts={telemetry.counts}
              showSearch={showSearch}
              searchQuery={searchQuery}
              onFilterChange={handleFilterChange}
              onToggleSearch={handleToggleSearch}
              onSearchChange={setSearchQuery}
            />
          )}



          {/* Nearest-call strip. Counts live once, on the filter tabs above. */}
          {!loading && rows.length > 0 && telemetry.closestFormatted && (
            <div className="dispatch-triage-strip" role="status">
              <div className="dispatch-triage-right">
                <IonIcon icon={compassOutline} aria-hidden="true" />
                <span>Nearest call: {telemetry.closestFormatted}</span>
              </div>
            </div>
          )}

          {/* Content States */}
          {loading ? (
            <LoadingBlock label="Updating dispatches…" />
          ) : rows.length === 0 ? (
            <EmptyState
              icon={shieldCheckmarkOutline}
              title="No active calls"
              body="No active calls for your unit right now. Continue your regular patrol or stand by for updates from the Barangay Desk."
              action={
                <Button
                  variant="secondary"
                  icon={refreshOutline}
                  onClick={() => {
                    tacticalFeedback.onTap();
                    setLoading(true);
                    void load().finally(() => setLoading(false));
                  }}
                >
                  Refresh
                </Button>
              }
            />
          ) : filteredAndSortedRows.length === 0 ? (
            <div className="dispatch-empty-card" role="region" aria-label="No results">
              <p className="dispatch-empty-desc dispatch-empty-desc--tight">
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
              {filteredAndSortedRows.map((row) => (
                <DispatchCard key={row.local_id} row={row} position={position} onOpen={openDetail} onDirections={openDirections} />
              ))}
            </div>
          )}

          {history.length > 0 && <DispatchHistory history={history} onOpen={openDetail} />}
        </div>
      </IonContent>
    </IonPage>
  );
};

export default AssignmentsPage;

