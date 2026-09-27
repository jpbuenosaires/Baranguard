// Must be imported once, from the app's root component — Expo Router has no
// App.tsx, so `_layout.tsx` is that root. See global.css's own doc comment.
import '../../global.css';
import { useEffect } from 'react';
import { router, Stack } from 'expo-router';
import * as SplashScreen from 'expo-splash-screen';
import { useFonts, Inter_400Regular, Inter_500Medium, Inter_600SemiBold, Inter_700Bold } from '@expo-google-fonts/inter';
import { StatusBar } from 'expo-status-bar';
import { GestureHandlerRootView } from 'react-native-gesture-handler';
import { HeroUINativeProvider } from 'heroui-native';
import { ThemeProvider } from '../theme/ThemeProvider';
import CriticalAlertOverlay from '../components/CriticalAlertOverlay';
import { onSessionExpired } from '../services/session';
import { startSyncScheduler } from '../services/syncScheduler';
import { pruneOldSyncedEvidenceFiles } from '../services/storageMaintenance';
import { checkForPendingNativeAlert } from '../services/criticalAlertStore';

void SplashScreen.preventAutoHideAsync();

/**
 * Listens for `apiService.ts`'s `request()` reporting a dead session (a
 * 401 on an authenticated call) and leaves whatever screen is up for
 * `/login` immediately. Mounted once at the root, same as
 * ../mobile/src/App.tsx's `SessionExpiryWatcher`.
 */
function useSessionExpiryWatcher() {
  useEffect(() => onSessionExpired(() => router.replace('/login')), []);
}

export default function RootLayout() {
  const [fontsLoaded] = useFonts({
    Inter_400Regular,
    Inter_500Medium,
    Inter_600SemiBold,
    Inter_700Bold,
  });
  useSessionExpiryWatcher();

  useEffect(() => {
    if (fontsLoaded) void SplashScreen.hideAsync();
  }, [fontsLoaded]);

  // Registered once at the root, same as ../mobile/src/App.tsx: a Tanod
  // regaining connectivity while sitting on the login screen (signed out
  // from a previous session) should not need a screen that sets up its
  // own sync trigger. Evidence pruning runs once per cold start — its
  // 30-day rule only matters on that timescale.
  useEffect(() => {
    startSyncScheduler();
    void pruneOldSyncedEvidenceFiles();
    // M12: picks up an alert CriticalAlertActivity's "Open Baranguard"
    // button stashed just before this cold launch — see
    // criticalAlertStore.ts's own doc for why this is the third delivery
    // path, alongside the (not yet wired) foreground/tapped push listeners.
    void checkForPendingNativeAlert();
  }, []);

  if (!fontsLoaded) return null;

  return (
    // GestureHandlerRootView is required at the true root for
    // react-native-gesture-handler (HeroUI Native's Switch/Slider/sheets
    // depend on it); HeroUINativeProvider supplies HeroUI's toast host and
    // portal (dialogs/menus render there) to every screen below it.
    // ThemeProvider stays innermost-of-the-three but still wraps
    // everything screen-level: it is now the one thing that also drives
    // Uniwind's theme (see ThemeProvider.tsx), so both the HeroUI/Tailwind
    // screens and any screen still on the old tokens.ts context agree.
    <GestureHandlerRootView style={{ flex: 1 }}>
      <HeroUINativeProvider>
        <ThemeProvider>
          <StatusBar style="light" />
          <Stack screenOptions={{ headerShown: false }}>
            <Stack.Screen name="index" />
            <Stack.Screen name="login" />
            <Stack.Screen name="(tabs)" />
            <Stack.Screen name="incidents/new" options={{ presentation: 'modal' }} />
            <Stack.Screen name="incidents/pick-location" options={{ presentation: 'modal' }} />
            <Stack.Screen name="incidents/[localId]/submitted" options={{ presentation: 'modal' }} />
            <Stack.Screen name="assignments/[localId]" options={{ presentation: 'modal' }} />
          </Stack>
          {/* Outside the Stack/tab router so an SOS/priority alert interrupts whichever screen a Tanod is on. */}
          <CriticalAlertOverlay />
        </ThemeProvider>
      </HeroUINativeProvider>
    </GestureHandlerRootView>
  );
}
