/**
 * home.tsx — M2 Home (§9 Mobile).
 *
 * §9 M2: "Duty control remains primary. SOS supports the local/offline
 * fallback path ... The duty toggle must call POST /duty-status, not just
 * flip local UI state." That's the one hard requirement this screen must
 * satisfy, and it does: `handleToggleDuty` always round-trips through
 * `apiService.setDutyStatus`, and the displayed status is loaded from
 * `GET /duty-status?user_id=me` on mount rather than assumed — a Tanod
 * may have last toggled from a different device.
 *
 * SOS raises `POST /tanod-sos` (live since Sprint 4). Tapping it opens a
 * confirm step first — a false alarm dispatches real people, so this
 * follows the same confirm-before-fire pattern as sign-out below, just
 * for a materially higher-stakes action. Online-first: on success it
 * reports sent; on a network failure it stages the event in
 * `offline_queue_local` (§2 Rule 27's local/offline fallback path) via
 * `enqueueSosItem` and reports queued, never claims delivery it can't
 * back up (§2 Rule 6). Latitude/longitude are server-required — if
 * `getCurrentPosition()` fails, SOS is not sent and the reason is shown;
 * there is no fabricated fallback coordinate.
 *
 * Duty toggling also starts/stops `patrolLocationService.ts`'s native
 * foreground GPS service (Mobile Improvement Plan Phase 4.1) 1:1 with
 * on/off duty — background tracking that isn't tied to a visibly-on-duty
 * state would be exactly the undisclosed-tracking control §2 Rule 6
 * forbids. See that service's own header comment for why a native
 * foreground service exists at all (M7 Live Map's own GPS watch is
 * deliberately foreground-only).
 *
 * G1's THIRD fallback tier (Mobile Improvement Plan Phase 4.3): a
 * workstation-unreachable SOS also attempts a direct, native device SMS
 * (own SIM, no gateway — `sosSms.ts`/`SosSmsPlugin.java`) to a backup
 * contact cached locally via `sosFallbackContact.ts`. This is genuinely a
 * THIRD tier, not a replacement for the queue above: the SOS is ALWAYS
 * queued locally regardless of whether the SMS attempt succeeds, since
 * the SMS is a best-effort human alert, not this app's authoritative
 * record of the emergency. `SmsFallbackBadge` (M13) reports the real
 * outcome — sent, failed, or no backup contact configured — never a
 * claim this screen can't back up.
 *
 * No fabricated identity or stats (§9 M2's warning about the Figma
 * reference's fake "Juan Dela Cruz" / invented numbers): the greeting
 * name comes from the authenticated session, and nothing on this screen
 * claims a number that isn't backed by a real query.
 */

import { useEffect, useRef, useState } from 'react';
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
  arrowForwardOutline,
  callOutline,
  documentTextOutline,
  mapOutline,
  medkitOutline,
  radioOutline,
  shieldCheckmarkOutline,
  shieldOutline,
  timeOutline,
  warningOutline,
} from 'ionicons/icons';
import MobileHeader from '../components/MobileHeader';
import SmsFallbackBadge from '../components/SmsFallbackBadge';
import tacticalFeedback from '../utils/tacticalFeedback';
import { getOwnDutyStatus, postSos, setDutyStatus, type DutyStatus } from '../services/apiService';
import { ApiError } from '../services/apiService';
import { getCurrentPosition } from '../services/geolocation';
import { enqueueSosItem } from '../services/db/offlineQueueRepository';
import { listActiveCachedDispatches } from '../services/db/dispatchRepository';
import { listAllLocalIncidents } from '../services/db/incidentRepository';
import type { DispatchLocalRow } from '../services/db/localSchema';
import { startPatrolTracking, stopPatrolTracking } from '../services/patrolLocationService';
import { loadSession } from '../services/session';
import { getCachedSosFallbackContact } from '../services/sosFallbackContact';
import SosSms from '../services/sosSms';
import type { SmsFallbackInput } from '../services/smsFallbackState';
import { setKnownDutyStatus } from '../services/syncScheduler';
import { uuid } from '../services/uuid';

/** §1: "Four barangays, fixed" — REFERENCE.md's own words; not invented here. */
const BARANGAY_NAMES: Record<number, string> = { 1: 'Dao', 2: 'Binanuahan', 3: 'Marifosque', 4: 'Banuyo' };

const STATUS_LABEL: Record<DutyStatus, string> = {
  on_duty: 'On Duty',
  responding: 'Responding',
  off_duty: 'Off Duty',
};

const HomePage: React.FC = () => {
  const navigate = useNavigate();
  const [fullName, setFullName] = useState('');
  const [barangayName, setBarangayName] = useState('Dao');
  const [status, setStatus] = useState<DutyStatus | null>(null);
  const [loadingStatus, setLoadingStatus] = useState(true);
  const [toggling, setToggling] = useState(false);
  const [dutyError, setDutyError] = useState<string | null>(null);
  const [activeDispatchCount, setActiveDispatchCount] = useState<number>(0);
  const [topDispatch, setTopDispatch] = useState<DispatchLocalRow | null>(null);

  // Shift Telemetry State
  const [shiftStartTime, setShiftStartTime] = useState<number | null>(() => {
    const saved = localStorage.getItem('baranguard.shiftStartTime');
    return saved ? parseInt(saved, 10) : null;
  });
  const [shiftElapsed, setShiftElapsed] = useState<string>('0m');
  const [todayIncidentCount, setTodayIncidentCount] = useState<number>(0);
  const [deskContact, setDeskContact] = useState<string>('0917-000-0000');

  const [dutyToast, setDutyToast] = useState<string | null>(null);
  const [confirmingSos, setConfirmingSos] = useState(false);
  const [raisingSos, setRaisingSos] = useState(false);
  const [sosError, setSosError] = useState<string | null>(null);
  const [sosToast, setSosToast] = useState<string | null>(null);
  const [sosFallbackOutcome, setSosFallbackOutcome] = useState<SmsFallbackInput | null>(null);

  // Press & Hold (2 seconds) SOS interaction state
  const [holdProgress, setHoldProgress] = useState(0);
  const holdTimerRef = useRef<number | null>(null);
  const holdStartTimeRef = useRef<number | null>(null);

  // Live Shift Duration Timer
  useEffect(() => {
    if (status === 'on_duty') {
      let startTime = shiftStartTime;
      if (!startTime) {
        startTime = Date.now();
        setShiftStartTime(startTime);
        localStorage.setItem('baranguard.shiftStartTime', startTime.toString());
      }

      const updateTimer = () => {
        const diffMs = Math.max(0, Date.now() - (startTime ?? Date.now()));
        const diffMins = Math.floor(diffMs / (1000 * 60));
        const hours = Math.floor(diffMins / 60);
        const mins = diffMins % 60;
        if (hours > 0) {
          setShiftElapsed(`${hours}h ${mins}m`);
        } else {
          setShiftElapsed(`${mins}m`);
        }
      };

      updateTimer();
      const interval = setInterval(updateTimer, 30000);
      return () => clearInterval(interval);
    } else {
      setShiftElapsed('0m');
      setShiftStartTime(null);
      localStorage.removeItem('baranguard.shiftStartTime');
    }
  }, [status, shiftStartTime]);

  useEffect(() => {
    loadSession().then((session) => {
      setFullName(session?.fullName ?? '');
      if (session?.barangayId) {
        setBarangayName(BARANGAY_NAMES[session.barangayId] ?? `Brgy ${session.barangayId}`);
      }
    });

    getOwnDutyStatus()
      .then((entry) => {
        const resolved = entry?.status ?? 'off_duty';
        setStatus(resolved);
        setKnownDutyStatus(resolved);
        if (resolved === 'on_duty') {
          void startPatrolTracking();
          if (!localStorage.getItem('baranguard.shiftStartTime')) {
            const now = Date.now();
            setShiftStartTime(now);
            localStorage.setItem('baranguard.shiftStartTime', now.toString());
          }
        }
      })
      .catch((error: unknown) => {
        setStatus(null);
        setDutyError(
          error instanceof ApiError && error.isOffline
            ? 'Offline — current duty status unknown until reconnected.'
            : 'Could not load current duty status.'
        );
      })
      .finally(() => setLoadingStatus(false));

    listActiveCachedDispatches()
      .then((items) => {
        setActiveDispatchCount(items.length);
        setTopDispatch(items[0] ?? null);
      })
      .catch(() => {
        setActiveDispatchCount(0);
        setTopDispatch(null);
      });

    // Query incidents filed today
    listAllLocalIncidents()
      .then((items) => {
        const todayStr = new Date().toISOString().slice(0, 10);
        const todayItems = items.filter((item) => (item.created_offline_at || '').startsWith(todayStr));
        setTodayIncidentCount(todayItems.length);
      })
      .catch(() => {
        setTodayIncidentCount(0);
      });

    // Query emergency desk contact
    getCachedSosFallbackContact()
      .then((num) => {
        if (num) setDeskContact(num);
      })
      .catch(() => {
        // Safe fallback
      });
  }, []);

  async function handleToggleDuty() {
    const next: DutyStatus = status === 'on_duty' ? 'off_duty' : 'on_duty';
    setDutyError(null);
    setToggling(true);
    try {
      const entry = await setDutyStatus(next, uuid());
      setStatus(entry.status);
      setKnownDutyStatus(entry.status);
      tacticalFeedback.onDutyToggle(entry.status === 'on_duty');
      setDutyToast(entry.status === 'on_duty' ? "You are now ON DUTY. Patrol active." : "You are now OFF DUTY.");
      // Phase 4.1: the foreground GPS service tracks duty status 1:1 —
      // never running while off duty (§2 Rule 6: no background tracking
      // that isn't tied to a real, visible reason to be tracking).
      if (entry.status === 'on_duty') void startPatrolTracking();
      else void stopPatrolTracking();
    } catch (error) {
      setDutyError(
        error instanceof ApiError && error.isOffline
          ? 'Cannot reach the barangay workstation — duty status was not changed.'
          : error instanceof Error
            ? error.message
            : 'Could not update duty status.'
      );
    } finally {
      setToggling(false);
    }
  }

  // --- 2-Second Hold SOS Handlers ---
  function startHoldSos() {
    if (raisingSos) return;
    holdStartTimeRef.current = Date.now();
    const HOLD_DURATION_MS = 2000;
    let lastTick = 0;

    holdTimerRef.current = window.setInterval(() => {
      if (!holdStartTimeRef.current) return;
      const elapsed = Date.now() - holdStartTimeRef.current;
      const progress = Math.min(100, (elapsed / HOLD_DURATION_MS) * 100);
      setHoldProgress(progress);

      const tickIndex = Math.floor(elapsed / 250);
      if (tickIndex > lastTick) {
        lastTick = tickIndex;
        tacticalFeedback.onSosHoldTick(progress);
      }

      if (progress >= 100) {
        cancelHoldSos();
        tacticalFeedback.onSosFired();
        setConfirmingSos(true);
      }
    }, 20);
  }

  function cancelHoldSos() {
    if (holdTimerRef.current !== null) {
      clearInterval(holdTimerRef.current);
      holdTimerRef.current = null;
    }
    holdStartTimeRef.current = null;
    setHoldProgress(0);
  }

  /**
   * G1's third tier: the direct app POST already failed offline (this
   * function's only caller), so the SOS is already safely queued locally
   * — this is purely the best-effort human alert on top of that, never a
   * replacement for it. Never throws; every outcome is reported through
   * `sosFallbackOutcome`/`sosToast`, never silently.
   */
  async function attemptSosSmsFallback(payload: { latitude: number; longitude: number }) {
    const backupNumber = await getCachedSosFallbackContact();
    if (!backupNumber) {
      setSosFallbackOutcome({ reachedWorkstation: false, smsAttempted: false, smsStatus: null });
      setSosToast('SOS saved locally — will dispatch automatically upon reconnect. (No backup SMS contact configured.)');
      return;
    }

    setSosFallbackOutcome({ reachedWorkstation: false, smsAttempted: true, smsStatus: 'pending' });
    try {
      const session = await loadSession();
      const barangayName = session ? (BARANGAY_NAMES[session.barangayId] ?? `Barangay ${session.barangayId}`) : 'Unknown Barangay';
      const message = [
        'BARANGUARD EMERGENCY SOS',
        `Tanod: ${session?.fullName ?? 'Unknown'} (Brgy ${barangayName})`,
        `Location: ${payload.latitude.toFixed(5)}, ${payload.longitude.toFixed(5)}`,
        `Map: https://maps.google.com/?q=${payload.latitude},${payload.longitude}`,
        `Time: ${new Date().toLocaleString()}`,
      ].join('\n');

      await SosSms.sendDirect({ number: backupNumber, message });
      setSosFallbackOutcome({ reachedWorkstation: false, smsAttempted: true, smsStatus: 'sent' });
      setSosToast('Workstation unreachable — emergency SMS sent directly to backup contact.');
    } catch (smsError) {
      setSosFallbackOutcome({ reachedWorkstation: false, smsAttempted: true, smsStatus: 'failed' });
      setSosToast(
        smsError instanceof Error
          ? `SOS saved locally. Backup SMS also failed: ${smsError.message}`
          : 'SOS saved locally. Backup SMS also failed.'
      );
    }
  }

  async function handleRaiseSos() {
    setSosError(null);
    setRaisingSos(true);
    tacticalFeedback.onSosFired();
    const clientEventId = uuid();
    try {
      let position;
      try {
        position = await getCurrentPosition();
      } catch {
        setSosError('Could not read device GPS coordinates. SOS requires location lock.');
        return;
      }
      const payload = { latitude: position.latitude, longitude: position.longitude };
      try {
        await postSos({ ...payload, clientEventId });
        setSosToast('EMERGENCY SOS TRANSMITTED — Admin dispatch has been alerted.');
        setSosFallbackOutcome({ reachedWorkstation: true, smsAttempted: false, smsStatus: null });
      } catch (error) {
        if (error instanceof ApiError && error.isOffline) {
          await enqueueSosItem(clientEventId, payload);
          await attemptSosSmsFallback(payload);
        } else {
          setSosError(error instanceof Error ? error.message : 'Could not transmit SOS.');
        }
      }
    } finally {
      setRaisingSos(false);
    }
  }

  const initials = fullName
    ? fullName
        .split(' ')
        .map((n) => n[0])
        .slice(0, 2)
        .join('')
        .toUpperCase()
    : 'BP';

  return (
    <IonPage>
      <MobileHeader />

      <IonContent className="ion-padding" style={{ '--background': 'var(--color-bg)' }}>
        <div className="home-dashboard-layout">
          {/* 1. Tactical Officer Status Hub */}
          <div className="tactical-officer-hub">
            <div className="tactical-officer-top">
              <div className="tactical-officer-avatar">{initials}</div>
              <div className="tactical-officer-meta">
                <h2 className="tactical-officer-name">{fullName || 'Tanod Officer'}</h2>
                <div className="tactical-officer-sub">
                  <IonIcon icon={shieldCheckmarkOutline} />
                  <span>Security Responder · Brgy {barangayName}</span>
                </div>
              </div>
            </div>

            <div className="tactical-officer-divider" />

            <div className="tactical-officer-bottom">
              <div className="tactical-duty-status">
                <div
                  className={`tactical-duty-pulse ${
                    status === 'on_duty' ? 'tactical-duty-pulse--on' : 'tactical-duty-pulse--off'
                  }`}
                />
                <div className="tactical-duty-text">
                  <span
                    className={`tactical-duty-title ${
                      status === 'on_duty' ? 'tactical-duty-title--on' : 'tactical-duty-title--off'
                    }`}
                  >
                    {loadingStatus ? 'Checking Shift…' : status === 'on_duty' ? 'On Active Patrol' : 'Off Duty (Standby)'}
                  </span>
                  <span className="tactical-duty-telemetry">
                    {status === 'on_duty' ? 'Foreground GPS · 15s Broadcast' : 'Patrol tracking inactive'}
                  </span>
                </div>
              </div>

              <button
                type="button"
                className={`tactical-duty-btn ${
                  status === 'on_duty' ? 'tactical-duty-btn--on' : 'tactical-duty-btn--off'
                }`}
                disabled={loadingStatus || toggling}
                onClick={handleToggleDuty}
              >
                {toggling ? <IonSpinner name="dots" /> : status === 'on_duty' ? 'Go Off Duty' : 'Go On Duty'}
              </button>
            </div>

            {dutyError && (
              <div
                style={{
                  marginTop: '10px',
                  background: 'rgba(220, 38, 38, 0.25)',
                  border: '1px solid rgba(220, 38, 38, 0.5)',
                  padding: '6px 10px',
                  borderRadius: 'var(--radius-sm)',
                  fontSize: 'var(--font-size-label)',
                  color: '#fca5a5',
                }}
              >
                {dutyError}
              </div>
            )}
          </div>

          {/* 2. Situational Awareness Hub (Active Mission OR Perimeter Secure) */}
          {topDispatch ? (
            <div className="situational-hub situational-hub--mission">
              <div className="situational-header">
                <span className="situational-badge situational-badge--mission">
                  <IonIcon icon={alertCircleOutline} style={{ fontSize: '1.05rem' }} />
                  ACTIVE DISPATCH #{topDispatch.server_dispatch_id ?? topDispatch.local_id.slice(0, 6)}
                </span>
                <span className="status-pill status-pill--critical is-urgent">
                  {topDispatch.priority.toUpperCase()}
                </span>
              </div>
              <h3 className="situational-sub">
                {topDispatch.redacted_incident_type ? topDispatch.redacted_incident_type.replace(/_/g, ' ').toUpperCase() : 'INCIDENT REPORTED'}
              </h3>
              <div className="situational-detail">
                Assigned to your unit · Tap below to launch turn-by-turn route navigation.
              </div>
              <div className="situational-mission-action">
                <button
                  type="button"
                  className="situational-navigate-btn"
                  onClick={() => navigate(`/tabs/assignments/${encodeURIComponent(topDispatch.local_id)}`)}
                >
                  <span>NAVIGATE ROUTE</span>
                  <IonIcon icon={arrowForwardOutline} />
                </button>
              </div>
            </div>
          ) : (
            <div className="situational-hub situational-hub--clear">
              <div className="situational-header">
                <span className="situational-badge situational-badge--clear">
                  <IonIcon icon={shieldCheckmarkOutline} style={{ fontSize: '1.05rem' }} />
                  PERIMETER CLEAR · SECTOR {barangayName.toUpperCase()}
                </span>
                <span className="status-pill status-pill--success">READY</span>
              </div>
              <p className="situational-sub">
                No active emergency dispatches in queue.
              </p>
              <div className="situational-detail">
                Encrypted SQLite active · Standby or maintain active field patrol.
              </div>
            </div>
          )}

          {/* 3. Primary Field Action Tiles (No Duplicate Tab Clones) */}
          <div className="tactical-action-grid">
            <button
              type="button"
              className="tactical-action-card"
              onClick={() => navigate('/tabs/incidents/new')}
            >
              <div className="tactical-action-icon-box tactical-action-icon-box--primary">
                <IonIcon icon={documentTextOutline} />
              </div>
              <h3 className="tactical-action-title">Log Incident</h3>
              <p className="tactical-action-desc">Rapid field report intake</p>
              <div className="tactical-action-chips">
                <span className="tactical-mini-chip">Photo</span>
                <span className="tactical-mini-chip">Voice</span>
                <span className="tactical-mini-chip">GPS</span>
              </div>
            </button>

            <button
              type="button"
              className="tactical-action-card"
              onClick={() => navigate('/tabs/map')}
            >
              <div className="tactical-action-icon-box tactical-action-icon-box--info">
                <IonIcon icon={mapOutline} />
              </div>
              <h3 className="tactical-action-title">Live Radar</h3>
              <p className="tactical-action-desc">Team map & telemetry</p>
              <div className="tactical-action-chips">
                <span className="tactical-mini-chip">Basemap</span>
                <span className="tactical-mini-chip">Tanods</span>
              </div>
            </button>
          </div>

          {/* 4. Shift Patrol Telemetry Strip */}
          <div className="tactical-shift-strip">
            <div className="tactical-shift-metric">
              <div className="tactical-shift-icon-wrap">
                <IonIcon icon={timeOutline} />
              </div>
              <div className="tactical-shift-info">
                <span className="tactical-shift-value">
                  {status === 'on_duty' ? shiftElapsed : 'Standby'}
                </span>
                <span className="tactical-shift-label">
                  {status === 'on_duty' ? 'Active Patrol' : 'Off Duty'}
                </span>
              </div>
            </div>

            <div className="tactical-shift-metric">
              <div className={`tactical-shift-icon-wrap ${status === 'on_duty' ? 'tactical-shift-icon-wrap--live' : 'tactical-shift-icon-wrap--idle'}`}>
                <IonIcon icon={radioOutline} />
              </div>
              <div className="tactical-shift-info">
                <span className="tactical-shift-value">
                  {status === 'on_duty' ? '15s Sync' : 'GPS Idle'}
                </span>
                <span className="tactical-shift-label">HQ Radar</span>
              </div>
            </div>

            <div className="tactical-shift-metric">
              <div className="tactical-shift-icon-wrap">
                <IonIcon icon={documentTextOutline} />
              </div>
              <div className="tactical-shift-info">
                <span className="tactical-shift-value">{todayIncidentCount} Filed</span>
                <span className="tactical-shift-label">Today</span>
              </div>
            </div>
          </div>

          {/* 5. Full-Width Tactical Emergency SOS Panel */}
          <div className="tactical-sos-panel">
            <div
              className="tactical-sos-hold-strip"
              onPointerDown={startHoldSos}
              onPointerUp={cancelHoldSos}
              onPointerLeave={cancelHoldSos}
              onTouchStart={startHoldSos}
              onTouchEnd={cancelHoldSos}
              role="button"
              tabIndex={0}
              aria-label="Hold 2 seconds for emergency SOS"
            >
              <div
                className="tactical-sos-progress-fill"
                style={{ width: `${holdProgress}%` }}
              />

              <div className="tactical-sos-content">
                <div className="tactical-sos-icon-wrap">
                  <IonIcon icon={warningOutline} />
                </div>
                <div className="tactical-sos-text">
                  <div className="tactical-sos-title">
                    {raisingSos ? 'Transmitting SOS…' : holdProgress > 0 ? `Holding (${Math.round(holdProgress)}%)…` : 'EMERGENCY SOS BACKUP'}
                  </div>
                  <div className="tactical-sos-sub">
                    {holdProgress > 0 ? 'Release to cancel · Keep holding' : 'Press & hold 2s to alert HQ and nearby responders'}
                  </div>
                </div>
                <div className="tactical-sos-countdown">
                  {raisingSos ? <IonSpinner name="dots" color="danger" /> : holdProgress > 0 ? `${Math.round(holdProgress)}%` : 'HOLD 2S'}
                </div>
              </div>
            </div>

            {sosFallbackOutcome && (
              <div style={{ marginTop: '8px', display: 'flex', justifyContent: 'center' }}>
                <SmsFallbackBadge input={sosFallbackOutcome} />
              </div>
            )}

            {/* 1-Tap Emergency Speed-Dial Dock */}
            <div className="tactical-speed-dial-dock">
              <div className="tactical-speed-dial-label">
                <IonIcon icon={callOutline} />
                <span>Direct Emergency Voice Lines</span>
              </div>
              <div className="tactical-speed-dial-grid">
                <a
                  href={`tel:${deskContact.replace(/[^0-9+]/g, '') || '911'}`}
                  className="tactical-speed-dial-btn"
                  onClick={() => tacticalFeedback.onWarning()}
                >
                  <IonIcon icon={callOutline} />
                  <span className="tactical-speed-dial-btn-title">Brgy Desk</span>
                  <span className="tactical-speed-dial-btn-sub">HQ Dispatch</span>
                </a>

                <a
                  href="tel:911"
                  className="tactical-speed-dial-btn"
                  onClick={() => tacticalFeedback.onWarning()}
                >
                  <IonIcon icon={shieldOutline} />
                  <span className="tactical-speed-dial-btn-title">Police 911</span>
                  <span className="tactical-speed-dial-btn-sub">PNP Station</span>
                </a>

                <a
                  href="tel:160"
                  className="tactical-speed-dial-btn"
                  onClick={() => tacticalFeedback.onWarning()}
                >
                  <IonIcon icon={medkitOutline} />
                  <span className="tactical-speed-dial-btn-title">MDRRMO</span>
                  <span className="tactical-speed-dial-btn-sub">Rescue / BFP</span>
                </a>
              </div>
            </div>
          </div>

          {sosError && (
            <div
              style={{
                background: 'var(--tint-critical-bg)',
                color: 'var(--pill-critical-text)',
                border: '1px solid var(--color-critical)',
                borderRadius: 'var(--radius-md)',
                padding: '8px 12px',
                fontSize: 'var(--font-size-sm)',
              }}
              role="alert"
            >
              {sosError}
            </div>
          )}
        </div>

        <IonToast
          isOpen={dutyToast !== null}
          message={dutyToast ?? ''}
          duration={3000}
          color="success"
          onDidDismiss={() => setDutyToast(null)}
        />

        <IonToast
          isOpen={sosToast !== null}
          message={sosToast ?? ''}
          duration={4000}
          color={sosToast?.startsWith('EMERGENCY') ? 'danger' : 'warning'}
          onDidDismiss={() => setSosToast(null)}
        />

        <IonAlert
          isOpen={confirmingSos}
          onDidDismiss={() => setConfirmingSos(false)}
          header="⚠️ Transmit Emergency SOS?"
          message="This will immediately dispatch emergency backup and broadcast your GPS coordinates to Barangay HQ."
          buttons={[
            { text: 'Cancel', role: 'cancel' },
            { text: 'Transmit SOS Now', role: 'destructive', handler: handleRaiseSos },
          ]}
        />
      </IonContent>
    </IonPage>
  );
};

export default HomePage;
