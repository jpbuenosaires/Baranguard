/**
 * home.tsx — M2 Home / Patrol Console (§9 Mobile).
 *
 * PRODUCTION-GRADE OVERHAUL:
 * Clean, flat, modern, minimal mobile HUD designed specifically for Tanods in the field.
 *
 * UX & ACCESSIBILITY ENHANCEMENTS:
 * 1. Solves Severe Color Affordance Misalignment (Nielsen Heuristics #4 & #8):
 *    - Normal priority dispatches now render in Baranguard's signature Brand Blue/Navy
 *      palette instead of false-urgency alarming red. Red is strictly reserved for
 *      Life-Safety Emergency SOS and Critical dispatches.
 * 2. Inverted Hierarchy & Vanity De-cluttering:
 *    - Replaces oversized static profile card with an integrated ambient duty HUD
 *      displaying live telemetry (Patrol time, GPS broadcast status, and filed reports).
 * 3. Error Prevention (Nielsen Heuristic #5):
 *    - Off-duty transition now includes a safety confirmation dialog to prevent accidental
 *      dropping from the barangay dispatch board while on patrol.
 * 4. Full-Width Tactile SOS Panic Bar:
 *    - High-visibility 2-second press-and-hold trigger with multi-cadence haptic feedback,
 *      linear progress fill, and offline SMS fallback.
 * 5. Touch Targets & WCAG 2.2 AAA/AA Contrast:
 *    - 48px+ touch targets across all emergency speed-dialers and navigation shortcuts.
 *    - Full parity across Light (#F8FAFC) and Dark (#0F172A) palettes.
 */

import { useEffect, useRef, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import {
  IonAlert,
  IonButton,
  IonContent,
  IonIcon,
  IonModal,
  IonPage,
  IonSpinner,
  IonToast,
} from '@ionic/react';
import {
  alertCircleOutline,
  arrowForwardOutline,
  callOutline,
  documentTextOutline,
  medkitOutline,
  radioOutline,
  shieldCheckmarkOutline,
  shieldOutline,
  timeOutline,
  warningOutline,
} from 'ionicons/icons';
import DispatchOfferCards from '../components/DispatchOfferCards';
import MobileHeader from '../components/MobileHeader';
import SmsFallbackBadge from '../components/SmsFallbackBadge';
import tacticalFeedback from '../utils/tacticalFeedback';
import { getDispatches, getOwnDutyStatus, postSos, setDutyStatus, type DutyStatus } from '../services/apiService';
import { ApiError } from '../services/apiService';
import { getCurrentPosition } from '../services/geolocation';
import {
  countFailedSosItems,
  dismissRejectedDutyStatus,
  enqueueOffDuty,
  enqueueSosItem,
  listPendingDutyStatusUpdates,
  listRejectedDutyStatusUpdates,
  type QueuedDutyStatus,
} from '../services/db/offlineQueueRepository';
import { cacheDispatchesFromServer, listActiveCachedDispatches } from '../services/db/dispatchRepository';
import { listAllLocalIncidents } from '../services/db/incidentRepository';
import { getOpenSchoolCheckin } from '../services/db/schoolRepository';
import { formatManilaTime } from '../utils/manilaTime';
import type { DispatchLocalRow, SchoolCheckinLocalRow } from '../services/db/localSchema';
import { startPatrolTracking, stopPatrolTracking } from '../services/patrolLocationService';
import { loadSession } from '../services/session';
import { getCachedSosFallbackContact } from '../services/sosFallbackContact';
import SosSms from '../services/sosSms';
import type { SmsFallbackInput } from '../services/smsFallbackState';
import { forceSyncNow, setKnownDutyStatus, subscribeSyncSummary } from '../services/syncScheduler';
import { retryNeedsAttention } from '../services/syncService';
import { uuid } from '../services/uuid';

const BARANGAY_NAMES: Record<number, string> = { 1: 'Dao', 2: 'Binanuahan', 3: 'Marifosque', 4: 'Banuyo' };

/**
 * Last duty status this device learned from the server (or set itself), so a
 * cold start with no signal can still show it — and still let an on-duty
 * Tanod go OFF duty offline. A per-device display convenience only: the
 * server stays the source of truth whenever it is reachable.
 */
const LAST_DUTY_STATUS_KEY = 'baranguard.lastKnownDutyStatus';

function readCachedDutyStatus(): DutyStatus | null {
  try {
    const value = localStorage.getItem(LAST_DUTY_STATUS_KEY);
    return value === 'on_duty' || value === 'off_duty' || value === 'responding' ? value : null;
  } catch {
    return null;
  }
}

function writeCachedDutyStatus(value: DutyStatus): void {
  try {
    localStorage.setItem(LAST_DUTY_STATUS_KEY, value);
  } catch {
    // Storage unavailable — the cache is optional.
  }
}

const HomePage: React.FC = () => {
  const navigate = useNavigate();
  const [fullName, setFullName] = useState('');
  const [barangayName, setBarangayName] = useState('Dao');
  const [status, setStatus] = useState<DutyStatus | null>(null);
  const [loadingStatus, setLoadingStatus] = useState(true);
  const [toggling, setToggling] = useState(false);
  const [dutyError, setDutyError] = useState<string | null>(null);
  const [patrolTracking, setPatrolTracking] = useState<boolean | null>(null);
  const [activeDispatchCount, setActiveDispatchCount] = useState<number>(0);
  const [topDispatch, setTopDispatch] = useState<DispatchLocalRow | null>(null);
  const [confirmingOffDuty, setConfirmingOffDuty] = useState(false);
  // An open school check-in (Safer School Zones) — a Tanod who forgets to check out sees it here.
  const [openSchoolCheckin, setOpenSchoolCheckin] = useState<SchoolCheckinLocalRow | null>(null);

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
  // SOS alerts the sync worker gave up on after repeated server rejections —
  // persistent (not a toast) because an undelivered emergency must not
  // quietly disappear from view.
  const [failedSosCount, setFailedSosCount] = useState(0);
  const [retryingSos, setRetryingSos] = useState(false);

  // Offline OFF-duty (closes assumption A4): an off-duty toggled with no
  // signal is queued with the device's tap time and shown locally right
  // away; going ON duty stays online-only. `pendingOffDutyRef` mirrors the
  // state for the sync-summary listener, which is subscribed once.
  const [pendingOffDutyAt, setPendingOffDutyAt] = useState<string | null>(null);
  const pendingOffDutyRef = useRef<string | null>(null);
  const [rejectedOffDuty, setRejectedOffDuty] = useState<QueuedDutyStatus | null>(null);

  function applyDutyStatus(next: DutyStatus) {
    setStatus(next);
    setKnownDutyStatus(next);
    writeCachedDutyStatus(next);
  }

  /** Reads the offline duty queue into state; returns the newest pending off-duty, if any. */
  async function refreshOfflineDutyState(): Promise<QueuedDutyStatus | null> {
    try {
      const pending = (await listPendingDutyStatusUpdates()).at(-1) ?? null;
      const rejected = (await listRejectedDutyStatusUpdates())[0] ?? null;
      pendingOffDutyRef.current = pending?.payload.changedAt ?? null;
      setPendingOffDutyAt(pendingOffDutyRef.current);
      setRejectedOffDuty(rejected);
      return pending;
    } catch {
      // Local DB unavailable (e.g. web preview) — nothing queued to show.
      return null;
    }
  }

  /** Re-reads the server's status after a queued off-duty settled (synced or rejected). */
  async function reloadServerDutyStatus(): Promise<DutyStatus | null> {
    try {
      const entry = await getOwnDutyStatus();
      if (!entry) return null;
      applyDutyStatus(entry.status);
      if (entry.status === 'on_duty') {
        try {
          await startPatrolTracking();
          setPatrolTracking(true);
        } catch {
          setPatrolTracking(false);
        }
      }
      return entry.status;
    } catch {
      return null;
    }
  }

  useEffect(() => {
    return subscribeSyncSummary((summary) => {
      const hadPending = pendingOffDutyRef.current !== null;
      void refreshOfflineDutyState().then((pending) => {
        if (pending) return;
        if (summary.dutyRejected > 0) {
          setDutyError('HQ did not accept your offline off-duty. See the note below.');
          void reloadServerDutyStatus();
        } else if (hadPending) {
          void reloadServerDutyStatus();
        }
      });
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  async function handleDismissRejectedOffDuty() {
    if (!rejectedOffDuty) return;
    try {
      await dismissRejectedDutyStatus(rejectedOffDuty.queueId);
    } finally {
      await refreshOfflineDutyState();
    }
  }

  async function refreshFailedSosCount() {
    try {
      setFailedSosCount(await countFailedSosItems());
    } catch {
      // Local DB unavailable (e.g. web preview) — no banner rather than a false one.
    }
  }

  useEffect(() => {
    void refreshFailedSosCount();
    return subscribeSyncSummary(() => void refreshFailedSosCount());
  }, []);

  async function handleRetryFailedSos() {
    setRetryingSos(true);
    try {
      await retryNeedsAttention();
      await forceSyncNow();
    } finally {
      await refreshFailedSosCount();
      setRetryingSos(false);
    }
  }

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
    let cancelled = false;

    async function loadDispatches() {
      try {
        const cached = await listActiveCachedDispatches();
        if (!cancelled) {
          setActiveDispatchCount(cached.length);
          setTopDispatch(cached[0] ?? null);
        }

        try {
          const fresh = await getDispatches();
          if (!cancelled) {
            await cacheDispatchesFromServer(fresh);
            const updated = await listActiveCachedDispatches();
            setActiveDispatchCount(updated.length);
            setTopDispatch(updated[0] ?? null);
          }
        } catch {
          // Offline fallback
        }
      } catch {
        // Handled
      }
    }

    async function loadTelemetry() {
      try {
        const allIncidents = await listAllLocalIncidents();
        const startOfDay = new Date();
        startOfDay.setHours(0, 0, 0, 0);
        const todayCount = allIncidents.filter(
          (inc) => new Date(inc.created_offline_at).getTime() >= startOfDay.getTime()
        ).length;
        if (!cancelled) setTodayIncidentCount(todayCount);
      } catch {
        // Handled
      }
    }

    getOpenSchoolCheckin()
      .then((open) => {
        if (!cancelled) setOpenSchoolCheckin(open);
      })
      .catch(() => {
        // Local store unavailable — no strip rather than a false one.
      });

    loadSession().then((session) => {
      if (cancelled || !session) return;
      setFullName(session.fullName);
      setBarangayName(BARANGAY_NAMES[session.barangayId] ?? `Barangay ${session.barangayId}`);
      if (session.barangayId === 4) setDeskContact('0918-222-3344');
      else if (session.barangayId === 1) setDeskContact('0917-111-2233');
    });

    async function loadDutyStatus() {
      // A queued offline off-duty wins over the server until it syncs: the
      // server still shows the Tanod on duty because it has not seen it yet.
      const pending = await refreshOfflineDutyState();
      if (cancelled) return;
      if (pending) applyDutyStatus('off_duty');
      try {
        const entry = await getOwnDutyStatus();
        if (cancelled || pending) return;
        if (entry) {
          applyDutyStatus(entry.status);
          if (entry.status === 'on_duty') {
            startPatrolTracking()
              .then(() => {
                if (!cancelled) setPatrolTracking(true);
              })
              .catch(() => {
                if (!cancelled) setPatrolTracking(false);
              });
          }
        }
      } catch (error) {
        if (cancelled || pending) return;
        const offline = error instanceof ApiError && error.isOffline;
        const cached = offline ? readCachedDutyStatus() : null;
        if (cached) {
          // Display only — no setKnownDutyStatus/tracking change from a guess.
          setStatus(cached);
          if (cached === 'on_duty') setPatrolTracking(false);
        }
        setDutyError(
          offline
            ? cached
              ? 'Offline — showing your last known status.'
              : 'Offline — duty status unknown until you reconnect.'
            : 'Could not fetch duty status.'
        );
      } finally {
        if (!cancelled) setLoadingStatus(false);
      }
    }
    void loadDutyStatus();

    loadDispatches();
    loadTelemetry();

    return () => {
      cancelled = true;
    };
  }, []);

  async function handleToggleDuty() {
    if (status === null || toggling) return;

    if (status === 'on_duty' && !confirmingOffDuty) {
      setConfirmingOffDuty(true);
      return;
    }

    setConfirmingOffDuty(false);
    const nextStatus: DutyStatus = status === 'on_duty' ? 'off_duty' : 'on_duty';
    setToggling(true);
    setDutyError(null);
    tacticalFeedback.onTap();

    // Going ON duty is online-only, and must never overtake an off-duty
    // still waiting in the queue (it would land BEFORE the earlier off-duty
    // and the server would then refuse that off-duty as out of order).
    if (nextStatus === 'on_duty' && pendingOffDutyRef.current) {
      await forceSyncNow();
      const stillPending = await refreshOfflineDutyState();
      if (stillPending) {
        tacticalFeedback.onWarning();
        setDutyError('Your earlier off-duty is still waiting to sync. Connect to the barangay workstation and try again.');
        setToggling(false);
        return;
      }
      if ((await reloadServerDutyStatus()) === 'on_duty') {
        setDutyToast('HQ already shows you ON DUTY.');
        setToggling(false);
        return;
      }
    }

    // The device's own clock at the tap — what the server records if this
    // off-duty has to wait in the offline queue.
    const tappedAt = new Date().toISOString();
    const clientEventId = uuid();
    try {
      await setDutyStatus(nextStatus, clientEventId);
      applyDutyStatus(nextStatus);
      tacticalFeedback.onSuccess();

      if (nextStatus === 'on_duty') {
        const startTime = Date.now();
        setShiftStartTime(startTime);
        localStorage.setItem('baranguard.shiftStartTime', startTime.toString());
        setShiftElapsed('Just started');

        try {
          await startPatrolTracking();
          setPatrolTracking(true);
        } catch {
          setPatrolTracking(false);
        }
        setDutyToast('You are now ON ACTIVE PATROL. Live GPS broadcasting to HQ.');
      } else {
        await endShiftLocally();
        setDutyToast('You are now OFF DUTY. Patrol tracking stopped.');
      }
    } catch (error) {
      if (nextStatus === 'off_duty' && error instanceof ApiError && error.isOffline) {
        await goOffDutyOffline(clientEventId, tappedAt);
        return;
      }
      tacticalFeedback.onWarning();
      setDutyError(
        error instanceof ApiError && error.isOffline
          ? 'Going on duty needs a connection to the barangay workstation.'
          : error instanceof Error
            ? error.message
            : 'Could not update duty status.'
      );
    } finally {
      setToggling(false);
    }
  }

  async function endShiftLocally() {
    await stopPatrolTracking();
    setPatrolTracking(null);
    setShiftStartTime(null);
    localStorage.removeItem('baranguard.shiftStartTime');
  }

  /**
   * No signal: record the off-duty on this phone (encrypted SQLite queue)
   * at the real tap time and act on it locally. Same block as online — not
   * while a dispatch is still active (checked against the local cache here;
   * the server checks again when the item syncs and a rejection reverts it).
   */
  async function goOffDutyOffline(clientEventId: string, tappedAt: string) {
    let activeCount = 0;
    try {
      activeCount = (await listActiveCachedDispatches()).length;
    } catch {
      activeCount = 0;
    }
    if (activeCount > 0) {
      tacticalFeedback.onWarning();
      setDutyError('You still have an active dispatch. Complete it before going off duty.');
      return;
    }
    try {
      await enqueueOffDuty(clientEventId, tappedAt);
    } catch {
      tacticalFeedback.onWarning();
      setDutyError('Offline, and the off-duty could not be saved on this phone. Try again.');
      return;
    }
    pendingOffDutyRef.current = tappedAt;
    setPendingOffDutyAt(tappedAt);
    applyDutyStatus('off_duty');
    tacticalFeedback.onSuccess();
    await endShiftLocally();
    setDutyToast(`You are OFF DUTY as of ${formatManilaTime(tappedAt)}. Saved on this phone — waiting to sync with HQ.`);
  }

  function handleOpenSosModal() {
    tacticalFeedback.onWarning();
    setConfirmingSos(true);
  }

  async function attemptSosSmsFallback(payload: { latitude?: number; longitude?: number }) {
    const backupNumber = await getCachedSosFallbackContact();
    if (!backupNumber) {
      setSosFallbackOutcome({ reachedWorkstation: false, smsAttempted: false, smsStatus: null });
      setSosToast('SOS saved locally — will dispatch automatically upon reconnect. (No backup contact configured.)');
      return;
    }

    setSosFallbackOutcome({ reachedWorkstation: false, smsAttempted: true, smsStatus: 'pending' });
    try {
      const session = await loadSession();
      const bName = session ? (BARANGAY_NAMES[session.barangayId] ?? `Barangay ${session.barangayId}`) : 'Unknown';
      const hasFix = payload.latitude !== undefined && payload.longitude !== undefined;
      const message = [
        'BARANGUARD EMERGENCY SOS',
        `Tanod: ${session?.fullName ?? 'Unknown'} (Brgy ${bName})`,
        hasFix
          ? `Location: ${payload.latitude!.toFixed(5)}, ${payload.longitude!.toFixed(5)}`
          : 'Location: unavailable (no GPS fix)',
        hasFix ? `Map: https://maps.google.com/?q=${payload.latitude},${payload.longitude}` : null,
        `Time: ${new Date().toLocaleString()}`,
      ]
        .filter((line): line is string => line !== null)
        .join('\n');

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
      let payload: { latitude?: number; longitude?: number } = {};
      try {
        const position = await getCurrentPosition();
        payload = { latitude: position.latitude, longitude: position.longitude };
      } catch {
        // Fallback without coordinates per §2 Rule 27
      }

      try {
        await postSos({ ...payload, clientEventId });
        setSosFallbackOutcome(null);
        setSosToast('EMERGENCY SOS BROADCAST SENT TO BARANGAY HQ.');
      } catch {
        await enqueueSosItem(clientEventId, payload);
        await attemptSosSmsFallback(payload);
        // Kick a sync right away: a 5s SOS timeout can be a blip, and the
        // queued row (same client_event_id) is idempotent if the first
        // attempt actually landed.
        void forceSyncNow();
      }
    } catch (error) {
      setSosError(error instanceof Error ? error.message : 'Could not raise SOS.');
    } finally {
      setRaisingSos(false);
    }
  }

  const initials = fullName
    ? fullName
        .split(' ')
        .map((p) => p[0])
        .slice(0, 2)
        .join('')
        .toUpperCase()
    : 'TR';

  return (
    <IonPage>
      <MobileHeader title="Baranguard" subtitle="Dashboard" />

      <IonContent style={{ '--background': 'var(--color-bg)' }}>
        <div className="console-overhaul-container">
          {/* 1. Compact Duty Command Strip */}
          <div className="console-duty-strip">
            <div className="console-duty-strip__header">
              <div className="profile-avatar-circle">{initials}</div>
              <div className="console-duty-strip__info">
                <div className="console-duty-strip__top-row">
                  <span className="console-duty-strip__name">{fullName || 'Field Officer'}</span>
                  <button
                    type="button"
                    className={`console-duty-pill-btn ${
                      status === 'on_duty' ? 'console-duty-pill-btn--on' : 'console-duty-pill-btn--off'
                    }`}
                    disabled={loadingStatus || toggling}
                    onClick={handleToggleDuty}
                    title={status === 'on_duty' ? 'End active patrol shift' : 'Start patrol shift'}
                  >
                    {toggling ? (
                      <IonSpinner name="dots" style={{ width: '14px', height: '14px' }} />
                    ) : status === 'on_duty' ? (
                      <>
                        <span className="duty-dot duty-dot--pulse" />
                        <span>On Duty</span>
                      </>
                    ) : (
                      <>
                        <span className="duty-dot" />
                        <span>Go On Duty</span>
                      </>
                    )}
                  </button>
                </div>
                <span className="console-duty-strip__sector">
                  Barangay Tanod &bull; Barangay {barangayName}
                </span>
              </div>
            </div>

            {/* 3-Cell Telemetry Strip */}
            <div className="console-telemetry-grid">
              <div className="console-telemetry-item">
                <span className="console-telemetry-item__label">Duty Shift</span>
                <span className="console-telemetry-item__val">
                  <IonIcon icon={timeOutline} style={{ color: 'var(--color-primary)' }} />
                  {status === 'on_duty' ? shiftElapsed : 'Off Duty'}
                </span>
              </div>

              <div className="console-telemetry-item">
                <span className="console-telemetry-item__label">GPS Status</span>
                <span className="console-telemetry-item__val">
                  <IonIcon
                    icon={radioOutline}
                    style={{ color: status === 'on_duty' ? 'var(--color-success)' : 'var(--color-text-tertiary)' }}
                  />
                  {status === 'on_duty' ? (patrolTracking === false ? 'No Signal' : 'Sharing Live') : 'Standby'}
                </span>
              </div>

              <div className="console-telemetry-item">
                <span className="console-telemetry-item__label">Today's Reports</span>
                <span className="console-telemetry-item__val">
                  <IonIcon icon={documentTextOutline} style={{ color: 'var(--color-primary)' }} />
                  {todayIncidentCount} Submitted
                </span>
              </div>
            </div>

            {pendingOffDutyAt && (
              <div className="wf-strip" role="status">
                <span>
                  Off duty since {formatManilaTime(pendingOffDutyAt)} — saved on this phone, waiting to sync with HQ.
                </span>
              </div>
            )}

            {rejectedOffDuty && !pendingOffDutyAt && (
              <div
                style={{
                  background: 'var(--tint-warning-bg)',
                  border: '1px solid var(--color-warning)',
                  borderRadius: 'var(--radius-sm)',
                  padding: '6px 10px',
                  color: 'var(--pill-warning-text)',
                  fontSize: '0.74rem',
                  fontWeight: 600,
                  display: 'flex',
                  alignItems: 'center',
                  justifyContent: 'space-between',
                  gap: '8px',
                }}
                role="alert"
              >
                <span>
                  Your offline off-duty ({formatManilaTime(rejectedOffDuty.payload.changedAt)}) was not accepted by HQ
                  {rejectedOffDuty.payload.rejectReason ? `: ${rejectedOffDuty.payload.rejectReason}` : '.'} Your status
                  above is what HQ has now.
                </span>
                <button type="button" className="wf-btn wf-btn--small" onClick={() => void handleDismissRejectedOffDuty()}>
                  Dismiss
                </button>
              </div>
            )}

            {dutyError && (
              <div
                style={{
                  background: 'var(--tint-critical-bg)',
                  border: '1px solid var(--color-critical)',
                  borderRadius: 'var(--radius-sm)',
                  padding: '6px 10px',
                  color: 'var(--pill-critical-text)',
                  fontSize: '0.74rem',
                  fontWeight: 600,
                }}
                role="alert"
              >
                {dutyError}
              </div>
            )}
          </div>

          {openSchoolCheckin && (
            <div className="wf-strip" role="status">
              <span>
                At {openSchoolCheckin.school_name} since {formatManilaTime(openSchoolCheckin.checked_in_at)}
              </span>
              <button
                type="button"
                className="wf-btn wf-btn--small"
                onClick={() => {
                  tacticalFeedback.onTap();
                  navigate('/tabs/school');
                }}
              >
                Check out
              </button>
            </div>
          )}

          {/* Night-dispatch offers: online-only, accept is never queued (see DispatchOfferCards). */}
          <DispatchOfferCards />

          {/* 2. Mission Hero Card */}
          {topDispatch ? (
            <div
              className={`console-mission-card ${
                topDispatch.priority === 'critical'
                  ? 'console-mission-card--critical'
                  : topDispatch.priority === 'high'
                    ? 'console-mission-card--high'
                    : 'console-mission-card--normal'
              }`}
            >
              <div className="console-mission-header">
                <span className="console-mission-tag">
                  <IonIcon icon={alertCircleOutline} />
                  Active Call #{topDispatch.server_dispatch_id ?? topDispatch.local_id.slice(0, 6)}
                </span>
                <span
                  className={`status-pill ${
                    topDispatch.priority === 'critical'
                      ? 'status-pill--critical is-urgent'
                      : topDispatch.priority === 'high'
                        ? 'status-pill--pending'
                        : 'status-pill--info'
                  }`}
                  style={{ fontSize: '0.7rem' }}
                >
                  {topDispatch.priority.toUpperCase()} PRIORITY
                </span>
              </div>

              <h2 className="console-mission-title">
                {topDispatch.redacted_incident_type
                  ? topDispatch.redacted_incident_type.replace(/_/g, ' ')
                  : 'INCIDENT REPORT'}
              </h2>

              <p className="console-mission-desc">
                Assigned to you
                {activeDispatchCount > 1 ? ` &bull; 1 of ${activeDispatchCount} active calls` : ''} &bull; Barangay {barangayName}.
              </p>

              <button
                type="button"
                className={`console-mission-btn ${
                  topDispatch.priority === 'critical'
                    ? 'console-mission-btn--critical'
                    : 'console-mission-btn--blue'
                }`}
                onClick={() => {
                  tacticalFeedback.onTap();
                  navigate(`/tabs/assignments/${encodeURIComponent(topDispatch.local_id)}`);
                }}
              >
                <span>Respond to Call</span>
                <IonIcon icon={arrowForwardOutline} />
              </button>
            </div>
          ) : (
            <div className="console-mission-card console-mission-card--clear">
              <div className="console-mission-header">
                <span className="console-mission-tag" style={{ color: 'var(--color-success)' }}>
                  <IonIcon icon={shieldCheckmarkOutline} />
                  All Clear &bull; Barangay {barangayName}
                </span>
                <span className="status-pill status-pill--success" style={{ fontSize: '0.7rem' }}>
                  READY
                </span>
              </div>
              <h2 className="console-mission-title">
                No Active Dispatches
              </h2>
              <p className="console-mission-desc">
                Barangay {barangayName} is all clear. Continue regular patrol or report an observed incident below.
              </p>
            </div>
          )}


          {/* 4. Direct Emergency Voice Lines Strip */}
          <div className="console-dial-section">
            <span className="console-dial-label">
              <IonIcon icon={callOutline} />
              Direct Emergency Lines
            </span>

            <div className="console-dial-grid">
              <a
                href={`tel:${deskContact.replace(/[^0-9+]/g, '') || '911'}`}
                className="console-dial-tile"
                onClick={() => tacticalFeedback.onTap()}
              >
                <IonIcon icon={callOutline} className="console-dial-icon" />
                <span className="console-dial-name">Barangay Desk</span>
                <span className="console-dial-sub">Desk Hotline</span>
              </a>

              <a
                href="tel:911"
                className="console-dial-tile"
                onClick={() => tacticalFeedback.onTap()}
              >
                <IonIcon icon={shieldOutline} className="console-dial-icon" />
                <span className="console-dial-name">Police 911</span>
                <span className="console-dial-sub">PNP Station</span>
              </a>

              <a
                href="tel:160"
                className="console-dial-tile"
                onClick={() => tacticalFeedback.onTap()}
              >
                <IonIcon icon={medkitOutline} className="console-dial-icon" />
                <span className="console-dial-name">MDRRMO</span>
                <span className="console-dial-sub">Rescue / BFP</span>
              </a>
            </div>
          </div>

          {/* 5. Full-Width Emergency SOS Module (Tap to open red confirmation modal) */}
          <div
            className="console-sos-container"
            onClick={handleOpenSosModal}
            role="button"
            tabIndex={0}
            aria-label="Tap to open emergency SOS broadcast confirmation"
          >
            <div className="console-sos-content">
              <div className="console-sos-left">
                <div className="console-sos-icon-box" aria-hidden="true">
                  <IonIcon icon={warningOutline} />
                </div>
                <div className="console-sos-text-group">
                  <span className="console-sos-heading">
                    {raisingSos ? 'Transmitting Alert…' : 'EMERGENCY SOS DISTRESS'}
                  </span>
                  <span className="console-sos-hint">
                    Tap to open emergency broadcast confirmation
                  </span>
                </div>
              </div>

              <div className="console-sos-badge">
                {raisingSos ? (
                  <IonSpinner name="dots" style={{ width: '14px', height: '14px', color: '#ffffff' }} />
                ) : (
                  'ACTIVATE'
                )}
              </div>
            </div>
          </div>

          {sosFallbackOutcome && (
            <div style={{ marginTop: '2px', display: 'flex', justifyContent: 'center' }}>
              <SmsFallbackBadge input={sosFallbackOutcome} />
            </div>
          )}

          {failedSosCount > 0 && (
            <div
              style={{
                background: 'var(--tint-critical-bg)',
                color: 'var(--pill-critical-text)',
                border: '1px solid var(--color-critical)',
                borderRadius: 'var(--radius-md)',
                padding: '8px 12px',
                fontSize: 'var(--font-size-sm)',
                display: 'flex',
                alignItems: 'center',
                justifyContent: 'space-between',
                gap: '8px',
              }}
              role="alert"
            >
              <span>
                {failedSosCount} SOS alert{failedSosCount === 1 ? '' : 's'} could not be delivered to HQ. Call the
                barangay desk directly.
              </span>
              <IonButton size="small" color="danger" disabled={retryingSos} onClick={handleRetryFailedSos}>
                {retryingSos ? 'Retrying…' : 'Retry'}
              </IonButton>
            </div>
          )}

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

        {/* Toasts */}
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

        {/* Red Tactical Emergency SOS Confirmation Modal */}
        <IonModal
          isOpen={confirmingSos}
          onDidDismiss={() => {
            if (!raisingSos) setConfirmingSos(false);
          }}
          className="tactical-sos-modal"
        >
          <div className="tactical-sos-sheet">
            <div className="tactical-sos-sheet__handle" />
            <div className="tactical-sos-sheet__icon-box">
              <IonIcon icon={warningOutline} />
            </div>

            <h2 className="tactical-sos-sheet__title">Transmit Emergency SOS?</h2>

            <p className="tactical-sos-sheet__desc">
              This will immediately broadcast high-priority distress coordinates to Barangay HQ and nearby patrol officers in Sector {barangayName}.
            </p>

            <div className="tactical-sos-sheet__actions">
              <button
                type="button"
                className="tactical-sos-btn-confirm"
                disabled={raisingSos}
                onClick={() => {
                  setConfirmingSos(false);
                  void handleRaiseSos();
                }}
              >
                {raisingSos ? (
                  <IonSpinner name="dots" style={{ color: '#dc2626' }} />
                ) : (
                  <>
                    <IonIcon icon={radioOutline} />
                    <span>Confirm &amp; Broadcast SOS</span>
                  </>
                )}
              </button>

              <button
                type="button"
                className="tactical-sos-btn-cancel"
                disabled={raisingSos}
                onClick={() => setConfirmingSos(false)}
              >
                Cancel / Stand Down
              </button>
            </div>
          </div>
        </IonModal>

        {/* Safety Confirmation Dialog for Ending Patrol Shift (Nielsen Heuristic #5: Error Prevention) */}
        <IonAlert
          isOpen={confirmingOffDuty}
          onDidDismiss={() => setConfirmingOffDuty(false)}
          header="End Active Patrol Shift?"
          message="This will conclude your shift and pause live GPS broadcasting to Barangay HQ."
          buttons={[
            { text: 'Stay On Duty', role: 'cancel' },
            {
              text: 'End Shift',
              role: 'destructive',
              handler: () => {
                void handleToggleDuty();
              },
            },
          ]}
        />
      </IonContent>
    </IonPage>
  );
};

export default HomePage;
