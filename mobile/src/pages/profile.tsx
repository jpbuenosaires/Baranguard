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
  calendarOutline,
  checkmarkOutline,
  chevronDownOutline,
  chevronUpOutline,
  copyOutline,
  documentTextOutline,
  logOutOutline,
  notificationsOutline,
  serverOutline,
  shieldCheckmarkOutline,
  syncOutline,
  wifiOutline,
  colorPaletteOutline,
  moonOutline,
  sunnyOutline,
  phonePortraitOutline,
} from 'ionicons/icons';
import { TextField } from '../components/FormFields';
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
import { getStoredTheme, setTheme, type ThemePreference, THEME_CHANGED_EVENT } from '../utils/theme';

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

  // Drawer toggles for clean tactical layout
  const [showServerSettings, setShowServerSettings] = useState(false);
  const [showStorageDetails, setShowStorageDetails] = useState(false);

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

  // Theme / Appearance
  const [themePref, setThemePref] = useState<ThemePreference>(() => getStoredTheme());

  useEffect(() => {
    void loadData();
    void pingWorkstation();

    const handleThemeChanged = () => {
      setThemePref(getStoredTheme());
    };
    window.addEventListener(THEME_CHANGED_EVENT, handleThemeChanged);
    return () => window.removeEventListener(THEME_CHANGED_EVENT, handleThemeChanged);
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
        <div className="app-column profile-layout">
          {/* Module 1: Tactical Responder Command Header */}
          <div className="profile-officer-card">
            <div className="profile-officer-header">
              <div className="profile-avatar-circle">{initials}</div>
              <div className="profile-officer-meta">
                <h2 className="profile-officer-name">{session?.fullName || 'Tanod Officer'}</h2>
                <div className="profile-officer-role">
                  <IonIcon icon={shieldCheckmarkOutline} />
                  <span>Role: {session?.role?.toUpperCase() || 'TANOD'} · Barangay #{session?.barangayId ?? 1}</span>
                </div>
              </div>
            </div>

            <div className="profile-device-strip">
              <div style={{ minWidth: 0, flex: 1 }}>
                <div style={{ fontSize: '0.65rem', textTransform: 'uppercase', color: 'rgba(255,255,255,0.6)', fontWeight: 700, marginBottom: 2 }}>
                  Device Identity Key
                </div>
                <div className="profile-device-key">
                  {deviceId || 'Loading device key…'}
                </div>
              </div>
              <button
                type="button"
                className="profile-copy-btn"
                onClick={handleCopyDeviceId}
              >
                <IonIcon icon={copiedDevice ? checkmarkOutline : copyOutline} />
                <span>{copiedDevice ? 'Copied' : 'Copy'}</span>
              </button>
            </div>
          </div>

          {/* Quick Action Navigation Tiles */}
          <div className="profile-quick-grid">
            <button
              type="button"
              className="profile-quick-card"
              onClick={() => navigate('/tabs/reports')}
            >
              <div className="profile-quick-icon">
                <IonIcon icon={documentTextOutline} />
              </div>
              <div style={{ minWidth: 0, flex: 1 }}>
                <h4 className="profile-quick-label">My Reports</h4>
                <div className="profile-quick-sub">Filed incidents & sync</div>
              </div>
            </button>

            <button
              type="button"
              className="profile-quick-card"
              onClick={() => navigate('/tabs/shifts')}
            >
              <div className="profile-quick-icon">
                <IonIcon icon={calendarOutline} />
              </div>
              <div style={{ minWidth: 0, flex: 1 }}>
                <h4 className="profile-quick-label">My Shifts</h4>
                <div className="profile-quick-sub">Schedule & swap requests</div>
              </div>
            </button>
          </div>

          {/* Module 2: Tactical Appearance & Night Patrol */}
          <div className="profile-section-card">
            <div className="profile-section-header">
              <div className="profile-section-title">
                <IonIcon icon={colorPaletteOutline} style={{ fontSize: '1.25rem', color: 'var(--color-primary)' }} />
                <span>Appearance & Night Vision</span>
              </div>
            </div>
            <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr 1fr', gap: '8px' }}>
              {(['system', 'light', 'dark'] as ThemePreference[]).map((mode) => {
                const isActive = themePref === mode;
                const modeLabel = mode === 'system' ? 'System' : mode === 'light' ? 'Light' : 'Dark (Night)';
                const modeIcon = mode === 'system' ? phonePortraitOutline : mode === 'light' ? sunnyOutline : moonOutline;

                return (
                  <button
                    key={mode}
                    type="button"
                    onClick={() => {
                      setTheme(mode);
                      setToastMessage(`Theme set to ${modeLabel}.`);
                    }}
                    style={{
                      display: 'flex',
                      flexDirection: 'column',
                      alignItems: 'center',
                      justifyContent: 'center',
                      gap: '6px',
                      padding: '10px 4px',
                      borderRadius: 'var(--radius-md)',
                      border: isActive ? '2px solid var(--color-primary)' : '1px solid var(--color-border)',
                      background: isActive ? 'var(--color-row-active-bg)' : 'var(--color-surface)',
                      color: isActive ? 'var(--color-primary)' : 'var(--color-text-secondary)',
                      fontWeight: isActive ? 700 : 500,
                      cursor: 'pointer',
                      transition: 'all 0.15s ease',
                    }}
                  >
                    <IonIcon icon={modeIcon} style={{ fontSize: '1.2rem' }} />
                    <span style={{ fontSize: 'var(--font-size-label)' }}>{modeLabel}</span>
                  </button>
                );
              })}
            </div>
          </div>

          {/* Module 3: Field Telemetry & SQLite Database Hub */}
          <div className="profile-section-card">
            <div className="profile-section-header">
              <div className="profile-section-title">
                <IonIcon icon={wifiOutline} style={{ fontSize: '1.25rem', color: 'var(--color-primary)' }} />
                <span>Workstation LAN Telemetry</span>
              </div>
              <span className={`status-pill ${isOnline ? 'status-pill--success' : 'status-pill--pending'}`}>
                {isOnline ? 'ONLINE' : 'OFFLINE'}
              </span>
            </div>

            <div className="profile-stat-grid">
              <div className="profile-stat-box">
                <span className="profile-stat-box-label">LAN Latency</span>
                <span className="profile-stat-box-value">
                  {latency !== null ? `${latency} ms` : 'Unreachable'}
                </span>
              </div>
              <div className="profile-stat-box">
                <span className="profile-stat-box-label">Sliding JWT</span>
                <span className="profile-stat-box-value" style={{ color: 'var(--color-success)', fontSize: '0.95rem' }}>
                  Auto-Renew
                </span>
              </div>
            </div>

            <IonButton
              fill="outline"
              expand="block"
              disabled={pinging}
              onClick={pingWorkstation}
              className="btn-touch-compact"
              style={{ fontWeight: 700, marginBottom: '6px' }}
            >
              {pinging ? <IonSpinner name="dots" /> : 'Ping Barangay Workstation'}
            </IonButton>

            {/* Collapsible Server Address Settings */}
            <button
              type="button"
              className="profile-drawer-toggle"
              onClick={() => setShowServerSettings(!showServerSettings)}
            >
              <span>Workstation Address {hasApiBaseUrlOverride() ? '(Custom Override)' : ''}</span>
              <IonIcon icon={showServerSettings ? chevronUpOutline : chevronDownOutline} />
            </button>

            {showServerSettings && (
              <div className="profile-drawer-content">
                <TextField label="Workstation LAN URL" value={baseUrlInput} onChange={setBaseUrlInput} autocapitalize="off" />
                <div style={{ display: 'flex', gap: '8px', marginTop: '8px' }}>
                  <IonButton
                    fill="outline"
                    className="btn-touch-compact"
                    style={{ flex: 1, fontWeight: 700 }}
                    disabled={savingBaseUrl || !baseUrlInput.trim()}
                    onClick={handleSaveBaseUrl}
                  >
                    {savingBaseUrl ? <IonSpinner name="dots" /> : 'Save & Reconnect'}
                  </IonButton>
                  {hasApiBaseUrlOverride() && (
                    <IonButton
                      fill="clear"
                      className="btn-touch-compact"
                      color="medium"
                      disabled={savingBaseUrl}
                      onClick={handleResetBaseUrl}
                    >
                      Reset Default
                    </IonButton>
                  )}
                </div>
              </div>
            )}
          </div>

          {/* Module 4: Encrypted Offline SQLite & Storage Inspector */}
          <div className="profile-section-card">
            <div className="profile-section-header">
              <div className="profile-section-title">
                <IonIcon icon={serverOutline} style={{ fontSize: '1.25rem', color: 'var(--color-info)' }} />
                <span>Offline SQLite Database</span>
              </div>
              <span className="status-pill status-pill--info">ENCRYPTED</span>
            </div>

            <div className="profile-stat-grid">
              <div className="profile-stat-box">
                <span className="profile-stat-box-label">Cached Dispatches</span>
                <span className="profile-stat-box-value">{localStats.dispatches}</span>
              </div>
              <div className="profile-stat-box">
                <span className="profile-stat-box-label">Unsynced Reports</span>
                <span className="profile-stat-box-value" style={{ color: localStats.unsyncedIncidents > 0 ? 'var(--color-warning)' : 'inherit' }}>
                  {localStats.unsyncedIncidents}
                </span>
              </div>
              <div className="profile-stat-box">
                <span className="profile-stat-box-label">GPS Breadcrumbs</span>
                <span className="profile-stat-box-value">{localStats.unsyncedGps}</span>
              </div>
              <div className="profile-stat-box">
                <span className="profile-stat-box-label">Queued Transitions</span>
                <span className="profile-stat-box-value">{localStats.pendingQueue}</span>
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

            {/* Storage Drawer */}
            {storage && (
              <>
                <button
                  type="button"
                  className="profile-drawer-toggle"
                  onClick={() => setShowStorageDetails(!showStorageDetails)}
                >
                  <span>Evidence Files & Offline Map Storage</span>
                  <IonIcon icon={showStorageDetails ? chevronUpOutline : chevronDownOutline} />
                </button>

                {showStorageDetails && (
                  <div className="profile-drawer-content">
                    <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '8px', marginBottom: '10px' }}>
                      <div style={{ background: 'var(--color-bg)', padding: '8px 12px', borderRadius: 'var(--radius-md)' }}>
                        <div style={{ fontSize: '0.68rem', color: 'var(--color-text-secondary)' }}>Evidence Files</div>
                        <div style={{ fontSize: '0.95rem', fontWeight: 700 }}>
                          {formatBytes(storage.evidence.totalBytes)} <span style={{ fontWeight: 400, fontSize: '0.72rem', color: 'var(--color-text-tertiary)' }}>({storage.evidence.fileCount})</span>
                        </div>
                      </div>
                      <div style={{ background: 'var(--color-bg)', padding: '8px 12px', borderRadius: 'var(--radius-md)' }}>
                        <div style={{ fontSize: '0.68rem', color: 'var(--color-text-secondary)' }}>Map Packages</div>
                        <div style={{ fontSize: '0.95rem', fontWeight: 700 }}>
                          {formatBytes(storage.mapPackages.totalBytes)} <span style={{ fontWeight: 400, fontSize: '0.72rem', color: 'var(--color-text-tertiary)' }}>({storage.mapPackages.fileCount})</span>
                        </div>
                      </div>
                    </div>
                    <IonButton fill="outline" className="btn-touch-compact" expand="block" disabled={pruning} onClick={handlePruneEvidence} style={{ fontWeight: 600 }}>
                      {pruning ? <IonSpinner name="dots" /> : 'Clear Old Synced Evidence (30+ days)'}
                    </IonButton>
                  </div>
                )}
              </>
            )}
          </div>

          {/* Module 5: Hardware & Alert Verification */}
          <div className="profile-section-card">
            <div className="profile-section-header">
              <div className="profile-section-title">
                <IonIcon icon={notificationsOutline} style={{ fontSize: '1.25rem', color: 'var(--color-warning)' }} />
                <span>Alert & Audio Verification</span>
              </div>
            </div>

            <NotificationDiagnostics />
          </div>

          {/* Module 6: Secure Terminal Sign Out */}
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
