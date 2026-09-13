/**
 * SyncQueueModal.tsx — Interactive Offline Queue Inspector & Manual Sync Trigger.
 *
 * Lets field responders inspect staged local SQLite records and trigger on-demand sync.
 */

import React, { useEffect, useState } from 'react';
import {
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
  cloudDoneOutline,
  closeOutline,
  documentTextOutline,
  navigateOutline,
  radioOutline,
  syncOutline,
  warningOutline,
} from 'ionicons/icons';
import { checkHealth } from '../services/apiService';
import { listUnsyncedIncidents } from '../services/db/incidentRepository';
import { listUnsyncedGpsPoints } from '../services/db/gpsTrackRepository';
import {
  listPendingDispatchStatusUpdates,
  listPendingSosItems,
} from '../services/db/offlineQueueRepository';
import { runSyncPass, type SyncSummary } from '../services/syncService';
import tacticalFeedback from '../utils/tacticalFeedback';

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
  const [syncResult, setSyncResult] = useState<SyncSummary | null>(null);
  const [syncError, setSyncError] = useState<string | null>(null);

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
      setSyncError(err instanceof Error ? err.message : 'Could not reach workstation for sync.');
    } finally {
      setSyncing(false);
    }
  };

  const totalPending = incidentCount + gpsCount + dispatchStatusCount + sosCount;

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
                  Workstation LAN Connection
                </div>
                <div className="sync-queue__subtitle">
                  {isOnline
                    ? `Active connection (${latencyMs ?? 0}ms latency)`
                    : 'Workstation unreachable — local cache active'}
                </div>
              </div>
              <span className={`status-pill ${isOnline ? 'status-pill--success' : 'status-pill--pending'}`}>
                {isOnline ? 'CONNECTED' : 'OFFLINE'}
              </span>
            </div>
          </div>

          {/* Pending Queue Breakdown */}
          <div className="card--elevated sync-queue__section">
            <div className="sync-queue__category-label">
              STAGED RECORDS WAITING TO SYNC ({totalPending})
            </div>

            {loading ? (
              <div style={{ display: 'flex', justifyContent: 'center', padding: '16px 0' }}>
                <IonSpinner name="dots" />
              </div>
            ) : (
              <div style={{ display: 'flex', flexDirection: 'column', gap: '8px' }}>
                <div className="sync-queue__row">
                  <div className="sync-queue__row-label">
                    <IonIcon icon={documentTextOutline} style={{ color: 'var(--color-primary)' }} />
                    <span>Incidents (M3 Local Reports)</span>
                  </div>
                  <span className={`status-pill ${incidentCount > 0 ? 'status-pill--info' : 'status-pill--neutral'}`}>
                    {incidentCount}
                  </span>
                </div>

                <div className="sync-queue__row">
                  <div className="sync-queue__row-label">
                    <IonIcon icon={navigateOutline} style={{ color: 'var(--color-success)' }} />
                    <span>GPS Breadcrumbs (M7 Tracking)</span>
                  </div>
                  <span className={`status-pill ${gpsCount > 0 ? 'status-pill--info' : 'status-pill--neutral'}`}>
                    {gpsCount}
                  </span>
                </div>

                <div className="sync-queue__row">
                  <div className="sync-queue__row-label">
                    <IonIcon icon={radioOutline} style={{ color: 'var(--color-warning)' }} />
                    <span>Dispatch Status Updates (M6)</span>
                  </div>
                  <span className={`status-pill ${dispatchStatusCount > 0 ? 'status-pill--pending' : 'status-pill--neutral'}`}>
                    {dispatchStatusCount}
                  </span>
                </div>

                <div className="sync-queue__row">
                  <div className="sync-queue__row-label">
                    <IonIcon icon={warningOutline} style={{ color: 'var(--color-critical)' }} />
                    <span>Emergency SOS Offline Queue</span>
                  </div>
                  <span className={`status-pill ${sosCount > 0 ? 'status-pill--critical is-urgent' : 'status-pill--neutral'}`}>
                    {sosCount}
                  </span>
                </div>
              </div>
            )}
          </div>

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
                <strong>Sync Completed:</strong> {syncResult.succeeded} uploaded, {syncResult.duplicates} reconciled, {syncResult.failed} failed.
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
    </IonModal>
  );
};

export default SyncQueueModal;
