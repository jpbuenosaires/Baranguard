/**
 * Two storage tiers, replacing the old app's @capacitor/preferences and
 * @aparajita/capacitor-secure-storage:
 *
 * - `prefs`: plain app-private key/value (AsyncStorage) for non-secret
 *   settings — device id, API base URL override, cached fallback contact.
 * - `secrets`: Android Keystore-backed (expo-secure-store) for anything
 *   that is a credential — DB passphrase, message encryption key, session
 *   JWT. The old app kept the JWT in plain SharedPreferences; it moves here.
 */
import AsyncStorage from '@react-native-async-storage/async-storage';
import * as SecureStore from 'expo-secure-store';

export const prefs = {
  get: (key: string): Promise<string | null> => AsyncStorage.getItem(key),
  set: (key: string, value: string): Promise<void> => AsyncStorage.setItem(key, value),
  remove: (key: string): Promise<void> => AsyncStorage.removeItem(key),
};

// SecureStore keys may only contain [A-Za-z0-9._-]; every key used in this
// app already fits (`baranguard.dbPassphrase` etc.).
export const secrets = {
  get: (key: string): Promise<string | null> => SecureStore.getItemAsync(key),
  set: (key: string, value: string): Promise<void> => SecureStore.setItemAsync(key, value),
  remove: (key: string): Promise<void> => SecureStore.deleteItemAsync(key),
};
