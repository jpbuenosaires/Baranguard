/**
 * M14 My Incident Reports. Port of ../mobile/src/pages/my-reports.tsx.
 *
 * Lists EVERY incident this device has ever captured
 * (`listAllLocalIncidents()`, not the sync worker's unsynced-only query),
 * newest first, each card's sync state derived via the same
 * `deriveSyncState()` M4 uses. Reads ONLY the local encrypted store — no
 * network call, so this works identically online or offline.
 */
import { useCallback, useEffect, useState } from 'react';
import { FlatList, RefreshControl, StyleSheet, Text, View } from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import MobileHeader from '../components/MobileHeader';
import { LoadingBlock } from '../components/LoadingBlock';
import { useTheme } from '../theme/ThemeProvider';
import { deriveSyncState, listAllLocalIncidents, type SyncState } from '../services/db/incidentRepository';
import type { IncidentLocalRow } from '../services/db/localSchema';

const SYNC_STATE_META: Record<SyncState, { label: string; tone: 'warning' | 'info' | 'success' | 'critical'; icon: keyof typeof Ionicons.glyphMap }> = {
  saved_locally: { label: 'STAGED IN CACHE', tone: 'warning', icon: 'cloud-upload-outline' },
  queued: { label: 'QUEUED FOR SYNC', tone: 'info', icon: 'cloud-upload-outline' },
  synced: { label: 'SYNCED', tone: 'success', icon: 'checkmark-done-outline' },
  duplicate_reconciled: { label: 'RECONCILED', tone: 'info', icon: 'checkmark-done-outline' },
  needs_attention: { label: 'SYNC FAILED', tone: 'critical', icon: 'alert-circle-outline' },
};

const PRIORITY_TONE: Record<string, 'info' | 'warning' | 'critical'> = { normal: 'info', high: 'warning', critical: 'critical' };

function excerpt(text: string, maxLength = 140): string {
  const trimmed = text.trim();
  return trimmed.length > maxLength ? `${trimmed.slice(0, maxLength)}…` : trimmed;
}

export default function MyReportsScreen() {
  const { colors, tokens } = useTheme();
  const [rows, setRows] = useState<IncidentLocalRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);

  const load = useCallback(async () => {
    setRows(await listAllLocalIncidents());
  }, []);

  useEffect(() => {
    let active = true;
    listAllLocalIncidents().then((all) => {
      if (active) {
        setRows(all);
        setLoading(false);
      }
    });
    return () => {
      active = false;
    };
  }, []);

  async function handleRefresh() {
    setRefreshing(true);
    await load();
    setRefreshing(false);
  }

  return (
    <View style={{ flex: 1, backgroundColor: colors.bg }}>
      <MobileHeader title="MY REPORTS" subtitle="Field Incident History" showBack />
      {loading ? (
        <LoadingBlock label="Loading your reports…" />
      ) : rows.length === 0 ? (
        <View style={styles.empty}>
          <View style={[styles.emptyIcon, { backgroundColor: colors.tintNeutralBg }]}>
            <Ionicons name="document-text-outline" size={30} color={colors.textSecondary} />
          </View>
          <Text style={[styles.emptyTitle, { color: colors.textPrimary }]}>No Reports Yet</Text>
          <Text style={{ color: colors.textSecondary, fontSize: 13, textAlign: 'center', maxWidth: 260 }}>
            Incidents you log from this device will show up here, whether or not they{'’'}ve synced yet.
          </Text>
        </View>
      ) : (
        <FlatList
          data={rows}
          keyExtractor={(row) => row.local_id}
          contentContainerStyle={styles.list}
          refreshControl={<RefreshControl refreshing={refreshing} onRefresh={handleRefresh} />}
          renderItem={({ item: row }) => {
            const state = deriveSyncState(row);
            const meta = SYNC_STATE_META[state];
            const priorityTone = PRIORITY_TONE[row.priority] ?? 'info';
            return (
              <View style={[styles.card, { backgroundColor: colors.surface, borderRadius: tokens.radius.md }]}>
                <View style={styles.cardHeader}>
                  <Pill label={row.priority} tone={priorityTone} colors={colors} />
                  <Pill label={meta.label} tone={meta.tone} icon={meta.icon} colors={colors} />
                  {row.server_incident_id !== null ? (
                    <Text style={[styles.caseId, { color: colors.textTertiary, marginLeft: 'auto' }]}>Case #{row.server_incident_id}</Text>
                  ) : null}
                </View>

                <Text style={[styles.incidentType, { color: colors.textPrimary }]}>{row.incident_type.replace(/_/g, ' ').toUpperCase()}</Text>
                <Text style={{ color: colors.textSecondary, fontSize: 13, lineHeight: 18, marginBottom: 8 }}>{excerpt(row.raw_narrative)}</Text>

                <View style={styles.metaRow}>
                  <View style={styles.metaItem}>
                    <Ionicons name="time-outline" size={12} color={colors.textTertiary} />
                    <Text style={{ color: colors.textTertiary, fontSize: 11 }}>{new Date(row.created_offline_at).toLocaleString()}</Text>
                  </View>
                  {row.latitude !== null && row.longitude !== null ? (
                    <View style={styles.metaItem}>
                      <Ionicons name="location-outline" size={12} color={colors.textTertiary} />
                      <Text style={{ color: colors.textTertiary, fontSize: 11 }}>
                        {row.latitude.toFixed(4)}, {row.longitude.toFixed(4)}
                      </Text>
                    </View>
                  ) : null}
                </View>

                {state === 'needs_attention' && row.last_sync_error ? (
                  <View style={[styles.errorBox, { backgroundColor: colors.tintCriticalBg, borderRadius: tokens.radius.sm }]}>
                    <Text style={{ color: colors.pillCriticalText, fontSize: 12 }}>{row.last_sync_error}</Text>
                  </View>
                ) : null}
              </View>
            );
          }}
        />
      )}
    </View>
  );
}

function Pill({
  label,
  tone,
  icon,
  colors,
}: {
  label: string;
  tone: 'info' | 'warning' | 'critical' | 'success';
  icon?: keyof typeof Ionicons.glyphMap;
  colors: ReturnType<typeof useTheme>['colors'];
}) {
  const bg = { success: colors.tintSuccessBg, warning: colors.tintWarningBg, critical: colors.tintCriticalBg, info: colors.tintInfoBg }[tone];
  const fg = { success: colors.pillSuccessText, warning: colors.pillWarningText, critical: colors.pillCriticalText, info: colors.pillInfoText }[tone];
  return (
    <View style={[styles.pill, { backgroundColor: bg }]}>
      {icon ? <Ionicons name={icon} size={11} color={fg} /> : null}
      <Text style={{ color: fg, fontSize: 10, fontWeight: '700', textTransform: 'uppercase' }}>{label}</Text>
    </View>
  );
}

const styles = StyleSheet.create({
  list: { padding: 16, gap: 12 },
  empty: { flex: 1, alignItems: 'center', justifyContent: 'center', padding: 24 },
  emptyIcon: { width: 64, height: 64, borderRadius: 32, alignItems: 'center', justifyContent: 'center', marginBottom: 16 },
  emptyTitle: { fontSize: 17, fontWeight: '700', marginBottom: 6 },
  card: { padding: 14, marginBottom: 12 },
  cardHeader: { flexDirection: 'row', alignItems: 'center', gap: 6, marginBottom: 6, flexWrap: 'wrap' },
  pill: { flexDirection: 'row', alignItems: 'center', gap: 4, paddingHorizontal: 8, paddingVertical: 3, borderRadius: 8 },
  caseId: { fontSize: 11, fontFamily: 'monospace' },
  incidentType: { fontSize: 15, fontWeight: '700', marginBottom: 4 },
  metaRow: { flexDirection: 'row', flexWrap: 'wrap', gap: 12 },
  metaItem: { flexDirection: 'row', alignItems: 'center', gap: 4 },
  errorBox: { marginTop: 8, padding: 8 },
});
