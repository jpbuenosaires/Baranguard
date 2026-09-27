/**
 * CriticalAlertOverlay.tsx — M12 Critical Alert Overlay (§9). Port of
 * ../mobile's CriticalAlertOverlay.tsx. Mounted ONCE at the root layout,
 * outside the tab router — an SOS or priority alert must interrupt
 * whichever screen a Tanod is on. Renders nothing when
 * `criticalAlertStore` has no current alert.
 *
 * Reads ONLY what the push payload already carried — never an API call to
 * enrich the alert before showing it. Acknowledge's failure does NOT keep
 * the overlay up (§2 Rule 7/15's offline-first stance) — the ack is
 * fire-and-forget, since it's a distinct, idempotent, always-retriable call.
 */
import { useEffect, useState } from 'react';
import { ActivityIndicator, Pressable, StyleSheet, Text, View } from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import { subscribeToCriticalAlert, dismissCriticalAlert, type CriticalAlertData } from '../services/criticalAlertStore';
import { acknowledgeNotification } from '../services/apiService';

const TYPE_LABEL: Record<CriticalAlertData['notificationType'], string> = {
  sos: 'SOS ALERT',
  priority_alert: 'PRIORITY ALERT',
  dispatch: 'NEW DISPATCH',
};

export default function CriticalAlertOverlay() {
  const [alert, setAlert] = useState<CriticalAlertData | null>(null);
  const [acknowledging, setAcknowledging] = useState(false);

  useEffect(() => subscribeToCriticalAlert(setAlert), []);

  if (!alert) return null;

  async function handleAcknowledge() {
    if (!alert) return;
    setAcknowledging(true);
    try {
      await acknowledgeNotification(alert.notificationId);
    } catch {
      // Fire-and-forget on failure.
    } finally {
      setAcknowledging(false);
      dismissCriticalAlert();
    }
  }

  return (
    <View style={styles.backdrop} pointerEvents="box-none">
      <View style={styles.card}>
        <View style={styles.header}>
          <Ionicons name="warning" size={22} color="#dc2626" />
          <Text style={styles.title}>{TYPE_LABEL[alert.notificationType]}</Text>
        </View>
        <Text style={styles.body}>{alert.body || alert.title}</Text>
        <Pressable disabled={acknowledging} onPress={handleAcknowledge} style={[styles.button, { opacity: acknowledging ? 0.7 : 1 }]}>
          {acknowledging ? <ActivityIndicator color="#fff" /> : <Text style={styles.buttonText}>Acknowledge Alert</Text>}
        </Pressable>
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  backdrop: {
    position: 'absolute',
    top: 0,
    left: 0,
    right: 0,
    bottom: 0,
    backgroundColor: 'rgba(0,0,0,0.6)',
    alignItems: 'center',
    justifyContent: 'center',
    padding: 20,
    zIndex: 1000,
  },
  card: {
    width: '100%',
    maxWidth: 420,
    backgroundColor: '#1e293b',
    borderRadius: 16,
    borderTopWidth: 4,
    borderTopColor: '#dc2626',
    padding: 20,
    shadowColor: '#dc2626',
    shadowOpacity: 0.4,
    shadowRadius: 12,
    elevation: 12,
  },
  header: { flexDirection: 'row', alignItems: 'center', gap: 8, marginBottom: 10 },
  title: { color: '#fca5a5', fontWeight: '800', fontSize: 15, letterSpacing: 0.5 },
  body: { color: '#e2e8f0', fontSize: 14, lineHeight: 20, marginBottom: 16 },
  button: { backgroundColor: '#dc2626', borderRadius: 12, paddingVertical: 14, alignItems: 'center' },
  buttonText: { color: '#fff', fontWeight: '800', fontSize: 14 },
});
