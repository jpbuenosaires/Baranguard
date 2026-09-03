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
 * Navigate opens the device's own map app via a `geo:` URI — no new
 * mapping dependency, and it works identically whether the cached route is
 * fresh or stale (a `geo:` intent re-routes live from wherever the map app
 * itself is, which is exactly the right fallback when "new OSRM routing is
 * unavailable offline").
 */

import { useEffect, useState } from 'react';
import { useNavigate, useParams } from 'react-router-dom';
import { IonButton, IonContent, IonHeader, IonNote, IonPage, IonSpinner, IonTitle, IonToolbar } from '@ionic/react';
import { ApiError, updateDispatchStatus } from '../services/apiService';
import {
  applyLocalStatusChange,
  getCachedDispatch,
  isCacheStale,
  markStatusSynced,
  nextStatusFor,
} from '../services/db/dispatchRepository';
import { enqueueDispatchStatusChange } from '../services/db/offlineQueueRepository';
import type { DispatchLocalRow } from '../services/db/localSchema';

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

const AssignmentDetailPage: React.FC = () => {
  const { localId = '' } = useParams<{ localId: string }>();
  const navigate = useNavigate();
  const [row, setRow] = useState<DispatchLocalRow | null>(null);
  const [loading, setLoading] = useState(true);
  const [updating, setUpdating] = useState(false);
  const [note, setNote] = useState<string | null>(null);

  useEffect(() => {
    setLoading(true);
    getCachedDispatch(localId)
      .then(setRow)
      .finally(() => setLoading(false));
  }, [localId]);

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
            : `Could not confirm with the workstation — status set to ${STATUS_LABEL[next]} locally and queued to sync.`
        );
      }
    } finally {
      setUpdating(false);
    }
  }

  function handleNavigate() {
    if (!row || row.latitude === null || row.longitude === null) return;
    window.open(`geo:${row.latitude},${row.longitude}?q=${row.latitude},${row.longitude}`, '_system');
  }

  if (loading) {
    return (
      <IonPage>
        <IonContent className="ion-padding">
          <div style={{ display: 'flex', justifyContent: 'center', paddingTop: 64 }}>
            <IonSpinner name="dots" />
          </div>
        </IonContent>
      </IonPage>
    );
  }

  if (!row) {
    return (
      <IonPage>
        <IonHeader>
          <IonToolbar>
            <IonTitle>Assignment</IonTitle>
          </IonToolbar>
        </IonHeader>
        <IonContent className="ion-padding">
          <p className="app-subtitle">This assignment is not in the local cache.</p>
          <IonButton expand="block" className="app-section" onClick={() => navigate('/assignments')}>
            Back to Assignments
          </IonButton>
        </IonContent>
      </IonPage>
    );
  }

  const stale = isCacheStale(row);
  const next = nextStatusFor(row.status);

  return (
    <IonPage>
      <IonHeader>
        <IonToolbar>
          <IonTitle>Assignment #{row.server_dispatch_id ?? row.local_id}</IonTitle>
        </IonToolbar>
      </IonHeader>
      <IonContent className="ion-padding">
        <h2 className="app-title">{row.redacted_incident_type ?? 'Incident type unavailable'}</h2>
        <p className="app-subtitle">
          {row.latitude !== null && row.longitude !== null
            ? `${row.latitude.toFixed(5)}, ${row.longitude.toFixed(5)}`
            : 'Location unavailable'}
        </p>

        <div className="app-section">
          <span className="status-pill status-pill--info">{STATUS_LABEL[row.status] ?? row.status}</span>
        </div>

        <div className="app-section">
          <p className="app-note">
            {ROUTE_STATUS_LABEL[row.route_status] ?? row.route_status}
            {stale ? ' — cached / last known, not live' : ''}
          </p>
        </div>

        <IonButton
          expand="block"
          className="app-section"
          disabled={row.latitude === null || row.longitude === null}
          onClick={handleNavigate}
        >
          Navigate
        </IonButton>

        {next && (
          <IonButton expand="block" className="app-stack" disabled={updating} onClick={handleAdvanceStatus}>
            {updating ? <IonSpinner name="dots" /> : NEXT_ACTION_LABEL[next]}
          </IonButton>
        )}

        {note && (
          <IonNote className="app-note" role="status">
            {note}
          </IonNote>
        )}

        {row.synced === 0 && (
          <IonNote className="app-note" role="status">
            A status change on this assignment is still waiting to sync.
          </IonNote>
        )}
      </IonContent>
    </IonPage>
  );
};

export default AssignmentDetailPage;
