/**
 * M1 Login. Port of ../mobile/src/pages/login.tsx.
 *
 * Rules this screen honors, unchanged:
 *   - No role selector — the server derives role from the account.
 *   - Generic failure message: unknown-user/wrong-password/locked-account
 *     are externally indistinguishable. An unreachable workstation gets
 *     its own honest message — a different fact, not a credential problem.
 *   - Submit disabled while authenticating.
 *   - Post-login setup (device registration, map package, SOS fallback
 *     contact) never blocks entering the app.
 */
import { useState } from 'react';
import { router } from 'expo-router';
import { ActivityIndicator, Alert, Pressable, ScrollView, StyleSheet, Text, TextInput, View } from 'react-native';
import { TextField } from '../components/FormFields';
import { useTheme } from '../theme/ThemeProvider';
import {
  ApiError,
  getApiBaseUrl,
  hasApiBaseUrlOverride,
  login,
  registerDevice,
  setApiBaseUrlOverride,
} from '../services/apiService';
import { getDeviceId, getDevicePublicKeyPem, getFcmToken } from '../services/deviceIdentity';
import { ensureMapPackageDownloaded } from '../services/mapPackageService';
import { storeMessageEncryptionKey } from '../services/messageEncryptionKey';
import { refreshSosFallbackContact } from '../services/sosFallbackContact';

const GENERIC_FAILURE = 'Unable to sign in with those credentials.';

export default function LoginScreen() {
  const { colors, tokens } = useTheme();
  const [username, setUsername] = useState('');
  const [password, setPassword] = useState('');
  const [showPassword, setShowPassword] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [serverUrlOpen, setServerUrlOpen] = useState(false);
  const [serverUrlDraft, setServerUrlDraft] = useState(getApiBaseUrl());

  async function handleSubmit() {
    setError(null);
    if (!username.trim() || !password) {
      setError('Enter your username and password.');
      return;
    }

    setBusy(true);
    try {
      const session = await login(username.trim(), password);
      // Authenticated. Everything below is best-effort — must never block entry.
      await runPostLoginSetup(session.barangayId);
      router.replace('/(tabs)/home');
    } catch (err) {
      if (err instanceof ApiError && err.isOffline) {
        setError('Cannot reach the barangay workstation. Check your connection to the barangay network.');
      } else {
        setError(GENERIC_FAILURE);
      }
      setPassword('');
    } finally {
      setBusy(false);
    }
  }

  function handleSaveServerUrl() {
    const trimmed = serverUrlDraft.trim();
    if (!trimmed) return;
    if (!/^https?:\/\//i.test(trimmed)) {
      Alert.alert('Invalid address', 'Enter a full address starting with http:// or https://');
      return;
    }
    void setApiBaseUrlOverride(trimmed);
    setServerUrlOpen(false);
  }

  return (
    <ScrollView
      style={{ backgroundColor: colors.navyDeep }}
      contentContainerStyle={styles.scrollContent}
      keyboardShouldPersistTaps="handled"
    >
      <View style={styles.brand}>
        <View style={[styles.emblem, { backgroundColor: colors.primary }]}>
          <Text style={styles.emblemText}>B</Text>
        </View>
        <Text style={styles.title}>BARANGUARD</Text>
        <Text style={styles.subtitle}>Field Responder Console</Text>
      </View>

      <View style={[styles.card, { backgroundColor: colors.surface, borderRadius: tokens.radius.lg }]}>
        <TextField label="Username" value={username} onChange={setUsername} autoCapitalize="none" disabled={busy} />
        <View>
          <TextField
            label="Password"
            value={password}
            onChange={setPassword}
            secureTextEntry={!showPassword}
            disabled={busy}
          />
          <Pressable style={styles.showPasswordBtn} onPress={() => setShowPassword((v) => !v)}>
            <Text style={{ color: colors.textSecondary, fontSize: 13 }}>{showPassword ? 'Hide' : 'Show'}</Text>
          </Pressable>
        </View>

        {error ? (
          <Text style={[styles.error, { color: colors.critical, backgroundColor: colors.tintCriticalBg }]} accessibilityRole="alert">
            {error}
          </Text>
        ) : null}

        <Pressable
          onPress={handleSubmit}
          disabled={busy}
          style={[styles.submitBtn, { backgroundColor: colors.primary, opacity: busy ? 0.7 : 1 }]}
        >
          {busy ? <ActivityIndicator color={colors.white} /> : <Text style={styles.submitText}>Sign In to Console</Text>}
        </Pressable>

        <Pressable
          disabled={busy}
          style={styles.workstationBtn}
          onPress={() => {
            setServerUrlDraft(getApiBaseUrl());
            setServerUrlOpen(true);
          }}
        >
          <Text style={{ color: colors.textSecondary }}>
            Workstation address{hasApiBaseUrlOverride() ? ' (custom)' : ''}
          </Text>
        </Pressable>
      </View>

      {serverUrlOpen ? (
        <View style={[styles.serverUrlPanel, { backgroundColor: colors.surface, borderRadius: tokens.radius.md }]}>
          <Text style={{ color: colors.textPrimary, fontWeight: '600', marginBottom: 8 }}>Workstation Address</Text>
          <Text style={{ color: colors.textSecondary, fontSize: 13, marginBottom: 8 }}>
            Only change this if told to by an administrator.
          </Text>
          <TextInput
            value={serverUrlDraft}
            onChangeText={setServerUrlDraft}
            autoCapitalize="none"
            placeholder="https://server:8081/api/v1"
            placeholderTextColor={colors.textDisabled}
            style={[styles.serverUrlInput, { borderColor: colors.border, color: colors.textPrimary }]}
          />
          <View style={styles.serverUrlActions}>
            <Pressable onPress={() => setServerUrlOpen(false)}>
              <Text style={{ color: colors.textSecondary }}>Cancel</Text>
            </Pressable>
            <Pressable
              onPress={() => {
                void setApiBaseUrlOverride(null);
                setServerUrlDraft(getApiBaseUrl());
              }}
            >
              <Text style={{ color: colors.warning }}>Reset to default</Text>
            </Pressable>
            <Pressable onPress={handleSaveServerUrl}>
              <Text style={{ color: colors.primary, fontWeight: '600' }}>Save</Text>
            </Pressable>
          </View>
        </View>
      ) : null}
    </ScrollView>
  );
}

/**
 * Device registration + map-package version check. Every failure here is
 * swallowed on purpose: the Tanod is already authenticated, and must enter
 * the app regardless.
 */
async function runPostLoginSetup(barangayId: number): Promise<void> {
  try {
    const fcmToken = await getFcmToken();
    const devicePublicKeyPem = await getDevicePublicKeyPem();
    const registration = await registerDevice({ deviceId: await getDeviceId(), fcmToken, devicePublicKeyPem });
    if (registration.messageEncryptionKey) {
      await storeMessageEncryptionKey(registration.messageEncryptionKey);
    }
  } catch {
    // Non-fatal by design.
  }

  // Deliberately not awaited — must never block entry, especially a
  // multi-MB map download.
  void ensureMapPackageDownloaded(barangayId);
  void refreshSosFallbackContact();
}

const styles = StyleSheet.create({
  scrollContent: { flexGrow: 1, justifyContent: 'center', padding: 20 },
  brand: { alignItems: 'center', marginBottom: 32 },
  emblem: { width: 56, height: 56, borderRadius: 28, alignItems: 'center', justifyContent: 'center', marginBottom: 12 },
  emblemText: { color: '#fff', fontSize: 24, fontWeight: '700' },
  title: { color: '#fff', fontSize: 24, fontWeight: '700', letterSpacing: 1 },
  subtitle: { color: '#94a3b8', fontSize: 14, marginTop: 4 },
  card: { padding: 20 },
  showPasswordBtn: { position: 'absolute', right: 12, top: 32 },
  error: { padding: 10, borderRadius: 8, marginBottom: 12, fontSize: 13 },
  submitBtn: { paddingVertical: 14, borderRadius: 10, alignItems: 'center', marginTop: 4 },
  submitText: { color: '#fff', fontWeight: '700', fontSize: 16 },
  workstationBtn: { alignItems: 'center', marginTop: 14, padding: 8 },
  serverUrlPanel: { marginTop: 16, padding: 16 },
  serverUrlInput: { borderWidth: 1, borderRadius: 8, padding: 10, marginBottom: 12 },
  serverUrlActions: { flexDirection: 'row', justifyContent: 'space-between' },
});
