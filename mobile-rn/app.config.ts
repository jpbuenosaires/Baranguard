/// <reference types="node" />
// ^ Scoped here, not in tsconfig: this file runs in Node at build time,
//   the app code does not (TS 6 no longer auto-includes @types/*).
import { existsSync } from 'node:fs';
import type { ExpoConfig } from 'expo/config';

// Dev builds use a separate applicationId so this app and the Capacitor app
// in ../mobile can be installed side by side; cutover sets
// BARANGUARD_APP_ID=ph.baranguard.tanod (see DEVLOG 2026-09-27 (3)).
const appId = process.env.BARANGUARD_APP_ID ?? 'ph.baranguard.tanod.rn';
const isCutoverBuild = appId === 'ph.baranguard.tanod';

// Firebase config is per-applicationId and never committed; push stays
// off (not crashing) until the matching file is dropped in.
const googleServicesFile = './google-services.json';

const config: ExpoConfig = {
  name: isCutoverBuild ? 'Baranguard' : 'Baranguard (RN dev)',
  slug: 'baranguard-tanod',
  version: '1.0.0',
  orientation: 'portrait',
  icon: './assets/icon.png',
  scheme: 'baranguard',
  userInterfaceStyle: 'automatic',
  android: {
    package: appId,
    adaptiveIcon: {
      backgroundColor: '#E6F4FE',
      foregroundImage: './assets/android-icon-foreground.png',
      backgroundImage: './assets/android-icon-background.png',
      monochromeImage: './assets/android-icon-monochrome.png',
    },
    predictiveBackGestureEnabled: false,
    ...(existsSync(googleServicesFile) ? { googleServicesFile } : {}),
    // Same set as ../mobile/android/app/src/main/AndroidManifest.xml.
    permissions: [
      'android.permission.INTERNET',
      'android.permission.ACCESS_FINE_LOCATION',
      'android.permission.ACCESS_COARSE_LOCATION',
      'android.permission.ACCESS_BACKGROUND_LOCATION',
      'android.permission.CAMERA',
      'android.permission.RECORD_AUDIO',
      'android.permission.POST_NOTIFICATIONS',
      'android.permission.SEND_SMS',
      'android.permission.FOREGROUND_SERVICE',
      'android.permission.FOREGROUND_SERVICE_LOCATION',
      'android.permission.REQUEST_IGNORE_BATTERY_OPTIMIZATIONS',
      'android.permission.USE_FULL_SCREEN_INTENT',
    ],
    // Expo's template adds these by default; the old app never had them and
    // nothing here needs them (files live in app-private storage; alerts use
    // a full-screen intent, not a draw-over-apps overlay).
    blockedPermissions: [
      'android.permission.SYSTEM_ALERT_WINDOW',
      'android.permission.READ_EXTERNAL_STORAGE',
      'android.permission.WRITE_EXTERNAL_STORAGE',
    ],
  },
  plugins: [
    'expo-router',
    'expo-font',
    'expo-splash-screen',
    'expo-audio',
    [
      'expo-image-picker',
      {
        cameraPermission: 'Baranguard needs the camera to attach photo evidence to incident reports.',
      },
    ],
    ['expo-sqlite', { useSQLCipher: true }],
    'expo-secure-store',
    [
      'expo-build-properties',
      {
        android: {
          // The LAN workstation's IP isn't fixed, so plain-HTTP API bases
          // (http://<lan-ip>:8081) must keep working — same trade-off as
          // the old app's network_security_config base-config.
          usesCleartextTraffic: true,
        },
      },
    ],
  ],
  experiments: {
    typedRoutes: true,
  },
};

export default config;
