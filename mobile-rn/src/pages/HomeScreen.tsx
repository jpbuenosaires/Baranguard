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
 */
import { useEffect, useRef, useState } from 'react';
import { router } from 'expo-router';
import { Alert, AppState, Linking, Pressable, ScrollView, StyleSheet, Text, View } from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import MobileHeader from '../components/MobileHeader';
import SmsFallbackBadge from '../components/SmsFallbackBadge';
import { useTheme } from '../theme/ThemeProvider';
import {
  ApiError,
  getDispatches,
  getOwnDutyStatus,
  postSos,
  setDutyStatus,
  type DutyStatus,
} from '../services/apiService';
import { getCurrentPosition } from '../services/geolocation';
import { enqueueSosItem } from '../services/db/offlineQueueRepository';
import { cacheDispatchesFromServer, listActiveCachedDispatches } from '../services/db/dispatchRepository';
import { listAllLocalIncidents } from '../services/db/incidentRepository';
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
  const { colors, tokens } = useTheme();
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

  const [dutyToast, setDutyToast] = useState<string | null>(null);
  const [raisingSos, setRaisingSos] = useState(false);
  const [sosError, setSosError] = useState<string | null>(null);
  const [sosToast, setSosToast] = useState<string | null>(null);
  const [sosFallbackOutcome, setSosFallbackOutcome] = useState<SmsFallbackInput | null>(null);

  const [holdProgress, setHoldProgress] = useState(0);
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
    if (raisingSos) return;
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
        Alert.alert(
          'Transmit Emergency SOS?',
          'This will immediately dispatch emergency backup and broadcast your GPS coordinates to Barangay HQ.',
          [
            { text: 'Cancel', style: 'cancel' },
            { text: 'Transmit SOS Now', style: 'destructive', onPress: () => void handleRaiseSos() },
          ],
        );
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

  const initials = fullName
    ? fullName.split(' ').map((n) => n[0]).slice(0, 2).join('').toUpperCase()
    : 'BP';

  const dutyOn = status === 'on_duty';
  const dutyUnknown = status === null && !loadingStatus;

  return (
    <View style={{ flex: 1, backgroundColor: colors.bg }}>
      <MobileHeader />
      <ScrollView contentContainerStyle={styles.scroll}>
        {/* 1. Officer status hub */}
        <View style={[styles.hub, { backgroundColor: colors.navy, borderRadius: tokens.radius.lg }]}>
          <View style={styles.hubTop}>
            <View style={styles.avatar}>
              <Text style={styles.avatarText}>{initials}</Text>
            </View>
            <View style={{ flex: 1 }}>
              <Text style={styles.hubName}>{fullName || 'Tanod Officer'}</Text>
              <View style={styles.hubSubRow}>
                <Ionicons name="shield-checkmark" size={13} color="rgba(255,255,255,0.75)" />
                <Text style={styles.hubSub}>Security Responder · Brgy {barangayName}</Text>
              </View>
            </View>
          </View>

          <View style={styles.hubDivider} />

          <View style={styles.hubBottom}>
            <View style={{ flexDirection: 'row', alignItems: 'center', gap: 10, flex: 1 }}>
              <View
                style={[
                  styles.pulseDot,
                  { backgroundColor: dutyOn ? '#4ade80' : dutyUnknown ? '#94a3b8' : '#64748b' },
                ]}
              />
              <View style={{ flex: 1 }}>
                <Text style={[styles.hubStatusTitle, { color: dutyOn ? '#4ade80' : dutyUnknown ? '#cbd5e1' : '#94a3b8' }]}>
                  {loadingStatus ? 'Checking Shift…' : dutyOn ? 'On Active Patrol' : status === null ? 'Duty Status Unknown (Offline)' : 'Off Duty (Standby)'}
                </Text>
                <Text style={styles.hubStatusSub}>
                  {!dutyOn ? 'Patrol tracking inactive' : patrolTracking === false ? 'GPS OFF — location permission denied' : 'Foreground GPS · 30s Broadcast'}
                </Text>
              </View>
            </View>

            <Pressable
              disabled={loadingStatus || toggling}
              onPress={handleToggleDuty}
              style={[styles.dutyBtn, { backgroundColor: dutyOn ? 'rgba(220,38,38,0.85)' : '#2563eb', opacity: loadingStatus || toggling ? 0.6 : 1 }]}
            >
              <Text style={styles.dutyBtnText}>{toggling ? '...' : dutyOn ? 'Go Off Duty' : 'Go On Duty'}</Text>
            </Pressable>
          </View>

          {dutyError ? (
            <View style={styles.hubError}>
              <Text style={{ color: '#fca5a5', fontSize: 12 }}>{dutyError}</Text>
            </View>
          ) : null}
        </View>

        {/* 2. Situational hub */}
        {topDispatch ? (
          <Pressable
            style={[styles.situational, { backgroundColor: colors.tintCriticalBg, borderRadius: tokens.radius.lg }]}
            onPress={() => router.push(`/assignments/${encodeURIComponent(topDispatch.local_id)}`)}
          >
            <View style={styles.situationalHeader}>
              <View style={{ flexDirection: 'row', alignItems: 'center', gap: 6 }}>
                <Ionicons name="alert-circle" size={16} color={colors.critical} />
                <Text style={{ color: colors.critical, fontSize: 12, fontWeight: '800' }}>
                  ACTIVE DISPATCH #{topDispatch.server_dispatch_id ?? topDispatch.local_id.slice(0, 6)}
                </Text>
              </View>
              <View style={{ backgroundColor: colors.critical, borderRadius: 999, paddingHorizontal: 8, paddingVertical: 3 }}>
                <Text style={{ color: '#fff', fontSize: 10, fontWeight: '800' }}>{topDispatch.priority.toUpperCase()}</Text>
              </View>
            </View>
            <Text style={{ color: colors.textPrimary, fontSize: 16, fontWeight: '800', marginTop: 8 }}>
              {topDispatch.redacted_incident_type ? topDispatch.redacted_incident_type.replace(/_/g, ' ').toUpperCase() : 'INCIDENT REPORTED'}
            </Text>
            <Text style={{ color: colors.textSecondary, fontSize: 12, marginTop: 4 }}>
              Assigned to your unit{activeDispatchCount > 1 ? ` · ${activeDispatchCount} active assignments` : ''} · Tap to navigate.
            </Text>
            <View style={[styles.navigateBtn, { backgroundColor: colors.critical }]}>
              <Text style={{ color: '#fff', fontWeight: '800', fontSize: 13 }}>NAVIGATE ROUTE</Text>
              <Ionicons name="arrow-forward" size={16} color="#fff" />
            </View>
          </Pressable>
        ) : (
          <View style={[styles.situational, { backgroundColor: colors.tintSuccessBg, borderRadius: tokens.radius.lg }]}>
            <View style={styles.situationalHeader}>
              <View style={{ flexDirection: 'row', alignItems: 'center', gap: 6 }}>
                <Ionicons name="shield-checkmark" size={16} color={colors.success} />
                <Text style={{ color: colors.success, fontSize: 12, fontWeight: '800' }}>PERIMETER CLEAR · SECTOR {barangayName.toUpperCase()}</Text>
              </View>
              <View style={{ backgroundColor: colors.success, borderRadius: 999, paddingHorizontal: 8, paddingVertical: 3 }}>
                <Text style={{ color: '#fff', fontSize: 10, fontWeight: '800' }}>READY</Text>
              </View>
            </View>
            <Text style={{ color: colors.textSecondary, fontSize: 13, marginTop: 6 }}>No active emergency dispatches in queue.</Text>
          </View>
        )}

        {/* 3. Primary action tiles */}
        <View style={styles.actionGrid}>
          <Pressable style={[styles.actionCard, { backgroundColor: colors.surface, borderRadius: tokens.radius.md }]} onPress={() => router.push('/incidents/new')}>
            <View style={[styles.actionIcon, { backgroundColor: colors.tintInfoBg }]}>
              <Ionicons name="document-text" size={20} color={colors.primary} />
            </View>
            <Text style={[styles.actionTitle, { color: colors.textPrimary }]}>Log Incident</Text>
            <Text style={{ color: colors.textTertiary, fontSize: 11 }}>Rapid field report intake</Text>
          </Pressable>

          <Pressable style={[styles.actionCard, { backgroundColor: colors.surface, borderRadius: tokens.radius.md }]} onPress={() => router.push('/(tabs)/map')}>
            <View style={[styles.actionIcon, { backgroundColor: colors.tintInfoBg }]}>
              <Ionicons name="map" size={20} color={colors.primary} />
            </View>
            <Text style={[styles.actionTitle, { color: colors.textPrimary }]}>Live Radar</Text>
            <Text style={{ color: colors.textTertiary, fontSize: 11 }}>Team map & telemetry</Text>
          </Pressable>
        </View>

        {/* 4. Shift telemetry strip */}
        <View style={[styles.shiftStrip, { backgroundColor: colors.surface, borderRadius: tokens.radius.md }]}>
          <ShiftMetric icon="time" value={dutyOn ? shiftElapsed : 'Standby'} label={dutyOn ? 'Active Patrol' : 'Off Duty'} colors={colors} />
          <ShiftMetric icon="radio" value={dutyOn ? '30s Sync' : 'GPS Idle'} label="HQ Radar" colors={colors} live={dutyOn} />
          <ShiftMetric icon="document-text" value={`${todayIncidentCount} Filed`} label="Today" colors={colors} />
        </View>

        {/* 5. Emergency SOS panel */}
        <View style={[styles.sosPanel, { backgroundColor: colors.navyDeep, borderRadius: tokens.radius.lg }]}>
          <Pressable
            onPressIn={startHoldSos}
            onPressOut={cancelHoldSos}
            style={styles.sosStrip}
          >
            <View style={[styles.sosProgressFill, { width: `${holdProgress}%` }]} />
            <View style={styles.sosContent}>
              <View style={styles.sosIconWrap}>
                <Ionicons name="warning" size={22} color="#fca5a5" />
              </View>
              <View style={{ flex: 1 }}>
                <Text style={styles.sosTitle}>
                  {raisingSos ? 'Transmitting SOS…' : holdProgress > 0 ? `Holding (${Math.round(holdProgress)}%)…` : 'EMERGENCY SOS BACKUP'}
                </Text>
                <Text style={styles.sosSub}>{holdProgress > 0 ? 'Release to cancel · Keep holding' : 'Press & hold 2s to alert HQ and nearby responders'}</Text>
              </View>
              <Text style={styles.sosCountdown}>{raisingSos ? '...' : holdProgress > 0 ? `${Math.round(holdProgress)}%` : 'HOLD 2S'}</Text>
            </View>
          </Pressable>

          {sosFallbackOutcome ? (
            <View style={{ marginTop: 10, alignItems: 'center' }}>
              <SmsFallbackBadge input={sosFallbackOutcome} />
            </View>
          ) : null}

          <View style={styles.speedDialDock}>
            <View style={styles.speedDialLabel}>
              <Ionicons name="call" size={12} color="rgba(255,255,255,0.6)" />
              <Text style={{ color: 'rgba(255,255,255,0.6)', fontSize: 11 }}>Direct Emergency Voice Lines</Text>
            </View>
            <View style={styles.speedDialGrid}>
              <SpeedDialButton icon="call" title="Brgy Desk" sub="HQ Dispatch" onPress={() => Linking.openURL(`tel:${deskContact.replace(/[^0-9+]/g, '') || '911'}`)} />
              <SpeedDialButton icon="shield" title="Police 911" sub="PNP Station" onPress={() => Linking.openURL('tel:911')} />
              <SpeedDialButton icon="medkit" title="MDRRMO" sub="Rescue / BFP" onPress={() => Linking.openURL('tel:160')} />
            </View>
          </View>
        </View>

        {sosError ? (
          <View style={{ backgroundColor: colors.tintCriticalBg, borderRadius: tokens.radius.md, padding: 12 }}>
            <Text style={{ color: colors.pillCriticalText, fontSize: 13 }}>{sosError}</Text>
          </View>
        ) : null}

        {dutyToast ? (
          <View style={[styles.toast, { backgroundColor: colors.success }]}>
            <Text style={styles.toastText}>{dutyToast}</Text>
          </View>
        ) : null}
        {sosToast ? (
          <View style={[styles.toast, { backgroundColor: sosToast.startsWith('EMERGENCY') ? colors.critical : colors.warning }]}>
            <Text style={styles.toastText}>{sosToast}</Text>
          </View>
        ) : null}
      </ScrollView>
    </View>
  );
}

function ShiftMetric({ icon, value, label, colors, live }: { icon: keyof typeof Ionicons.glyphMap; value: string; label: string; colors: ReturnType<typeof useTheme>['colors']; live?: boolean }) {
  return (
    <View style={{ flex: 1, flexDirection: 'row', alignItems: 'center', gap: 8 }}>
      <View style={{ width: 30, height: 30, borderRadius: 15, alignItems: 'center', justifyContent: 'center', backgroundColor: live ? colors.tintSuccessBg : colors.tintNeutralBg }}>
        <Ionicons name={icon} size={14} color={live ? colors.success : colors.textTertiary} />
      </View>
      <View>
        <Text style={{ color: colors.textPrimary, fontSize: 13, fontWeight: '700' }}>{value}</Text>
        <Text style={{ color: colors.textTertiary, fontSize: 10 }}>{label}</Text>
      </View>
    </View>
  );
}

function SpeedDialButton({ icon, title, sub, onPress }: { icon: keyof typeof Ionicons.glyphMap; title: string; sub: string; onPress: () => void }) {
  return (
    <Pressable
      style={{ flex: 1, backgroundColor: 'rgba(255,255,255,0.06)', borderRadius: 12, padding: 10, alignItems: 'center', gap: 4 }}
      onPress={() => {
        tacticalFeedback.onWarning();
        onPress();
      }}
    >
      <Ionicons name={icon} size={16} color="#fff" />
      <Text style={{ color: '#fff', fontSize: 11, fontWeight: '700' }}>{title}</Text>
      <Text style={{ color: 'rgba(255,255,255,0.5)', fontSize: 9 }}>{sub}</Text>
    </Pressable>
  );
}

const styles = StyleSheet.create({
  scroll: { padding: 16, gap: 14 },
  hub: { padding: 16 },
  hubTop: { flexDirection: 'row', alignItems: 'center', gap: 12 },
  avatar: { width: 44, height: 44, borderRadius: 22, backgroundColor: 'rgba(255,255,255,0.15)', alignItems: 'center', justifyContent: 'center' },
  avatarText: { color: '#fff', fontWeight: '800', fontSize: 15 },
  hubName: { color: '#fff', fontSize: 17, fontWeight: '800' },
  hubSubRow: { flexDirection: 'row', alignItems: 'center', gap: 5, marginTop: 2 },
  hubSub: { color: 'rgba(255,255,255,0.75)', fontSize: 12 },
  hubDivider: { height: 1, backgroundColor: 'rgba(255,255,255,0.12)', marginVertical: 12 },
  hubBottom: { flexDirection: 'row', alignItems: 'center', gap: 10 },
  pulseDot: { width: 10, height: 10, borderRadius: 5 },
  hubStatusTitle: { fontSize: 14, fontWeight: '800' },
  hubStatusSub: { color: 'rgba(255,255,255,0.6)', fontSize: 11, marginTop: 2 },
  dutyBtn: { paddingHorizontal: 16, paddingVertical: 10, borderRadius: 10 },
  dutyBtnText: { color: '#fff', fontWeight: '800', fontSize: 13 },
  hubError: { marginTop: 10, backgroundColor: 'rgba(220,38,38,0.25)', borderRadius: 8, padding: 8 },
  situational: { padding: 16 },
  situationalHeader: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between' },
  navigateBtn: { flexDirection: 'row', alignItems: 'center', justifyContent: 'center', gap: 6, borderRadius: 10, paddingVertical: 10, marginTop: 12 },
  actionGrid: { flexDirection: 'row', gap: 12 },
  actionCard: { flex: 1, padding: 14, gap: 6 },
  actionIcon: { width: 36, height: 36, borderRadius: 18, alignItems: 'center', justifyContent: 'center' },
  actionTitle: { fontSize: 14, fontWeight: '700' },
  shiftStrip: { flexDirection: 'row', padding: 14, gap: 8 },
  sosPanel: { padding: 14 },
  sosStrip: { position: 'relative', overflow: 'hidden', borderRadius: 14, backgroundColor: 'rgba(220,38,38,0.18)', borderWidth: 1, borderColor: 'rgba(220,38,38,0.4)' },
  sosProgressFill: { position: 'absolute', left: 0, top: 0, bottom: 0, backgroundColor: 'rgba(220,38,38,0.35)' },
  sosContent: { flexDirection: 'row', alignItems: 'center', gap: 12, padding: 16 },
  sosIconWrap: { width: 40, height: 40, borderRadius: 20, backgroundColor: 'rgba(220,38,38,0.3)', alignItems: 'center', justifyContent: 'center' },
  sosTitle: { color: '#fff', fontWeight: '800', fontSize: 14 },
  sosSub: { color: 'rgba(255,255,255,0.65)', fontSize: 11, marginTop: 2 },
  sosCountdown: { color: '#fca5a5', fontWeight: '800', fontSize: 13 },
  speedDialDock: { marginTop: 14 },
  speedDialLabel: { flexDirection: 'row', alignItems: 'center', gap: 6, marginBottom: 8 },
  speedDialGrid: { flexDirection: 'row', gap: 8 },
  toast: { borderRadius: 10, padding: 12 },
  toastText: { color: '#fff', fontSize: 13, fontWeight: '600' },
});
