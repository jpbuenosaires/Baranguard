/**
 * home.tsx — M2 Home / Patrol Console (§9 Mobile).
 *
 * Priority-ordered HUD: duty status, alerts, active call, emergency lines,
 * with Report/SOS docked above the tab bar. Sections live in components/home/*.
 */

import { useEffect, useRef, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { IonAlert, IonButton, IonContent, IonIcon, IonPage, IonSpinner, IonToast } from '@ionic/react';
import { documentTextOutline, warningOutline } from 'ionicons/icons';
import DispatchOfferCards from '../components/DispatchOfferCards';
import MobileHeader from '../components/MobileHeader';
import { Banner, Button } from '../components/ui';
import DutyStatusCard from '../components/home/DutyStatusCard';
import DispatchHeadline from '../components/home/DispatchHeadline';
import EmergencyDials from '../components/home/EmergencyDials';
import SosConfirmSheet from '../components/home/SosConfirmSheet';
import {
  barangayLabel,
  dutyStatusErrorMessage,
  formatShiftElapsed,
  readCachedDutyStatus,
  writeCachedDutyStatus,
} from '../utils/homeDuty';
import { useSosFlow } from '../components/home/useSosFlow';
import SmsFallbackBadge from '../components/SmsFallbackBadge';
import TacticalAlertBar, { type TacticalAlertItem } from '../components/TacticalAlertBar';
import tacticalFeedback from '../utils/tacticalFeedback';
import { getDispatches, getOwnDutyStatus, setDutyStatus, type DutyStatus } from '../services/apiService';
import { ApiError } from '../services/apiService';
import {
  dismissRejectedDutyStatus,
  enqueueOffDuty,
  listPendingDutyStatusUpdates,
  listRejectedDutyStatusUpdates,
  type QueuedDutyStatus,
} from '../services/db/offlineQueueRepository';
import { cacheDispatchesFromServer, listActiveCachedDispatches } from '../services/db/dispatchRepository';
import { countLocalIncidentsSince } from '../services/db/incidentRepository';
import { getOpenSchoolCheckin } from '../services/db/schoolRepository';
import { formatManilaTime } from '../utils/manilaTime';
import type { DispatchLocalRow, SchoolCheckinLocalRow } from '../services/db/localSchema';
import { startPatrolTracking, stopPatrolTracking } from '../services/patrolLocationService';
import { loadSession } from '../services/session';
import { getCachedSosFallbackContact } from '../services/sosFallbackContact';
import {
  forceSyncNow,
  isSyncDeviceBlocked,
  setKnownDutyStatus,
  subscribeSyncDeviceBlocked,
  subscribeSyncSummary,
} from '../services/syncScheduler';
import { uuid } from '../services/uuid';

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
  const [deskContact, setDeskContact] = useState<string | null>(null);

  const [dutyToast, setDutyToast] = useState<string | null>(null);
  const {
    confirmingSos,
    setConfirmingSos,
    raisingSos,
    sosError,
    sosToast,
    setSosToast,
    sosFallbackOutcome,
    failedSosCount,
    retryingSos,
    handleRetryFailedSos,
    handleOpenSosModal,
    handleRaiseSos,
  } = useSosFlow();
  // The workstation refuses this phone's whole sync because its device id
  // belongs to another account: saved reports and SOS alerts cannot leave.
  const [deviceBlocked, setDeviceBlocked] = useState(isSyncDeviceBlocked());
  useEffect(() => subscribeSyncDeviceBlocked(setDeviceBlocked), []);

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
        setShiftElapsed(formatShiftElapsed(Date.now() - (startTime ?? Date.now())));
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
        const startOfDay = new Date();
        startOfDay.setHours(0, 0, 0, 0);
        const todayCount = await countLocalIncidentsSince(startOfDay.toISOString());
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
      setBarangayName(barangayLabel(session.barangayId));
    });

    // Backup contact comes from the cached SOS fallback number only; no number cached = no tile.
    getCachedSosFallbackContact()
      .then((n) => {
        if (!cancelled) setDeskContact(n);
      })
      .catch(() => {
        // Preferences unavailable: no tile rather than a made-up number.
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
        setDutyError(dutyStatusErrorMessage(offline, Boolean(cached)));
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

  const homeAlerts: TacticalAlertItem[] = [];
  if (dutyError) {
    homeAlerts.push({
      id: 'duty-error',
      severity: 'critical',
      message: dutyError,
    });
  }
  if (rejectedOffDuty && !pendingOffDutyAt) {
    homeAlerts.push({
      id: 'rejected-off-duty',
      severity: 'warning',
      message: `Your offline off-duty (${formatManilaTime(rejectedOffDuty.payload.changedAt)}) was not accepted by HQ${
        rejectedOffDuty.payload.rejectReason ? `: ${rejectedOffDuty.payload.rejectReason}` : '.'
      } Your status above is what HQ has now.`,
      actionLabel: 'Dismiss',
      onAction: () => void handleDismissRejectedOffDuty(),
    });
  }
  if (pendingOffDutyAt) {
    homeAlerts.push({
      id: 'pending-off-duty',
      severity: 'info',
      message: `Off duty since ${formatManilaTime(pendingOffDutyAt)} — saved on this phone, waiting to sync with HQ.`,
    });
  }
  if (openSchoolCheckin) {
    homeAlerts.push({
      id: 'open-school-checkin',
      severity: 'info',
      message: `At ${openSchoolCheckin.school_name} since ${formatManilaTime(openSchoolCheckin.checked_in_at)}`,
      actionLabel: 'Check out',
      onAction: () => {
        tacticalFeedback.onTap();
        navigate('/tabs/school');
      },
    });
  }

  return (
    <IonPage>
      <MobileHeader title="Baranguard" subtitle="Dashboard" />

      <IonContent className="h4-content">
        <div className="console-overhaul-container console-overhaul-container--docked-sos h4-home">
          <DutyStatusCard
            fullName={fullName}
            barangayName={barangayName}
            status={status}
            loadingStatus={loadingStatus}
            toggling={toggling}
            shiftElapsed={shiftElapsed}
            patrolTracking={patrolTracking}
            todayIncidentCount={todayIncidentCount}
            onToggleDuty={handleToggleDuty}
          />

          {/* Consolidated Prioritized Tactical Alert Bar */}
          <TacticalAlertBar alerts={homeAlerts} />

          {/* Night-dispatch offers: online-only, accept is never queued (see DispatchOfferCards). */}
          <DispatchOfferCards />

          <DispatchHeadline topDispatch={topDispatch} activeDispatchCount={activeDispatchCount} />

          <EmergencyDials deskContact={deskContact} />

          {sosFallbackOutcome && (
            <div className="h4-fallback-badge">
              <SmsFallbackBadge input={sosFallbackOutcome} />
            </div>
          )}

          {deviceBlocked && (
            <Banner tone="error" role="alert">
              <strong>This phone is registered to a different account.</strong> Reports and SOS alerts saved here
              cannot be sent to HQ from this account. Nothing is lost: log in with the account that saved them, or ask
              the Chief Tanod to reset this phone. For an emergency, call the barangay desk or text your backup contact.
            </Banner>
          )}
          {failedSosCount > 0 && (
            <Banner
              tone="error"
              role="alert"
              action={
                <IonButton size="small" color="danger" disabled={retryingSos} onClick={handleRetryFailedSos}>
                  {retryingSos ? 'Retrying…' : 'Retry'}
                </IonButton>
              }
            >
              {failedSosCount} SOS alert{failedSosCount === 1 ? '' : 's'} could not be delivered to HQ. Call the
              barangay desk directly.
            </Banner>
          )}

          {sosError && (
            <Banner tone="error" role="alert">
              {sosError}
            </Banner>
          )}
        </div>

        {/* 5. SOS control: docked above the tab bar so it never needs scrolling. Same confirm sheet and send flow. */}
        <div slot="fixed" className="home-sos-dock">
          <Button
            variant="primary"
            size="lg"
            fullWidth
            icon={documentTextOutline}
            className="h4-report-btn"
            onClick={() => {
              tacticalFeedback.onTap();
              navigate('/tabs/incidents/new');
            }}
          >
            Report incident
          </Button>
          <button
            type="button"
            className="home-sos-button"
            onClick={handleOpenSosModal}
            disabled={raisingSos}
            aria-label={raisingSos ? 'Transmitting emergency SOS' : 'Emergency SOS. Opens confirmation.'}
          >
            <span className="home-sos-button__icon" aria-hidden="true">
              <IonIcon icon={warningOutline} />
            </span>
            <span className="home-sos-button__label">
              {raisingSos ? 'Transmitting alert…' : 'EMERGENCY SOS'}
            </span>
            {raisingSos && <IonSpinner name="dots" className="home-sos-button__spinner" />}
          </button>
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

        <SosConfirmSheet
          isOpen={confirmingSos}
          raisingSos={raisingSos}
          barangayName={barangayName}
          onClose={() => setConfirmingSos(false)}
          onConfirm={() => {
            setConfirmingSos(false);
            void handleRaiseSos();
          }}
        />

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
