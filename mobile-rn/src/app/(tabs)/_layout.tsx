/**
 * Bottom-nav tabs. Port of ../mobile/src/App.tsx's `TabbedShell`.
 *
 * Tab order/rationale unchanged (2026-09-03 decision): Log Incident keeps
 * the persistent, always-one-tap-away slot for a field emergency app.
 * Schedule (M8/M9) and My Reports (M14) stay off the bar, reachable from
 * Profile — used far less often than the four that get a tab.
 *
 * "Log Incident" is not a real tab screen: `listeners.tabPress` intercepts
 * the press and pushes the modal route instead, so it never becomes the
 * active tab (mirrors the old app routing to `/tabs/incidents/new` outside
 * the tab's own back-stack, tab bar hidden by the modal covering it).
 */
import { router, Tabs } from 'expo-router';
import { Ionicons } from '@expo/vector-icons';
import { useTheme } from '../../theme/ThemeProvider';

export default function TabsLayout() {
  const { colors } = useTheme();

  return (
    <Tabs
      screenOptions={{
        headerShown: false,
        tabBarActiveTintColor: colors.primary,
        tabBarInactiveTintColor: colors.textTertiary,
        tabBarStyle: { backgroundColor: colors.surface, borderTopColor: colors.border },
      }}
    >
      <Tabs.Screen
        name="home"
        options={{
          title: 'Home',
          tabBarIcon: ({ color, focused, size }) => <Ionicons name={focused ? 'home' : 'home-outline'} color={color} size={size} />,
        }}
      />
      <Tabs.Screen
        name="assignments"
        options={{
          title: 'Assignments',
          tabBarIcon: ({ color, focused, size }) => <Ionicons name={focused ? 'list' : 'list-outline'} color={color} size={size} />,
        }}
      />
      <Tabs.Screen
        name="log-incident"
        options={{
          title: 'Log Incident',
          tabBarIcon: ({ color, size }) => <Ionicons name="add-circle" color={color} size={size + 6} />,
        }}
        listeners={{
          tabPress: (e) => {
            e.preventDefault();
            router.push('/incidents/new');
          },
        }}
      />
      <Tabs.Screen
        name="map"
        options={{
          title: 'Map',
          tabBarIcon: ({ color, focused, size }) => <Ionicons name={focused ? 'map' : 'map-outline'} color={color} size={size} />,
        }}
      />
      <Tabs.Screen
        name="profile"
        options={{
          title: 'Profile',
          tabBarIcon: ({ color, focused, size }) => <Ionicons name={focused ? 'person' : 'person-outline'} color={color} size={size} />,
        }}
      />
      {/* M14 — reached from Profile, not its own tab bar button. Expo
          Router auto-adds a bar entry for every file in this group unless
          explicitly suppressed with href: null. */}
      <Tabs.Screen name="reports" options={{ href: null }} />
    </Tabs>
  );
}
