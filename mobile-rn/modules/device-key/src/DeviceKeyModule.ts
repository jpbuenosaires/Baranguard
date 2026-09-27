import { NativeModule, requireNativeModule } from 'expo';

declare class DeviceKeyModule extends NativeModule<{}> {
  /** SPKI PEM of the Keystore key, created on first call. */
  getPublicKey(): Promise<string>;
  /** Base64 DER SHA256withECDSA signature over `payload`. */
  sign(payload: string): Promise<string>;
}

export default requireNativeModule<DeviceKeyModule>('DeviceKey');
