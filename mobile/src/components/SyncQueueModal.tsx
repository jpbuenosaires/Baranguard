/**
 * SyncQueueModal.tsx — Interactive Offline Queue Inspector & Manual Sync Trigger.
 *
 * Lets field responders inspect staged local SQLite records and trigger on-demand sync.
 */

import React, { useEffect, useState } from 'react';
import {
  IonAlert,
  IonButton,
  IonContent,
  IonHeader,
  IonIcon,
  IonModal,
  IonSpinner,
  IonTitle,
  IonToolbar,
} from '@ionic/react';
import { closeOutline, syncOutline, trashOutline } from 'ionicons/icons';
import { ApiError, checkHealth } from '../services/apiService';
import { loadSession } from '../services/session';
import { listUnsyncedIncidents } from '../services/db/incidentRepository';
import { listUnsyncedGpsPoints } from '../services/db/gpsTrackRepository';
import {
  listPendingDispatchStatusUpdates,
  listPendingDutyStatusUpdates,
  listPendingSosItems,
} from '../services/db/offlineQueueRepository';
import {
  countWorkflowPending,
  discardFailedWorkflowRow,
  listFailedWorkflowRows,
  type FailedWorkflowRow,
} from '../services/db/workflowSync';
import { isSyncAuthBlocked, isSyncDeviceBlocked, runSyncPassExclusive } from '../services/syncScheduler';
import {
  getNeedsAttentionCounts,
  retryNeedsAttention,
  type NeedsAttentionCounts,
  type SyncSummary,
} from '../services/syncService';
import tacticalFeedback from '../utils/tacticalFeedback';
import { LoadingBlock } from './LoadingBlock';
import { Banner, SyncLabel } from './ui';
import { buildQueueRows, formatQueueHeader, formatSyncResult } from './syncQueueSummary';

interface SyncQueueModalProps {
  isOpen: boolean;
  onClose: () => void;
}

export const SyncQueueModal: React.FC<SyncQueueModalProps> = ({ isOpen, onClose }) => {
  const [loading, setLoading] = useState(true);
  const [syncing, setSyncing] = useState(false);
  const [isOnline, setIsOnline] = useState<boolean | null>(null);
  const [latencyMs, setLatencyMs] = useState<number | null>(null);

  const [incidentCount, setIncidentCount] = useState(0);
  const [gpsCount, setGpsCount] = useState(0);
  const [dispatchStatusCount, setDispatchStatusCount] = useState(0);
  const [sosCount, setSosCount] = useState(0);
  const [referralCount, setReferralCount] = useState(0);
  const [dutyRecordCount, setDutyRecordCount] = useState(0);
  const [syncResult, setSyncResult] = useState<SyncSummary | null>(null);
  const [syncError, setSyncError] = useState<string | null>(null);
  const [needsAttention, setNeedsAttention] = useState<NeedsAttentionCounts | null>(null);
  // Permanently failed availability/accomplishment/referral/check-in rows the user may discard.
  const [failedRows, setFailedRows] = useState<FailedWorkflowRow[]>([]);
  const [discardTarget, setDiscardTarget] = useState<FailedWorkflowRow | null>(null);
  // True when queued items are waiting on a fresh login, not on connectivity.
  const [reloginRequired, setReloginRequired] = useState(false);
  const [deviceBlocked, setDeviceBlocked] = useState(false);

  const loadCounts = async () => {
    setLoading(true);
    setSyncError(null);
    try {
      const t0 = performance.now();
      const online = await checkHealth();
      const elapsed = Math.round(performance.now() - t0);
      setIsOnline(online);
      setLatencyMs(online ? elapsed : null);

      const incidents = await listUnsyncedIncidents();
      setIncidentCount(incidents.length);

      const gps = await listUnsyncedGpsPoints();
      setGpsCount(gps.length);

      // Offline off-duty toggles ride in the same row as dispatch status changes.
      const dispatchUpdates = await listPendingDispatchStatusUpdates();
      const dutyUpdates = await listPendingDutyStatusUpdates();
      setDispatchStatusCount(dispatchUpdates.length + dutyUpdates.length);

      const sos = await listPendingSosItems();
      setSosCount(sos.length);

      setReferralCount(await countWorkflowPending('referral_local'));
      const [availability, accomplishments, checkins] = await Promise.all([
        countWorkflowPending('availability_local'),
        countWorkflowPending('accomplishment_entry_local'),
        countWorkflowPending('school_checkin_local'),
      ]);
      setDutyRecordCount(availability + accomplishments + checkins);

      setNeedsAttention(await getNeedsAttentionCounts());
      setFailedRows(await listFailedWorkflowRows());
      setReloginRequired(isSyncAuthBlocked() || (await loadSession()) === null);
      setDeviceBlocked(isSyncDeviceBlocked());
    } catch {
      setIsOnline(false);
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    if (isOpen) {
      setSyncResult(null);
      void loadCounts();
    }
  }, [isOpen]);

  const handleTriggerSync = async () => {
    setSyncing(true);
    setSyncError(null);
    setSyncResult(null);
    try {
      const summary = await runSyncPassExclusive();
      setSyncResult(summary);
      tacticalFeedback.onSuccess();
      await loadCounts();
    } catch (err) {
      if (err instanceof ApiError && err.status === 401) {
        setReloginRequired(true);
        setSyncError('Session expired — saved items are pending. Log in again to send them.');
      } else if (err instanceof ApiError && err.status === 422 && err.code === 'DEVICE_NOT_REGISTERED') {
        setDeviceBlocked(true);
        setSyncError('This phone is registered to a different account. Saved items are kept but cannot be sent from this account.');
      } else {
        setSyncError(err instanceof Error ? err.message : 'Could not reach workstation for sync.');
      }
    } finally {
      setSyncing(false);
    }
  };

  // Gives capped items a fresh attempt budget, then syncs right away.
  const handleRetryFailed = async () => {
    setSyncing(true);
    setSyncError(null);
    setSyncResult(null);
    try {
      await retryNeedsAttention();
      setSyncResult(await runSyncPassExclusive());
      tacticalFeedback.onSuccess();
    } catch (err) {
      setSyncError(err instanceof Error ? err.message : 'Could not reach workstation for sync.');
    } finally {
      setSyncing(false);
      await loadCounts();
    }
  };

  // Deletes ONE capped row from this phone after the user confirmed; the server is not touched.
  const handleDiscard = async (target: FailedWorkflowRow) => {
    setDiscardTarget(null);
    setSyncError(null);
    try {
      await discardFailedWorkflowRow(target.table, target.localId);
      tacticalFeedback.onSuccess();
    } catch {
      setSyncError('Could not remove that item from this phone.');
    } finally {
      await loadCounts();
    }
  };

  const totalPending = incidentCount + gpsCount + dispatchStatusCount + sosCount + referralCount + dutyRecordCount;
  const attentionTotal = needsAttention?.total ?? 0;
  const na = needsAttention;
  const rows = buildQueueRows(
    {
      sos: sosCount,
      incidents: incidentCount,
      dispatchAndDuty: dispatchStatusCount,
      referrals: referralCount,
      workflowRecords: dutyRecordCount,
      gps: gpsCount,
    },
    {
      sos: na?.sos ?? 0,
      incidents: (na?.incidents ?? 0) + (na?.evidence ?? 0),
      dispatchAndDuty: (na?.dispatch ?? 0) + (na?.dutyStatus ?? 0),
      referrals: na?.referrals ?? 0,
      workflowRecords: (na?.availability ?? 0) + (na?.accomplishments ?? 0) + (na?.schoolCheckins ?? 0),
      gps: na?.gps ?? 0,
    },
    isOnline
  );
  const result = syncResult ? formatSyncResult(syncResult) : null;

  return (
    <IonModal isOpen={isOpen} onDidDismiss={onClose} initialBreakpoint={0.75} breakpoints={[0, 0.75, 1.0]}>
      <IonHeader>
        <IonToolbar className="mobile-topbar">
          <IonTitle>Sync queue</IonTitle>
          <IonButton fill="clear" slot="end" onClick={onClose} color="light" aria-label="Close sync queue">
            <IonIcon icon={closeOutline} aria-hidden="true" />
          </IonButton>
        </IonToolbar>
      </IonHeader>

      <IonContent className="ion-padding content-bg">
        <div className="app-column sync-queue__column">
          {/* Connectivity of the phone, not the state of any record */}
          <div className="card--elevated sync-queue__section">
            <div className="ui-queue__conn">
              <div>
                <div className="sync-queue__title">Barangay Desk connection</div>
                <div className="sync-queue__subtitle">
                  {isOnline
                    ? `Connected (${latencyMs ?? 0}ms)`
                    : 'Barangay Desk unreachable. Saved items stay on this phone.'}
                </div>
              </div>
              <span className={`status-pill ${isOnline ? 'status-pill--success' : 'status-pill--pending'}`}>
                {isOnline ? 'Online' : 'Offline'}
              </span>
            </div>
          </div>

          {/* Queue: header with counts, then one row per kind, SOS first */}
          <div className="card--elevated sync-queue__section">
            <div className="sync-queue__category-label" role="status">
              {loading ? 'Checking the queue' : formatQueueHeader(totalPending, attentionTotal)}
            </div>

            {loading ? (
              <LoadingBlock compact />
            ) : (
              <ul className="ui-queue__list">
                {rows.map((row) => (
                  <li
                    key={row.kind}
                    className={`ui-queue__row${row.kind === 'sos' && row.pending + row.failed > 0 ? ' ui-queue__row--urgent' : ''}`}
                  >
                    <div className="ui-queue__main">
                      <span className="ui-queue__label">{row.label}</span>
                      <span className="ui-queue__count" aria-label={`${row.pending} waiting`}>
                        {row.pending}
                      </span>
                    </div>
                    {row.state ? (
                      <SyncLabel state={row.state} willRetry={false} />
                    ) : (
                      <span className="ui-queue__none">None waiting</span>
                    )}
                    {row.failed > 0 && (
                      <div className="ui-queue__fail">
                        {row.failed} not sent after repeated tries.
                        {row.note ? ` ${row.note}` : ''}
                      </div>
                    )}
                  </li>
                ))}
              </ul>
            )}
          </div>

          {/* Records the automatic sync gave up on, each with its reason. Never hidden. */}
          {attentionTotal > 0 && (
            <Banner
              tone="error"
              role="alert"
              action={
                <IonButton size="small" color="warning" disabled={syncing || !isOnline} onClick={handleRetryFailed}>
                  <IonIcon icon={syncOutline} slot="start" />
                  Retry failed items
                </IonButton>
              }
            >
              <strong>{attentionTotal} not sent.</strong> The workstation kept rejecting these, so automatic sync
              stopped retrying. They are still saved on this phone.
              {failedRows.length > 0 && (
                <ul className="ui-queue__failed">
                  {failedRows.map((row) => (
                    <li key={`${row.table}:${row.localId}`} className="ui-queue__failed-row">
                      <div className="ui-queue__failed-text">
                        <div className="ui-queue__failed-label">{row.label}</div>
                        {row.lastError && <div>Reason: {row.lastError}</div>}
                      </div>
                      <IonButton
                        size="small"
                        fill="outline"
                        color="danger"
                        disabled={syncing}
                        aria-label={`Discard ${row.label}`}
                        onClick={() => setDiscardTarget(row)}
                      >
                        <IonIcon icon={trashOutline} slot="start" />
                        Discard
                      </IonButton>
                    </li>
                  ))}
                </ul>
              )}
            </Banner>
          )}

          {deviceBlocked && totalPending > 0 && (
            <Banner tone="error" role="alert">
              <strong>Cannot send from this account.</strong> {totalPending} saved item{totalPending === 1 ? '' : 's'}{' '}
              belong to a phone registered to a different account. They are kept safely. Log in with the account that
              saved them, or ask the Chief Tanod to reset this phone.
            </Banner>
          )}

          {reloginRequired && totalPending > 0 && (
            <Banner tone="warning" role="alert">
              <strong>Waiting for you to log in again.</strong> {totalPending} saved item{totalPending === 1 ? '' : 's'}{' '}
              will send automatically after you log in again.
            </Banner>
          )}

          {result && (
            <Banner tone={result.tone} role="status">
              <strong>{result.tone === 'success' ? 'Result:' : 'Some items were not sent:'}</strong> {result.headline}
              {result.details.map((d) => (
                <div key={d}>{d}</div>
              ))}
            </Banner>
          )}

          {syncError && (
            <Banner tone="error" role="alert">
              {syncError}
            </Banner>
          )}

          <IonButton
            expand="block"
            disabled={syncing || !isOnline}
            onClick={handleTriggerSync}
            className="sync-queue__send-btn"
          >
            {syncing ? (
              <>
                <IonSpinner name="dots" />
                <span className="ml-8">Sending to HQ…</span>
              </>
            ) : (
              <>
                <IonIcon icon={syncOutline} slot="start" />
                Send all saved items now
              </>
            )}
          </IonButton>
        </div>
      </IonContent>

      <IonAlert
        isOpen={discardTarget !== null}
        onDidDismiss={() => setDiscardTarget(null)}
        header="Discard this item?"
        message={`${discardTarget?.label ?? 'This item'} was never accepted by the barangay desk. Discarding removes it from this phone only and cannot be undone.`}
        buttons={[
          { text: 'Keep it', role: 'cancel' },
          { text: 'Discard', role: 'destructive', handler: () => {
              if (discardTarget) void handleDiscard(discardTarget);
            },
          },
        ]}
      />
    </IonModal>
  );
};

export default SyncQueueModal;
