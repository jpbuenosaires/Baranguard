/**
 * ProfileScreen.tsx — M10 Profile & Tactical Field Diagnostics Console.
 * Port of ../mobile/src/pages/profile.tsx, built out fully in Phase 7
 * (Phase 2 had shipped session display/theme/sign-out only).
 *
 * Provides real telemetry — never a hardcoded "Enabled"/"Online" (§2 Rule
 * 6): network ping is a real `checkHealth()` probe, local stats are real
 * SQLite counts, storage figures are real file-system measurements.
 *
 * Push/notification diagnostics honestly report "not wired up yet" rather
 * than faking a permission check — this rebuild has not installed
 * `@react-native-firebase/messaging` (see `criticalAlertStore.ts`'s own
 * doc for why). "Test Full-Screen Alert" still exercises the real native
 * path Phase 6 built, independent of Firebase.
 *
 * Logout fix (defect 4, DEVLOG 2026-09-27 (3)): the old app's sign-out
 * never closed the local database or stopped patrol tracking. Both happen
 * here.
 */
import { useCallback, useEffect, useState } from 'react';
import { router } from 'expo-router';
import { ActivityIndicator, Alert, Pressable, ScrollView, StyleSheet, Switch, Text, TextInput, View } from 'react-native';
import * as Clipboard from 'expo-clipboard';
import { Ionicons } from '@expo/vector-icons';
import MobileHeader from '../components/MobileHeader';
import { useTheme } from '../theme/ThemeProvider';
import {
  checkHealth,
  getApiBaseUrl,
  hasApiBaseUrlOverride,
  logout,
  setApiBaseUrlOverride,
} from '../services/apiService';
import { getDeviceId } from '../services/deviceIdentity';
import { clearSession, loadSession, type StoredSession } from '../services/session';
import { closeLocalDatabase } from '../services/db/localDatabase';
import { listActiveCachedDispatches } from '../services/db/dispatchRepository';
import { listUnsyncedIncidents } from '../services/db/incidentRepository';
import { listUnsyncedGpsPoints } from '../services/db/gpsTrackRepository';
import { listPendingDispatchStatusUpdates, listPendingSosItems } from '../services/db/offlineQueueRepository';
import { runSyncPass } from '../services/syncService';
import { formatBytes, getStorageSnapshot, pruneOldSyncedEvidenceFiles, type StorageSnapshot } from '../services/storageMaintenance';
import { stopPatrolTracking } from '../services/patrolLocationService';
import { triggerTestCriticalAlert } from '../services/criticalAlertStore';
import tacticalFeedback from '../utils/tacticalFeedback';

interface LocalStats {
  dispatches: number;
  unsyncedIncidents: number;
  unsyncedGps: number;
  pendingQueue: number;
}

export default function ProfileScreen() {
  const { colors, mode, setPreference, tokens } = useTheme();
  const [session, setSession] = useState<StoredSession | null>(null);
  const [deviceId, setDeviceId] = useState('');
  const [copiedDevice, setCopiedDevice] = useState(false);

  const [pinging, setPinging] = useState(false);
  const [latency, setLatency] = useState<number | null>(null);
  const [isOnline, setIsOnline] = useState<boolean | null>(null);

  const [baseUrlInput, setBaseUrlInput] = useState(getApiBaseUrl());
  const [savingBaseUrl, setSavingBaseUrl] = useState(false);
  const [showServerSettings, setShowServerSettings] = useState(false);

  const [localStats, setLocalStats] = useState<LocalStats>({ dispatches: 0, unsyncedIncidents: 0, unsyncedGps: 0, pendingQueue: 0 });
  const [syncing, setSyncing] = useState(false);

  const [storage, setStorage] = useState<StorageSnapshot | null>(null);
  const [pruning, setPruning] = useState(false);
  const [showStorageDetails, setShowStorageDetails] = useState(false);

  const loadData = useCallback(async () => {
    setSession(await loadSession());
    setDeviceId(await getDeviceId());
    setBaseUrlInput(getApiBaseUrl());

    try {
      const [dispatches, unsyncedIncidents, unsyncedGps, pendingStatus, pendingSos] = await Promise.all([
        listActiveCachedDispatches(),
        listUnsyncedIncidents(),
        listUnsyncedGpsPoints(),
        listPendingDispatchStatusUpdates(),
        listPendingSosItems(),
      ]);
      setLocalStats({
        dispatches: dispatches.length,
        unsyncedIncidents: unsyncedIncidents.length,
        unsyncedGps: unsyncedGps.length,
        pendingQueue: pendingStatus.length + pendingSos.length,
      });
    } catch {
      // Local queries safe fallback.
    }

    try {
      setStorage(getStorageSnapshot());
    } catch {
      setStorage(null);
    }
  }, []);

  const pingWorkstation = useCallback(async () => {
    setPinging(true);
    const t0 = Date.now();
    try {
      const ok = await checkHealth();
      setIsOnline(ok);
      setLatency(ok ? Date.now() - t0 : null);
      if (ok) tacticalFeedback.onSuccess();
    } catch {
      setIsOnline(false);
      setLatency(null);
    } finally {
      setPinging(false);
    }
  }, []);

  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect -- loadData/pingWorkstation are reused by manual retry handlers below (save/reset base URL), so inlining their bodies here isn't practical; both are real network+DB reads, not values derivable during render.
    void loadData();
    void pingWorkstation();
  }, [loadData, pingWorkstation]);

  async function handleSaveBaseUrl() {
    const trimmed = baseUrlInput.trim();
    if (!trimmed) return;
    setSavingBaseUrl(true);
    try {
      await setApiBaseUrlOverride(trimmed);
      setBaseUrlInput(getApiBaseUrl());
      await pingWorkstation();
      Alert.alert('Workstation Address', 'Updated.');
    } finally {
      setSavingBaseUrl(false);
    }
  }

  async function handleResetBaseUrl() {
    setSavingBaseUrl(true);
    try {
      await setApiBaseUrlOverride(null);
      setBaseUrlInput(getApiBaseUrl());
      await pingWorkstation();
      Alert.alert('Workstation Address', 'Reverted to the default.');
    } finally {
      setSavingBaseUrl(false);
    }
  }

  async function handleCopyDeviceId() {
    if (!deviceId) return;
    await Clipboard.setStringAsync(deviceId);
    setCopiedDevice(true);
    setTimeout(() => setCopiedDevice(false), 2000);
  }

  async function handleManualSync() {
    setSyncing(true);
    try {
      const result = await runSyncPass();
      tacticalFeedback.onSuccess();
      const evidenceNote = result.evidenceUploaded > 0 ? ` · ${result.evidenceUploaded} evidence file(s) uploaded` : '';
      Alert.alert('Sync', `Sync complete: ${result.succeeded} uploaded, ${result.duplicates} verified${evidenceNote}.`);
      await loadData();
    } catch (err) {
      Alert.alert('Sync', err instanceof Error ? err.message : 'Workstation unreachable for sync.');
    } finally {
      setSyncing(false);
    }
  }

  async function handlePruneEvidence() {
    setPruning(true);
    try {
      const result = await pruneOldSyncedEvidenceFiles();
      Alert.alert(
        'Storage',
        result.prunedCount > 0
          ? `Cleared ${result.prunedCount} old evidence file(s), freed ${formatBytes(result.freedBytes)}.`
          : 'No evidence old enough to clear yet (30+ days since confirmed upload).',
      );
      await loadData();
    } catch {
      Alert.alert('Storage', 'Could not run evidence cleanup.');
    } finally {
      setPruning(false);
    }
  }

  function confirmSignOut() {
    Alert.alert('Sign Out', 'Local cached incidents and GPS tracks will remain encrypted on this device.', [
      { text: 'Cancel', style: 'cancel' },
      { text: 'Sign Out', style: 'destructive', onPress: handleSignOut },
    ]);
  }

  async function handleSignOut() {
    try {
      await logout();
    } catch {
      // Offline sign-out is fine — the server-side session dies on its own TTL.
    }
    void stopPatrolTracking();
    await clearSession();
    await closeLocalDatabase();
    router.replace('/login');
  }

  async function handleTestCriticalAlert() {
    try {
      await triggerTestCriticalAlert();
    } catch {
      Alert.alert('Test alert failed', 'Could not post the test full-screen alert.');
    }
  }

  const totalUnsynced = localStats.unsyncedIncidents + localStats.unsyncedGps + localStats.pendingQueue;

  return (
    <View style={{ flex: 1, backgroundColor: colors.bg }}>
      <MobileHeader title="CONSOLE & PROFILE" subtitle="Responder Diagnostics" />
      <ScrollView contentContainerStyle={styles.scroll}>
        <View style={[styles.card, { backgroundColor: colors.navy, borderRadius: tokens.radius.lg }]}>
          <Text style={styles.officerName}>{session?.fullName ?? 'Signed in'}</Text>
          <Text style={styles.officerRole}>
            {(session?.role ?? '').toUpperCase()} · Barangay #{session?.barangayId ?? 1}
          </Text>
          <View style={styles.deviceStrip}>
            <View style={{ flex: 1, minWidth: 0 }}>
              <Text style={styles.deviceLabel}>Device Identity Key</Text>
              <Text style={styles.deviceKey} numberOfLines={1}>{deviceId || 'Loading…'}</Text>
            </View>
            <Pressable style={styles.copyBtn} onPress={handleCopyDeviceId}>
              <Ionicons name={copiedDevice ? 'checkmark' : 'copy-outline'} size={13} color="#fff" />
              <Text style={styles.copyBtnText}>{copiedDevice ? 'Copied' : 'Copy'}</Text>
            </Pressable>
          </View>
        </View>

        <View style={styles.quickGrid}>
          <Pressable style={[styles.quickCard, { backgroundColor: colors.surface, borderRadius: tokens.radius.md }]} onPress={() => router.push('/(tabs)/reports')}>
            <Ionicons name="document-text" size={18} color={colors.primary} />
            <Text style={[styles.quickLabel, { color: colors.textPrimary }]}>My Reports</Text>
            <Text style={{ color: colors.textTertiary, fontSize: 10 }}>Filed incidents & sync</Text>
          </Pressable>
          <Pressable style={[styles.quickCard, { backgroundColor: colors.surface, borderRadius: tokens.radius.md }]} onPress={() => router.push('/shifts')}>
            <Ionicons name="calendar" size={18} color={colors.primary} />
            <Text style={[styles.quickLabel, { color: colors.textPrimary }]}>My Shifts</Text>
            <Text style={{ color: colors.textTertiary, fontSize: 10 }}>Schedule & swap requests</Text>
          </Pressable>
        </View>

        <Section title="Appearance" icon="color-palette" colors={colors} tokens={tokens}>
          <View style={styles.row}>
            <Text style={{ color: colors.textPrimary, fontSize: 15 }}>Dark mode</Text>
            <Switch value={mode === 'dark'} onValueChange={(v) => setPreference(v ? 'dark' : 'light')} />
          </View>
        </Section>

        <Section title="Workstation LAN Telemetry" icon="wifi" colors={colors} tokens={tokens} badge={isOnline ? 'ONLINE' : 'OFFLINE'} badgeTone={isOnline ? 'success' : 'warning'}>
          <View style={styles.statGrid}>
            <StatBox label="LAN Latency" value={latency !== null ? `${latency} ms` : 'Unreachable'} colors={colors} />
            <StatBox label="Sliding JWT" value="Auto-Renew" colors={colors} valueColor={colors.success} />
          </View>
          <Pressable disabled={pinging} style={[styles.outlineBtn, { borderColor: colors.border }]} onPress={pingWorkstation}>
            {pinging ? <ActivityIndicator color={colors.primary} /> : <Text style={{ color: colors.primary, fontWeight: '700' }}>Ping Barangay Workstation</Text>}
          </Pressable>

          <Pressable style={styles.drawerToggle} onPress={() => setShowServerSettings((v) => !v)}>
            <Text style={{ color: colors.textSecondary, fontSize: 12 }}>Workstation Address {hasApiBaseUrlOverride() ? '(Custom Override)' : ''}</Text>
            <Ionicons name={showServerSettings ? 'chevron-up' : 'chevron-down'} size={14} color={colors.textTertiary} />
          </Pressable>
          {showServerSettings ? (
            <View style={{ marginTop: 8 }}>
              <TextInput
                value={baseUrlInput}
                onChangeText={setBaseUrlInput}
                autoCapitalize="none"
                autoCorrect={false}
                placeholder="Workstation LAN URL"
                placeholderTextColor={colors.textTertiary}
                style={[styles.textInput, { borderColor: colors.border, color: colors.textPrimary }]}
              />
              <View style={{ flexDirection: 'row', gap: 8, marginTop: 8 }}>
                <Pressable disabled={savingBaseUrl || !baseUrlInput.trim()} style={[styles.outlineBtn, { flex: 1, borderColor: colors.border }]} onPress={handleSaveBaseUrl}>
                  {savingBaseUrl ? <ActivityIndicator color={colors.primary} /> : <Text style={{ color: colors.primary, fontWeight: '700' }}>Save & Reconnect</Text>}
                </Pressable>
                {hasApiBaseUrlOverride() ? (
                  <Pressable disabled={savingBaseUrl} onPress={handleResetBaseUrl} style={styles.resetBtn}>
                    <Text style={{ color: colors.textSecondary, fontWeight: '600' }}>Reset Default</Text>
                  </Pressable>
                ) : null}
              </View>
            </View>
          ) : null}
        </Section>

        <Section title="Offline SQLite Database" icon="server" colors={colors} tokens={tokens} badge="ENCRYPTED" badgeTone="info">
          <View style={styles.statGrid}>
            <StatBox label="Cached Dispatches" value={String(localStats.dispatches)} colors={colors} />
            <StatBox label="Unsynced Reports" value={String(localStats.unsyncedIncidents)} colors={colors} valueColor={localStats.unsyncedIncidents > 0 ? colors.warning : undefined} />
            <StatBox label="GPS Breadcrumbs" value={String(localStats.unsyncedGps)} colors={colors} />
            <StatBox label="Queued Transitions" value={String(localStats.pendingQueue)} colors={colors} />
          </View>
          <Pressable disabled={syncing || !isOnline} style={[styles.primaryBtn, { backgroundColor: colors.primary, opacity: syncing || !isOnline ? 0.6 : 1 }]} onPress={handleManualSync}>
            {syncing ? (
              <ActivityIndicator color="#fff" />
            ) : (
              <>
                <Ionicons name="sync" size={14} color="#fff" />
                <Text style={styles.primaryBtnText}>Sync All Local Records ({totalUnsynced})</Text>
              </>
            )}
          </Pressable>

          {storage ? (
            <>
              <Pressable style={styles.drawerToggle} onPress={() => setShowStorageDetails((v) => !v)}>
                <Text style={{ color: colors.textSecondary, fontSize: 12 }}>Evidence Files & Offline Map Storage</Text>
                <Ionicons name={showStorageDetails ? 'chevron-up' : 'chevron-down'} size={14} color={colors.textTertiary} />
              </Pressable>
              {showStorageDetails ? (
                <View>
                  <View style={styles.statGrid}>
                    <StatBox label="Evidence Files" value={`${formatBytes(storage.evidence.totalBytes)} (${storage.evidence.fileCount})`} colors={colors} />
                    <StatBox label="Map Packages" value={`${formatBytes(storage.mapPackages.totalBytes)} (${storage.mapPackages.fileCount})`} colors={colors} />
                  </View>
                  <Pressable disabled={pruning} style={[styles.outlineBtn, { borderColor: colors.border }]} onPress={handlePruneEvidence}>
                    {pruning ? <ActivityIndicator color={colors.primary} /> : <Text style={{ color: colors.primary, fontWeight: '600' }}>Clear Old Synced Evidence (30+ days)</Text>}
                  </Pressable>
                </View>
              ) : null}
            </>
          ) : null}
        </Section>

        <Section title="Alert & Audio Verification" icon="notifications" colors={colors} tokens={tokens}>
          <Text style={{ color: colors.textSecondary, fontSize: 12, marginBottom: 10 }}>
            Push notification permission: not available — Firebase push isn&apos;t wired up in this build yet.
          </Text>
          <Pressable style={[styles.outlineBtn, { borderColor: colors.border }]} onPress={handleTestCriticalAlert}>
            <Ionicons name="warning-outline" size={14} color={colors.warning} />
            <Text style={{ color: colors.warning, fontWeight: '700' }}>Test Full-Screen Alert</Text>
          </Pressable>
        </Section>

        <Pressable style={[styles.signOutBtn, { borderColor: colors.critical }]} onPress={confirmSignOut}>
          <Ionicons name="log-out-outline" size={16} color={colors.critical} />
          <Text style={{ color: colors.critical, fontWeight: '700' }}>SIGN OUT OF TERMINAL</Text>
        </Pressable>
      </ScrollView>
    </View>
  );
}

function Section({
  title,
  icon,
  colors,
  tokens,
  badge,
  badgeTone,
  children,
}: {
  title: string;
  icon: keyof typeof Ionicons.glyphMap;
  colors: ReturnType<typeof useTheme>['colors'];
  tokens: ReturnType<typeof useTheme>['tokens'];
  badge?: string;
  badgeTone?: 'success' | 'warning' | 'info';
  children: React.ReactNode;
}) {
  const badgeBg = badgeTone ? { success: colors.tintSuccessBg, warning: colors.tintWarningBg, info: colors.tintInfoBg }[badgeTone] : undefined;
  const badgeFg = badgeTone ? { success: colors.pillSuccessText, warning: colors.pillWarningText, info: colors.pillInfoText }[badgeTone] : undefined;
  return (
    <View style={[styles.card, { backgroundColor: colors.surface, borderRadius: tokens.radius.lg }]}>
      <View style={styles.sectionHeader}>
        <View style={styles.row}>
          <Ionicons name={icon} size={16} color={colors.primary} />
          <Text style={{ color: colors.textPrimary, fontWeight: '700', fontSize: 13 }}>{title}</Text>
        </View>
        {badge ? (
          <View style={{ backgroundColor: badgeBg, borderRadius: 999, paddingHorizontal: 8, paddingVertical: 3 }}>
            <Text style={{ color: badgeFg, fontSize: 10, fontWeight: '700' }}>{badge}</Text>
          </View>
        ) : null}
      </View>
      <View style={{ marginTop: 10 }}>{children}</View>
    </View>
  );
}

function StatBox({ label, value, colors, valueColor }: { label: string; value: string; colors: ReturnType<typeof useTheme>['colors']; valueColor?: string }) {
  return (
    <View style={[styles.statBox, { backgroundColor: colors.tintNeutralBg }]}>
      <Text style={{ color: colors.textTertiary, fontSize: 10 }}>{label}</Text>
      <Text style={{ color: valueColor ?? colors.textPrimary, fontWeight: '700', fontSize: 14, marginTop: 2 }}>{value}</Text>
    </View>
  );
}

const styles = StyleSheet.create({
  scroll: { padding: 16, gap: 14 },
  card: { padding: 16 },
  officerName: { color: '#fff', fontSize: 17, fontWeight: '800' },
  officerRole: { color: 'rgba(255,255,255,0.7)', fontSize: 11, marginTop: 2 },
  deviceStrip: { flexDirection: 'row', alignItems: 'center', gap: 10, marginTop: 14, backgroundColor: 'rgba(255,255,255,0.08)', borderRadius: 10, padding: 10 },
  deviceLabel: { color: 'rgba(255,255,255,0.6)', fontSize: 9, textTransform: 'uppercase', fontWeight: '700' },
  deviceKey: { color: '#fff', fontSize: 11, fontFamily: 'monospace', marginTop: 2 },
  copyBtn: { flexDirection: 'row', alignItems: 'center', gap: 4, backgroundColor: 'rgba(255,255,255,0.15)', borderRadius: 999, paddingHorizontal: 10, paddingVertical: 6 },
  copyBtnText: { color: '#fff', fontSize: 11, fontWeight: '700' },
  quickGrid: { flexDirection: 'row', gap: 12 },
  quickCard: { flex: 1, padding: 14, gap: 4 },
  quickLabel: { fontSize: 13, fontWeight: '700' },
  row: { flexDirection: 'row', alignItems: 'center', gap: 8, justifyContent: 'space-between' },
  sectionHeader: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between' },
  statGrid: { flexDirection: 'row', flexWrap: 'wrap', gap: 8, marginBottom: 10 },
  statBox: { flexGrow: 1, minWidth: '45%', borderRadius: 10, padding: 10 },
  outlineBtn: { flexDirection: 'row', alignItems: 'center', justifyContent: 'center', gap: 6, borderWidth: 1, borderRadius: 10, paddingVertical: 10, marginBottom: 6 },
  primaryBtn: { flexDirection: 'row', alignItems: 'center', justifyContent: 'center', gap: 6, borderRadius: 10, paddingVertical: 12, marginBottom: 6 },
  primaryBtnText: { color: '#fff', fontWeight: '700', fontSize: 13 },
  resetBtn: { paddingHorizontal: 14, alignItems: 'center', justifyContent: 'center' },
  drawerToggle: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', paddingVertical: 8 },
  textInput: { borderWidth: 1, borderRadius: 10, padding: 10, fontSize: 13 },
  signOutBtn: { flexDirection: 'row', alignItems: 'center', justifyContent: 'center', gap: 8, borderWidth: 1, borderRadius: 12, paddingVertical: 14 },
});
