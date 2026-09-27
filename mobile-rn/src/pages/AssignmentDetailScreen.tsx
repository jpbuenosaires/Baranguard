/**
 * M6 Assignment Detail / Navigation. Port of
 * ../mobile/src/pages/assignment-detail.tsx.
 *
 * Status changes may be made offline and queue into
 * `dispatch_status_updates[]`; they reconcile using idempotent client
 * event IDs and the dispatch transition matrix. A client must not locally
 * skip states — the status button always advances by exactly ONE step
 * (`nextStatusFor`), structurally, not by convention:
 *   1. Applies the change to `dispatch_local` immediately (optimistic).
 *   2. Tries `PATCH /dispatch/:id/status` immediately.
 *   3. On success, marks the local row synced. On ANY failure, the SAME
 *      event id is queued into `offline_queue_local` for later sync.
 *
 * "Get Route" is an explicit tap, matching the old app's battery/data
 * reasoning and ORS's request-limited free tier.
 *
 * SCOPE NOTE: the embedded live map (`LiveMapCanvas`/MapLibre) is Phase 5
 * scope. This screen has full status/route/turn-by-turn logic now, with a
 * placeholder in place of the map — swapped for the real one once Phase 5
 * lands, per this rebuild's own phase plan.
 */
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { router, useLocalSearchParams } from 'expo-router';
import { ActivityIndicator, Linking, Pressable, ScrollView, StyleSheet, Text, View } from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import MobileHeader from '../components/MobileHeader';
import { LoadingBlock } from '../components/LoadingBlock';
import ActiveStepCard from '../components/ActiveStepCard';
import { useTheme } from '../theme/ThemeProvider';
import { ApiError, getDispatchRoute, updateDispatchStatus, type RouteData } from '../services/apiService';
import { applyLocalStatusChange, cacheRouteFetch, getCachedDispatch, isCacheStale, markStatusSynced, nextStatusFor } from '../services/db/dispatchRepository';
import { enqueueDispatchStatusChange } from '../services/db/offlineQueueRepository';
import type { DispatchLocalRow } from '../services/db/localSchema';
import { getCurrentPosition, watchPosition, type DevicePosition } from '../services/geolocation';
import tacticalFeedback from '../utils/tacticalFeedback';
import { computeNavigationState, formatRemainingTime, formatNavDistance, type NavigationState } from '../utils/routeProgress';
import { distanceMeters, formatDistance } from '../utils/geo';

const STATUS_LABEL: Record<string, string> = { assigned: 'Assigned', en_route: 'En Route', arrived: 'Arrived', completed: 'Completed' };
const NEXT_ACTION_LABEL: Record<string, string> = { en_route: 'Mark En Route', arrived: 'Mark Arrived', completed: 'Mark Completed' };
const ROUTE_STATUS_LABEL: Record<string, string> = { available: 'Route available', unavailable: 'No route available', stale: 'Route may be out of date' };
const STAGES = ['assigned', 'en_route', 'arrived', 'completed'];

export default function AssignmentDetailScreen() {
  const { colors, tokens } = useTheme();
  const { localId = '' } = useLocalSearchParams<{ localId: string }>();
  const [row, setRow] = useState<DispatchLocalRow | null>(null);
  const [loading, setLoading] = useState(true);
  const [updating, setUpdating] = useState(false);
  const [note, setNote] = useState<string | null>(null);
  const [position, setPosition] = useState<DevicePosition | null>(null);
  const [fetchingRoute, setFetchingRoute] = useState(false);
  const [navigationActive, setNavigationActive] = useState(false);
  const arrivalPromptedRef = useRef(false);
  const autoFetchedRef = useRef(false);

  useEffect(() => {
    if (!note) return;
    const timer = setTimeout(() => setNote(null), 4000);
    return () => clearTimeout(timer);
  }, [note]);

  useEffect(() => {
    let active = true;
    getCachedDispatch(localId).then((found) => {
      if (active) {
        setRow(found);
        setLoading(false);
      }
    });
    return () => {
      active = false;
    };
  }, [localId]);

  // Purely derived from the cached row — hydrates whatever was already
  // cached (a prior fetch this session, or one carried in from GET
  // /dispatch's own list refresh) so reopening this screen shows the last
  // known route immediately.
  const route = useMemo<RouteData | null>(() => {
    if (!row?.route_json) return null;
    try {
      return JSON.parse(row.route_json) as RouteData;
    } catch {
      return null;
    }
  }, [row]);

  useEffect(() => {
    // Auto-activates navigation mode whenever the assignment (re-)enters
    // en_route — a real UI-mode sync from external data, not a value
    // derivable during render (navigationActive can also be toggled off
    // manually afterward, so it isn't purely a function of row.status).
    // eslint-disable-next-line react-hooks/set-state-in-effect
    if (row?.status === 'en_route') setNavigationActive(true);
  }, [row?.status]);

  useEffect(() => {
    let stopWatch: (() => void) | undefined;
    let cancelled = false;

    getCurrentPosition()
      .then((p) => {
        if (!cancelled) setPosition(p);
      })
      .catch(() => {});

    watchPosition((p) => {
      if (!cancelled) setPosition(p);
    })
      .then((stop) => {
        if (cancelled) stop();
        else stopWatch = stop;
      })
      .catch(() => {});

    return () => {
      cancelled = true;
      stopWatch?.();
    };
  }, []);

  const handleGetRoute = useCallback(async () => {
    if (!row || row.server_dispatch_id === null || !position) {
      setNote(position ? 'This assignment has no server id yet — cannot fetch a route.' : 'Waiting for a GPS fix — try again in a moment.');
      return;
    }
    setFetchingRoute(true);
    setNote(null);
    try {
      const result = await getDispatchRoute(row.server_dispatch_id, { latitude: position.latitude, longitude: position.longitude });
      await cacheRouteFetch(row.local_id, result.routeJson, result.routeStatus);
      setRow(await getCachedDispatch(row.local_id));
      setNote(
        result.routeStatus === 'available' ? 'Route updated.' : result.routeStatus === 'stale' ? 'Could not refresh — showing the last known route.' : 'No route available right now.',
      );
    } catch (error) {
      setNote(error instanceof ApiError && error.isOffline ? 'Offline — cannot fetch a route right now.' : 'Workstation unreachable — cannot fetch a route right now.');
    } finally {
      setFetchingRoute(false);
    }
  }, [row, position]);

  useEffect(() => {
    if (!autoFetchedRef.current && row && row.server_dispatch_id !== null && position && (!route || row.route_status === 'stale')) {
      autoFetchedRef.current = true;
      void handleGetRoute();
    }
  }, [row, position, route, handleGetRoute]);

  // Recomputed on every GPS update — purely derived from navigationActive/
  // route/position, no reason for this to be state+effect.
  const navState = useMemo<NavigationState | null>(() => {
    if (!navigationActive || !route || !position) return null;
    return computeNavigationState(position, route);
  }, [navigationActive, route, position]);

  useEffect(() => {
    // Arrival is a genuine one-shot side effect (haptic + toast) reacting
    // to a derived value crossing a threshold — not itself derivable
    // during render.
    if (navState?.hasArrived && !arrivalPromptedRef.current) {
      arrivalPromptedRef.current = true;
      tacticalFeedback.vibrate([80, 100, 80, 100, 80]);
      setNote(row?.status === 'en_route' ? 'You have arrived at the destination — tap "Mark Arrived" to update your status.' : 'You have arrived at the destination.');
    }
  }, [navState?.hasArrived, row?.status]);

  async function handleAdvanceStatus() {
    if (!row) return;
    const next = nextStatusFor(row.status);
    if (!next) return;
    if (row.server_dispatch_id === null) {
      setNote('This assignment has no server id yet — cannot change status.');
      return;
    }

    setUpdating(true);
    setNote(null);
    try {
      const { clientEventId } = await applyLocalStatusChange(row.local_id, next);
      tacticalFeedback.vibrate([40, 50, 40]);
      setRow(await getCachedDispatch(row.local_id));

      try {
        await updateDispatchStatus(row.server_dispatch_id, next);
        await markStatusSynced(row.local_id);
        setRow(await getCachedDispatch(row.local_id));
        setNote(`Status updated to ${STATUS_LABEL[next]}.`);
      } catch (error) {
        await enqueueDispatchStatusChange(clientEventId, { dispatchLocalId: row.local_id, serverDispatchId: row.server_dispatch_id, status: next });
        setNote(
          error instanceof ApiError && error.isOffline
            ? `Offline — status set to ${STATUS_LABEL[next]} locally and queued to sync.`
            : `Workstation unreachable — status set to ${STATUS_LABEL[next]} locally and queued to sync.`,
        );
      }
    } finally {
      setUpdating(false);
    }
  }

  function handleOpenExternalMaps() {
    if (!row || row.latitude === null || row.longitude === null) return;
    void Linking.openURL(`geo:${row.latitude},${row.longitude}?q=${row.latitude},${row.longitude}`);
  }

  if (loading) {
    return (
      <View style={{ flex: 1, backgroundColor: colors.bg }}>
        <MobileHeader title="DISPATCH" showBack />
        <LoadingBlock />
      </View>
    );
  }

  if (!row) {
    return (
      <View style={{ flex: 1, backgroundColor: colors.bg }}>
        <MobileHeader title="DISPATCH" showBack />
        <View style={styles.notFound}>
          <Text style={{ color: colors.textSecondary, marginBottom: 16 }}>This assignment is not found in the local device cache.</Text>
          <Pressable style={[styles.primaryBtn, { backgroundColor: colors.primary }]} onPress={() => router.back()}>
            <Text style={styles.primaryBtnText}>Back to Assignments</Text>
          </Pressable>
        </View>
      </View>
    );
  }

  const stale = isCacheStale(row);
  const next = nextStatusFor(row.status);
  const currentStageIndex = STAGES.indexOf(row.status);
  const hasTarget = row.latitude !== null && row.longitude !== null;
  const distanceText =
    position && hasTarget
      ? `${formatDistance(distanceMeters(position.latitude, position.longitude, row.latitude!, row.longitude!))} away`
      : hasTarget
        ? `${row.latitude!.toFixed(4)}, ${row.longitude!.toFixed(4)}`
        : 'Target location set';

  const mapPlaceholder = (
    <View style={[styles.mapPlaceholder, { backgroundColor: colors.navyDeep, borderRadius: tokens.radius.md }]}>
      <Ionicons name="map-outline" size={28} color="rgba(255,255,255,0.5)" />
      <Text style={styles.mapPlaceholderText}>Live map lands in Phase 5</Text>
      {hasTarget ? <Text style={styles.mapPlaceholderCoords}>{row.latitude!.toFixed(5)}, {row.longitude!.toFixed(5)}</Text> : null}
    </View>
  );

  if (navigationActive) {
    return (
      <View style={{ flex: 1, backgroundColor: colors.navyDeep }}>
        <MobileHeader title={`DISPATCH #${row.server_dispatch_id ?? row.local_id.slice(0, 6)}`} subtitle="Turn-by-Turn Guidance" showBack />
        <View style={{ height: 200 }}>{mapPlaceholder}</View>
        {navState && route ? <ActiveStepCard navState={navState} steps={route.steps} mode={route.mode} onReroute={handleGetRoute} /> : null}

        <View style={styles.floatingControls}>
          <FloatingBtn icon="refresh-outline" onPress={handleGetRoute} busy={fetchingRoute} disabled={!position} />
          <FloatingBtn icon="open-outline" onPress={handleOpenExternalMaps} />
          <FloatingBtn icon="stop-outline" onPress={() => setNavigationActive(false)} tone="critical" />
        </View>

        {note ? (
          <View style={styles.toast}>
            <Text style={{ color: '#fff', fontSize: 13 }}>{note}</Text>
          </View>
        ) : null}

        <View style={[styles.bottomSheet, { backgroundColor: colors.surface, borderTopLeftRadius: tokens.radius.xl, borderTopRightRadius: tokens.radius.xl }]}>
          <View style={styles.sheetHeader}>
            <View style={styles.sheetTitleRow}>
              <Pill label={row.priority.toUpperCase()} tone={row.priority === 'critical' ? 'critical' : row.priority === 'high' ? 'warning' : 'info'} colors={colors} />
              <Text style={[styles.sheetTitle, { color: colors.textPrimary }]}>
                {row.redacted_incident_type ? row.redacted_incident_type.replace(/_/g, ' ').toUpperCase() : 'INCIDENT'}
              </Text>
            </View>
            <View style={[styles.statusChip, { backgroundColor: colors.surfaceBlue }]}>
              <Text style={{ color: colors.primary, fontSize: 12, fontWeight: '700' }}>{STATUS_LABEL[row.status] ?? row.status}</Text>
            </View>
          </View>

          <Text style={{ color: colors.textSecondary, fontSize: 13, marginBottom: 12 }}>
            {navState ? `${formatRemainingTime(navState.remainingTimeS)} (${formatNavDistance(navState.remainingDistanceM)} remaining)` : distanceText}
          </Text>

          {next ? (
            <Pressable
              disabled={updating}
              onPress={handleAdvanceStatus}
              style={[styles.primaryBtn, { backgroundColor: row.priority === 'critical' ? colors.critical : colors.primary, opacity: updating ? 0.7 : 1 }]}
            >
              {updating ? <ActivityIndicator color="#fff" /> : <Text style={styles.primaryBtnText}>{NEXT_ACTION_LABEL[next]}</Text>}
            </Pressable>
          ) : (
            <View style={styles.completedRow}>
              <Ionicons name="checkmark-circle-outline" size={18} color={colors.success} />
              <Text style={{ color: colors.success, fontWeight: '700' }}>Dispatch assignment completed</Text>
            </View>
          )}

          {row.synced === 0 ? (
            <View style={styles.syncNote}>
              <Ionicons name="sync-outline" size={12} color={colors.warning} />
              <Text style={{ color: colors.warning, fontSize: 11 }}>Pending synchronization with Barangay HQ</Text>
            </View>
          ) : null}
        </View>
      </View>
    );
  }

  return (
    <View style={{ flex: 1, backgroundColor: colors.bg }}>
      <MobileHeader title={`DISPATCH #${row.server_dispatch_id ?? row.local_id.slice(0, 6)}`} subtitle="Field Assignment Detail" showBack />
      <ScrollView contentContainerStyle={styles.content}>
        <View style={[styles.briefingCard, { backgroundColor: colors.surface, borderRadius: tokens.radius.lg }]}>
          <View style={styles.rowBetween}>
            <Pill label={`${row.priority.toUpperCase()} PRIORITY`} tone={row.priority === 'critical' ? 'critical' : row.priority === 'high' ? 'warning' : 'info'} colors={colors} />
            <Pill label={STATUS_LABEL[row.status] ?? row.status} tone="info" colors={colors} />
          </View>
          <Text style={[styles.briefingTitle, { color: colors.textPrimary }]}>
            {row.redacted_incident_type ? row.redacted_incident_type.replace(/_/g, ' ').toUpperCase() : 'INCIDENT BRIEFING'}
          </Text>
          <View style={styles.rowBetween}>
            <View style={styles.geoRow}>
              <Ionicons name="location-outline" size={14} color={colors.primary} />
              <Text style={{ color: colors.textSecondary, fontSize: 13 }}>{distanceText}</Text>
            </View>
            <Text style={{ color: colors.textTertiary, fontSize: 11 }}>
              {ROUTE_STATUS_LABEL[row.route_status] ?? row.route_status}
              {stale ? ' (Cached)' : ''}
            </Text>
          </View>
        </View>

        <View style={[styles.stepperCard, { backgroundColor: colors.surface, borderRadius: tokens.radius.lg }]}>
          <Text style={styles.stepperLabel}>DISPATCH WORKFLOW</Text>
          <View style={styles.stepperRow}>
            {STAGES.map((stage, idx) => {
              const done = idx < currentStageIndex;
              const activeStage = idx === currentStageIndex;
              return (
                <View key={stage} style={styles.stepperStep}>
                  <View
                    style={[
                      styles.stepperNode,
                      { backgroundColor: done ? colors.success : activeStage ? colors.primary : colors.surfaceHover, borderColor: colors.border },
                    ]}
                  >
                    {done ? <Ionicons name="checkmark" size={14} color="#fff" /> : <Text style={{ color: activeStage ? '#fff' : colors.textTertiary, fontWeight: '700' }}>{idx + 1}</Text>}
                  </View>
                  <Text style={{ color: activeStage ? colors.primary : colors.textTertiary, fontSize: 10, fontWeight: activeStage ? '700' : '400' }}>{STATUS_LABEL[stage]}</Text>
                </View>
              );
            })}
          </View>
        </View>

        {hasTarget ? (
          <View style={{ marginBottom: 16 }}>
            <View style={{ height: 180 }}>{mapPlaceholder}</View>
            <View style={styles.mapActionsRow}>
              <Pressable onPress={handleGetRoute} disabled={fetchingRoute || !position} style={styles.mapAction}>
                {fetchingRoute ? <ActivityIndicator size="small" color={colors.primary} /> : <Ionicons name="refresh-outline" size={14} color={colors.primary} />}
                <Text style={{ color: colors.primary, fontSize: 12, fontWeight: '700' }}>Re-route</Text>
              </Pressable>
              <Pressable onPress={handleOpenExternalMaps} style={styles.mapAction}>
                <Ionicons name="open-outline" size={14} color={colors.textSecondary} />
                <Text style={{ color: colors.textSecondary, fontSize: 12 }}>External Maps</Text>
              </Pressable>
            </View>
          </View>
        ) : null}

        {note ? (
          <View style={[styles.inlineNote, { backgroundColor: colors.tintInfoBg, borderRadius: tokens.radius.md }]}>
            <Text style={{ color: colors.pillInfoText, fontSize: 13 }}>{note}</Text>
          </View>
        ) : null}

        {row.synced === 0 ? (
          <View style={[styles.inlineNote, { backgroundColor: colors.tintWarningBg, borderRadius: tokens.radius.md, flexDirection: 'row', alignItems: 'center', gap: 8 }]}>
            <Ionicons name="sync-outline" size={14} color={colors.pillWarningText} />
            <Text style={{ color: colors.pillWarningText, fontSize: 13 }}>Pending synchronization with Barangay HQ.</Text>
          </View>
        ) : null}

        <Pressable
          onPress={() => {
            tacticalFeedback.onTap();
            if (row.status === 'assigned') void handleAdvanceStatus();
            setNavigationActive(true);
          }}
          style={[styles.primaryBtn, { backgroundColor: colors.primary }]}
        >
          <Ionicons name="navigate-outline" size={16} color="#fff" />
          <Text style={styles.primaryBtnText}>{row.status === 'assigned' ? 'Start Navigation & En Route' : 'Resume Navigation'}</Text>
        </Pressable>

        {next && row.status !== 'assigned' ? (
          <Pressable disabled={updating} onPress={handleAdvanceStatus} style={[styles.outlineBtn, { borderColor: colors.border }]}>
            {updating ? <ActivityIndicator color={colors.textPrimary} /> : <Text style={{ color: colors.textPrimary, fontWeight: '700' }}>{NEXT_ACTION_LABEL[next]}</Text>}
          </Pressable>
        ) : null}
      </ScrollView>
    </View>
  );
}

function FloatingBtn({
  icon,
  onPress,
  busy,
  disabled,
  tone,
}: {
  icon: keyof typeof Ionicons.glyphMap;
  onPress: () => void;
  busy?: boolean;
  disabled?: boolean;
  tone?: 'critical';
}) {
  return (
    <Pressable onPress={onPress} disabled={disabled} style={[styles.floatingBtn, { opacity: disabled ? 0.5 : 1 }]}>
      {busy ? <ActivityIndicator size="small" color="#3b82f6" /> : <Ionicons name={icon} size={18} color={tone === 'critical' ? '#dc2626' : '#3b82f6'} />}
    </Pressable>
  );
}

function Pill({ label, tone, colors }: { label: string; tone: 'info' | 'warning' | 'critical'; colors: ReturnType<typeof useTheme>['colors'] }) {
  const bg = { warning: colors.tintWarningBg, critical: colors.tintCriticalBg, info: colors.tintInfoBg }[tone];
  const fg = { warning: colors.pillWarningText, critical: colors.pillCriticalText, info: colors.pillInfoText }[tone];
  return (
    <View style={{ backgroundColor: bg, borderRadius: 8, paddingHorizontal: 8, paddingVertical: 3 }}>
      <Text style={{ color: fg, fontSize: 11, fontWeight: '700' }}>{label}</Text>
    </View>
  );
}

const styles = StyleSheet.create({
  content: { padding: 16 },
  notFound: { flex: 1, alignItems: 'center', justifyContent: 'center', padding: 24 },
  primaryBtn: { flexDirection: 'row', gap: 8, alignItems: 'center', justifyContent: 'center', borderRadius: 12, paddingVertical: 14, marginBottom: 10 },
  primaryBtnText: { color: '#fff', fontWeight: '800', fontSize: 15 },
  outlineBtn: { borderWidth: 1, borderRadius: 12, paddingVertical: 12, alignItems: 'center' },
  briefingCard: { padding: 16, marginBottom: 14, gap: 8 },
  rowBetween: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center' },
  briefingTitle: { fontSize: 18, fontWeight: '800' },
  geoRow: { flexDirection: 'row', alignItems: 'center', gap: 6 },
  stepperCard: { padding: 14, marginBottom: 14 },
  stepperLabel: { fontSize: 12, fontWeight: '700', color: '#64748b', marginBottom: 10 },
  stepperRow: { flexDirection: 'row', justifyContent: 'space-between' },
  stepperStep: { alignItems: 'center', gap: 4, flex: 1 },
  stepperNode: { width: 28, height: 28, borderRadius: 14, alignItems: 'center', justifyContent: 'center', borderWidth: 1 },
  mapPlaceholder: { flex: 1, alignItems: 'center', justifyContent: 'center', gap: 6 },
  mapPlaceholderText: { color: 'rgba(255,255,255,0.6)', fontSize: 12 },
  mapPlaceholderCoords: { color: 'rgba(255,255,255,0.4)', fontSize: 11, fontFamily: 'monospace' },
  mapActionsRow: { flexDirection: 'row', justifyContent: 'space-between', marginTop: 8, paddingHorizontal: 4 },
  mapAction: { flexDirection: 'row', alignItems: 'center', gap: 4 },
  inlineNote: { padding: 10, marginBottom: 12 },
  floatingControls: { position: 'absolute', right: 12, top: 220, gap: 10 },
  floatingBtn: { width: 40, height: 40, borderRadius: 20, backgroundColor: '#fff', alignItems: 'center', justifyContent: 'center' },
  toast: { position: 'absolute', bottom: 220, left: 16, right: 16, backgroundColor: 'rgba(0,0,0,0.8)', borderRadius: 10, padding: 10 },
  bottomSheet: { padding: 16, paddingBottom: 24 },
  sheetHeader: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center', marginBottom: 8 },
  sheetTitleRow: { flexDirection: 'row', alignItems: 'center', gap: 8, flex: 1 },
  sheetTitle: { fontSize: 13, fontWeight: '700' },
  statusChip: { paddingHorizontal: 8, paddingVertical: 3, borderRadius: 999 },
  completedRow: { flexDirection: 'row', alignItems: 'center', justifyContent: 'center', gap: 6, paddingVertical: 8 },
  syncNote: { flexDirection: 'row', alignItems: 'center', justifyContent: 'center', gap: 6, marginTop: 8 },
});
