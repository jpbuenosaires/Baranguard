/**
 * M4 Incident Submitted Confirmation. Port of
 * ../mobile/src/pages/incident-submitted.tsx.
 *
 * "Displays 'Saved locally,' 'Queued,' 'Synced,' 'Duplicate reconciled,'
 * or 'Needs attention.' Never claims server submission when only local
 * persistence has occurred." The state is DERIVED from the stored row
 * (`deriveSyncState`), never passed in as a hopeful assumption.
 *
 * SmsFallbackBadge (M13) is Phase 6 scope — this screen's own call site in
 * the old app always passed `smsAttempted: false`, which derives to no
 * badge anyway, so nothing observable is lost by not porting it yet.
 */
import { useEffect, useState } from 'react';
import { router, useLocalSearchParams } from 'expo-router';
import * as Clipboard from 'expo-clipboard';
import { Pressable, ScrollView, StyleSheet, Text, View } from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import MobileHeader from '../components/MobileHeader';
import { LoadingBlock } from '../components/LoadingBlock';
import { useTheme } from '../theme/ThemeProvider';
import { deriveSyncState, getLocalIncident, type SyncState } from '../services/db/incidentRepository';
import type { IncidentLocalRow } from '../services/db/localSchema';
import tacticalFeedback from '../utils/tacticalFeedback';

const STATE_LABELS: Record<SyncState, string> = {
  saved_locally: 'Saved locally',
  queued: 'Queued for sync',
  synced: 'Synced with HQ',
  duplicate_reconciled: 'Duplicate reconciled',
  needs_attention: 'Needs attention',
};

const STATE_TONE: Record<SyncState, 'success' | 'warning' | 'critical' | 'info'> = {
  saved_locally: 'warning',
  queued: 'info',
  synced: 'success',
  duplicate_reconciled: 'success',
  needs_attention: 'critical',
};

const STATE_DETAIL: Record<SyncState, string> = {
  saved_locally: 'This report is safely encrypted on your device. It will upload automatically when in range of the Barangay HQ network.',
  queued: 'Report is queued and ready for transmission.',
  synced: 'The barangay workstation has verified and confirmed this incident.',
  duplicate_reconciled: 'The workstation already received this report; your local record was synchronized.',
  needs_attention: 'This report could not be sent. It is safely preserved on this device.',
};

export default function IncidentSubmittedScreen() {
  const { colors, tokens } = useTheme();
  const { localId } = useLocalSearchParams<{ localId: string }>();
  const [row, setRow] = useState<IncidentLocalRow | null>(null);
  const [loading, setLoading] = useState(true);
  const [copied, setCopied] = useState(false);

  useEffect(() => {
    let active = true;
    getLocalIncident(localId ?? '')
      .then((found) => {
        if (active) {
          setRow(found);
          setLoading(false);
        }
      })
      .catch(() => {
        if (active) setLoading(false);
      });
    return () => {
      active = false;
    };
  }, [localId]);

  async function handleCopyId() {
    if (!row?.client_event_id) return;
    await Clipboard.setStringAsync(row.client_event_id);
    tacticalFeedback.vibrate(30);
    setCopied(true);
    setTimeout(() => setCopied(false), 2000);
  }

  const state: SyncState | null = row ? deriveSyncState(row) : null;

  return (
    <View style={{ flex: 1, backgroundColor: colors.bg }}>
      <MobileHeader title="REPORT CONFIRMED" subtitle="Local Capture Verification" />
      <ScrollView contentContainerStyle={styles.content}>
        {loading ? (
          <LoadingBlock />
        ) : !row ? (
          <View style={[styles.card, { backgroundColor: colors.surface, borderRadius: tokens.radius.lg, borderTopColor: colors.critical }]}>
            <Text style={{ color: colors.critical, fontSize: 17, fontWeight: '700', marginBottom: 8 }}>Report Not Found</Text>
            <Text style={{ color: colors.textSecondary, marginBottom: 16 }}>That incident report could not be located in local storage.</Text>
            <Pressable style={[styles.primaryBtn, { backgroundColor: colors.primary }]} onPress={() => router.replace('/(tabs)/home')}>
              <Text style={styles.primaryBtnText}>Return to Home</Text>
            </Pressable>
          </View>
        ) : state ? (
          <>
            <View style={[styles.card, styles.heroCard, { backgroundColor: colors.surface, borderRadius: tokens.radius.lg }]}>
              <View style={[styles.heroIcon, { backgroundColor: colors.tintSuccessBg, borderColor: colors.success }]}>
                <Ionicons name="shield-checkmark-outline" size={38} color={colors.success} />
              </View>
              <Text style={[styles.heroTitle, { color: colors.textPrimary }]}>Incident Stored Locally</Text>
              <Text style={{ color: colors.textSecondary, fontSize: 13, marginBottom: 10 }}>Committed atomically to encrypted SQLite</Text>
              <Pill label={STATE_LABELS[state]} tone={STATE_TONE[state]} />
            </View>

            <View style={[styles.card, { backgroundColor: colors.surface, borderRadius: tokens.radius.lg }]}>
              <Text style={styles.label}>PERSISTENCE STATUS</Text>
              <Text style={{ color: colors.textPrimary, fontSize: 13, lineHeight: 19 }}>{STATE_DETAIL[state]}</Text>
            </View>

            <View style={[styles.card, { backgroundColor: colors.surface, borderRadius: tokens.radius.lg }]}>
              <View style={styles.rowBetween}>
                <Text style={styles.label}>CLIENT EVENT REFERENCE</Text>
                <Pressable onPress={handleCopyId} style={[styles.copyBtn, { backgroundColor: colors.surfaceBlue }]}>
                  <Ionicons name={copied ? 'checkmark-outline' : 'copy-outline'} size={13} color={colors.primary} />
                  <Text style={{ color: colors.primary, fontSize: 11, fontWeight: '600' }}>{copied ? 'Copied!' : 'Copy'}</Text>
                </Pressable>
              </View>
              <View style={[styles.codeBox, { backgroundColor: colors.bg, borderColor: colors.border, borderRadius: tokens.radius.sm }]}>
                <Text style={{ color: colors.textPrimary, fontFamily: 'monospace', fontSize: 12 }}>{row.client_event_id}</Text>
              </View>
              <Text style={{ color: colors.textTertiary, fontSize: 11, marginTop: 8 }}>
                Captured: {new Date(row.created_offline_at).toLocaleString()}
              </Text>
            </View>

            <Pressable style={[styles.primaryBtn, { backgroundColor: colors.primary }]} onPress={() => router.replace('/(tabs)/home')}>
              <Ionicons name="home-outline" size={16} color="#fff" />
              <Text style={styles.primaryBtnText}>Return to Patrol Console</Text>
            </Pressable>
            <Pressable
              style={[styles.outlineBtn, { borderColor: colors.border }]}
              onPress={() => router.replace('/incidents/new')}
            >
              <Ionicons name="document-text-outline" size={16} color={colors.textPrimary} />
              <Text style={{ color: colors.textPrimary, fontWeight: '600' }}>Log Another Incident</Text>
            </Pressable>
            <Pressable style={styles.clearBtn} onPress={() => router.replace('/(tabs)/reports')}>
              <Ionicons name="list-outline" size={16} color={colors.textSecondary} />
              <Text style={{ color: colors.textSecondary, fontWeight: '600' }}>View My Reports</Text>
            </Pressable>
          </>
        ) : null}
      </ScrollView>
    </View>
  );
}

function Pill({ label, tone }: { label: string; tone: 'success' | 'warning' | 'critical' | 'info' }) {
  const { colors } = useTheme();
  const bg = { success: colors.tintSuccessBg, warning: colors.tintWarningBg, critical: colors.tintCriticalBg, info: colors.tintInfoBg }[tone];
  const fg = { success: colors.pillSuccessText, warning: colors.pillWarningText, critical: colors.pillCriticalText, info: colors.pillInfoText }[tone];
  return (
    <View style={{ backgroundColor: bg, borderRadius: 8, paddingHorizontal: 10, paddingVertical: 4 }}>
      <Text style={{ color: fg, fontSize: 12, fontWeight: '600' }}>{label}</Text>
    </View>
  );
}

const styles = StyleSheet.create({
  content: { padding: 16, gap: 12 },
  card: { padding: 16 },
  heroCard: { alignItems: 'center', paddingVertical: 28 },
  heroIcon: { width: 72, height: 72, borderRadius: 36, alignItems: 'center', justifyContent: 'center', borderWidth: 2, marginBottom: 12 },
  heroTitle: { fontSize: 20, fontWeight: '800', marginBottom: 4 },
  label: { fontSize: 12, fontWeight: '700', color: '#64748b', marginBottom: 6 },
  rowBetween: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center', marginBottom: 8 },
  copyBtn: { flexDirection: 'row', alignItems: 'center', gap: 4, paddingHorizontal: 8, paddingVertical: 4, borderRadius: 6 },
  codeBox: { borderWidth: 1, padding: 10 },
  primaryBtn: { flexDirection: 'row', gap: 8, alignItems: 'center', justifyContent: 'center', borderRadius: 10, paddingVertical: 14 },
  primaryBtnText: { color: '#fff', fontWeight: '700', fontSize: 15 },
  outlineBtn: { flexDirection: 'row', gap: 8, alignItems: 'center', justifyContent: 'center', borderWidth: 1, borderRadius: 10, paddingVertical: 14 },
  clearBtn: { flexDirection: 'row', gap: 8, alignItems: 'center', justifyContent: 'center', paddingVertical: 10 },
});
