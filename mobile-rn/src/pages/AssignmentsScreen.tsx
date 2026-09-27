/**
 * M5 Assignments List. Port of ../mobile/src/pages/assignments.tsx.
 *
 * Reads cached assignments so the screen still works when the workstation
 * is unreachable. On mount, tries a real `GET /dispatch` refresh (which
 * repopulates `dispatch_local`); if that fails (offline), falls straight
 * back to whatever is already cached — the screen never blanks just
 * because the workstation is unreachable.
 *
 * Distance/bearing: a foreground-only self-position watch (haversine,
 * NOT road-routed — same honesty as everywhere else this figure is
 * shown). Never calls `postGps()` — GPS broadcast to the server stays
 * Live Map's job (Phase 5).
 */
import { useCallback, useEffect, useMemo, useState } from 'react';
import { router } from 'expo-router';
import { FlatList, Pressable, RefreshControl, StyleSheet, Text, TextInput, View } from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import MobileHeader from '../components/MobileHeader';
import { LoadingBlock } from '../components/LoadingBlock';
import { useTheme } from '../theme/ThemeProvider';
import { ApiError, getDispatches } from '../services/apiService';
import { cacheDispatchesFromServer, isCacheStale, listActiveCachedDispatches } from '../services/db/dispatchRepository';
import type { DispatchLocalRow } from '../services/db/localSchema';
import { getCurrentPosition, watchPosition, type DevicePosition } from '../services/geolocation';
import { bearingLabel, distanceMeters, formatDistance } from '../utils/geo';
import tacticalFeedback from '../utils/tacticalFeedback';

const PRIORITY_TONE: Record<string, 'info' | 'warning' | 'critical'> = { normal: 'info', high: 'warning', critical: 'critical' };
const STATUS_TONE: Record<string, 'warning' | 'info' | 'success'> = { assigned: 'warning', en_route: 'info', arrived: 'success' };
const STATUS_LABEL: Record<string, string> = { assigned: 'Assigned', en_route: 'En Route', arrived: 'Arrived' };
const PRIORITY_ORDER: Record<string, number> = { critical: 0, high: 1, normal: 2 };

function categoryIcon(type?: string | null): keyof typeof Ionicons.glyphMap {
  const t = (type ?? '').toLowerCase();
  if (t.includes('injury') || t.includes('medical') || t.includes('health')) return 'medkit-outline';
  if (t.includes('theft') || t.includes('vandalism') || t.includes('robbery')) return 'shield-checkmark-outline';
  if (t.includes('traffic') || t.includes('vehic') || t.includes('car')) return 'car-outline';
  if (t.includes('animal') || t.includes('dog')) return 'paw-outline';
  if (t.includes('fire') || t.includes('smoke')) return 'flame-outline';
  if (t.includes('disturbance') || t.includes('dispute') || t.includes('noise')) return 'alert-circle-outline';
  return 'document-text-outline';
}

type FilterTab = 'all' | 'critical' | 'en_route' | 'assigned' | 'arrived';

export default function AssignmentsScreen() {
  const { colors, tokens } = useTheme();
  const [rows, setRows] = useState<DispatchLocalRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [offlineNote, setOfflineNote] = useState<string | null>(null);
  const [position, setPosition] = useState<DevicePosition | null>(null);
  const [activeFilter, setActiveFilter] = useState<FilterTab>('all');
  const [searchQuery, setSearchQuery] = useState('');

  useEffect(() => {
    let stopWatch: (() => void) | undefined;
    let cancelled = false;

    getCurrentPosition()
      .then((p) => {
        if (!cancelled) setPosition(p);
      })
      .catch(() => {
        // No fix yet — cards fall back to "Distance unknown" below.
      });

    watchPosition((p) => {
      if (!cancelled) setPosition(p);
    })
      .then((stop) => {
        if (cancelled) stop();
        else stopWatch = stop;
      })
      .catch(() => {
        // Same non-fatal treatment as every other screen's watch failure.
      });

    return () => {
      cancelled = true;
      stopWatch?.();
    };
  }, []);

  const load = useCallback(async () => {
    try {
      const entries = await getDispatches();
      await cacheDispatchesFromServer(entries);
      setOfflineNote(null);
    } catch (error) {
      setOfflineNote(
        error instanceof ApiError && error.isOffline
          ? 'Offline — showing the last cached assignments.'
          : 'Could not refresh from the workstation — showing cached records.',
      );
    }
    const cached = await listActiveCachedDispatches();
    setRows(cached);
  }, []);

  useEffect(() => {
    let active = true;
    // react-hooks/set-state-in-effect: this fetches on mount AND is reused
    // for pull-to-refresh/retry — restructuring it into a derivable value
    // isn't possible for a real network+cache fetch. The rule inspects
    // `load`'s own body (a local function) but not an imported one, which
    // is why an equivalent effect calling an imported function directly
    // (see IncidentSubmittedScreen) doesn't trip it.
    // eslint-disable-next-line react-hooks/set-state-in-effect
    load().then(() => {
      if (active) setLoading(false);
    });
    return () => {
      active = false;
    };
  }, [load]);

  async function handleRefresh() {
    tacticalFeedback.onTap();
    setRefreshing(true);
    await load();
    setRefreshing(false);
  }

  const telemetry = useMemo(() => {
    const counts = { all: rows.length, critical: 0, en_route: 0, assigned: 0, arrived: 0 };
    let closestDist = Infinity;
    let closestBearing = '';
    for (const r of rows) {
      if (r.priority === 'critical') counts.critical += 1;
      if (r.status === 'en_route') counts.en_route += 1;
      if (r.status === 'assigned') counts.assigned += 1;
      if (r.status === 'arrived') counts.arrived += 1;
      if (position && r.latitude !== null && r.longitude !== null) {
        const dist = distanceMeters(position.latitude, position.longitude, r.latitude, r.longitude);
        if (dist < closestDist) {
          closestDist = dist;
          closestBearing = bearingLabel(position.latitude, position.longitude, r.latitude, r.longitude);
        }
      }
    }
    return { counts, closestFormatted: closestDist !== Infinity ? `${formatDistance(closestDist)} · ${closestBearing}` : 'Searching…' };
  }, [rows, position]);

  const filteredAndSortedRows = useMemo(() => {
    const query = searchQuery.trim().toLowerCase();
    const filtered = rows.filter((r) => {
      if (activeFilter === 'critical' && r.priority !== 'critical') return false;
      if (activeFilter === 'en_route' && r.status !== 'en_route') return false;
      if (activeFilter === 'assigned' && r.status !== 'assigned') return false;
      if (activeFilter === 'arrived' && r.status !== 'arrived') return false;
      if (query) {
        const typeMatch = (r.redacted_incident_type ?? '').toLowerCase().includes(query);
        const idMatch = (r.server_dispatch_id ? `#${r.server_dispatch_id}` : `#${r.local_id}`).toLowerCase().includes(query);
        return typeMatch || idMatch;
      }
      return true;
    });
    return [...filtered].sort((a, b) => {
      const pA = PRIORITY_ORDER[a.priority] ?? 2;
      const pB = PRIORITY_ORDER[b.priority] ?? 2;
      if (pA !== pB) return pA - pB;
      if (position && a.latitude !== null && a.longitude !== null && b.latitude !== null && b.longitude !== null) {
        return (
          distanceMeters(position.latitude, position.longitude, a.latitude, a.longitude) -
          distanceMeters(position.latitude, position.longitude, b.latitude, b.longitude)
        );
      }
      return 0;
    });
  }, [rows, activeFilter, searchQuery, position]);

  function goToDetail(localId: string) {
    tacticalFeedback.onTap();
    router.push(`/assignments/${encodeURIComponent(localId)}`);
  }

  return (
    <View style={{ flex: 1, backgroundColor: colors.bg }}>
      <MobileHeader title="DISPATCHES" subtitle="Active Field Queue" />

      {loading ? (
        <LoadingBlock label="Loading dispatch assignments…" />
      ) : (
        <FlatList
          data={filteredAndSortedRows}
          keyExtractor={(row) => row.local_id}
          contentContainerStyle={styles.list}
          refreshControl={<RefreshControl refreshing={refreshing} onRefresh={handleRefresh} />}
          ListHeaderComponent={
            <View style={{ gap: 12, marginBottom: 12 }}>
              {offlineNote ? (
                <View style={[styles.offlineBanner, { backgroundColor: colors.tintWarningBg, borderRadius: tokens.radius.sm }]}>
                  <Ionicons name="warning-outline" size={16} color={colors.pillWarningText} />
                  <Text style={{ color: colors.pillWarningText, fontSize: 12, flex: 1 }}>{offlineNote}</Text>
                  <Pressable onPress={() => void load()}>
                    <Ionicons name="refresh-outline" size={16} color={colors.pillWarningText} />
                  </Pressable>
                </View>
              ) : null}

              {rows.length > 0 ? (
                <>
                  <View style={[styles.telemetryStrip, { backgroundColor: colors.surface, borderRadius: tokens.radius.md }]}>
                    <TelemetryItem icon="flash-outline" label="Urgent" value={`${telemetry.counts.critical} CRIT`} colors={colors} />
                    <TelemetryItem icon="compass-outline" label="Nearest" value={telemetry.closestFormatted} colors={colors} />
                    <TelemetryItem icon="navigate-outline" label="Responding" value={`${telemetry.counts.en_route} Active`} colors={colors} />
                  </View>

                  <View style={[styles.searchBox, { backgroundColor: colors.surface, borderRadius: tokens.radius.sm, borderColor: colors.border }]}>
                    <Ionicons name="search-outline" size={16} color={colors.textTertiary} />
                    <TextInput
                      value={searchQuery}
                      onChangeText={setSearchQuery}
                      placeholder="Search incident type or #ID..."
                      placeholderTextColor={colors.textDisabled}
                      style={{ flex: 1, color: colors.textPrimary, fontSize: 13 }}
                    />
                    {searchQuery ? (
                      <Pressable onPress={() => setSearchQuery('')}>
                        <Ionicons name="close-circle-outline" size={16} color={colors.textTertiary} />
                      </Pressable>
                    ) : null}
                  </View>

                  <View style={styles.filterRow}>
                    {(['all', 'critical', 'en_route', 'assigned', 'arrived'] as FilterTab[]).map((tab) => {
                      const active = activeFilter === tab;
                      const count = telemetry.counts[tab];
                      return (
                        <Pressable
                          key={tab}
                          onPress={() => {
                            tacticalFeedback.onTap();
                            setActiveFilter(tab);
                          }}
                          style={[
                            styles.filterChip,
                            { borderRadius: tokens.radius.lg, backgroundColor: active ? colors.primary : colors.surface, borderColor: colors.border },
                          ]}
                        >
                          <Text style={{ color: active ? '#fff' : colors.textSecondary, fontSize: 12, fontWeight: '600' }}>
                            {tab === 'en_route' ? 'En Route' : tab[0].toUpperCase() + tab.slice(1)}
                          </Text>
                          {count > 0 ? (
                            <Text style={{ color: active ? '#fff' : colors.textTertiary, fontSize: 11 }}> {count}</Text>
                          ) : null}
                        </Pressable>
                      );
                    })}
                  </View>
                </>
              ) : null}
            </View>
          }
          ListEmptyComponent={
            <View style={[styles.emptyCard, { backgroundColor: colors.surface, borderRadius: tokens.radius.lg }]}>
              <View style={[styles.emptyIcon, { backgroundColor: colors.tintSuccessBg }]}>
                <Ionicons name="shield-checkmark-outline" size={28} color={colors.success} />
              </View>
              <Text style={{ color: colors.textPrimary, fontSize: 16, fontWeight: '700', marginBottom: 4 }}>
                {rows.length === 0 ? 'No Active Dispatches' : 'No dispatches found for this filter.'}
              </Text>
              {rows.length === 0 ? (
                <Text style={{ color: colors.textSecondary, fontSize: 13, textAlign: 'center' }}>
                  You have no pending assignments. Stand by or maintain active patrol.
                </Text>
              ) : (
                <Pressable onPress={() => setActiveFilter('all')} style={{ marginTop: 8 }}>
                  <Text style={{ color: colors.primary, fontWeight: '600' }}>Reset Filter</Text>
                </Pressable>
              )}
            </View>
          }
          renderItem={({ item: row }) => {
            const stale = isCacheStale(row);
            const distanceText =
              row.latitude === null || row.longitude === null
                ? 'Coordinates pending'
                : position
                  ? `${formatDistance(distanceMeters(position.latitude, position.longitude, row.latitude, row.longitude))} · ${bearingLabel(position.latitude, position.longitude, row.latitude, row.longitude)}`
                  : 'Distance unknown — GPS acquiring';
            const actionLabel = row.status === 'en_route' ? 'NAVIGATE ROUTE' : row.status === 'assigned' ? 'START ROUTE' : 'VIEW STATUS';

            return (
              <Pressable
                onPress={() => goToDetail(row.local_id)}
                style={[
                  styles.card,
                  {
                    backgroundColor: colors.surface,
                    borderRadius: tokens.radius.lg,
                    borderLeftColor: row.priority === 'critical' ? colors.critical : row.priority === 'high' ? colors.warning : colors.border,
                  },
                ]}
              >
                <View style={styles.cardTop}>
                  <View style={styles.cardTopLeft}>
                    <Pill label={row.priority.toUpperCase()} tone={PRIORITY_TONE[row.priority] ?? 'info'} colors={colors} />
                    <Pill label={STATUS_LABEL[row.status] ?? row.status} tone={STATUS_TONE[row.status] ?? 'info'} colors={colors} />
                  </View>
                  <Text style={{ color: colors.textTertiary, fontSize: 11, fontFamily: 'monospace' }}>
                    #{row.server_dispatch_id ?? row.local_id.slice(0, 6)}
                  </Text>
                </View>

                <View style={styles.cardMain}>
                  <View style={[styles.iconBox, { backgroundColor: colors.tintInfoBg }]}>
                    <Ionicons name={categoryIcon(row.redacted_incident_type)} size={20} color={colors.primary} />
                  </View>
                  <View style={{ flex: 1 }}>
                    <Text style={[styles.cardType, { color: colors.textPrimary }]}>
                      {row.redacted_incident_type ? row.redacted_incident_type.replace(/_/g, ' ').toUpperCase() : 'INCIDENT DETAILS RESTRICTED'}
                    </Text>
                    <View style={styles.geoRow}>
                      <Ionicons name="location-outline" size={12} color={colors.textTertiary} />
                      <Text style={{ color: colors.textTertiary, fontSize: 12 }}>{distanceText}</Text>
                    </View>
                    {stale ? (
                      <View style={styles.geoRow}>
                        <Ionicons name="time-outline" size={12} color={colors.textTertiary} />
                        <Text style={{ color: colors.textTertiary, fontSize: 11 }}>Cached data</Text>
                      </View>
                    ) : null}
                  </View>
                </View>

                <View style={[styles.cardFooter, { borderTopColor: colors.border }]}>
                  <Text style={{ color: colors.textTertiary, fontSize: 11 }}>Barangay Dao Tanod</Text>
                  <Text style={{ color: colors.primary, fontSize: 12, fontWeight: '700' }}>{actionLabel} →</Text>
                </View>
              </Pressable>
            );
          }}
        />
      )}
    </View>
  );
}

function TelemetryItem({ icon, label, value, colors }: { icon: keyof typeof Ionicons.glyphMap; label: string; value: string; colors: ReturnType<typeof useTheme>['colors'] }) {
  return (
    <View style={styles.telemetryItem}>
      <View style={styles.telemetryLabel}>
        <Ionicons name={icon} size={12} color={colors.textTertiary} />
        <Text style={{ color: colors.textTertiary, fontSize: 10 }}>{label}</Text>
      </View>
      <Text style={{ color: colors.textPrimary, fontSize: 13, fontWeight: '700' }}>{value}</Text>
    </View>
  );
}

function Pill({ label, tone, colors }: { label: string; tone: 'info' | 'warning' | 'critical' | 'success'; colors: ReturnType<typeof useTheme>['colors'] }) {
  const bg = { success: colors.tintSuccessBg, warning: colors.tintWarningBg, critical: colors.tintCriticalBg, info: colors.tintInfoBg }[tone];
  const fg = { success: colors.pillSuccessText, warning: colors.pillWarningText, critical: colors.pillCriticalText, info: colors.pillInfoText }[tone];
  return (
    <View style={{ backgroundColor: bg, borderRadius: 8, paddingHorizontal: 8, paddingVertical: 3 }}>
      <Text style={{ color: fg, fontSize: 10, fontWeight: '700' }}>{label}</Text>
    </View>
  );
}

const styles = StyleSheet.create({
  list: { padding: 16 },
  offlineBanner: { flexDirection: 'row', alignItems: 'center', gap: 8, padding: 10 },
  telemetryStrip: { flexDirection: 'row', justifyContent: 'space-between', padding: 14 },
  telemetryItem: { alignItems: 'center', gap: 4 },
  telemetryLabel: { flexDirection: 'row', alignItems: 'center', gap: 3 },
  searchBox: { flexDirection: 'row', alignItems: 'center', gap: 8, borderWidth: 1, paddingHorizontal: 10, paddingVertical: 8 },
  filterRow: { flexDirection: 'row', flexWrap: 'wrap', gap: 8 },
  filterChip: { flexDirection: 'row', alignItems: 'center', borderWidth: 1, paddingHorizontal: 12, paddingVertical: 6 },
  emptyCard: { alignItems: 'center', padding: 32 },
  emptyIcon: { width: 56, height: 56, borderRadius: 28, alignItems: 'center', justifyContent: 'center', marginBottom: 12 },
  card: { borderLeftWidth: 4, padding: 14, marginBottom: 12 },
  cardTop: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center', marginBottom: 10 },
  cardTopLeft: { flexDirection: 'row', gap: 6 },
  cardMain: { flexDirection: 'row', gap: 12, marginBottom: 10 },
  iconBox: { width: 40, height: 40, borderRadius: 10, alignItems: 'center', justifyContent: 'center' },
  cardType: { fontSize: 14, fontWeight: '700', marginBottom: 4 },
  geoRow: { flexDirection: 'row', alignItems: 'center', gap: 4, marginTop: 2 },
  cardFooter: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center', borderTopWidth: 1, paddingTop: 10 },
});
