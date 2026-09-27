/**
 * Cold-start session gate. Port of ../mobile/src/App.tsx's
 * `RequireSession` + the root `/` redirect, combined: expo-router has no
 * "wrap this whole subtree once" primitive, so the check runs here, once,
 * and redirects — same one-time-per-mount behavior (not per navigation),
 * same reasoning: gates on a session EXISTING (`hasStoredSession`), not on
 * local expiry, so a Tanod out of range still reaches their cached tabs.
 */
import { useEffect, useState } from 'react';
import { Redirect } from 'expo-router';
import { ActivityIndicator, View } from 'react-native';
import { hasStoredSession } from '../services/session';
import { useTheme } from '../theme/ThemeProvider';

export default function Index() {
  const { colors } = useTheme();
  const [state, setState] = useState<'checking' | 'in' | 'out'>('checking');

  useEffect(() => {
    let active = true;
    hasStoredSession().then((stored) => {
      if (active) setState(stored ? 'in' : 'out');
    });
    return () => {
      active = false;
    };
  }, []);

  if (state === 'checking') {
    return (
      <View style={{ flex: 1, alignItems: 'center', justifyContent: 'center', backgroundColor: colors.bg }}>
        <ActivityIndicator color={colors.primary} />
      </View>
    );
  }

  return <Redirect href={state === 'in' ? '/(tabs)/home' : '/login'} />;
}
