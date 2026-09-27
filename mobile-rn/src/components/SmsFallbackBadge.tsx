/**
 * SmsFallbackBadge.tsx — the display half of M13 SMS Fallback Confirmation.
 * Renders nothing when `deriveSmsFallbackState` returns null (the record
 * already reached the workstation — there is no fallback state to show).
 */
import { View, Text } from 'react-native';
import { useTheme } from '../theme/ThemeProvider';
import { deriveSmsFallbackState, SMS_FALLBACK_STATE_LABEL, SMS_FALLBACK_STATE_TONE, type SmsFallbackInput } from '../services/smsFallbackState';

export default function SmsFallbackBadge({ input }: { input: SmsFallbackInput }) {
  const { colors } = useTheme();
  const state = deriveSmsFallbackState(input);
  if (!state) return null;

  const tone = SMS_FALLBACK_STATE_TONE[state];
  const bg = { success: colors.tintSuccessBg, info: colors.tintInfoBg, critical: colors.tintCriticalBg, warning: colors.tintWarningBg }[tone];
  const fg = { success: colors.pillSuccessText, info: colors.pillInfoText, critical: colors.pillCriticalText, warning: colors.pillWarningText }[tone];

  return (
    <View style={{ backgroundColor: bg, borderRadius: 999, paddingHorizontal: 10, paddingVertical: 4 }}>
      <Text style={{ color: fg, fontSize: 11, fontWeight: '700' }}>{SMS_FALLBACK_STATE_LABEL[state]}</Text>
    </View>
  );
}
