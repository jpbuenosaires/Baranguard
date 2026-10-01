import React, { useEffect, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import {
  IonAlert,
  IonButton,
  IonContent,
  IonIcon,
  IonPage,
  IonSpinner,
  IonToast,
} from '@ionic/react';
import {
  calendarOutline,
  checkmarkCircleOutline,
  checkmarkOutline,
  chevronDownOutline,
  chevronForwardOutline,
  chevronUpOutline,
  copyOutline,
  documentTextOutline,
  logOutOutline,
  schoolOutline,
  notificationsOutline,
  shieldCheckmarkOutline,
  syncOutline,
  warningOutline,
} from 'ionicons/icons';
import MobileHeader from '../components/MobileHeader';
import NotificationDiagnostics from '../components/NotificationDiagnostics';
import { checkHealth, logout } from '../services/apiService';
import { getDeviceId } from '../services/deviceIdentity';
import { clearSession, loadSession, type StoredSession } from '../services/session';
import { listActiveCachedDispatches } from '../services/db/dispatchRepository';
import { listUnsyncedIncidents } from '../services/db/incidentRepository';
import { listUnsyncedGpsPoints } from '../services/db/gpsTrackRepository';
import { listPendingDispatchStatusUpdates, listPendingSosItems } from '../services/db/offlineQueueRepository';
import { runSyncPass, type SyncSummary } from '../services/syncService';
import {
  formatBytes,
  getStorageSnapshot,
  pruneOldSyncedEvidenceFiles,
  type StorageSnapshot,
} from '../services/storageMaintenance';
import tacticalFeedback from '../utils/tacticalFeedback';

const BARANGAY_NAMES: Record<number, string> = {
  1: 'Dao',
  2: 'Binanuahan',
  3: 'Marifosque',
  4: 'Banuyo',
};

const ProfilePage: React.FC = () => {
  const navigate = useNavigate();
  const [session, setSession] = useState<StoredSession | null>(null);
  const [deviceId, setDeviceId] = useState<string>('');
  const [copiedDevice, setCopiedDevice] = useState(false);

  // Network State
  const [isOnline, setIsOnline] = useState<boolean | null>(null);

  // Local Storage Telemetry
  const [localStats, setLocalStats] = useState({
    dispatches: 0,
    unsyncedIncidents: 0,
    unsyncedGps: 0,
    pendingQueue: 0,
  });

  // Sync state
  const [syncing, setSyncing] = useState(false);
  const [toastMessage, setToastMessage] = useState<string | null>(null);
  const [confirmingSignOut, setConfirmingSignOut] = useState(false);

  // Storage telemetry/cleanup
  const [storage, setStorage] = useState<StorageSnapshot | null>(null);
  const [pruning, setPruning] = useState(false);
  const [showStorageDetails, setShowStorageDetails] = useState(false);

  const loadData = async () => {
    const s = await loadSession();
    setSession(s);

    const devId = await getDeviceId();
    setDeviceId(devId);

    try {
      const dispatches = await listActiveCachedDispatches();
      const unsyncedIncidents = await listUnsyncedIncidents();
      const unsyncedGps = await listUnsyncedGpsPoints();
      const pendingStatus = await listPendingDispatchStatusUpdates();
      const pendingSos = await listPendingSosItems();

      setLocalStats({
        dispatches: dispatches.length,
        unsyncedIncidents: unsyncedIncidents.length,
        unsyncedGps: unsyncedGps.length,
        pendingQueue: pendingStatus.length + pendingSos.length,
      });
    } catch {
      // Local queries safe fallback
    }

    try {
      setStorage(await getStorageSnapshot());
    } catch {
      setStorage(null);
    }
  };

  const checkConnection = async () => {
    try {
      const ok = await checkHealth();
      setIsOnline(ok);
      if (ok) {
        tacticalFeedback.onSuccess();
      }
    } catch {
      setIsOnline(false);
    }
  };

  useEffect(() => {
    void loadData();
    void checkConnection();
  }, []);

  const handleCopyDeviceId = () => {
    if (!deviceId) return;
    navigator.clipboard.writeText(deviceId);
    tacticalFeedback.onTap();
    setCopiedDevice(true);
    setTimeout(() => setCopiedDevice(false), 2000);
  };

  const handleManualSync = async () => {
    setSyncing(true);
    try {
      const result: SyncSummary = await runSyncPass();
      tacticalFeedback.onSuccess();
      const evidenceNote =
        result.evidenceUploaded > 0 ? ` · ${result.evidenceUploaded} evidence file(s) uploaded` : '';
      setToastMessage(
        `Sync complete: ${result.succeeded} uploaded, ${result.duplicates} verified${evidenceNote}.`
      );
      await loadData();
    } catch (err) {
      setToastMessage(err instanceof Error ? err.message : 'Workstation unreachable for sync.');
    } finally {
      setSyncing(false);
    }
  };

  const handlePruneEvidence = async () => {
    setPruning(true);
    try {
      const result = await pruneOldSyncedEvidenceFiles();
      setToastMessage(
        result.prunedCount > 0
          ? `Cleared ${result.prunedCount} old evidence file(s), freed ${formatBytes(result.freedBytes)}.`
          : 'No evidence old enough to clear yet (30+ days since confirmed upload).'
      );
      await loadData();
    } catch {
      setToastMessage('Could not run evidence cleanup.');
    } finally {
      setPruning(false);
    }
  };

  const handleSignOut = async () => {
    try {
      await logout();
    } catch {
      // Offline sign-out
    }
    await clearSession();
    navigate('/login', { replace: true });
  };

  const initials = session?.fullName
    ? session.fullName
        .split(' ')
        .map((n) => n[0])
        .slice(0, 2)
        .join('')
        .toUpperCase()
    : 'TO';

  const barangayName = session?.barangayId
    ? BARANGAY_NAMES[session.barangayId] ?? `Barangay ${session.barangayId}`
    : 'Dao';

  const totalUnsynced =
    localStats.unsyncedIncidents + localStats.unsyncedGps + localStats.pendingQueue;

  return (
    <IonPage>
      <MobileHeader title="Console & Profile" subtitle="Responder Diagnostics" />

      <IonContent className="ion-padding" style={{ '--background': 'var(--color-bg)' }}>
        <div className="app-column profile-layout">
          {/* Section 1: Responder Identity & Duty Status */}
          <div className="profile-officer-card">
            <div className="profile-officer-header">
              <div className="profile-avatar-circle">{initials}</div>
              <div className="profile-officer-meta">
                <div className="profile-officer-top-row">
                  <h2 className="profile-officer-name">{session?.fullName || 'Tanod Officer'}</h2>
                  <span className="profile-verified-badge">
                    <IonIcon icon={shieldCheckmarkOutline} />
                    Active Duty
                  </span>
                </div>
                <div className="profile-officer-role">
                  Security Responder · Brgy {barangayName}
                </div>
              </div>
            </div>

            <div className="profile-officer-stats">
              <div className="profile-stat-cell">
                <span className="profile-stat-label">Active Dispatches</span>
                <span className="profile-stat-val">{localStats.dispatches} Assigned</span>
              </div>
              <div className="profile-stat-cell">
                <span className="profile-stat-label">Barangay Post</span>
                <span className="profile-stat-val">{barangayName} HQ</span>
              </div>
            </div>
          </div>

          {/* Section 2: Prominent Operational Records Navigation */}
          <div className="profile-prominent-nav">
            <button
              type="button"
              className="profile-nav-card"
              onClick={() => navigate('/tabs/reports')}
            >
              <div className="profile-nav-card__icon-box profile-nav-card__icon-box--blue">
                <IonIcon icon={documentTextOutline} />
              </div>
              <div className="profile-nav-card__body">
                <div className="profile-nav-card__title-row">
                  <h3 className="profile-nav-card__title">My Filed Reports</h3>
                  <IonIcon icon={chevronForwardOutline} style={{ color: 'var(--color-text-tertiary)', fontSize: '1.1rem' }} />
                </div>
                <p className="profile-nav-card__sub">
                  Review submitted incidents, attach supplementary evidence, and track dispatch status.
                </p>
              </div>
            </button>

            <button
              type="button"
              className="profile-nav-card"
              onClick={() => navigate('/tabs/shifts')}
            >
              <div className="profile-nav-card__icon-box profile-nav-card__icon-box--green">
                <IonIcon icon={calendarOutline} />
              </div>
              <div className="profile-nav-card__body">
                <div className="profile-nav-card__title-row">
                  <h3 className="profile-nav-card__title">My Duty Shifts</h3>
                  <IonIcon icon={chevronForwardOutline} style={{ color: 'var(--color-text-tertiary)', fontSize: '1.1rem' }} />
                </div>
                <p className="profile-nav-card__sub">
                  View scheduled patrol assignments, shift hours, and request replacements.
                </p>
              </div>
            </button>
          </div>

          {/* 2026-10 tanod workflow: accomplishment report + school check-in */}
          <div className="profile-prominent-nav">
            <button type="button" className="profile-nav-card" onClick={() => navigate('/tabs/accomplishments')}>
              <div className="profile-nav-card__icon-box profile-nav-card__icon-box--blue">
                <IonIcon icon={documentTextOutline} />
              </div>
              <div className="profile-nav-card__body">
                <div className="profile-nav-card__title-row">
                  <h3 className="profile-nav-card__title">My Accomplishments</h3>
                  <IonIcon icon={chevronForwardOutline} style={{ color: 'var(--color-text-tertiary)', fontSize: '1.1rem' }} />
                </div>
                <p className="profile-nav-card__sub">
                  Log what you did each day and submit your monthly accomplishment report.
                </p>
              </div>
            </button>

            <button type="button" className="profile-nav-card" onClick={() => navigate('/tabs/school')}>
              <div className="profile-nav-card__icon-box profile-nav-card__icon-box--green">
                <IonIcon icon={schoolOutline} />
              </div>
              <div className="profile-nav-card__body">
                <div className="profile-nav-card__title-row">
                  <h3 className="profile-nav-card__title">School Check-in</h3>
                  <IonIcon icon={chevronForwardOutline} style={{ color: 'var(--color-text-tertiary)', fontSize: '1.1rem' }} />
                </div>
                <p className="profile-nav-card__sub">
                  Check in and out when posted at a school (Safer School Zones). Works offline.
                </p>
              </div>
            </button>
          </div>

          {/* Section 3: Data Sync & Station Health (Combined & Decluttered) */}
          <div className="profile-section-card">
            <div className="profile-section-header">
              <div className="profile-section-title">
                <IonIcon icon={syncOutline} style={{ fontSize: '1.25rem', color: 'var(--color-primary)' }} />
                <span>Station Sync & Storage</span>
              </div>
              <span
                className={`status-pill ${
                  isOnline ? 'status-pill--success' : 'status-pill--pending'
                }`}
              >
                {isOnline ? 'ONLINE' : 'OFFLINE MODE'}
              </span>
            </div>

            {/* Sync Health Banner */}
            {totalUnsynced === 0 ? (
              <div className="profile-sync-banner profile-sync-banner--synced">
                <IonIcon icon={checkmarkCircleOutline} style={{ fontSize: '1.3rem', flexShrink: 0 }} />
                <div>
                  <div style={{ fontWeight: 700, fontSize: '0.85rem' }}>All records synced to Barangay HQ</div>
                  <div style={{ fontSize: '0.72rem', opacity: 0.9 }}>
                    Your incident reports and GPS tracks are fully up to date.
                  </div>
                </div>
              </div>
            ) : (
              <div className="profile-sync-banner profile-sync-banner--pending">
                <IonIcon icon={warningOutline} style={{ fontSize: '1.3rem', flexShrink: 0 }} />
                <div>
                  <div style={{ fontWeight: 700, fontSize: '0.85rem' }}>
                    {totalUnsynced} record(s) pending upload
                  </div>
                  <div style={{ fontSize: '0.72rem', opacity: 0.9 }}>
                    Saved on this device. Tap below to sync when connected.
                  </div>
                </div>
              </div>
            )}

            {/* Breakdown Chips (Progressive disclosure of pending items) */}
            {totalUnsynced > 0 && (
              <div className="profile-sync-badge-row">
                {localStats.unsyncedIncidents > 0 && (
                  <span className="profile-sync-chip">
                    <IonIcon icon={documentTextOutline} />
                    {localStats.unsyncedIncidents} Incident(s)
                  </span>
                )}
                {localStats.unsyncedGps > 0 && (
                  <span className="profile-sync-chip">
                    <IonIcon icon={syncOutline} />
                    {localStats.unsyncedGps} GPS Log(s)
                  </span>
                )}
                {localStats.pendingQueue > 0 && (
                  <span className="profile-sync-chip">
                    <IonIcon icon={shieldCheckmarkOutline} />
                    {localStats.pendingQueue} Status Update(s)
                  </span>
                )}
              </div>
            )}

            <IonButton
              expand="block"
              disabled={syncing || !isOnline}
              onClick={handleManualSync}
              style={{
                '--background': 'var(--color-primary)',
                '--border-radius': 'var(--radius-sm)',
                fontWeight: 700,
                minHeight: '46px',
                boxShadow: 'none',
              }}
            >
              {syncing ? (
                <IonSpinner name="dots" />
              ) : (
                <>
                  <IonIcon icon={syncOutline} slot="start" />
                  {totalUnsynced > 0
                    ? `Sync Records Now (${totalUnsynced})`
                    : 'Check Station Connection'}
                </>
              )}
            </IonButton>

            {/* Progressive Disclosure Storage Drawer */}
            {storage && (
              <>
                <button
                  type="button"
                  className="profile-drawer-toggle"
                  onClick={() => setShowStorageDetails(!showStorageDetails)}
                  aria-expanded={showStorageDetails}
                >
                  <span>Offline Storage Breakdown</span>
                  <IonIcon icon={showStorageDetails ? chevronUpOutline : chevronDownOutline} />
                </button>

                {showStorageDetails && (
                  <div className="profile-drawer-content">
                    <div
                      style={{
                        display: 'grid',
                        gridTemplateColumns: '1fr 1fr',
                        gap: '8px',
                        marginBottom: '10px',
                      }}
                    >
                      <div
                        style={{
                          background: 'var(--color-bg)',
                          padding: '8px 12px',
                          borderRadius: 'var(--radius-sm)',
                          border: '1px solid var(--color-border)',
                        }}
                      >
                        <div style={{ fontSize: '0.68rem', color: 'var(--color-text-secondary)', fontWeight: 600 }}>
                          Evidence Files
                        </div>
                        <div style={{ fontSize: '0.95rem', fontWeight: 700, color: 'var(--color-text-primary)' }}>
                          {formatBytes(storage.evidence.totalBytes)}{' '}
                          <span style={{ fontWeight: 400, fontSize: '0.72rem', color: 'var(--color-text-secondary)' }}>
                            ({storage.evidence.fileCount})
                          </span>
                        </div>
                      </div>
                      <div
                        style={{
                          background: 'var(--color-bg)',
                          padding: '8px 12px',
                          borderRadius: 'var(--radius-sm)',
                          border: '1px solid var(--color-border)',
                        }}
                      >
                        <div style={{ fontSize: '0.68rem', color: 'var(--color-text-secondary)', fontWeight: 600 }}>
                          Offline Map
                        </div>
                        <div style={{ fontSize: '0.95rem', fontWeight: 700, color: 'var(--color-text-primary)' }}>
                          {formatBytes(storage.mapPackages.totalBytes)}{' '}
                          <span style={{ fontWeight: 400, fontSize: '0.72rem', color: 'var(--color-text-secondary)' }}>
                            ({storage.mapPackages.fileCount})
                          </span>
                        </div>
                      </div>
                    </div>
                    <IonButton
                      fill="outline"
                      className="btn-touch-compact"
                      expand="block"
                      disabled={pruning}
                      onClick={handlePruneEvidence}
                      style={{
                        fontWeight: 600,
                        '--border-radius': 'var(--radius-sm)',
                      }}
                    >
                      {pruning ? <IonSpinner name="dots" /> : 'Clear Old Synced Evidence (30+ days)'}
                    </IonButton>
                  </div>
                )}
              </>
            )}
          </div>

          {/* Section 4: Alert Readiness & Terminal Diagnostics */}
          <div className="profile-section-card">
            <div className="profile-section-header">
              <div className="profile-section-title">
                <IonIcon icon={notificationsOutline} style={{ fontSize: '1.25rem', color: 'var(--color-warning)' }} />
                <span>Emergency Push Alert Readiness</span>
              </div>
            </div>

            <NotificationDiagnostics />

            {/* Subtle technical diagnostics footer with 1-tap copy for IT/admin */}
            <div className="profile-terminal-footer">
              <div className="profile-terminal-info">
                <span className="profile-terminal-label">Device Terminal ID</span>
                <span className="profile-terminal-key">{deviceId || 'Detecting…'}</span>
              </div>
              <button
                type="button"
                className="profile-copy-btn"
                onClick={handleCopyDeviceId}
                aria-label="Copy Device Terminal ID"
              >
                <IonIcon icon={copiedDevice ? checkmarkOutline : copyOutline} />
                <span>{copiedDevice ? 'Copied' : 'Copy'}</span>
              </button>
            </div>
          </div>

          {/* Section 5: Secure Terminal Sign Out */}
          <div className="profile-signout-card">
            <button
              type="button"
              className="profile-signout-btn"
              onClick={() => setConfirmingSignOut(true)}
            >
              <IonIcon icon={logOutOutline} style={{ fontSize: '1.2rem' }} />
              <span>SIGN OUT OF TERMINAL</span>
            </button>
          </div>
        </div>

        <IonToast
          isOpen={toastMessage !== null}
          message={toastMessage ?? ''}
          duration={3500}
          onDidDismiss={() => setToastMessage(null)}
        />

        <IonAlert
          isOpen={confirmingSignOut}
          onDidDismiss={() => setConfirmingSignOut(false)}
          header="Confirm Sign Out?"
          message="Local cached incidents and GPS tracks will remain encrypted on this device."
          buttons={[
            { text: 'Cancel', role: 'cancel' },
            { text: 'Sign Out', role: 'destructive', handler: handleSignOut },
          ]}
        />
      </IonContent>
    </IonPage>
  );
};

export default ProfilePage;
