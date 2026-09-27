/**
 * MyShiftsScreen.tsx — M8 Shift Schedule + M9 Shift Swap Request. Port of
 * ../mobile/src/pages/my-shifts.tsx.
 *
 * `GET /shifts` already forces a tanod caller to their own rows
 * server-side (§6) — no `?user_id=me` needed. Swap requests are raised
 * WITHOUT a `target_user_id`: picking a specific substitute needs
 * `GET /users` (Admin-only, §7), so this deliberately asks the desk to
 * assign a substitute when reviewing the request.
 */
import { useCallback, useEffect, useState } from 'react';
import { Alert, Pressable, ScrollView, StyleSheet, Text, TextInput, View } from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import MobileHeader from '../components/MobileHeader';
import { LoadingBlock } from '../components/LoadingBlock';
import { useTheme } from '../theme/ThemeProvider';
import { ApiError, getMyShifts, getMyShiftSwapRequests, requestShiftSwap, type ShiftEntry, type ShiftSwapRequestEntry } from '../services/apiService';
import { uuid } from '../services/uuid';

const SWAP_STATUS_TONE: Record<string, 'warning' | 'success' | 'critical'> = {
  pending: 'warning',
  approved: 'success',
  denied: 'critical',
};

function formatRange(startAt: string, endAt: string): string {
  const start = new Date(startAt);
  const end = new Date(endAt);
  return `${start.toLocaleDateString()} · ${start.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}–${end.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}`;
}

export default function MyShiftsScreen() {
  const { colors, tokens } = useTheme();
  const [shifts, setShifts] = useState<ShiftEntry[]>([]);
  const [swapRequests, setSwapRequests] = useState<ShiftSwapRequestEntry[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [swapTarget, setSwapTarget] = useState<ShiftEntry | null>(null);
  const [reasonInput, setReasonInput] = useState('');
  const [submittingSwap, setSubmittingSwap] = useState(false);

  const load = useCallback(async () => {
    try {
      const [shiftItems, swapItems] = await Promise.all([getMyShifts(), getMyShiftSwapRequests()]);
      setShifts(shiftItems);
      setSwapRequests(swapItems);
      setError(null);
    } catch (err) {
      setError(err instanceof ApiError && err.isOffline ? 'Offline — shift schedule needs a connection to the barangay workstation.' : 'Could not load your shift schedule.');
    }
  }, []);

  // `load` never changes identity (empty deps), so this runs once on mount
  // — `loading` already starts true, no need to set it again here. `load`
  // is reused by handleSubmitSwap's post-submit refresh, so inlining its
  // body here isn't practical.
  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect -- fetch-on-mount via a shared, reused loader; not a value derivable during render.
    load().finally(() => setLoading(false));
  }, [load]);

  function pendingSwapForShift(shiftId: number): ShiftSwapRequestEntry | undefined {
    return swapRequests.find((r) => r.shiftId === shiftId && r.status === 'pending');
  }

  async function handleSubmitSwap() {
    if (!swapTarget) return;
    setSubmittingSwap(true);
    try {
      await requestShiftSwap(swapTarget.shiftId, reasonInput.trim() || undefined, uuid());
      setSwapTarget(null);
      setReasonInput('');
      Alert.alert('Shift Swap', 'Swap request sent — the desk will assign a substitute.');
      await load();
    } catch (err) {
      Alert.alert('Shift Swap', err instanceof Error ? err.message : 'Could not submit the swap request.');
    } finally {
      setSubmittingSwap(false);
    }
  }

  return (
    <View style={{ flex: 1, backgroundColor: colors.bg }}>
      <MobileHeader title="MY SHIFTS" subtitle="Schedule & Swap Requests" showBack />
      {loading ? (
        <LoadingBlock label="Loading your schedule…" />
      ) : (
        <ScrollView contentContainerStyle={styles.scroll}>
          {error ? (
            <View style={[styles.banner, { backgroundColor: colors.tintWarningBg }]}>
              <Text style={{ color: colors.pillWarningText, fontSize: 13 }}>{error}</Text>
            </View>
          ) : shifts.length === 0 ? (
            <View style={[styles.emptyCard, { backgroundColor: colors.surface, borderRadius: tokens.radius.md }]}>
              <Text style={{ color: colors.textSecondary, textAlign: 'center' }}>No upcoming shifts have been scheduled for you yet.</Text>
            </View>
          ) : (
            <View style={{ gap: 10 }}>
              {shifts.map((shift) => {
                const pendingSwap = pendingSwapForShift(shift.shiftId);
                return (
                  <View key={shift.shiftId} style={[styles.card, { backgroundColor: colors.surface, borderRadius: tokens.radius.md }]}>
                    <View style={styles.row}>
                      <Ionicons name="calendar" size={15} color={colors.primary} />
                      <Text style={{ color: colors.textPrimary, fontWeight: '700', fontSize: 13 }}>{formatRange(shift.startAt, shift.endAt)}</Text>
                    </View>
                    {shift.patrolZone ? (
                      <View style={[styles.row, { marginTop: 4 }]}>
                        <Ionicons name="location" size={13} color={colors.textTertiary} />
                        <Text style={{ color: colors.textSecondary, fontSize: 12 }}>{shift.patrolZone}</Text>
                      </View>
                    ) : null}

                    {pendingSwap ? (
                      <View style={[styles.pill, { backgroundColor: colors.tintWarningBg, marginTop: 10, alignSelf: 'flex-start' }]}>
                        <Text style={{ color: colors.pillWarningText, fontSize: 10, fontWeight: '700' }}>SWAP REQUEST PENDING</Text>
                      </View>
                    ) : (
                      <Pressable
                        style={[styles.outlineBtn, { borderColor: colors.border, marginTop: 10 }]}
                        onPress={() => {
                          setSwapTarget(shift);
                          setReasonInput('');
                        }}
                      >
                        <Ionicons name="swap-horizontal" size={14} color={colors.primary} />
                        <Text style={{ color: colors.primary, fontWeight: '700', fontSize: 12 }}>Request Swap</Text>
                      </Pressable>
                    )}
                  </View>
                );
              })}
            </View>
          )}

          {swapRequests.length > 0 ? (
            <View style={{ marginTop: 20 }}>
              <Text style={[styles.sectionTitle, { color: colors.textPrimary }]}>Swap Request History</Text>
              <View style={{ gap: 8, marginTop: 8 }}>
                {swapRequests.map((r) => {
                  const tone = SWAP_STATUS_TONE[r.status] ?? 'warning';
                  const bg = { warning: colors.tintWarningBg, success: colors.tintSuccessBg, critical: colors.tintCriticalBg }[tone];
                  const fg = { warning: colors.pillWarningText, success: colors.pillSuccessText, critical: colors.pillCriticalText }[tone];
                  return (
                    <View key={r.requestId} style={[styles.card, { backgroundColor: colors.surface, borderRadius: tokens.radius.md }]}>
                      <View style={styles.rowBetween}>
                        <View style={[styles.pill, { backgroundColor: bg }]}>
                          <Text style={{ color: fg, fontSize: 10, fontWeight: '700' }}>{r.status.toUpperCase()}</Text>
                        </View>
                        <View style={styles.row}>
                          <Ionicons name="time" size={11} color={colors.textTertiary} />
                          <Text style={{ color: colors.textTertiary, fontSize: 11 }}>{new Date(r.requestedAt).toLocaleDateString()}</Text>
                        </View>
                      </View>
                      {r.reason ? <Text style={{ color: colors.textSecondary, fontSize: 12, marginTop: 6 }}>{r.reason}</Text> : null}
                    </View>
                  );
                })}
              </View>
            </View>
          ) : null}
        </ScrollView>
      )}

      {swapTarget ? (
        <View style={styles.modalBackdrop}>
          <View style={[styles.modalCard, { backgroundColor: colors.surface, borderRadius: tokens.radius.lg }]}>
            <Text style={[styles.sectionTitle, { color: colors.textPrimary }]}>Request a Shift Swap</Text>
            <Text style={{ color: colors.textSecondary, fontSize: 12, marginTop: 4, marginBottom: 12 }}>
              {formatRange(swapTarget.startAt, swapTarget.endAt)}
              {swapTarget.patrolZone ? ` · ${swapTarget.patrolZone}` : ''}
            </Text>
            <TextInput
              value={reasonInput}
              onChangeText={setReasonInput}
              placeholder="Reason (optional)"
              placeholderTextColor={colors.textTertiary}
              multiline
              numberOfLines={3}
              style={[styles.textArea, { borderColor: colors.border, color: colors.textPrimary }]}
            />
            <View style={{ flexDirection: 'row', gap: 10, marginTop: 14 }}>
              <Pressable style={[styles.outlineBtn, { flex: 1, borderColor: colors.border, justifyContent: 'center' }]} onPress={() => setSwapTarget(null)}>
                <Text style={{ color: colors.textPrimary, fontWeight: '600' }}>Cancel</Text>
              </Pressable>
              <Pressable
                disabled={submittingSwap}
                style={[styles.primaryBtn, { flex: 1, backgroundColor: colors.primary, opacity: submittingSwap ? 0.7 : 1 }]}
                onPress={handleSubmitSwap}
              >
                <Text style={{ color: '#fff', fontWeight: '700' }}>{submittingSwap ? 'Sending…' : 'Send Request'}</Text>
              </Pressable>
            </View>
          </View>
        </View>
      ) : null}
    </View>
  );
}

const styles = StyleSheet.create({
  scroll: { padding: 16 },
  banner: { borderRadius: 10, padding: 12 },
  emptyCard: { padding: 28, alignItems: 'center' },
  card: { padding: 14 },
  row: { flexDirection: 'row', alignItems: 'center', gap: 6 },
  rowBetween: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between' },
  pill: { paddingHorizontal: 8, paddingVertical: 3, borderRadius: 8 },
  outlineBtn: { flexDirection: 'row', alignItems: 'center', gap: 6, borderWidth: 1, borderRadius: 10, paddingVertical: 8, paddingHorizontal: 12, alignSelf: 'flex-start' },
  sectionTitle: { fontSize: 14, fontWeight: '700' },
  modalBackdrop: { position: 'absolute', top: 0, left: 0, right: 0, bottom: 0, backgroundColor: 'rgba(0,0,0,0.5)', alignItems: 'center', justifyContent: 'center', padding: 20 },
  modalCard: { width: '100%', maxWidth: 420, padding: 18 },
  textArea: { borderWidth: 1, borderRadius: 10, padding: 10, minHeight: 70, textAlignVertical: 'top', fontSize: 13 },
  primaryBtn: { borderRadius: 10, paddingVertical: 10, alignItems: 'center' },
});
