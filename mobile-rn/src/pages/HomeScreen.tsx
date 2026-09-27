/**
 * HomeScreen.tsx — M2 Home (§9 Mobile). Port of ../mobile/src/pages/home.tsx.
 *
 * §9 M2's one hard requirement: "The duty toggle must call
 * POST /duty-status, not just flip local UI state." `handleToggleDuty`
 * always round-trips through `setDutyStatus`, and the displayed status is
 * loaded from `getOwnDutyStatus()` on mount rather than assumed — a Tanod
 * may have last toggled from a different device.
 *
 * Duty toggling starts/stops `patrolLocationService.ts`'s native foreground
 * GPS service 1:1 with on/off duty (Phase 5) — background tracking that
 * isn't tied to a visibly-on-duty state is exactly the undisclosed-tracking
 * control §2 Rule 6 forbids.
 *
 * SOS is online-first: on success it reports sent; on a network failure it
 * stages the event in `offline_queue_local` via `enqueueSosItem` (§2 Rule
 * 27's local/offline fallback path), then attempts G1's THIRD tier — a
 * direct device SMS via `sos-sms` (Phase 6) — as a best-effort human alert
 * on top of the queue, never a replacement for it. `SmsFallbackBadge`
 * reports the real outcome, never a claim this screen can't back up.
 *
 * Unlike the old app, a missing GPS fix does NOT block SOS (C-01, this
 * rebuild's whole reason for existing) — `postSos` already accepts a null
 * location (server falls back to last-known/no-fix per migration 0026).
 *
 * UI redesign (2026-09-27, approved mockup): HeroUI Native + Tailwind
 * (Uniwind) replace the hand-rolled StyleSheet, and the SOS control is now
 * a press-and-hold ring (RingProgress) that, on completion, opens a
 * BottomSheet confirm step rather than firing immediately — the user
 * explicitly asked for BOTH the hold gesture and a confirm step, not one
 * in place of the other. Every handler below is unchanged from the prior
 * version; only what renders them changed.
 */
import { useEffect, useRef, useState } from 'react';
import { router } from 'expo-router';
import { AppState, Linking, Pressable, ScrollView, Text, View } from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import { BottomSheet, Button, Switch, useThemeColor } from 'heroui-native';
import AppHeader from '../ui/AppHeader';
import StatusChip from '../ui/StatusChip';
import RingProgress from '../ui/RingProgress';
import SmsFallbackBadge from '../components/SmsFallbackBadge';
import {
  ApiError,
  checkHealth,
  getDispatches,
  getOwnDutyStatus,
  postSos,
  setDutyStatus,
  type DutyStatus,
} from '../services/apiService';
import { getCurrentPosition } from '../services/geolocation';
import { enqueueSosItem, listPendingDispatchStatusUpdates, listPendingSosItems } from '../services/db/offlineQueueRepository';
import { cacheDispatchesFromServer, listActiveCachedDispatches } from '../services/db/dispatchRepository';
import { listAllLocalIncidents, listUnsyncedIncidents } from '../services/db/incidentRepository';
import type { DispatchLocalRow } from '../services/db/localSchema';
import { startPatrolTracking, stopPatrolTracking } from '../services/patrolLocationService';
import { loadSession } from '../services/session';
import { getCachedSosFallbackContact } from '../services/sosFallbackContact';
import { sendSosSmsDirect } from '../services/sosSms';
import type { SmsFallbackInput } from '../services/smsFallbackState';
import { setKnownDutyStatus } from '../services/syncScheduler';
import { prefs } from '../services/storage';
import { uuid } from '../services/uuid';
import tacticalFeedback from '../utils/tacticalFeedback';

/** §1: "Four barangays, fixed" — not invented here. */
const BARANGAY_NAMES: Record<number, string> = { 1: 'Dao', 2: 'Binanuahan', 3: 'Marifosque', 4: 'Banuyo' };
const SHIFT_START_KEY = 'baranguard.shiftStartTime';
const HOLD_DURATION_MS = 2000;

export default function HomeScreen() {
  const [accent, danger, dangerSoft, success, muted] = useThemeColor(['accent', 'danger', 'danger-soft', 'success', 'muted']);

  const [fullName, setFullName] = useState('');
  const [barangayName, setBarangayName] = useState('Dao');
  const [status, setStatus] = useState<DutyStatus | null>(null);
  const [loadingStatus, setLoadingStatus] = useState(true);
  const [toggling, setToggling] = useState(false);
  const [dutyError, setDutyError] = useState<string | null>(null);
  const [patrolTracking, setPatrolTracking] = useState<boolean | null>(null);
  const [activeDispatchCount, setActiveDispatchCount] = useState(0);
  const [topDispatch, setTopDispatch] = useState<DispatchLocalRow | null>(null);

  const [shiftStartTime, setShiftStartTime] = useState<number | null>(null);
  const [shiftElapsed, setShiftElapsed] = useState('0m');
  const [todayIncidentCount, setTodayIncidentCount] = useState(0);
  const [deskContact, setDeskContact] = useState('0917-000-0000');

  const [isOnline, setIsOnline] = useState<boolean | null>(null);
  const [queuedCount, setQueuedCount] = useState(0);

  const [dutyToast, setDutyToast] = useState<string | null>(null);
  const [raisingSos, setRaisingSos] = useState(false);
  const [sosError, setSosError] = useState<string | null>(null);
  const [sosToast, setSosToast] = useState<string | null>(null);
  const [sosFallbackOutcome, setSosFallbackOutcome] = useState<SmsFallbackInput | null>(null);

  const [holdProgress, setHoldProgress] = useState(0);
  const [confirmVisible, setConfirmVisible] = useState(false);
  const holdTimerRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const holdStartTimeRef = useRef<number | null>(null);

  useEffect(() => {
    if (!dutyToast) return;
    const timer = setTimeout(() => setDutyToast(null), 3000);
    return () => clearTimeout(timer);
  }, [dutyToast]);

  useEffect(() => {
    if (!sosToast) return;
    const timer = setTimeout(() => setSosToast(null), 4500);
    return () => clearTimeout(timer);
  }, [sosToast]);

  // Header connection chip: a real probe (Rule 6 — never a fake badge),
  // same 30s cadence the old MobileHeader used. "Queued" counts what a
  // Tanod would recognize as "waiting to sync" (incidents, SOS, dispatch
  // status updates) — GPS points are left out, they turn over every 30s on
  // their own and would make the header flicker rather than inform.
  useEffect(() => {
    let cancelled = false;
    async function probe() {
      const [ok, incidents, sos, dispatchUpdates] = await Promise.all([
        checkHealth(),
        listUnsyncedIncidents().catch(() => []),
        listPendingSosItems().catch(() => []),
        listPendingDispatchStatusUpdates().catch(() => []),
      ]);
      if (cancelled) return;
      setIsOnline(ok);
      setQueuedCount(incidents.length + sos.length + dispatchUpdates.length);
    }
    void probe();
    const interval = setInterval(probe, 30000);
    return () => {
      cancelled = true;
      clearInterval(interval);
    };
  }, []);

  // Live shift duration timer — resets the persisted shift-start marker
  // when duty status transitions away from on_duty (a real external-state
  // sync, not something derivable during render: the marker must survive
  // app restarts while on duty, via AsyncStorage).
  useEffect(() => {
    if (status !== 'on_duty') {
      // eslint-disable-next-line react-hooks/set-state-in-effect -- reacting to a genuine external transition (duty status), not a value derivable during render.
      setShiftElapsed('0m');
      setShiftStartTime(null);
      void prefs.remove(SHIFT_START_KEY);
      return undefined;
    }

    let cancelled = false;
    let interval: ReturnType<typeof setInterval> | undefined;

    async function start() {
      let startTime = shiftStartTime;
      if (!startTime) {
        const saved = await prefs.get(SHIFT_START_KEY);
        startTime = saved ? parseInt(saved, 10) : Date.now();
        if (cancelled) return;
        setShiftStartTime(startTime);
        await prefs.set(SHIFT_START_KEY, String(startTime));
      }

      function updateTimer() {
        const diffMs = Math.max(0, Date.now() - (startTime ?? Date.now()));
        const diffMins = Math.floor(diffMs / 60000);
        const hours = Math.floor(diffMins / 60);
        const mins = diffMins % 60;
        setShiftElapsed(hours > 0 ? `${hours}h ${mins}m` : `${mins}m`);
      }

      updateTimer();
      interval = setInterval(updateTimer, 30000);
    }

    void start();
    return () => {
      cancelled = true;
      if (interval) clearInterval(interval);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps -- shiftStartTime is seeded once per on-duty transition, not re-read every render.
  }, [status]);

  function refreshActiveDispatches() {
    getDispatches()
      .then((entries) => cacheDispatchesFromServer(entries))
      .catch(() => {
        // Offline or unreachable — fall through to whatever's already cached.
      })
      .finally(() => {
        listActiveCachedDispatches()
          .then((items) => {
            setActiveDispatchCount(items.length);
            setTopDispatch(items[0] ?? null);
          })
          .catch(() => {
            setActiveDispatchCount(0);
            setTopDispatch(null);
          });
      });
  }

  const PATROL_GPS_DENIED =
    'On duty, but patrol GPS is OFF — location permission was not granted. Allow Location for Baranguard in Android Settings, then toggle duty again.';

  function applyPatrolResult(started: boolean) {
    setPatrolTracking(started);
    if (!started) setDutyError(PATROL_GPS_DENIED);
  }

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
          void startPatrolTracking().then(applyPatrolResult);
        }
      })
      .catch((error: unknown) => {
        setStatus(null);
        setDutyError(
          error instanceof ApiError && error.isOffline
            ? 'Offline — current duty status unknown until reconnected.'
            : 'Could not load current duty status.',
        );
      })
      .finally(() => setLoadingStatus(false));

    refreshActiveDispatches();

    listAllLocalIncidents()
      .then((items) => {
        const todayStr = new Date().toISOString().slice(0, 10);
        setTodayIncidentCount(items.filter((item) => (item.created_offline_at || '').startsWith(todayStr)).length);
      })
      .catch(() => setTodayIncidentCount(0));

    getCachedSosFallbackContact()
      .then((num) => {
        if (num) setDeskContact(num);
      })
      .catch(() => undefined);
  }, []);

  // Re-query the dispatch cache whenever the app comes back to the
  // foreground — covers both "backgrounded then resumed" and a push that
  // landed while backgrounded.
  useEffect(() => {
    const subscription = AppState.addEventListener('change', (state) => {
      if (state === 'active') refreshActiveDispatches();
    });
    return () => subscription.remove();
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
      setDutyToast(entry.status === 'on_duty' ? 'You are now ON DUTY. Patrol active.' : 'You are now OFF DUTY.');
      if (entry.status === 'on_duty') {
        applyPatrolResult(await startPatrolTracking());
      } else {
        setPatrolTracking(null);
        void stopPatrolTracking();
      }
    } catch (error) {
      setDutyError(
        error instanceof ApiError && error.isOffline
          ? 'Cannot reach the barangay workstation — duty status was not changed.'
          : error instanceof Error
            ? error.message
            : 'Could not update duty status.',
      );
    } finally {
      setToggling(false);
    }
  }

  function startHoldSos() {
    if (raisingSos || confirmVisible) return;
    holdStartTimeRef.current = Date.now();
    let lastTick = 0;
    holdTimerRef.current = setInterval(() => {
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
        // The user asked for the hold gesture AND a confirm step, not
        // either/or — completing the hold opens this sheet rather than
        // sending immediately.
        setConfirmVisible(true);
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
   * function's only caller), so the SOS is already safely queued locally —
   * this is purely the best-effort human alert on top of that.
   */
  async function attemptSosSmsFallback(payload: { latitude: number; longitude: number } | null) {
    const backupNumber = await getCachedSosFallbackContact();
    if (!backupNumber) {
      setSosFallbackOutcome({ reachedWorkstation: false, smsAttempted: false, smsStatus: null });
      setSosToast('SOS saved locally — will dispatch automatically upon reconnect. (No backup SMS contact configured.)');
      return;
    }

    setSosFallbackOutcome({ reachedWorkstation: false, smsAttempted: true, smsStatus: 'pending' });
    try {
      const session = await loadSession();
      const brgy = session ? (BARANGAY_NAMES[session.barangayId] ?? `Barangay ${session.barangayId}`) : 'Unknown Barangay';
      const locationLine = payload
        ? [`Location: ${payload.latitude.toFixed(5)}, ${payload.longitude.toFixed(5)}`, `Map: https://maps.google.com/?q=${payload.latitude},${payload.longitude}`]
        : ['Location: unavailable (no GPS fix)'];
      const message = [
        'BARANGUARD EMERGENCY SOS',
        `Tanod: ${session?.fullName ?? 'Unknown'} (Brgy ${brgy})`,
        ...locationLine,
        `Time: ${new Date().toLocaleString()}`,
      ].join('\n');

      await sendSosSmsDirect(backupNumber, message);
      setSosFallbackOutcome({ reachedWorkstation: false, smsAttempted: true, smsStatus: 'sent' });
      setSosToast('Workstation unreachable — emergency SMS sent directly to backup contact.');
    } catch (smsError) {
      setSosFallbackOutcome({ reachedWorkstation: false, smsAttempted: true, smsStatus: 'failed' });
      setSosToast(
        smsError instanceof Error
          ? `SOS saved locally. Backup SMS also failed: ${smsError.message}`
          : 'SOS saved locally. Backup SMS also failed.',
      );
    }
  }

  async function handleRaiseSos() {
    setConfirmVisible(false);
    setSosError(null);
    setRaisingSos(true);
    tacticalFeedback.onSosFired();
    const clientEventId = uuid();
    try {
      // C-01: a missing GPS fix never blocks SOS — the server falls back
      // to last-known/no-fix (migration 0026). Unlike the old app, this
      // is not a hard requirement, just best-effort enrichment.
      let position: { latitude: number; longitude: number } | null = null;
      try {
        const fix = await getCurrentPosition();
        position = { latitude: fix.latitude, longitude: fix.longitude };
      } catch {
        position = null;
      }

      try {
        await postSos({ location: position, clientEventId });
        setSosToast('EMERGENCY SOS TRANSMITTED — Admin dispatch has been alerted.');
        setSosFallbackOutcome({ reachedWorkstation: true, smsAttempted: false, smsStatus: null });
      } catch (error) {
        if (error instanceof ApiError && error.isOffline) {
          await enqueueSosItem(clientEventId, position ?? {});
          await attemptSosSmsFallback(position);
        } else {
          setSosError(error instanceof Error ? error.message : 'Could not transmit SOS.');
        }
      }
    } finally {
      setRaisingSos(false);
    }
  }

  const dutyOn = status === 'on_duty';
  const dutyUnknown = status === null && !loadingStatus;
  const holding = holdProgress > 0;

  return (
    <View className="flex-1 bg-background">
      <AppHeader eyebrow={`Barangay ${barangayName} · Tanod`} title={fullName || 'Tanod Officer'}>
        <StatusChip dotColor={dutyOn ? success : dutyUnknown ? muted : '#94a3b8'} label={loadingStatus ? 'Checking…' : dutyOn ? 'On duty' : 'Off duty'} />
        <StatusChip
          icon={<Ionicons name={isOnline === false ? 'cloud-offline-outline' : 'cloud-done-outline'} size={14} color="#ffffff" />}
          label={isOnline === false ? `Offline · ${queuedCount} queued` : `Online · ${queuedCount} queued`}
        />
      </AppHeader>

      <ScrollView className="flex-1" contentInsetAdjustmentBehavior="automatic">
        <View className="p-4 gap-3.5">
        {/* 1. Duty status card */}
        <View className="bg-surface border border-border rounded-[20px] p-4 gap-3.5">
          <View className="flex-row items-center gap-3">
            <View className={`w-11 h-11 rounded-2xl items-center justify-center ${dutyOn ? 'bg-success-soft' : 'bg-default'}`}>
              <Ionicons name="shield-checkmark" size={22} color={dutyOn ? success : muted} />
            </View>
            <View className="flex-1">
              <Text className="text-[17px] font-bold text-foreground">
                {loadingStatus ? 'Checking shift…' : dutyOn ? 'On active patrol' : status === null ? 'Duty status unknown (offline)' : 'Off duty'}
              </Text>
              <Text className="text-[13px] text-muted">
                {!dutyOn ? 'Turn on to start your patrol' : patrolTracking === false ? 'GPS off — location permission denied' : 'Sharing location every 30s'}
              </Text>
            </View>
            <Switch isSelected={dutyOn} onSelectedChange={() => void handleToggleDuty()} isDisabled={loadingStatus || toggling} accessibilityLabel="On duty" />
          </View>

          {dutyError ? (
            <View className="bg-danger-soft rounded-2xl p-2.5">
              <Text className="text-danger-soft-foreground text-xs">{dutyError}</Text>
            </View>
          ) : null}

          <View className="flex-row border-t border-border pt-3">
            <HomeStat value={dutyOn ? shiftElapsed : '—'} label="On patrol" />
            <HomeStat value={dutyOn ? 'Every 30s' : 'Paused'} label="Location sync" />
            <HomeStat value={String(todayIncidentCount)} label="Filed today" />
          </View>
        </View>

        {/* 2. Emergency SOS — press and hold, then confirm */}
        <View className="items-center gap-2.5 py-1">
          <Pressable
            onPressIn={startHoldSos}
            onPressOut={cancelHoldSos}
            accessibilityRole="button"
            accessibilityLabel="SOS. Press and hold for 2 seconds to raise an emergency alert."
          >
            <RingProgress size={200} strokeWidth={9} progress={holdProgress / 100} trackColor={dangerSoft} fillColor={danger}>
              <View className="w-[152px] h-[152px] rounded-full bg-danger items-center justify-center gap-1" style={{ elevation: 10 }}>
                <Text className="text-white text-[38px] font-extrabold tracking-widest">SOS</Text>
                <Text className="text-white text-[13px] font-semibold">{raisingSos ? 'Sending…' : holding ? `Keep holding… ${Math.round(holdProgress)}%` : 'Hold 2 seconds'}</Text>
              </View>
            </RingProgress>
          </Pressable>
          <Text className="text-[13px] text-muted text-center max-w-[280px]">
            Alerts the barangay desk and every on-duty Tanod. Still sends by SMS when you&apos;re offline.
          </Text>

          {sosFallbackOutcome ? <SmsFallbackBadge input={sosFallbackOutcome} /> : null}
          {sosError ? (
            <View className="bg-danger-soft rounded-2xl p-3 self-stretch">
              <Text className="text-danger-soft-foreground text-[13px]">{sosError}</Text>
            </View>
          ) : null}
        </View>

        {/* 3. Active dispatch / perimeter status */}
        {topDispatch ? (
          <Pressable
            className="bg-danger-soft rounded-[20px] p-4 gap-2"
            onPress={() => router.push(`/assignments/${encodeURIComponent(topDispatch.local_id)}`)}
          >
            <View className="flex-row items-center justify-between">
              <View className="flex-row items-center gap-1.5">
                <Ionicons name="alert-circle" size={16} color={danger} />
                <Text className="text-danger-soft-foreground text-xs font-extrabold">
                  ACTIVE DISPATCH #{topDispatch.server_dispatch_id ?? topDispatch.local_id.slice(0, 6)}
                </Text>
              </View>
              <View className="bg-danger rounded-full px-2 py-0.5">
                <Text className="text-white text-[10px] font-extrabold">{topDispatch.priority.toUpperCase()}</Text>
              </View>
            </View>
            <Text className="text-foreground text-base font-extrabold">
              {topDispatch.redacted_incident_type ? topDispatch.redacted_incident_type.replace(/_/g, ' ').toUpperCase() : 'INCIDENT REPORTED'}
            </Text>
            <Text className="text-muted text-xs">
              Assigned to your unit{activeDispatchCount > 1 ? ` · ${activeDispatchCount} active assignments` : ''} · Tap to navigate.
            </Text>
            <View className="flex-row items-center justify-center gap-1.5 bg-danger rounded-2xl py-2.5 mt-1">
              <Text className="text-white font-extrabold text-[13px]">NAVIGATE ROUTE</Text>
              <Ionicons name="arrow-forward" size={16} color="#fff" />
            </View>
          </Pressable>
        ) : (
          <View className="bg-success-soft rounded-[20px] p-4 gap-1.5">
            <View className="flex-row items-center justify-between">
              <View className="flex-row items-center gap-1.5">
                <Ionicons name="shield-checkmark" size={16} color={success} />
                <Text className="text-success-soft-foreground text-xs font-extrabold">PERIMETER CLEAR · SECTOR {barangayName.toUpperCase()}</Text>
              </View>
              <View className="bg-success rounded-full px-2 py-0.5">
                <Text className="text-white text-[10px] font-extrabold">READY</Text>
              </View>
            </View>
            <Text className="text-muted text-[13px]">No active emergency dispatches in queue.</Text>
          </View>
        )}

        {/* 4. Quick call */}
        <View className="gap-2">
          <Text className="text-foreground text-[15px] font-bold">Quick call</Text>
          <View className="flex-row gap-2.5">
            <SpeedDialButton icon="call" title="Brgy Desk" onPress={() => Linking.openURL(`tel:${deskContact.replace(/[^0-9+]/g, '') || '911'}`)} />
            <SpeedDialButton icon="shield" title="Police 911" onPress={() => Linking.openURL('tel:911')} />
            <SpeedDialButton icon="medkit" title="MDRRMO" onPress={() => Linking.openURL('tel:160')} />
          </View>
        </View>

        {/* 5. Quick links */}
        <View className="flex-row gap-3">
          <Pressable className="flex-1 bg-surface border border-border rounded-2xl p-3.5 gap-1.5" onPress={() => router.push('/incidents/new')}>
            <View className="w-9 h-9 rounded-full bg-accent-soft items-center justify-center">
              <Ionicons name="document-text" size={18} color={accent} />
            </View>
            <Text className="text-foreground text-sm font-bold">Log Incident</Text>
            <Text className="text-muted text-[11px]">Rapid field report intake</Text>
          </Pressable>
          <Pressable className="flex-1 bg-surface border border-border rounded-2xl p-3.5 gap-1.5" onPress={() => router.push('/(tabs)/map')}>
            <View className="w-9 h-9 rounded-full bg-accent-soft items-center justify-center">
              <Ionicons name="map" size={18} color={accent} />
            </View>
            <Text className="text-foreground text-sm font-bold">Live Map</Text>
            <Text className="text-muted text-[11px]">Team map & telemetry</Text>
          </Pressable>
        </View>

        {dutyToast ? <Toast tone="success" text={dutyToast} /> : null}
        {sosToast ? <Toast tone={sosToast.startsWith('EMERGENCY') ? 'danger' : 'warning'} text={sosToast} /> : null}
        </View>
      </ScrollView>

      {/* SOS confirm — the second, explicit step the user asked for on top
          of the hold gesture. `Cancel` and the sheet's own dismiss both
          just close it; only "Send SOS now" calls handleRaiseSos. */}
      <BottomSheet isOpen={confirmVisible} onOpenChange={setConfirmVisible}>
        <BottomSheet.Portal>
          <BottomSheet.Overlay />
          <BottomSheet.Content enableDynamicSizing>
            <View className="p-5 pb-8 gap-4">
              <View className="flex-row items-center gap-3.5">
                <View className="w-14 h-14 rounded-2xl bg-danger-soft items-center justify-center">
                  <Ionicons name="warning" size={26} color={danger} />
                </View>
                <View className="flex-1">
                  <BottomSheet.Title className="text-[20px] font-extrabold text-foreground">Send SOS alert?</BottomSheet.Title>
                  <Text className="text-muted text-[13px]">This can&apos;t be unsent.</Text>
                </View>
              </View>
              <BottomSheet.Description className="text-foreground text-[15px] leading-5">
                Your name and location go to the barangay desk and every on-duty Tanod right now.
              </BottomSheet.Description>
              <View className="flex-row items-center gap-2.5 p-3 rounded-2xl bg-default">
                <Ionicons name="chatbox-ellipses-outline" size={18} color={accent} />
                <Text className="flex-1 text-foreground text-xs">No connection? It&apos;s sent by SMS from this phone instead.</Text>
              </View>
              <Button variant="danger" size="lg" onPress={() => void handleRaiseSos()}>
                Send SOS now
              </Button>
              <Button variant="outline" size="lg" onPress={() => setConfirmVisible(false)}>
                Cancel
              </Button>
            </View>
          </BottomSheet.Content>
        </BottomSheet.Portal>
      </BottomSheet>
    </View>
  );
}

function HomeStat({ value, label }: { value: string; label: string }) {
  return (
    <View className="flex-1 gap-0.5">
      <Text className="text-foreground text-[17px] font-bold">{value}</Text>
      <Text className="text-muted text-xs">{label}</Text>
    </View>
  );
}

function SpeedDialButton({ icon, title, onPress }: { icon: keyof typeof Ionicons.glyphMap; title: string; onPress: () => void }) {
  return (
    <Pressable
      className="flex-1 h-[76px] bg-surface border border-border rounded-2xl items-center justify-center gap-1.5"
      onPress={() => {
        tacticalFeedback.onWarning();
        onPress();
      }}
    >
      <Ionicons name={icon} size={20} color="#1d4ed8" />
      <Text className="text-foreground text-[13px] font-semibold">{title}</Text>
    </Pressable>
  );
}

function Toast({ tone, text }: { tone: 'success' | 'danger' | 'warning'; text: string }) {
  const bg = tone === 'success' ? 'bg-success' : tone === 'danger' ? 'bg-danger' : 'bg-warning';
  return (
    <View className={`${bg} rounded-2xl p-3`}>
      <Text className="text-white text-[13px] font-semibold">{text}</Text>
    </View>
  );
}
