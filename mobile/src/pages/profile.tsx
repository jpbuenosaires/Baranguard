import React, { useEffect, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import {
  IonAlert,
  IonContent,
  IonIcon,
  IonPage,
  IonToast,
  useIonViewWillEnter,
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
  timeOutline,
} from 'ionicons/icons';
import MobileHeader from '../components/MobileHeader';
import NotificationDiagnostics from '../components/NotificationDiagnostics';
import { Banner, Button } from '../components/ui';
import { formatSyncResult } from '../components/syncQueueSummary';
import { checkHealth, getDispatches, logout } from '../services/apiService';
import { getDeviceId } from '../services/deviceIdentity';
import { clearSession, loadSession, type StoredSession } from '../services/session';
import { cacheDispatchesFromServer, listActiveCachedDispatches } from '../services/db/dispatchRepository';
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

  // Stay mounted between tab visits: re-read the on-phone counts, and pull the latest dispatches so "Active
  // Dispatches" is not a stale cache.
  useIonViewWillEnter(() => {
    void getDispatches()
      .then((fresh) => cacheDispatchesFromServer(fresh))
      .catch(() => undefined)
      .finally(() => void loadData());
  });

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
      const summary = formatSyncResult(result);
      setToastMessage(`Sync result: ${[summary.headline, ...summary.details].join(' ')}`);
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
      <MobileHeader title="Profile" />

      <IonContent className="ion-padding content-bg">
        <div className="app-column profile-layout">
          <section className="profile-identity" aria-label="Your account">
            <div className="profile-avatar-circle" aria-hidden="true">{initials}</div>
            <div className="profile-identity__body">
              <h2 className="profile-identity__name">{session?.fullName || 'Tanod Officer'}</h2>
              <p className="profile-identity__role">Security responder, Brgy {barangayName}</p>
              <span className="profile-verified-badge">
                <IonIcon icon={shieldCheckmarkOutline} aria-hidden="true" />
                Active Duty
              </span>
              <p className="profile-identity__line">Barangay post: {barangayName} HQ</p>
              <p className="profile-identity__line">Active dispatches: {localStats.dispatches}</p>
            </div>
          </section>

          <ul className="profile-list">
            <li>
              <button type="button" className="profile-row" onClick={() => navigate('/tabs/reports')}>
                <span className="profile-row__icon" aria-hidden="true">
                  <IonIcon icon={documentTextOutline} />
                </span>
                <span className="profile-row__text">
                  <span className="profile-row__title">My filed reports</span>
                  <span className="profile-row__sub">Incidents you submitted</span>
                </span>
                <IonIcon icon={chevronForwardOutline} className="profile-row__chevron" aria-hidden="true" />
              </button>
            </li>
            <li>
              <button type="button" className="profile-row" onClick={() => navigate('/tabs/shifts')}>
                <span className="profile-row__icon" aria-hidden="true">
                  <IonIcon icon={timeOutline} />
                </span>
                <span className="profile-row__text">
                  <span className="profile-row__title">My duty shifts</span>
                  <span className="profile-row__sub">Published patrol shifts</span>
                </span>
                <IonIcon icon={chevronForwardOutline} className="profile-row__chevron" aria-hidden="true" />
              </button>
            </li>
            <li>
              <button type="button" className="profile-row" onClick={() => navigate('/tabs/availability')}>
                <span className="profile-row__icon" aria-hidden="true">
                  <IonIcon icon={calendarOutline} />
                </span>
                <span className="profile-row__text">
                  <span className="profile-row__title">My availability</span>
                  <span className="profile-row__sub">When you can serve</span>
                </span>
                <IonIcon icon={chevronForwardOutline} className="profile-row__chevron" aria-hidden="true" />
              </button>
            </li>
            <li>
              <button type="button" className="profile-row" onClick={() => navigate('/tabs/accomplishments')}>
                <span className="profile-row__icon" aria-hidden="true">
                  <IonIcon icon={checkmarkCircleOutline} />
                </span>
                <span className="profile-row__text">
                  <span className="profile-row__title">My accomplishments</span>
                  <span className="profile-row__sub">Daily log and monthly report</span>
                </span>
                <IonIcon icon={chevronForwardOutline} className="profile-row__chevron" aria-hidden="true" />
              </button>
            </li>
            <li>
              <button type="button" className="profile-row" onClick={() => navigate('/tabs/school')}>
                <span className="profile-row__icon" aria-hidden="true">
                  <IonIcon icon={schoolOutline} />
                </span>
                <span className="profile-row__text">
                  <span className="profile-row__title">School check-in</span>
                  <span className="profile-row__sub">Safer School Zones, works offline</span>
                </span>
                <IonIcon icon={chevronForwardOutline} className="profile-row__chevron" aria-hidden="true" />
              </button>
            </li>
          </ul>

          <div className="profile-section-card">
            <div className="profile-section-header">
              <div className="profile-section-title">
                <IonIcon icon={syncOutline} className="icon-lg-primary" aria-hidden="true" />
                <span>Sync and storage</span>
              </div>
              <span
                className={`status-pill ${
                  isOnline ? 'status-pill--success' : 'status-pill--pending'
                }`}
              >
                {isOnline ? 'ONLINE' : 'OFFLINE MODE'}
              </span>
            </div>

            {totalUnsynced === 0 ? (
              <Banner tone="success" role="status">
                <strong>Nothing waiting to send.</strong> Your incident reports, GPS tracks and status updates have all
                been sent.
              </Banner>
            ) : (
              <Banner tone="warning" role="status">
                <strong>
                  {totalUnsynced} record{totalUnsynced === 1 ? '' : 's'} not sent yet.
                </strong>{' '}
                Saved on this phone. Tap below to send when connected.
              </Banner>
            )}

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

            <Button
              fullWidth
              icon={syncOutline}
              loading={syncing}
              disabled={!isOnline}
              onClick={handleManualSync}
            >
              {totalUnsynced > 0 ? `Sync records now (${totalUnsynced})` : 'Check connection'}
            </Button>

            {storage && (
              <>
                <button
                  type="button"
                  className="profile-drawer-toggle"
                  onClick={() => setShowStorageDetails(!showStorageDetails)}
                  aria-expanded={showStorageDetails}
                >
                  <span>Offline storage breakdown</span>
                  <IonIcon icon={showStorageDetails ? chevronUpOutline : chevronDownOutline} />
                </button>

                {showStorageDetails && (
                  <div className="profile-drawer-content">
                    <div className="profile-storage-grid">
                      <div className="profile-storage-tile">
                        <div className="profile-storage-tile__label">Evidence files</div>
                        <div className="profile-storage-tile__value">
                          {formatBytes(storage.evidence.totalBytes)}{' '}
                          <span className="profile-storage-tile__count">
                            ({storage.evidence.fileCount})
                          </span>
                        </div>
                      </div>
                      <div className="profile-storage-tile">
                        <div className="profile-storage-tile__label">Offline map</div>
                        <div className="profile-storage-tile__value">
                          {formatBytes(storage.mapPackages.totalBytes)}{' '}
                          <span className="profile-storage-tile__count">
                            ({storage.mapPackages.fileCount})
                          </span>
                        </div>
                      </div>
                    </div>
                    <Button variant="secondary" fullWidth loading={pruning} onClick={handlePruneEvidence}>
                      Clear old sent evidence (30+ days)
                    </Button>
                  </div>
                )}
              </>
            )}
          </div>

          <div className="profile-section-card">
            <div className="profile-section-header">
              <div className="profile-section-title">
                <IonIcon icon={notificationsOutline} className="icon-lg-warning" aria-hidden="true" />
                <span>Alerts on this phone</span>
              </div>
            </div>

            <NotificationDiagnostics />

            <div className="profile-terminal-footer">
              <div className="profile-terminal-info">
                <span className="profile-terminal-label">Device ID</span>
                <span className="profile-terminal-key">{deviceId || 'Detecting…'}</span>
              </div>
              <button
                type="button"
                className="profile-copy-btn"
                onClick={handleCopyDeviceId}
                aria-label="Copy device ID"
              >
                <IonIcon icon={copiedDevice ? checkmarkOutline : copyOutline} />
                <span>{copiedDevice ? 'Copied' : 'Copy'}</span>
              </button>
            </div>
          </div>

          <button
            type="button"
            className="profile-signout-btn"
            onClick={() => setConfirmingSignOut(true)}
          >
            <IonIcon icon={logOutOutline} className="icon-md" aria-hidden="true" />
            <span>Sign out</span>
          </button>
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
