/**
 * Tactical turn-by-turn HUD banner. Port of
 * ../mobile/src/components/ActiveStepCard.tsx.
 */
import { useState } from 'react';
import { Pressable, ScrollView, StyleSheet, Text, View } from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import type { NavigationState } from '../utils/routeProgress';
import { formatRemainingTime, formatNavDistance } from '../utils/routeProgress';
import type { RouteStep } from '../services/apiService';

interface Props {
  navState: NavigationState;
  steps: RouteStep[];
  mode: 'car' | 'foot';
  onReroute: () => void;
}

function maneuverIcon(instruction?: string | null): keyof typeof Ionicons.glyphMap {
  const lower = (instruction || '').toLowerCase();
  if (lower.includes('turn left') || lower.includes('bear left') || lower.includes('sharp left')) return 'arrow-back';
  if (lower.includes('turn right') || lower.includes('bear right') || lower.includes('sharp right')) return 'arrow-forward';
  if (lower.includes('u-turn')) return 'return-down-back';
  if (lower.includes('roundabout')) return 'refresh';
  if (lower.includes('arrive') || lower.includes('destination')) return 'flag';
  if (lower.includes('head') || lower.includes('depart') || lower.includes('start')) return 'navigate';
  return 'arrow-up';
}

export default function ActiveStepCard({ navState, steps, onReroute }: Props) {
  const [expanded, setExpanded] = useState(false);

  if (!navState.currentStep) return null;

  if (navState.hasArrived) {
    return (
      <View style={[styles.hud, { borderColor: '#10b981' }]}>
        <View style={styles.row}>
          <View style={[styles.maneuverIcon, { backgroundColor: 'rgba(16, 185, 129, 0.25)', borderColor: 'rgba(16, 185, 129, 0.6)' }]}>
            <Ionicons name="checkmark-circle" size={22} color="#34d399" />
          </View>
          <View style={{ flex: 1 }}>
            <Text style={[styles.instruction, { color: '#34d399' }]}>Destination Reached</Text>
            <Text style={{ color: '#a7f3d0', fontSize: 12 }}>Tap &quot;Mark Arrived&quot; to advance your status</Text>
          </View>
        </View>
      </View>
    );
  }

  if (navState.isOffRoute) {
    return (
      <View style={[styles.hud, { borderColor: '#f59e0b' }]}>
        <View style={styles.row}>
          <View style={[styles.maneuverIcon, { backgroundColor: 'rgba(245, 158, 11, 0.25)', borderColor: 'rgba(245, 158, 11, 0.6)' }]}>
            <Ionicons name="warning" size={22} color="#fbbf24" />
          </View>
          <View style={{ flex: 1 }}>
            <Text style={[styles.instruction, { color: '#fbbf24' }]}>Off Route</Text>
            <Text style={{ color: '#fde68a', fontSize: 12 }}>{formatNavDistance(navState.remainingDistanceM)} remaining</Text>
          </View>
          <Pressable onPress={onReroute} style={styles.rerouteBtn}>
            <Ionicons name="refresh" size={14} color="#000" />
            <Text style={styles.rerouteText}>Re-route</Text>
          </Pressable>
        </View>
      </View>
    );
  }

  const currentStep = navState.currentStep;
  const icon = maneuverIcon(currentStep.instruction || currentStep.maneuver);
  const upcomingSteps = steps.slice(navState.currentStepIndex + 1, navState.currentStepIndex + 4);

  return (
    <View style={styles.hud}>
      <View style={styles.row}>
        <View style={styles.maneuverIcon}>
          <Ionicons name={icon} size={22} color="#fff" />
        </View>
        <View style={{ flex: 1 }}>
          <View style={styles.distanceRow}>
            <Text style={styles.distance}>{formatNavDistance(navState.distanceToNextTurnM)}</Text>
            <Text style={styles.stats}>
              · {formatRemainingTime(navState.remainingTimeS)} ({formatNavDistance(navState.remainingDistanceM)})
            </Text>
          </View>
          <Text style={styles.instruction} numberOfLines={2}>
            {currentStep.instruction || `Continue on ${currentStep.maneuver}`}
          </Text>
        </View>
        {upcomingSteps.length > 0 ? (
          <Pressable onPress={() => setExpanded((v) => !v)} style={styles.toggleBtn}>
            <Ionicons name={expanded ? 'chevron-up' : 'chevron-down'} size={18} color="#fff" />
          </Pressable>
        ) : null}
      </View>

      <View style={styles.progressTrack}>
        <View style={[styles.progressFill, { width: `${Math.min(100, Math.max(0, Math.round(navState.progressFraction * 100)))}%` }]} />
      </View>

      {expanded && upcomingSteps.length > 0 ? (
        <ScrollView style={styles.upcomingList}>
          {upcomingSteps.map((step, idx) => (
            <View key={navState.currentStepIndex + 1 + idx} style={styles.upcomingRow}>
              <Ionicons name={maneuverIcon(step.instruction || step.maneuver)} size={14} color="#60a5fa" />
              <Text style={styles.upcomingText} numberOfLines={1}>
                {step.instruction || `Continue on ${step.maneuver}`}
              </Text>
              {step.distanceM > 0 ? <Text style={styles.upcomingDistance}>{formatNavDistance(step.distanceM)}</Text> : null}
            </View>
          ))}
        </ScrollView>
      ) : null}
    </View>
  );
}

const styles = StyleSheet.create({
  hud: { backgroundColor: 'rgba(15, 23, 42, 0.95)', borderRadius: 16, borderWidth: 2, borderColor: 'transparent', padding: 12, margin: 12 },
  row: { flexDirection: 'row', alignItems: 'center', gap: 10 },
  maneuverIcon: { width: 40, height: 40, borderRadius: 20, alignItems: 'center', justifyContent: 'center', backgroundColor: 'rgba(59,130,246,0.3)', borderWidth: 1, borderColor: 'rgba(59,130,246,0.6)' },
  distanceRow: { flexDirection: 'row', alignItems: 'baseline', gap: 8 },
  distance: { color: '#fff', fontSize: 20, fontWeight: '800' },
  stats: { color: '#cbd5e1', fontSize: 12 },
  instruction: { color: '#fff', fontSize: 14, fontWeight: '600', marginTop: 2 },
  toggleBtn: { width: 32, height: 32, borderRadius: 16, alignItems: 'center', justifyContent: 'center', backgroundColor: 'rgba(255,255,255,0.12)' },
  rerouteBtn: { flexDirection: 'row', alignItems: 'center', gap: 4, backgroundColor: '#f59e0b', borderRadius: 999, paddingHorizontal: 12, paddingVertical: 6 },
  rerouteText: { color: '#000', fontWeight: '800', fontSize: 12 },
  progressTrack: { height: 4, backgroundColor: 'rgba(255,255,255,0.15)', borderRadius: 2, marginTop: 10, overflow: 'hidden' },
  progressFill: { height: 4, backgroundColor: '#3b82f6' },
  upcomingList: { marginTop: 10, paddingTop: 8, borderTopWidth: 1, borderTopColor: 'rgba(255,255,255,0.12)', maxHeight: 140 },
  upcomingRow: { flexDirection: 'row', alignItems: 'center', gap: 8, paddingVertical: 3 },
  upcomingText: { flex: 1, color: '#cbd5e1', fontSize: 12 },
  upcomingDistance: { color: '#94a3b8', fontSize: 11 },
});
