/**
 * M10 Profile — Phase 2 gives it real session display, theme toggle, and
 * sign-out; the full diagnostics panel (sync queue, storage, server URL
 * card) lands in Phase 7. Phase 6 adds a "Test Full-Screen Alert" button —
 * the one way to exercise `modules/critical-alert`'s native path without a
 * real FCM project (REMAINING.md A4), same as the old app's own Profile.
 *
 * Logout fix (defect 4, DEVLOG 2026-09-27 (3)): the old app's sign-out
 * never closed the local database or stopped patrol tracking. Both now
 * happen here — DB close since Phase 1, patrol tracking since Phase 5.
 */
import { useEffect, useState } from 'react';
import { router } from 'expo-router';
import { Alert, Pressable, StyleSheet, Switch, Text, View } from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import { useTheme } from '../../theme/ThemeProvider';
import { logout } from '../../services/apiService';
import { clearSession, loadSession, type StoredSession } from '../../services/session';
import { closeLocalDatabase } from '../../services/db/localDatabase';
import { stopPatrolTracking } from '../../services/patrolLocationService';
import { triggerTestCriticalAlert } from '../../services/criticalAlertStore';

export default function ProfileScreen() {
  const { colors, mode, setPreference } = useTheme();
  const [session, setSession] = useState<StoredSession | null>(null);

  useEffect(() => {
    void loadSession().then(setSession);
  }, []);

  function confirmSignOut() {
    Alert.alert('Sign Out', 'Sign out of Baranguard?', [
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

  return (
    <View style={[styles.container, { backgroundColor: colors.bg }]}>
      <View style={[styles.card, { backgroundColor: colors.surface, borderRadius: 16 }]}>
        <Text style={[styles.name, { color: colors.textPrimary }]}>{session?.fullName ?? 'Signed in'}</Text>
        <Text style={[styles.role, { color: colors.textSecondary }]}>{session?.role ?? ''}</Text>
      </View>

      <View style={[styles.card, { backgroundColor: colors.surface, borderRadius: 16 }]}>
        <View style={styles.row}>
          <Text style={{ color: colors.textPrimary, fontSize: 15 }}>Dark mode</Text>
          <Switch value={mode === 'dark'} onValueChange={(v) => setPreference(v ? 'dark' : 'light')} />
        </View>
      </View>

      <Pressable
        style={[styles.linkRow, { backgroundColor: colors.surface, borderRadius: 16 }]}
        onPress={() => router.push('/(tabs)/reports')}
      >
        <Ionicons name="document-text-outline" size={18} color={colors.textPrimary} />
        <Text style={{ color: colors.textPrimary, fontSize: 15, flex: 1 }}>My Reports</Text>
        <Ionicons name="chevron-forward" size={16} color={colors.textTertiary} />
      </Pressable>

      <Pressable style={[styles.linkRow, { backgroundColor: colors.surface, borderRadius: 16 }]} onPress={handleTestCriticalAlert}>
        <Ionicons name="warning-outline" size={18} color={colors.warning} />
        <Text style={{ color: colors.textPrimary, fontSize: 15, flex: 1 }}>Test Full-Screen Alert</Text>
        <Ionicons name="chevron-forward" size={16} color={colors.textTertiary} />
      </Pressable>

      <Pressable style={[styles.signOutBtn, { borderColor: colors.critical }]} onPress={confirmSignOut}>
        <Text style={{ color: colors.critical, fontWeight: '600' }}>Sign Out</Text>
      </Pressable>
    </View>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1, padding: 16, gap: 16 },
  card: { padding: 16 },
  name: { fontSize: 18, fontWeight: '700' },
  role: { fontSize: 13, marginTop: 2, textTransform: 'capitalize' },
  row: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between' },
  linkRow: { flexDirection: 'row', alignItems: 'center', gap: 10, padding: 16 },
  signOutBtn: { borderWidth: 1, borderRadius: 12, paddingVertical: 14, alignItems: 'center', marginTop: 8 },
});
