/**
 * LiveMapScreen.tsx — M7 Live Map (§9 Mobile). Port of ../mobile's
 * live-map.tsx onto RN/expo-location/LiveMapCanvas.tsx (MapLibre Native).
 *
 * GPS broadcast here is FOREGROUND-ONLY, same documented scope as the old
 * app: starts when this screen mounts, stops when it unmounts. Continuous
 * background GPS (Phase 5's `patrol-location` native module) is a separate
 * concern started/stopped by duty status, not this screen — see
 * `geolocation.ts`'s and `patrolLocationService.ts`'s own header comments.
 * Every position update attempts a live `POST /gps`; on failure the point is
 * staged in `gps_track_local` instead — no position is ever silently
 * dropped.
 */
import { useEffect, useRef, useState } from 'react';
import { Pressable, RefreshControl, ScrollView, StyleSheet, Text, View } from 'react-native';
import * as Clipboard from 'expo-clipboard';
import { Ionicons } from '@expo/vector-icons';
import LiveMapCanvas, { type BasemapStatus, type LiveMapCanvasHandle } from '../components/LiveMapCanvas';
import { LoadingBlock } from '../components/LoadingBlock';
import MobileHeader from '../components/MobileHeader';
import { useTheme } from '../theme/ThemeProvider';
import {
  ApiError,
  getNearbyIncidents,
  getNearbyTanods,
  postGps,
  type NearbyIncident,
  type NearbyTanod,
} from '../services/apiService';
import { saveGpsPointLocally } from '../services/db/gpsTrackRepository';
import { getCurrentPosition, watchPosition, type DevicePosition } from '../services/geolocation';
import { ensureMapPackageDownloaded } from '../services/mapPackageService';
import { loadSession } from '../services/session';
import { uuid } from '../services/uuid';
import { bearingLabel, distanceMeters, formatDistance, formatRelativeAge } from '../utils/geo';
import tacticalFeedback from '../utils/tacticalFeedback';

const MIN_BROADCAST_INTERVAL_MS = 15000;
const NEARBY_REFRESH_INTERVAL_MS = 30000;
const STALE_AFTER_SECONDS = 120;

type RadarSegment = 'incidents' | 'tanods';

const PRIORITY_TONE: Record<string, 'info' | 'warning' | 'critical'> = { normal: 'info', high: 'warning', critical: 'critical' };

export default function LiveMapScreen() {
  const { colors, tokens } = useTheme();
  const [position, setPosition] = useState<DevicePosition | null>(null);
  const [positionError, setPositionError] = useState<string | null>(null);
  const [nearby, setNearby] = useState<NearbyIncident[]>([]);
  const [nearbyError, setNearbyError] = useState<string | null>(null);
  const [nearbyTanods, setNearbyTanods] = useState<NearbyTanod[]>([]);
  const [tanodsError, setTanodsError] = useState<string | null>(null);
  const [barangayId, setBarangayId] = useState<number | null>(null);
  const [basemapStatus, setBasemapStatus] = useState<BasemapStatus>({ kind: 'loading' });
  const [activeSegment, setActiveSegment] = useState<RadarSegment>('incidents');
  const [copiedAt, setCopiedAt] = useState<number | null>(null);
  // React Compiler forbids calling the impure Date.now() during render (the
  // "age" and "just copied" labels below need the current time) — a ticking
  // state value is the compiler-safe equivalent.
  const [nowMs, setNowMs] = useState(() => Date.now());

  useEffect(() => {
    const interval = setInterval(() => setNowMs(Date.now()), 1000);
    return () => clearInterval(interval);
  }, []);

  const lastBroadcastAt = useRef(0);
  const mapCanvasRef = useRef<LiveMapCanvasHandle | null>(null);

  useEffect(() => {
    let cancelled = false;
    async function loadBarangay() {
      const session = await loadSession();
      if (cancelled || !session) return;
      setBarangayId(session.barangayId);
      void ensureMapPackageDownloaded(session.barangayId);
    }
    void loadBarangay();
    return () => {
      cancelled = true;
    };
  }, []);

  useEffect(() => {
    let stopWatch: (() => void) | undefined;
    let cancelled = false;

    async function broadcast(point: DevicePosition) {
      const now = Date.now();
      if (now - lastBroadcastAt.current < MIN_BROADCAST_INTERVAL_MS) return;
      lastBroadcastAt.current = now;

      try {
        await postGps({
          latitude: point.latitude,
          longitude: point.longitude,
          accuracyM: point.accuracyM,
          recordedAt: point.recordedAt,
          clientEventId: uuid(),
        });
      } catch {
        await saveGpsPointLocally({
          latitude: point.latitude,
          longitude: point.longitude,
          accuracyM: point.accuracyM,
          recordedAt: point.recordedAt,
        });
      }
    }

    async function start() {
      try {
        const initial = await getCurrentPosition();
        if (cancelled) return;
        setPosition(initial);
        setPositionError(null);
        await broadcast(initial);
      } catch {
        setPositionError('Unable to read device location. Ensure GPS is enabled.');
      }

      try {
        stopWatch = await watchPosition((update) => {
          if (cancelled) return;
          setPosition(update);
          setPositionError(null);
          void broadcast(update);
        });
      } catch {
        setPositionError('Could not initialize real-time location tracking.');
      }
    }

    void start();
    return () => {
      cancelled = true;
      stopWatch?.();
    };
  }, []);

  useEffect(() => {
    if (!position) return undefined;
    let cancelled = false;
    const lat = position.latitude;
    const lng = position.longitude;

    async function refreshNearby() {
      try {
        const items = await getNearbyIncidents({ latitude: lat, longitude: lng });
        if (!cancelled) {
          setNearby(items);
          setNearbyError(null);
        }
      } catch (error) {
        if (!cancelled) {
          setNearbyError(error instanceof ApiError && error.isOffline ? 'Offline — nearby incident telemetry unavailable.' : 'Could not load nearby incidents.');
        }
      }
    }

    void refreshNearby();
    const interval = setInterval(refreshNearby, NEARBY_REFRESH_INTERVAL_MS);
    return () => {
      cancelled = true;
      clearInterval(interval);
    };
  }, [position]);

  useEffect(() => {
    if (!position) return undefined;
    let cancelled = false;

    async function refreshTanods() {
      try {
        const items = await getNearbyTanods();
        if (!cancelled) {
          setNearbyTanods(items);
          setTanodsError(null);
        }
      } catch (error) {
        if (!cancelled) {
          setTanodsError(error instanceof ApiError && error.isOffline ? 'Offline — nearby Tanod telemetry unavailable.' : 'Could not load nearby Tanods.');
        }
      }
    }

    void refreshTanods();
    const interval = setInterval(refreshTanods, NEARBY_REFRESH_INTERVAL_MS);
    return () => {
      cancelled = true;
      clearInterval(interval);
    };
  }, [position]);

  const ageSeconds = position ? Math.floor((nowMs - new Date(position.recordedAt).getTime()) / 1000) : null;
  const isLive = ageSeconds !== null && ageSeconds < STALE_AFTER_SECONDS;

  const basemapLabel =
    basemapStatus.kind === 'offline'
      ? `Offline MBTiles v${basemapStatus.version}`
      : basemapStatus.kind === 'online'
        ? 'Online OpenStreetMap'
        : basemapStatus.kind === 'unavailable'
          ? 'Basemap Unavailable'
          : 'Loading Tiles…';

  async function handleCopyCoords() {
    if (!position) return;
    const coordsStr = `${position.latitude.toFixed(5)}, ${position.longitude.toFixed(5)}`;
    await Clipboard.setStringAsync(coordsStr);
    tacticalFeedback.onTap();
    setCopiedAt(Date.now());
  }

  function handleFocusTarget(lat: number, lng: number) {
    tacticalFeedback.onTap();
    mapCanvasRef.current?.focusCoordinates(lat, lng, 16);
  }

  return (
    <View style={{ flex: 1, backgroundColor: colors.bg }}>
      <MobileHeader title="LIVE RADAR" subtitle="Field Telemetry" />
      <ScrollView contentContainerStyle={styles.scroll} refreshControl={<RefreshControl refreshing={false} onRefresh={() => undefined} />}>
        <View style={styles.mapWrapper}>
          <LiveMapCanvas
            ref={mapCanvasRef}
            barangayId={barangayId}
            position={position}
            incidents={nearby}
            tanods={nearbyTanods}
            onStatusChange={setBasemapStatus}
            height={330}
          />
          <View style={[styles.mapBadge, { backgroundColor: 'rgba(15,23,42,0.85)' }]}>
            <Ionicons name="navigate" size={12} color={colors.primary} />
            <Text style={styles.mapBadgeText}>{basemapLabel}</Text>
          </View>
        </View>

        <View style={[styles.hud, { backgroundColor: colors.navyDeep }]}>
          <View style={styles.hudHeader}>
            <View style={styles.hudTitleWrap}>
              <View style={[styles.hudIcon, { backgroundColor: isLive ? 'rgba(74,222,128,0.2)' : 'rgba(148,163,184,0.2)' }]}>
                <Ionicons name="locate" size={16} color={isLive ? '#4ade80' : '#94a3b8'} />
              </View>
              <View>
                <Text style={styles.hudTitle}>GPS Telemetry Lock</Text>
                <Text style={styles.hudSub}>{isLive ? 'Continuous GPS lock active' : 'Acquiring satellite fix…'}</Text>
              </View>
            </View>
            <View style={[styles.statusPill, { backgroundColor: isLive ? 'rgba(74,222,128,0.2)' : 'rgba(148,163,184,0.2)' }]}>
              <Text style={{ color: isLive ? '#4ade80' : '#cbd5e1', fontSize: 10, fontWeight: '700' }}>
                {isLive ? 'LIVE SATELLITE LOCK' : 'SIGNAL STALE'}
              </Text>
            </View>
          </View>

          {position ? (
            <Pressable style={styles.coordsPill} onPress={handleCopyCoords}>
              <View style={{ flex: 1 }}>
                <Text style={styles.coordsText}>
                  {position.latitude.toFixed(5)}, {position.longitude.toFixed(5)}
                </Text>
                <Text style={styles.coordsMeta}>
                  Accuracy: ±{position.accuracyM.toFixed(0)}m · {ageSeconds !== null ? formatRelativeAge(ageSeconds) : 'Live'}
                </Text>
              </View>
              <View style={styles.copyBtn}>
                <Ionicons name="copy-outline" size={14} color="#fff" />
                <Text style={styles.copyBtnText}>{copiedAt && nowMs - copiedAt < 2000 ? 'Copied' : 'Copy'}</Text>
              </View>
            </Pressable>
          ) : positionError ? (
            <View style={[styles.errorBox, { backgroundColor: colors.tintCriticalBg }]}>
              <Text style={{ color: colors.pillCriticalText, fontSize: 13 }}>{positionError}</Text>
            </View>
          ) : (
            <LoadingBlock label="Triangulating satellite coordinates…" />
          )}

          <View style={styles.broadcastRow}>
            <Ionicons name="radio-outline" size={14} color="#38bdf8" />
            <Text style={styles.broadcastText}>Transmitting live coordinates to Barangay HQ every 15s</Text>
          </View>
        </View>

        <View style={styles.segmentBar}>
          <Pressable
            style={[styles.segmentTab, activeSegment === 'incidents' ? { backgroundColor: colors.primary } : { backgroundColor: colors.surface }]}
            onPress={() => {
              tacticalFeedback.onTap();
              setActiveSegment('incidents');
            }}
          >
            <Ionicons name="alert-circle-outline" size={14} color={activeSegment === 'incidents' ? '#fff' : colors.textSecondary} />
            <Text style={{ color: activeSegment === 'incidents' ? '#fff' : colors.textSecondary, fontSize: 12, fontWeight: '700' }}>
              Nearby Incidents ({nearby.length})
            </Text>
          </Pressable>
          <Pressable
            style={[styles.segmentTab, activeSegment === 'tanods' ? { backgroundColor: colors.primary } : { backgroundColor: colors.surface }]}
            onPress={() => {
              tacticalFeedback.onTap();
              setActiveSegment('tanods');
            }}
          >
            <Ionicons name="people-outline" size={14} color={activeSegment === 'tanods' ? '#fff' : colors.textSecondary} />
            <Text style={{ color: activeSegment === 'tanods' ? '#fff' : colors.textSecondary, fontSize: 12, fontWeight: '700' }}>
              Peer Tanods ({nearbyTanods.length})
            </Text>
          </Pressable>
        </View>

        {activeSegment === 'incidents' ? (
          <View style={{ gap: 10 }}>
            {nearbyError ? (
              <View style={[styles.errorBox, { backgroundColor: colors.tintWarningBg }]}>
                <Text style={{ color: colors.pillWarningText, fontSize: 12 }}>{nearbyError}</Text>
              </View>
            ) : null}
            {nearby.length === 0 && !nearbyError ? (
              <EmptyNote colors={colors} text="No active incidents detected in your immediate perimeter." />
            ) : (
              nearby.map((incident) => (
                <Pressable
                  key={incident.incidentId}
                  style={[styles.itemCard, { backgroundColor: colors.surface, borderRadius: tokens.radius.md, borderLeftColor: toneColor(colors, PRIORITY_TONE[incident.priority]) }]}
                  onPress={() => handleFocusTarget(incident.latitude, incident.longitude)}
                >
                  <View style={styles.itemTop}>
                    <Text style={[styles.itemTitle, { color: colors.textPrimary }]}>{incident.incidentType.replace(/_/g, ' ').toUpperCase()}</Text>
                    <View style={[styles.pill, { backgroundColor: toneBg(colors, PRIORITY_TONE[incident.priority]) }]}>
                      <Text style={{ color: toneColor(colors, PRIORITY_TONE[incident.priority]), fontSize: 10, fontWeight: '700' }}>{incident.priority}</Text>
                    </View>
                  </View>
                  <View style={styles.itemMeta}>
                    <Ionicons name="location-outline" size={12} color={colors.textTertiary} />
                    <Text style={{ color: colors.textTertiary, fontSize: 11 }}>
                      {position
                        ? `${formatDistance(distanceMeters(position.latitude, position.longitude, incident.latitude, incident.longitude))} · ${bearingLabel(position.latitude, position.longitude, incident.latitude, incident.longitude)}`
                        : `${incident.latitude.toFixed(4)}, ${incident.longitude.toFixed(4)}`}
                    </Text>
                    <Ionicons name="time-outline" size={12} color={colors.textTertiary} />
                    <Text style={{ color: colors.textTertiary, fontSize: 11 }}>{formatRelativeAge(incident.ageSeconds)}</Text>
                  </View>
                </Pressable>
              ))
            )}
          </View>
        ) : (
          <View style={{ gap: 10 }}>
            {tanodsError ? (
              <View style={[styles.errorBox, { backgroundColor: colors.tintWarningBg }]}>
                <Text style={{ color: colors.pillWarningText, fontSize: 12 }}>{tanodsError}</Text>
              </View>
            ) : null}
            {nearbyTanods.length === 0 && !tanodsError ? (
              <EmptyNote colors={colors} text="No other Tanods have a recorded position right now." />
            ) : (
              nearbyTanods.map((tanod) => (
                <Pressable
                  key={tanod.userId}
                  style={[styles.itemCard, { backgroundColor: colors.surface, borderRadius: tokens.radius.md, borderLeftColor: tanod.isStale ? colors.textDisabled : colors.success }]}
                  onPress={() => handleFocusTarget(tanod.latitude, tanod.longitude)}
                >
                  <View style={styles.itemTop}>
                    <View style={{ flexDirection: 'row', alignItems: 'center', gap: 6 }}>
                      <Ionicons name="shield-checkmark-outline" size={14} color={colors.primary} />
                      <Text style={[styles.itemTitle, { color: colors.textPrimary }]}>{tanod.fullName}</Text>
                    </View>
                    <View style={[styles.pill, { backgroundColor: tanod.isStale ? colors.tintNeutralBg : colors.tintSuccessBg }]}>
                      <Text style={{ color: tanod.isStale ? colors.pillNeutralText : colors.pillSuccessText, fontSize: 10, fontWeight: '700' }}>
                        {tanod.isStale ? 'STALE' : 'LIVE'}
                      </Text>
                    </View>
                  </View>
                  <View style={styles.itemMeta}>
                    <Ionicons name="location-outline" size={12} color={colors.textTertiary} />
                    <Text style={{ color: colors.textTertiary, fontSize: 11 }}>
                      {position
                        ? `${formatDistance(distanceMeters(position.latitude, position.longitude, tanod.latitude, tanod.longitude))} · ${bearingLabel(position.latitude, position.longitude, tanod.latitude, tanod.longitude)}`
                        : `${tanod.latitude.toFixed(4)}, ${tanod.longitude.toFixed(4)}`}
                    </Text>
                    <Ionicons name="time-outline" size={12} color={colors.textTertiary} />
                    <Text style={{ color: colors.textTertiary, fontSize: 11 }}>{formatRelativeAge(tanod.ageSeconds)}</Text>
                  </View>
                  {tanod.dispatchId !== null ? (
                    <Text style={{ color: colors.primary, fontSize: 11, fontWeight: '700', marginTop: 6 }}>Assigned to Dispatch #{tanod.dispatchId}</Text>
                  ) : null}
                </Pressable>
              ))
            )}
          </View>
        )}
      </ScrollView>
    </View>
  );
}

function toneBg(colors: ReturnType<typeof useTheme>['colors'], tone: 'info' | 'warning' | 'critical'): string {
  return { info: colors.tintInfoBg, warning: colors.tintWarningBg, critical: colors.tintCriticalBg }[tone];
}
function toneColor(colors: ReturnType<typeof useTheme>['colors'], tone: 'info' | 'warning' | 'critical'): string {
  return { info: colors.pillInfoText, warning: colors.pillWarningText, critical: colors.pillCriticalText }[tone];
}

function EmptyNote({ colors, text }: { colors: ReturnType<typeof useTheme>['colors']; text: string }) {
  return (
    <View style={[styles.emptyNote, { backgroundColor: colors.surface, borderColor: colors.border }]}>
      <Text style={{ color: colors.textSecondary, fontSize: 13, textAlign: 'center' }}>{text}</Text>
    </View>
  );
}

const styles = StyleSheet.create({
  scroll: { padding: 16, gap: 14 },
  mapWrapper: { position: 'relative' },
  mapBadge: {
    position: 'absolute',
    top: 10,
    left: 10,
    flexDirection: 'row',
    alignItems: 'center',
    gap: 6,
    paddingHorizontal: 10,
    paddingVertical: 5,
    borderRadius: 999,
  },
  mapBadgeText: { color: '#fff', fontSize: 11, fontWeight: '600' },
  hud: { borderRadius: 16, padding: 14, gap: 12 },
  hudHeader: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', gap: 8 },
  hudTitleWrap: { flexDirection: 'row', alignItems: 'center', gap: 10, flex: 1 },
  hudIcon: { width: 32, height: 32, borderRadius: 16, alignItems: 'center', justifyContent: 'center' },
  hudTitle: { color: '#fff', fontWeight: '700', fontSize: 13 },
  hudSub: { color: 'rgba(255,255,255,0.7)', fontSize: 11 },
  statusPill: { paddingHorizontal: 8, paddingVertical: 4, borderRadius: 999 },
  coordsPill: { flexDirection: 'row', alignItems: 'center', gap: 10, backgroundColor: 'rgba(255,255,255,0.08)', borderRadius: 10, padding: 10 },
  coordsText: { color: '#fff', fontWeight: '700', fontSize: 13 },
  coordsMeta: { color: 'rgba(255,255,255,0.6)', fontSize: 11, marginTop: 2 },
  copyBtn: { flexDirection: 'row', alignItems: 'center', gap: 4, backgroundColor: 'rgba(255,255,255,0.15)', borderRadius: 999, paddingHorizontal: 10, paddingVertical: 6 },
  copyBtnText: { color: '#fff', fontSize: 11, fontWeight: '700' },
  errorBox: { borderRadius: 10, padding: 10 },
  broadcastRow: { flexDirection: 'row', alignItems: 'center', gap: 6 },
  broadcastText: { color: 'rgba(255,255,255,0.7)', fontSize: 11 },
  segmentBar: { flexDirection: 'row', gap: 8 },
  segmentTab: { flex: 1, flexDirection: 'row', alignItems: 'center', justifyContent: 'center', gap: 6, paddingVertical: 10, borderRadius: 10 },
  itemCard: { padding: 12, borderLeftWidth: 3 },
  itemTop: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', marginBottom: 6 },
  itemTitle: { fontSize: 13, fontWeight: '700' },
  itemMeta: { flexDirection: 'row', alignItems: 'center', gap: 6, flexWrap: 'wrap' },
  pill: { paddingHorizontal: 8, paddingVertical: 3, borderRadius: 8 },
  emptyNote: { padding: 24, borderRadius: 12, borderWidth: 1, alignItems: 'center' },
});
