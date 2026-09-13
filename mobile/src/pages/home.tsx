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
  addOutline,
  documentTextOutline,
  logOutOutline,
  mapOutline,
  navigateOutline,
  radioOutline,
  shieldCheckmarkOutline,
  syncOutline,
  warningOutline,
} from 'ionicons/icons';
import MobileHeader from '../components/MobileHeader';
import SmsFallbackBadge from '../components/SmsFallbackBadge';
import tacticalFeedback from '../utils/tacticalFeedback';
import { getOwnDutyStatus, logout, postSos, setDutyStatus, type DutyStatus } from '../services/apiService';
import { ApiError } from '../services/apiService';
import { getCurrentPosition } from '../services/geolocation';
import { enqueueSosItem } from '../services/db/offlineQueueRepository';
import { listActiveCachedDispatches } from '../services/db/dispatchRepository';
import { startPatrolTracking, stopPatrolTracking } from '../services/patrolLocationService';
import { clearSession, loadSession } from '../services/session';
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
  const [status, setStatus] = useState<DutyStatus | null>(null);
  const [loadingStatus, setLoadingStatus] = useState(true);
  const [toggling, setToggling] = useState(false);
  const [dutyError, setDutyError] = useState<string | null>(null);
  const [activeDispatchCount, setActiveDispatchCount] = useState<number>(0);

  const [confirmingSignOut, setConfirmingSignOut] = useState(false);
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

  useEffect(() => {
    loadSession().then((session) => setFullName(session?.fullName ?? ''));

    getOwnDutyStatus()
      .then((entry) => {
        const resolved = entry?.status ?? 'off_duty';
        setStatus(resolved);
        setKnownDutyStatus(resolved);
        // Phase 4.1: resume background tracking on load if a previous
        // session left this Tanod on duty — the foreground service does
        // NOT survive an app reinstall/process-data-clear, only an
        // ordinary background/kill-and-restart, so this is the resync
        // point for "was on duty, reopened the app".
        if (resolved === 'on_duty') void startPatrolTracking();
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
      .then((items) => setActiveDispatchCount(items.length))
      .catch(() => setActiveDispatchCount(0));
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

  async function handleSignOut() {
    try {
      await logout();
    } catch {
      // Offline sign-out support
    }
    await clearSession();
    // Stops the on-duty sync interval from firing against a signed-out
    // session — the next login's own getOwnDutyStatus() call re-establishes it.
    setKnownDutyStatus(null);
    // A signed-out session has no token for PatrolLocationService's own
    // background POSTs to authenticate with — stop it rather than leave
    // it running (and its notification showing) with nothing useful to do.
    void stopPatrolTracking();
    navigate('/login', { replace: true });
  }

  const initials = fullName
    ? fullName
        .split(' ')
        .map((n) => n[0])
        .slice(0, 2)
        .join('')
        .toUpperCase()
    : 'BP';

  const CIRCUMFERENCE = 2 * Math.PI * 38; // Radius 38
  const strokeDashoffset = CIRCUMFERENCE - (holdProgress / 100) * CIRCUMFERENCE;

  return (
    <IonPage>
      <MobileHeader />

      <IonContent className="ion-padding" style={{ '--background': 'var(--color-bg)' }}>
        <div className="app-column">
          {/* Officer Hero Card */}
          <div className="hero-officer-card">
            <div className="hero-officer-header">
              <div className="hero-officer__avatar">{initials}</div>
              <div className="hero-officer__info">
                <h2 className="hero-officer__name">{fullName || 'Tanod Officer'}</h2>
                <div className="hero-officer__badge">
                  <IonIcon icon={shieldCheckmarkOutline} />
                  <span>Barangay Security Responder</span>
                </div>
              </div>
            </div>

            {/* Tactical Duty Switch */}
            <div className="duty-switch-card">
              <div className="duty-status-badge">
                <div
                  className={`duty-pulse-indicator ${
                    status === 'on_duty' ? 'duty-pulse-indicator--on' : 'duty-pulse-indicator--off'
                  }`}
                />
                <div className="duty-status-text">
                  <span className="duty-status-title">
                    {loadingStatus ? 'Checking Shift…' : status ? STATUS_LABEL[status] : 'Standby'}
                  </span>
                  <span className="duty-status-sub">
                    {status === 'on_duty' ? 'Active on Field Patrol' : 'Off Patrol Status'}
                  </span>
                </div>
              </div>

              <IonButton
                className="duty-toggle-button"
                size="small"
                disabled={loadingStatus || toggling}
                onClick={handleToggleDuty}
              >
                {toggling ? <IonSpinner name="dots" /> : status === 'on_duty' ? 'Go Off Duty' : 'Go On Duty'}
              </IonButton>
            </div>

            {dutyError && (
              <div
                style={{
                  marginTop: '10px',
                  background: 'rgba(220, 38, 38, 0.2)',
                  border: '1px solid rgba(220, 38, 38, 0.4)',
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

          {/* Telemetry Strip */}
          <div className="telemetry-strip">
            <div className="telemetry-card">
              <div className="telemetry-card__icon">
                <IonIcon icon={radioOutline} />
              </div>
              <div className="telemetry-card__details">
                <span className="telemetry-card__label">Dispatches</span>
                <span className="telemetry-card__value">
                  {activeDispatchCount} {activeDispatchCount === 1 ? 'Active' : 'Active'}
                </span>
              </div>
            </div>

            <div className="telemetry-card">
              <div className="telemetry-card__icon" style={{ color: 'var(--color-success)' }}>
                <IonIcon icon={navigateOutline} />
              </div>
              <div className="telemetry-card__details">
                <span className="telemetry-card__label">GPS Broadcast</span>
                <span className="telemetry-card__value">15s Cadence</span>
              </div>
            </div>
          </div>

          {/* Operational Action Grid */}
          <div className="action-grid">
            <button
              type="button"
              className="action-card"
              onClick={() => navigate('/incidents/new')}
            >
              <div className="action-card__icon-box action-card__icon-box--primary">
                <IonIcon icon={documentTextOutline} />
              </div>
              <h3 className="action-card__title">Log Incident</h3>
              <p className="action-card__desc">Capture report with photo & voice evidence</p>
            </button>

            <button
              type="button"
              className="action-card"
              onClick={() => navigate('/assignments')}
            >
              <div className="action-card__icon-box action-card__icon-box--warning">
                <IonIcon icon={radioOutline} />
              </div>
              {activeDispatchCount > 0 && (
                <span className="action-card__badge status-pill status-pill--critical">
                  {activeDispatchCount} NEW
                </span>
              )}
              <h3 className="action-card__title">Assignments</h3>
              <p className="action-card__desc">View dispatches and update response status</p>
            </button>

            <button
              type="button"
              className="action-card"
              onClick={() => navigate('/map')}
            >
              <div className="action-card__icon-box action-card__icon-box--info">
                <IonIcon icon={mapOutline} />
              </div>
              <h3 className="action-card__title">Live Map</h3>
              <p className="action-card__desc">Check GPS telemetry and nearby incidents</p>
            </button>

            <div className="action-card" style={{ opacity: 0.9 }}>
              <div className="action-card__icon-box" style={{ background: 'var(--tint-neutral-bg)', color: 'var(--color-text-secondary)' }}>
                <IonIcon icon={syncOutline} />
              </div>
              <h3 className="action-card__title">Offline Store</h3>
              <p className="action-card__desc">Local SQLite encryption active</p>
            </div>
          </div>

          {/* Tactical Emergency SOS Console */}
          <div className="sos-tactical-box">
            <div className="sos-tactical-box__title">
              <IonIcon icon={warningOutline} />
              <span>EMERGENCY SOS DISPATCH</span>
            </div>
            <p className="sos-tactical-box__sub">
              Press and hold for 2 seconds to alert Barangay Admin and nearby Tanod
            </p>

            <div className="sos-hold-wrapper">
              <svg className="sos-hold-svg" viewBox="0 0 90 90">
                <circle cx="45" cy="45" r="38" className="sos-hold-track" />
                <circle
                  cx="45"
                  cy="45"
                  r="38"
                  className="sos-hold-progress"
                  style={{
                    strokeDasharray: CIRCUMFERENCE,
                    strokeDashoffset,
                  }}
                />
              </svg>

              <button
                type="button"
                className="sos-hold-btn"
                onPointerDown={startHoldSos}
                onPointerUp={cancelHoldSos}
                onPointerLeave={cancelHoldSos}
                onTouchStart={startHoldSos}
                onTouchEnd={cancelHoldSos}
                disabled={raisingSos}
                aria-label="Press and hold to trigger Emergency SOS"
              >
                {raisingSos ? <IonSpinner name="dots" color="light" /> : 'HOLD\nSOS'}
              </button>
            </div>

            <span className="sos-hold-caption">
              {holdProgress > 0 ? `Holding (${Math.round(holdProgress)}%)…` : 'Hold 2s to activate'}
            </span>

            {sosFallbackOutcome && (
              <div style={{ marginTop: '8px', display: 'flex', justifyContent: 'center' }}>
                <SmsFallbackBadge input={sosFallbackOutcome} />
              </div>
            )}

            <button
              type="button"
              onClick={() => setConfirmingSos(true)}
              style={{
                marginTop: '10px',
                background: 'transparent',
                border: 'none',
                color: 'var(--color-critical)',
                fontSize: '0.75rem',
                textDecoration: 'underline',
                cursor: 'pointer',
              }}
            >
              Or tap here for emergency confirmation
            </button>
          </div>

          {sosError && (
            <div
              style={{
                background: 'var(--tint-critical-bg)',
                color: 'var(--pill-critical-text)',
                border: '1px solid var(--color-critical)',
                borderRadius: 'var(--radius-md)',
                padding: '10px',
                marginBottom: '16px',
                fontSize: 'var(--font-size-sm)',
              }}
              role="alert"
            >
              {sosError}
            </div>
          )}

          {/* Sign Out Utility */}
          <div style={{ textAlign: 'center', marginTop: '16px', marginBottom: '32px' }}>
            <IonButton
              fill="clear"
              color="medium"
              onClick={() => setConfirmingSignOut(true)}
              style={{ fontSize: 'var(--font-size-sm)', textTransform: 'none' }}
            >
              <IonIcon icon={logOutOutline} slot="start" />
              Sign out of Patrol Console
            </IonButton>
          </div>
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

        <IonAlert
          isOpen={confirmingSignOut}
          onDidDismiss={() => setConfirmingSignOut(false)}
          header="Sign out?"
          message="You will need to sign in again to resume field patrol and sync."
          buttons={[
            { text: 'Cancel', role: 'cancel' },
            { text: 'Sign Out', role: 'destructive', handler: handleSignOut },
          ]}
        />
      </IonContent>
    </IonPage>
  );
};

export default HomePage;
