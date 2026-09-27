/**
 * Branded topbar. Port of ../mobile's MobileHeader.tsx — the theme toggle
 * moved into Profile (Phase 2) rather than living here twice, and the
 * sync-queue modal it opened is Phase 7 diagnostics scope; the shield
 * brand mark, back button, and the live/cache connection probe carry over.
 */
import { useEffect, useState } from 'react';
import { router } from 'expo-router';
import { Pressable, StyleSheet, Text, View } from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import { useTheme } from '../theme/ThemeProvider';
import { checkHealth } from '../services/apiService';

interface MobileHeaderProps {
  title?: string;
  subtitle?: string;
  showBack?: boolean;
}

export default function MobileHeader({ title, subtitle, showBack = false }: MobileHeaderProps) {
  const { colors } = useTheme();
  const [isOnline, setIsOnline] = useState<boolean | null>(null);

  useEffect(() => {
    let cancelled = false;
    async function probe() {
      const ok = await checkHealth();
      if (!cancelled) setIsOnline(ok);
    }
    void probe();
    const interval = setInterval(probe, 30000);
    return () => {
      cancelled = true;
      clearInterval(interval);
    };
  }, []);

  return (
    <View style={[styles.bar, { backgroundColor: colors.navy }]}>
      {showBack ? (
        <Pressable onPress={() => router.back()} hitSlop={12} style={styles.backBtn}>
          <Ionicons name="chevron-back" size={22} color="#fff" />
        </Pressable>
      ) : (
        <View style={[styles.emblem, { backgroundColor: colors.primary }]}>
          <Text style={styles.emblemText}>B</Text>
        </View>
      )}

      <View style={styles.textBlock}>
        <Text style={styles.title} numberOfLines={1}>
          {title || 'BARANGUARD'}
        </Text>
        <Text style={styles.subtitle} numberOfLines={1}>
          {subtitle || 'Field Console'}
        </Text>
      </View>

      <View style={styles.statusPill}>
        <View style={[styles.statusDot, { backgroundColor: isOnline ? colors.success : colors.textDisabled }]} />
        <Text style={styles.statusText}>{isOnline ? 'LIVE' : 'CACHE'}</Text>
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  bar: { flexDirection: 'row', alignItems: 'center', paddingHorizontal: 12, paddingVertical: 10, gap: 10 },
  backBtn: { width: 32, height: 32, alignItems: 'center', justifyContent: 'center' },
  emblem: { width: 32, height: 32, borderRadius: 16, alignItems: 'center', justifyContent: 'center' },
  emblemText: { color: '#fff', fontWeight: '700' },
  textBlock: { flex: 1 },
  title: { color: '#fff', fontWeight: '700', fontSize: 14, letterSpacing: 0.5 },
  subtitle: { color: 'rgba(255,255,255,0.7)', fontSize: 11 },
  statusPill: { flexDirection: 'row', alignItems: 'center', gap: 5 },
  statusDot: { width: 7, height: 7, borderRadius: 4 },
  statusText: { color: '#fff', fontSize: 11, fontWeight: '600' },
});
