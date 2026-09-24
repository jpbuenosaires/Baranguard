/**
 * deviceKey.ts — the TypeScript edge of `DeviceKeyPlugin.java` (Android),
 * a LOCAL custom Capacitor plugin for code-review finding H-09
 * (2026-09-24 external audit): "X-Device-Id is an identifier, not strong
 * proof of device authenticity."
 *
 * Real usage lives in `deviceIdentity.ts`'s `getDevicePublicKeyPem()` /
 * `signDeviceRequest()` — this file is only the raw native-plugin edge,
 * same split as `fullScreenAlert.ts` vs `deviceIdentity.ts`'s
 * `getFcmToken()`.
 */

import { registerPlugin } from '@capacitor/core';

export interface DeviceKeyPlugin {
  /** Generates the device's Keystore keypair on first call; returns the same public key on every later call. */
  getPublicKey(): Promise<{ publicKeyPem: string }>;
  /** Signs `payload` (a caller-built canonical string) with the Keystore private key. Base64 DER ECDSA signature. */
  sign(options: { payload: string }): Promise<{ signature: string }>;
}

const DeviceKey = registerPlugin<DeviceKeyPlugin>('DeviceKey');

export default DeviceKey;
