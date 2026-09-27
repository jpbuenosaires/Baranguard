import { ActivityIndicator, StyleSheet, Text, View } from 'react-native';
import { useTheme } from '../theme/ThemeProvider';

export function LoadingBlock({ label }: { label?: string }) {
  const { colors } = useTheme();
  return (
    <View style={styles.container}>
      <ActivityIndicator color={colors.primary} />
      {label ? <Text style={{ color: colors.textTertiary, marginTop: 10, fontSize: 13 }}>{label}</Text> : null}
    </View>
  );
}

const styles = StyleSheet.create({
  container: { alignItems: 'center', justifyContent: 'center', paddingVertical: 48 },
});
