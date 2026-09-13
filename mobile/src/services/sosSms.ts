/**
 * sosSms.ts — the TypeScript edge of `SosSmsPlugin.java` (Android,
 * `android/app/src/main/java/ph/baranguard/tanod/SosSmsPlugin.java`), a
 * LOCAL custom Capacitor plugin (not an npm dependency) for G1's third
 * SOS fallback tier (Mobile Improvement Plan Phase 4.3).
 *
 * `registerPlugin()` is Capacitor's own mechanism for a plugin whose
 * native side isn't resolved through `capacitor.config.ts`'s automatic
 * dependency scan — the Java class is registered directly in
 * `MainActivity.onCreate()` instead.
 *
 * NOT DEVICE-VERIFIED for an actual completed send (same disclosure this
 * codebase already gives every native-plugin edge — see
 * `deviceIdentity.ts`'s `getFcmToken()`): the permission-request path and
 * plugin registration were exercised on a real device, but a real SMS
 * send has a real-world cost and notifies a real phone, so this session
 * did not trigger one against an arbitrary number without the user
 * choosing a test number first.
 */

import { registerPlugin } from '@capacitor/core';

export interface SosSmsPlugin {
  sendDirect(options: { number: string; message: string }): Promise<{ sent: boolean }>;
}

const SosSms = registerPlugin<SosSmsPlugin>('SosSms');

export default SosSms;
