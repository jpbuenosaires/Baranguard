/**
 * Tactile confirmation for field responders. Ported from ../mobile's
 * tacticalFeedback.ts, which synthesized tones via the Web Audio API (not
 * available in RN) and vibrated via `navigator.vibrate`. RN's
 * `expo-haptics` replaces both with real native haptic feedback — the
 * public method names are kept identical so every call site (Home's duty
 * toggle, SOS, this screen's category-chip taps) needed no changes.
 */
import * as Haptics from 'expo-haptics';

class TacticalFeedback {
  /** Fallback for a specific millisecond vibration pattern — most call sites should prefer the semantic methods below. */
  vibrate(_pattern?: number | number[]): void {
    void Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light);
  }

  onTap(): void {
    void Haptics.selectionAsync();
  }

  onDutyToggle(isOnDuty: boolean): void {
    void Haptics.notificationAsync(isOnDuty ? Haptics.NotificationFeedbackType.Success : Haptics.NotificationFeedbackType.Warning);
  }

  onSosHoldTick(_progressPercent: number): void {
    void Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Medium);
  }

  onSosFired(): void {
    void Haptics.notificationAsync(Haptics.NotificationFeedbackType.Error);
  }

  onWarning(): void {
    void Haptics.notificationAsync(Haptics.NotificationFeedbackType.Warning);
  }

  onSuccess(): void {
    void Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success);
  }
}

export default new TacticalFeedback();
