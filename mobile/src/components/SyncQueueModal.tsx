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
import {
  checkmarkCircleOutline,
  closeOutline,
  documentTextOutline,
  navigateOutline,
  swapHorizontalOutline,
  timeOutline,
  radioOutline,
  syncOutline,
  trashOutline,
  warningOutline,
} from 'ionicons/icons';
import { ApiError, checkHealth } from '../services/apiService';
import { loadSession } from '../services/session';
import { listUnsyncedIncidents } from '../services/db/incidentRepository';
import { listUnsyncedGpsPoints } from '../services/db/gpsTrackRepository';
import {
  listPendingDispatchStatusUpdates,
  listPendingSosItems,
} from '../services/db/offlineQueueRepository';
import {
  countWorkflowPending,
  discardFailedWorkflowRow,
  listFailedWorkflowRows,
  type FailedWorkflowRow,
} from '../services/db/workflowSync';
import { isSyncAuthBlocked } from '../services/syncScheduler';
import {
  getNeedsAttentionCounts,
  retryNeedsAttention,
  runSyncPass,
  type NeedsAttentionCounts,
  type SyncSummary,
} from '../services/syncService';
import tacticalFeedback from '../utils/tacticalFeedback';
import { LoadingBlock } from './LoadingBlock';

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

      const dispatchUpdates = await listPendingDispatchStatusUpdates();
      setDispatchStatusCount(dispatchUpdates.length);

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
      const summary = await runSyncPass();
      setSyncResult(summary);
      tacticalFeedback.onSuccess();
      await loadCounts();
    } catch (err) {
      if (err instanceof ApiError && err.status === 401) {
        setReloginRequired(true);
        setSyncError('Session expired — saved items are pending. Log in again to send them.');
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
      setSyncResult(await runSyncPass());
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

  return (
    <IonModal isOpen={isOpen} onDidDismiss={onClose} initialBreakpoint={0.75} breakpoints={[0, 0.75, 1.0]}>
      <IonHeader>
        <IonToolbar className="mobile-topbar">
          <IonTitle>Sync & Offline Telemetry</IonTitle>
          <IonButton fill="clear" slot="end" onClick={onClose} color="light">
            <IonIcon icon={closeOutline} />
          </IonButton>
        </IonToolbar>
      </IonHeader>

      <IonContent className="ion-padding" style={{ '--background': 'var(--color-bg)' }}>
        <div className="app-column" style={{ paddingTop: 0 }}>
          {/* Connection Telemetry */}
          <div className="card--elevated sync-queue__section">
            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
              <div>
                <div className="sync-queue__title">
                  Barangay Desk Connection
                </div>
                <div className="sync-queue__subtitle">
                  {isOnline
                    ? `Connected (${latencyMs ?? 0}ms)`
                    : 'Barangay Desk unreachable — saved offline'}
                </div>
              </div>
              <span className={`status-pill ${isOnline ? 'status-pill--success' : 'status-pill--pending'}`}>
                {isOnline ? 'Online' : 'Offline'}
              </span>
            </div>
          </div>

          {/* Pending Queue Breakdown */}
          <div className="card--elevated sync-queue__section">
            <div className="sync-queue__category-label">
              Saved Items Waiting to Sync ({totalPending})
            </div>

            {loading ? (
              <LoadingBlock compact />
            ) : (
              <div style={{ display: 'flex', flexDirection: 'column', gap: '8px' }}>
                <div className="sync-queue__row">
                  <div className="sync-queue__row-label">
                    <IonIcon icon={documentTextOutline} style={{ color: 'var(--color-primary)' }} />
                    <span>Incident Reports</span>
                  </div>
                  <span className={`status-pill ${incidentCount > 0 ? 'status-pill--info' : 'status-pill--neutral'}`}>
                    {incidentCount}
                  </span>
                </div>

                <div className="sync-queue__row">
                  <div className="sync-queue__row-label">
                    <IonIcon icon={navigateOutline} style={{ color: 'var(--color-success)' }} />
                    <span>Location History</span>
                  </div>
                  <span className={`status-pill ${gpsCount > 0 ? 'status-pill--info' : 'status-pill--neutral'}`}>
                    {gpsCount}
                  </span>
                </div>

                <div className="sync-queue__row">
                  <div className="sync-queue__row-label">
                    <IonIcon icon={radioOutline} style={{ color: 'var(--color-warning)' }} />
                    <span>Dispatch Status Updates</span>
                  </div>
                  <span className={`status-pill ${dispatchStatusCount > 0 ? 'status-pill--pending' : 'status-pill--neutral'}`}>
                    {dispatchStatusCount}
                  </span>
                </div>

                <div className="sync-queue__row">
                  <div className="sync-queue__row-label">
                    <IonIcon icon={swapHorizontalOutline} style={{ color: 'var(--color-primary)' }} />
                    <span>Referrals</span>
                  </div>
                  <span className={`status-pill ${referralCount > 0 ? 'status-pill--info' : 'status-pill--neutral'}`}>
                    {referralCount}
                  </span>
                </div>

                <div className="sync-queue__row">
                  <div className="sync-queue__row-label">
                    <IonIcon icon={timeOutline} style={{ color: 'var(--color-primary)' }} />
                    <span>Availability, Accomplishments & School Check-ins</span>
                  </div>
                  <span className={`status-pill ${dutyRecordCount > 0 ? 'status-pill--info' : 'status-pill--neutral'}`}>
                    {dutyRecordCount}
                  </span>
                </div>

                <div className="sync-queue__row">
                  <div className="sync-queue__row-label">
                    <IonIcon icon={warningOutline} style={{ color: 'var(--color-critical)' }} />
                    <span>Emergency SOS Alerts</span>
                  </div>
                  <span className={`status-pill ${sosCount > 0 ? 'status-pill--critical is-urgent' : 'status-pill--neutral'}`}>
                    {sosCount}
                  </span>
                </div>
              </div>
            )}
          </div>

          {/* Needs attention: items the automatic sync gave up on. Never hidden. */}
          {attentionTotal > 0 && needsAttention && (
            <div
              style={{
                background: 'var(--tint-warning-bg)',
                border: '1px solid var(--color-warning)',
                borderRadius: 'var(--radius-md)',
                padding: '12px',
                color: 'var(--pill-warning-text)',
                fontSize: 'var(--font-size-sm)',
                marginBottom: '16px',
              }}
              role="alert"
            >
              <div style={{ display: 'flex', alignItems: 'center', gap: '8px', marginBottom: '8px' }}>
                <IonIcon icon={warningOutline} style={{ fontSize: '1.4rem' }} />
                <strong>Needs attention ({attentionTotal})</strong>
              </div>
              <div style={{ marginBottom: '8px' }}>
                The workstation kept rejecting these, so automatic sync stopped retrying. They are still saved on
                this device.
                {needsAttention.sos > 0 && ` ${needsAttention.sos} emergency SOS alert(s) — call the barangay desk.`}
                {needsAttention.incidents > 0 && ` ${needsAttention.incidents} incident report(s).`}
                {needsAttention.evidence > 0 && ` ${needsAttention.evidence} evidence file(s).`}
                {needsAttention.gps > 0 && ` ${needsAttention.gps} location point(s).`}
                {needsAttention.referrals > 0 && ` ${needsAttention.referrals} referral(s).`}
                {needsAttention.availability + needsAttention.accomplishments + needsAttention.schoolCheckins > 0 &&
                  ` ${needsAttention.availability + needsAttention.accomplishments + needsAttention.schoolCheckins} availability / accomplishment / school check-in record(s).`}
              </div>
              {failedRows.length > 0 && (
                <div style={{ display: 'flex', flexDirection: 'column', gap: '6px', marginBottom: '8px' }}>
                  {failedRows.map((row) => (
                    <div
                      key={`${row.table}:${row.localId}`}
                      style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: '8px' }}
                    >
                      <div style={{ minWidth: 0 }}>
                        <div style={{ fontWeight: 600 }}>{row.label}</div>
                        {row.lastError && <div style={{ opacity: 0.85 }}>{row.lastError}</div>}
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
                    </div>
                  ))}
                </div>
              )}
              <IonButton size="small" color="warning" disabled={syncing || !isOnline} onClick={handleRetryFailed}>
                <IonIcon icon={syncOutline} slot="start" />
                Retry failed items
              </IonButton>
            </div>
          )}

          {reloginRequired && totalPending > 0 && (
            <div
              style={{
                background: 'var(--tint-warning-bg)',
                border: '1px solid var(--color-warning)',
                borderRadius: 'var(--radius-md)',
                padding: '12px',
                color: 'var(--pill-warning-text)',
                fontSize: 'var(--font-size-sm)',
                marginBottom: '16px',
              }}
              role="alert"
            >
              <strong>Pending — re-login required.</strong> {totalPending} saved item{totalPending === 1 ? '' : 's'}{' '}
              will send automatically after you log in again.
            </div>
          )}

          {/* Sync Result Banner */}
          {syncResult && (
            <div
              style={{
                background: 'var(--tint-success-bg)',
                border: '1px solid var(--color-success)',
                borderRadius: 'var(--radius-md)',
                padding: '12px',
                color: 'var(--pill-success-text)',
                fontSize: 'var(--font-size-sm)',
                marginBottom: '16px',
                display: 'flex',
                alignItems: 'center',
                gap: '8px',
              }}
            >
              <IonIcon icon={checkmarkCircleOutline} style={{ fontSize: '1.4rem' }} />
              <div>
                <strong>Sync Finished:</strong> {syncResult.succeeded} uploaded, {syncResult.duplicates} synced, {syncResult.failed} failed.
                {syncResult.dispatchRejected > 0 && (
                  <> {syncResult.dispatchRejected} status change(s) were rejected by HQ and reverted.</>
                )}
                {(syncResult.evidenceUploaded > 0 || syncResult.evidenceFailed > 0) && (
                  <>
                    {' '}
                    {syncResult.evidenceUploaded} evidence file{syncResult.evidenceUploaded === 1 ? '' : 's'} uploaded
                    {syncResult.evidenceFailed > 0 ? `, ${syncResult.evidenceFailed} pending retry` : ''}.
                  </>
                )}
              </div>
            </div>
          )}

          {syncError && (
            <div
              style={{
                background: 'var(--tint-critical-bg)',
                border: '1px solid var(--color-critical)',
                borderRadius: 'var(--radius-md)',
                padding: '12px',
                color: 'var(--pill-critical-text)',
                fontSize: 'var(--font-size-sm)',
                marginBottom: '16px',
              }}
              role="alert"
            >
              {syncError}
            </div>
          )}

          {/* Action Button */}
          <IonButton
            expand="block"
            disabled={syncing || !isOnline}
            onClick={handleTriggerSync}
            style={{
              '--background': 'linear-gradient(135deg, var(--color-navy) 0%, var(--color-primary) 100%)',
              fontWeight: 700,
              height: '48px',
              boxShadow: 'var(--shadow-fab)',
            }}
          >
            {syncing ? (
              <>
                <IonSpinner name="dots" />
                <span style={{ marginLeft: '8px' }}>Synchronizing with HQ…</span>
              </>
            ) : (
              <>
                <IonIcon icon={syncOutline} slot="start" />
                Synchronize All Records Now
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
