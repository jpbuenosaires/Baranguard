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
 * Distance and Call Dispatch are deliberately NOT built here: distance
 * needs the Tanod's own live position (M7's geolocation service), and
 * wiring that into this list is a separate M5+M7 integration the
 * reference doesn't explicitly ask for this cut — showing a fake/stale
 * distance would be its own demo-tell (§8). Call Dispatch has no phone
 * number field anywhere in §5/§6 to call. Navigate/Mark-as-Arrived live on
 * M6's detail screen instead, reached by tapping a card.
 */

import { useCallback, useEffect, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import {
  IonContent,
  IonHeader,
  IonNote,
  IonPage,
  IonRefresher,
  IonRefresherContent,
  IonSpinner,
  IonTitle,
  IonToolbar,
} from '@ionic/react';
import type { RefresherEventDetail } from '@ionic/core';
import { ApiError, getDispatches } from '../services/apiService';
import { cacheDispatchesFromServer, isCacheStale, listActiveCachedDispatches } from '../services/db/dispatchRepository';
import type { DispatchLocalRow } from '../services/db/localSchema';

const PRIORITY_DOT_CLASS: Record<string, string> = {
  normal: 'priority-dot--normal',
  high: 'priority-dot--high',
  critical: 'priority-dot--critical',
};

const PRIORITY_PILL_CLASS: Record<string, string> = {
  normal: 'status-pill--info',
  high: 'status-pill--pending',
  critical: 'status-pill--critical',
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

  const load = useCallback(async () => {
    try {
      const entries = await getDispatches();
      await cacheDispatchesFromServer(entries);
      setOfflineNote(null);
    } catch (error) {
      setOfflineNote(
        error instanceof ApiError && error.isOffline
          ? 'Offline — showing the last cached assignments.'
          : 'Could not refresh from the workstation — showing the last cached assignments.'
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
      <IonHeader>
        <IonToolbar>
          <IonTitle>Assignments</IonTitle>
        </IonToolbar>
      </IonHeader>
      <IonContent className="ion-padding">
        <IonRefresher slot="fixed" onIonRefresh={handleRefresh}>
          <IonRefresherContent />
        </IonRefresher>

        {offlineNote && (
          <IonNote className="app-note" role="status">
            {offlineNote}
          </IonNote>
        )}

        {loading ? (
          <div style={{ display: 'flex', justifyContent: 'center', paddingTop: 64 }}>
            <IonSpinner name="dots" />
          </div>
        ) : rows.length === 0 ? (
          <div className="app-section">
            <p className="app-subtitle">No Active Assignments</p>
          </div>
        ) : (
          <div className="card-list app-section">
            {rows.map((row) => {
              const stale = isCacheStale(row);
              return (
                <button
                  key={row.local_id}
                  type="button"
                  className="card"
                  onClick={() => navigate(`/assignments/${encodeURIComponent(row.local_id)}`)}
                >
                  <div className="card__header">
                    <span className={`priority-dot ${PRIORITY_DOT_CLASS[row.priority] ?? 'priority-dot--normal'}`} />
                    <span className="card__title">Assignment #{row.server_dispatch_id ?? row.local_id}</span>
                    <span className={`status-pill ${PRIORITY_PILL_CLASS[row.priority] ?? 'status-pill--info'}`}>
                      {row.priority}
                    </span>
                  </div>
                  <div className="card__meta">
                    {row.redacted_incident_type ?? 'Incident type unavailable'} ·{' '}
                    {STATUS_LABEL[row.status] ?? row.status}
                  </div>
                  <div className="card__meta">
                    {row.latitude !== null && row.longitude !== null
                      ? `${row.latitude.toFixed(5)}, ${row.longitude.toFixed(5)}`
                      : 'Location unavailable'}
                  </div>
                  {stale && <div className="card__meta card__meta--warning">Cached — last known, not live</div>}
                </button>
              );
            })}
          </div>
        )}
      </IonContent>
    </IonPage>
  );
};

export default AssignmentsPage;
