import { StyleSheet, Text, View } from 'react-native';

// Phase 0 placeholder. Phase 2 replaces this with the session gate that
// routes to login or the tab shell.
export default function Index() {
  return (
    <View style={styles.container}>
      <Text style={styles.title}>Baranguard</Text>
      <Text style={styles.subtitle}>React Native rebuild — scaffold</Text>
    </View>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1, alignItems: 'center', justifyContent: 'center' },
  title: { fontSize: 24, fontWeight: '700' },
  subtitle: { marginTop: 8, opacity: 0.7 },
});
