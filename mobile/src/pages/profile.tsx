/**
 * profile.tsx — M10 Profile & Tactical Field Diagnostics Console (§9 Mobile).
 *
 * Provides responders with full telemetry on their operational session,
 * device identity, push notification readiness, local SQLite database health,
 * and LAN workstation connectivity.
 */

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
  alertCircleOutline,
  calendarOutline,
  checkmarkOutline,
  copyOutline,
  documentTextOutline,
  fingerPrintOutline,
  hardwareChipOutline,
  logOutOutline,
  notificationsOutline,
  radioOutline,
  serverOutline,
  shieldCheckmarkOutline,
  syncOutline,
  timeOutline,
  volumeHighOutline,
  wifiOutline,
} from 'ionicons/icons';
import { TextField } from '../components/FormFields';
import FullScreenAlert from '../services/fullScreenAlert';
import MobileHeader from '../components/MobileHeader';
import NotificationDiagnostics from '../components/NotificationDiagnostics';
import { checkHealth, getApiBaseUrl, hasApiBaseUrlOverride, logout, setApiBaseUrlOverride } from '../services/apiService';
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

const ProfilePage: React.FC = () => {
  const navigate = useNavigate();
  const [session, setSession] = useState<StoredSession | null>(null);
  const [deviceId, setDeviceId] = useState<string>('');
  const [copiedDevice, setCopiedDevice] = useState(false);

  // Network Telemetry
  const [pinging, setPinging] = useState(false);
  const [latency, setLatency] = useState<number | null>(null);
  const [isOnline, setIsOnline] = useState<boolean | null>(null);

  // Workstation connection override (Mobile Improvement Plan Phase 1.3) —
  // a DHCP-reassigned workstation IP shouldn't require a rebuild to fix.
  const [baseUrlInput, setBaseUrlInput] = useState(getApiBaseUrl());
  const [savingBaseUrl, setSavingBaseUrl] = useState(false);

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

  // Storage telemetry/cleanup (Phase 3.3)
  const [storage, setStorage] = useState<StorageSnapshot | null>(null);
  const [pruning, setPruning] = useState(false);

  const loadData = async () => {
    const s = await loadSession();
    setSession(s);

    const devId = await getDeviceId();
    setDeviceId(devId);

    // Reflects a runtime override that may have finished loading from
    // Preferences after this component's initial render (see
    // apiService.ts's loadApiBaseUrlOverride()).
    setBaseUrlInput(getApiBaseUrl());

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

  const pingWorkstation = async () => {
    setPinging(true);
    const t0 = performance.now();
    try {
      const ok = await checkHealth();
      const diff = Math.round(performance.now() - t0);
      setIsOnline(ok);
      setLatency(ok ? diff : null);
      if (ok) {
        tacticalFeedback.onSuccess();
      }
    } catch {
      setIsOnline(false);
      setLatency(null);
    } finally {
      setPinging(false);
    }
  };

  useEffect(() => {
    void loadData();
    void pingWorkstation();
  }, []);

  const handleSaveBaseUrl = async () => {
    const trimmed = baseUrlInput.trim();
    if (!trimmed) return;
    setSavingBaseUrl(true);
    try {
      await setApiBaseUrlOverride(trimmed);
      setBaseUrlInput(getApiBaseUrl());
      setToastMessage('Workstation address updated.');
      await pingWorkstation();
    } finally {
      setSavingBaseUrl(false);
    }
  };

  const handleResetBaseUrl = async () => {
    setSavingBaseUrl(true);
    try {
      await setApiBaseUrlOverride(null);
      setBaseUrlInput(getApiBaseUrl());
      setToastMessage('Reverted to the default workstation address.');
      await pingWorkstation();
    } finally {
      setSavingBaseUrl(false);
    }
  };

  const handleCopyDeviceId = () => {
    if (!deviceId) return;
    navigator.clipboard.writeText(deviceId);
    setCopiedDevice(true);
    setTimeout(() => setCopiedDevice(false), 2000);
  };

  const handleManualSync = async () => {
    setSyncing(true);
    try {
      const result: SyncSummary = await runSyncPass();
      tacticalFeedback.onSuccess();
      const evidenceNote = result.evidenceUploaded > 0 ? ` · ${result.evidenceUploaded} evidence file(s) uploaded` : '';
      setToastMessage(`Sync complete: ${result.succeeded} uploaded, ${result.duplicates} verified${evidenceNote}.`);
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

  const handleTestChimes = () => {
    tacticalFeedback.onSosFired();
    setToastMessage('Tactical audio chime & emergency vibration test dispatched.');
  };

  const handleTestFullScreenAlert = async () => {
    try {
      await FullScreenAlert.showTest({
        title: 'Test Critical Alert',
        body: 'This is a test of the full-screen emergency alert (Phase 4.2).',
      });
    } catch {
      setToastMessage('Could not show the full-screen alert test.');
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

  const totalUnsynced =
    localStats.unsyncedIncidents + localStats.unsyncedGps + localStats.pendingQueue;

  return (
    <IonPage>
      <MobileHeader title="CONSOLE & PROFILE" subtitle="Responder Diagnostics" />

      <IonContent className="ion-padding" style={{ '--background': 'var(--color-bg)' }}>
        <div className="app-column">
          {/* Card 1: Responder Identity */}
          <div className="hero-officer-card" style={{ marginBottom: '16px' }}>
            <div className="hero-officer-header">
              <div className="hero-officer__avatar">{initials}</div>
              <div className="hero-officer__info">
                <h2 className="hero-officer__name">{session?.fullName || 'Tanod Officer'}</h2>
                <div className="hero-officer__badge">
                  <IonIcon icon={shieldCheckmarkOutline} />
                  <span>Role: {session?.role?.toUpperCase() || 'TANOD'} · Barangay #{session?.barangayId ?? 1}</span>
                </div>
              </div>
            </div>

            <div style={{ marginTop: '16px', background: 'rgba(255, 255, 255, 0.08)', borderRadius: 'var(--radius-md)', padding: '10px 14px' }}>
              <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '4px' }}>
                <span style={{ fontSize: '0.72rem', textTransform: 'uppercase', color: 'var(--color-surface-blue)', fontWeight: 600 }}>
                  Device Identity Key
                </span>
                <button
                  type="button"
                  onClick={handleCopyDeviceId}
                  style={{
                    display: 'flex',
                    alignItems: 'center',
                    gap: '4px',
                    background: 'rgba(255, 255, 255, 0.15)',
                    border: 'none',
                    borderRadius: 'var(--radius-sm)',
                    padding: '2px 8px',
                    color: 'var(--color-white)',
                    fontSize: '0.72rem',
                    cursor: 'pointer',
                  }}
                >
                  <IonIcon icon={copiedDevice ? checkmarkOutline : copyOutline} />
                  <span>{copiedDevice ? 'Copied' : 'Copy'}</span>
                </button>
              </div>
              <div style={{ fontFamily: 'var(--font-mono)', fontSize: '0.78rem', wordBreak: 'break-all', opacity: 0.9 }}>
                {deviceId || 'Loading device key…'}
              </div>
            </div>
          </div>

          {/* Quick Links — M14 My Reports (Phase 2.2), M8/M9 My Shifts (Phase 4.4) */}
          <div style={{ display: 'grid', gridTemplateColumns: '1fr', gap: '8px', marginBottom: '16px' }}>
            <button
              type="button"
              onClick={() => navigate('/reports')}
              className="card--elevated"
              style={{
                display: 'flex',
                alignItems: 'center',
                gap: '10px',
                padding: '14px 16px',
                border: 'none',
                width: '100%',
                textAlign: 'left',
                cursor: 'pointer',
                background: 'var(--color-bg)',
              }}
            >
              <IonIcon icon={documentTextOutline} style={{ fontSize: '1.3rem', color: 'var(--color-primary)' }} />
              <div style={{ flex: 1 }}>
                <div style={{ fontSize: 'var(--font-size-md)', fontWeight: 700, color: 'var(--color-text-primary)' }}>My Reports</div>
                <div style={{ fontSize: '0.75rem', color: 'var(--color-text-secondary)' }}>Review incidents you've filed and their sync status</div>
              </div>
            </button>

            <button
              type="button"
              onClick={() => navigate('/shifts')}
              className="card--elevated"
              style={{
                display: 'flex',
                alignItems: 'center',
                gap: '10px',
                padding: '14px 16px',
                border: 'none',
                width: '100%',
                textAlign: 'left',
                cursor: 'pointer',
                background: 'var(--color-bg)',
              }}
            >
              <IonIcon icon={calendarOutline} style={{ fontSize: '1.3rem', color: 'var(--color-primary)' }} />
              <div style={{ flex: 1 }}>
                <div style={{ fontSize: 'var(--font-size-md)', fontWeight: 700, color: 'var(--color-text-primary)' }}>My Shifts</div>
                <div style={{ fontSize: '0.75rem', color: 'var(--color-text-secondary)' }}>View your schedule and request a swap</div>
              </div>
            </button>
          </div>

          {/* Card 2: Workstation LAN Telemetry */}
          <div className="card--elevated" style={{ marginBottom: '16px' }}>
            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '12px' }}>
              <div style={{ display: 'flex', alignItems: 'center', gap: '8px' }}>
                <IonIcon icon={wifiOutline} style={{ fontSize: '1.3rem', color: 'var(--color-primary)' }} />
                <span style={{ fontSize: 'var(--font-size-md)', fontWeight: 700 }}>
                  Workstation LAN Telemetry
                </span>
              </div>
              <span className={`status-pill ${isOnline ? 'status-pill--success' : 'status-pill--pending'}`}>
                {isOnline ? 'ONLINE' : 'OFFLINE'}
              </span>
            </div>

            <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '8px', marginBottom: '12px' }}>
              <div style={{ background: 'var(--color-bg)', padding: '10px', borderRadius: 'var(--radius-md)' }}>
                <div style={{ fontSize: '0.7rem', color: 'var(--color-text-secondary)', textTransform: 'uppercase' }}>
                  LAN Latency
                </div>
                <div style={{ fontSize: 'var(--font-size-md)', fontWeight: 700, color: 'var(--color-text-primary)' }}>
                  {latency !== null ? `${latency} ms` : 'Unreachable'}
                </div>
              </div>

              <div style={{ background: 'var(--color-bg)', padding: '10px', borderRadius: 'var(--radius-md)' }}>
                <div style={{ fontSize: '0.7rem', color: 'var(--color-text-secondary)', textTransform: 'uppercase' }}>
                  Sliding JWT
                </div>
                <div style={{ fontSize: 'var(--font-size-md)', fontWeight: 700, color: 'var(--color-success)' }}>
                  Auto-Renew
                </div>
              </div>
            </div>

            <IonButton
              fill="outline"
              size="small"
              expand="block"
              disabled={pinging}
              onClick={pingWorkstation}
              style={{ fontWeight: 600, marginBottom: '12px' }}
            >
              {pinging ? <IonSpinner name="dots" /> : 'Ping Barangay Workstation'}
            </IonButton>

            <div style={{ borderTop: '1px solid var(--color-border)', paddingTop: '12px' }}>
              <div style={{ fontSize: '0.7rem', color: 'var(--color-text-secondary)', textTransform: 'uppercase', marginBottom: '6px' }}>
                Workstation Address {hasApiBaseUrlOverride() && <span style={{ color: 'var(--color-primary)' }}>(custom)</span>}
              </div>
              <TextField label="Workstation Address" value={baseUrlInput} onChange={setBaseUrlInput} autocapitalize="off" />
              <div style={{ display: 'flex', gap: '8px', marginTop: '8px' }}>
                <IonButton
                  fill="outline"
                  size="small"
                  style={{ flex: 1, fontWeight: 600 }}
                  disabled={savingBaseUrl || !baseUrlInput.trim()}
                  onClick={handleSaveBaseUrl}
                >
                  {savingBaseUrl ? <IonSpinner name="dots" /> : 'Save & Reconnect'}
                </IonButton>
                {hasApiBaseUrlOverride() && (
                  <IonButton
                    fill="clear"
                    size="small"
                    color="medium"
                    disabled={savingBaseUrl}
                    onClick={handleResetBaseUrl}
                  >
                    Reset
                  </IonButton>
                )}
              </div>
              <div style={{ fontSize: '0.68rem', color: 'var(--color-text-tertiary)', marginTop: '6px' }}>
                Change this if the workstation's LAN address changed (e.g. after a router restart re-assigned it via DHCP) — takes effect immediately, no reinstall needed.
              </div>
            </div>
          </div>

          {/* Card 3: Push Notifications & Audio Haptics */}
          <div className="card--elevated" style={{ marginBottom: '16px' }}>
            <div style={{ display: 'flex', alignItems: 'center', gap: '8px', marginBottom: '8px' }}>
              <IonIcon icon={notificationsOutline} style={{ fontSize: '1.3rem', color: 'var(--color-warning)' }} />
              <span style={{ fontSize: 'var(--font-size-md)', fontWeight: 700 }}>
                Critical Alert Diagnostics (M12)
              </span>
            </div>

            <NotificationDiagnostics />

            <div style={{ marginTop: '12px' }}>
              <IonButton
                fill="outline"
                color="medium"
                size="small"
                expand="block"
                onClick={handleTestChimes}
                style={{ fontWeight: 600 }}
              >
                <IonIcon icon={volumeHighOutline} slot="start" />
                Test Emergency Audio & Vibration
              </IonButton>
              <IonButton
                fill="outline"
                color="danger"
                size="small"
                expand="block"
                onClick={handleTestFullScreenAlert}
                style={{ fontWeight: 600, marginTop: '8px' }}
              >
                <IonIcon icon={alertCircleOutline} slot="start" />
                Test Full-Screen Alert (Phase 4.2)
              </IonButton>
            </div>
          </div>

          {/* Card 4: SQLite Offline Storage Inspector */}
          <div className="card--elevated" style={{ marginBottom: '16px' }}>
            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '12px' }}>
              <div style={{ display: 'flex', alignItems: 'center', gap: '8px' }}>
                <IonIcon icon={serverOutline} style={{ fontSize: '1.3rem', color: 'var(--color-info)' }} />
                <span style={{ fontSize: 'var(--font-size-md)', fontWeight: 700 }}>
                  Offline SQLite Database
                </span>
              </div>
              <span className="status-pill status-pill--info">ENCRYPTED</span>
            </div>

            <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '8px', marginBottom: '12px' }}>
              <div style={{ background: 'var(--color-bg)', padding: '8px 12px', borderRadius: 'var(--radius-md)' }}>
                <div style={{ fontSize: '0.7rem', color: 'var(--color-text-secondary)' }}>Cached Dispatches</div>
                <div style={{ fontSize: '1.1rem', fontWeight: 700 }}>{localStats.dispatches}</div>
              </div>

              <div style={{ background: 'var(--color-bg)', padding: '8px 12px', borderRadius: 'var(--radius-md)' }}>
                <div style={{ fontSize: '0.7rem', color: 'var(--color-text-secondary)' }}>Unsynced Reports</div>
                <div style={{ fontSize: '1.1rem', fontWeight: 700, color: localStats.unsyncedIncidents > 0 ? 'var(--color-warning)' : 'inherit' }}>
                  {localStats.unsyncedIncidents}
                </div>
              </div>

              <div style={{ background: 'var(--color-bg)', padding: '8px 12px', borderRadius: 'var(--radius-md)' }}>
                <div style={{ fontSize: '0.7rem', color: 'var(--color-text-secondary)' }}>GPS Breadcrumbs</div>
                <div style={{ fontSize: '1.1rem', fontWeight: 700 }}>{localStats.unsyncedGps}</div>
              </div>

              <div style={{ background: 'var(--color-bg)', padding: '8px 12px', borderRadius: 'var(--radius-md)' }}>
                <div style={{ fontSize: '0.7rem', color: 'var(--color-text-secondary)' }}>Queued Transitions</div>
                <div style={{ fontSize: '1.1rem', fontWeight: 700 }}>{localStats.pendingQueue}</div>
              </div>
            </div>

            <IonButton
              expand="block"
              disabled={syncing || !isOnline}
              onClick={handleManualSync}
              style={{
                '--background': 'linear-gradient(135deg, var(--color-navy) 0%, var(--color-primary) 100%)',
                fontWeight: 700,
              }}
            >
              {syncing ? (
                <IonSpinner name="dots" />
              ) : (
                <>
                  <IonIcon icon={syncOutline} slot="start" />
                  Sync All Local Records ({totalUnsynced})
                </>
              )}
            </IonButton>

            {storage && (
              <div style={{ marginTop: '14px', borderTop: '1px solid var(--color-border)', paddingTop: '12px' }}>
                <div style={{ fontSize: '0.7rem', color: 'var(--color-text-secondary)', textTransform: 'uppercase', marginBottom: '8px' }}>
                  Device Storage (evidence &amp; offline maps)
                </div>
                <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '8px', marginBottom: '10px' }}>
                  <div style={{ background: 'var(--color-bg)', padding: '8px 12px', borderRadius: 'var(--radius-md)' }}>
                    <div style={{ fontSize: '0.7rem', color: 'var(--color-text-secondary)' }}>Evidence Files</div>
                    <div style={{ fontSize: '1rem', fontWeight: 700 }}>
                      {formatBytes(storage.evidence.totalBytes)} <span style={{ fontWeight: 400, color: 'var(--color-text-tertiary)', fontSize: '0.75rem' }}>({storage.evidence.fileCount})</span>
                    </div>
                  </div>
                  <div style={{ background: 'var(--color-bg)', padding: '8px 12px', borderRadius: 'var(--radius-md)' }}>
                    <div style={{ fontSize: '0.7rem', color: 'var(--color-text-secondary)' }}>Offline Map Packages</div>
                    <div style={{ fontSize: '1rem', fontWeight: 700 }}>
                      {formatBytes(storage.mapPackages.totalBytes)} <span style={{ fontWeight: 400, color: 'var(--color-text-tertiary)', fontSize: '0.75rem' }}>({storage.mapPackages.fileCount})</span>
                    </div>
                  </div>
                </div>
                <IonButton fill="outline" size="small" expand="block" disabled={pruning} onClick={handlePruneEvidence} style={{ fontWeight: 600 }}>
                  {pruning ? <IonSpinner name="dots" /> : 'Clear Old Synced Evidence (30+ days)'}
                </IonButton>
              </div>
            )}
          </div>

          {/* Sign Out CTA */}
          <div style={{ textAlign: 'center', marginTop: '24px', marginBottom: '32px' }}>
            <IonButton
              expand="block"
              fill="outline"
              color="danger"
              onClick={() => setConfirmingSignOut(true)}
              style={{ fontWeight: 700, height: '48px' }}
            >
              <IonIcon icon={logOutOutline} slot="start" />
              Sign Out of Terminal
            </IonButton>
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
