/**
 * PickLocationScreen — modal route backing NewIncidentScreen's "Pick on Map"
 * button. Port of ../mobile's LocationPickerModal.tsx onto an expo-router
 * modal route (that app used an in-page IonModal; this rebuild's other
 * secondary flows — incidents/new, assignments/[localId] — are already
 * modal ROUTES, so this follows the same pattern rather than introducing a
 * one-off in-page modal component).
 *
 * Reuses `LiveMapCanvas` rather than a second map implementation, same
 * reasoning as the old app: the picked point renders through the existing
 * `incidents` marker path (a synthetic single-item array) instead of
 * teaching that shared component a new marker style only this screen needs.
 */
import { useEffect, useState } from 'react';
import { router, useLocalSearchParams } from 'expo-router';
import { Pressable, StyleSheet, Text, View, useWindowDimensions } from 'react-native';
import MobileHeader from '../components/MobileHeader';
import LiveMapCanvas, { type FocusTarget } from '../components/LiveMapCanvas';
import { useTheme } from '../theme/ThemeProvider';
import type { NearbyIncident } from '../services/apiService';
import { getCurrentPosition, type DevicePosition } from '../services/geolocation';
import { loadSession } from '../services/session';
import { resolveLocationPick } from '../services/locationPickerBridge';

export default function PickLocationScreen() {
  const { colors, tokens } = useTheme();
  const { height: windowHeight } = useWindowDimensions();
  const { lat, lng } = useLocalSearchParams<{ lat?: string; lng?: string }>();
  const initial: FocusTarget | null = lat && lng ? { latitude: Number(lat), longitude: Number(lng) } : null;

  const [barangayId, setBarangayId] = useState<number | null>(null);
  const [selfPosition, setSelfPosition] = useState<DevicePosition | null>(null);
  const [picked, setPicked] = useState<FocusTarget | null>(initial);

  useEffect(() => {
    let cancelled = false;
    loadSession().then((session) => {
      if (!cancelled && session) setBarangayId(session.barangayId);
    });
    return () => {
      cancelled = true;
    };
  }, []);

  useEffect(() => {
    let cancelled = false;
    getCurrentPosition()
      .then((p) => {
        if (!cancelled) setSelfPosition(p);
      })
      .catch(() => {});
    return () => {
      cancelled = true;
    };
  }, []);

  function handleCancel() {
    resolveLocationPick(null);
    router.back();
  }

  function handleConfirm() {
    if (!picked) return;
    resolveLocationPick(picked);
    router.back();
  }

  const pickedIncidents: NearbyIncident[] = picked
    ? [{ incidentId: -1, incidentType: 'picked_location', priority: 'normal', status: 'pending', latitude: picked.latitude, longitude: picked.longitude, ageSeconds: 0 }]
    : [];

  return (
    <View style={{ flex: 1, backgroundColor: colors.bg }}>
      <MobileHeader title="SET LOCATION" subtitle="Tap the map to drop a pin" />
      <View style={styles.body}>
        <LiveMapCanvas
          barangayId={barangayId}
          position={selfPosition}
          incidents={pickedIncidents}
          tanods={[]}
          focusTarget={picked}
          onMapClick={setPicked}
          height={Math.max(240, windowHeight - 300)}
        />
        <Text style={{ color: colors.textSecondary, fontSize: 13, marginTop: 10 }}>Tap anywhere on the map to drop a pin at that spot.</Text>
        {picked ? (
          <Text style={[styles.coords, { color: colors.textPrimary }]}>
            {picked.latitude.toFixed(5)}, {picked.longitude.toFixed(5)}
          </Text>
        ) : null}

        <Pressable
          disabled={!picked}
          onPress={handleConfirm}
          style={[styles.primaryBtn, { backgroundColor: colors.primary, borderRadius: tokens.radius.md, opacity: picked ? 1 : 0.5 }]}
        >
          <Text style={styles.primaryBtnText}>Use This Location</Text>
        </Pressable>
        <Pressable onPress={handleCancel} style={styles.cancelBtn}>
          <Text style={{ color: colors.textSecondary, fontWeight: '600' }}>Cancel</Text>
        </Pressable>
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  body: { padding: 16, flex: 1 },
  coords: { fontFamily: 'monospace', fontSize: 13, marginTop: 4 },
  primaryBtn: { marginTop: 14, paddingVertical: 14, alignItems: 'center' },
  primaryBtnText: { color: '#fff', fontWeight: '800', fontSize: 15 },
  cancelBtn: { marginTop: 10, paddingVertical: 10, alignItems: 'center' },
});
