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
import { Pressable, View, type GestureResponderEvent } from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import { useThemeColor } from 'heroui-native';
import { useTheme } from '../../theme/ThemeProvider';

/**
 * The Log Incident tab's `tabBarButton` — a raised circular button matching
 * the approved Home mockup, instead of a same-size icon among the other
 * four. It still never becomes the "active" tab (see the file's own note
 * below): `onPress` is provided by expo-router/react-navigation and already
 * carries the `tabPress` interception below, so this only replaces the
 * button's LOOK, not its behavior.
 */
function ReportTabButton({ onPress }: { onPress?: (e: GestureResponderEvent) => void }) {
  const accent = useThemeColor('accent');
  return (
    <View className="flex-1 items-center">
      <Pressable
        onPress={onPress}
        accessibilityRole="button"
        accessibilityLabel="Report an incident"
        className="w-[60px] h-[60px] rounded-full items-center justify-center -mt-6 border-4 border-background"
        style={{ backgroundColor: accent, elevation: 6 }}
      >
        <Ionicons name="add" size={28} color="#ffffff" />
      </Pressable>
    </View>
  );
}

export default function TabsLayout() {
  const { colors } = useTheme();

  return (
    <Tabs
      screenOptions={{
        headerShown: false,
        tabBarActiveTintColor: colors.primary,
        tabBarInactiveTintColor: colors.textTertiary,
        tabBarStyle: { backgroundColor: colors.surface, borderTopColor: colors.border, height: 64, paddingBottom: 8, paddingTop: 8 },
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
          title: '',
          tabBarButton: (props) => <ReportTabButton onPress={props.onPress} />,
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
