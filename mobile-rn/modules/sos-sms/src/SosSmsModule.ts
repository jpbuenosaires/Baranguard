import { NativeModule, requireNativeModule } from 'expo';

declare class SosSmsModule extends NativeModule<{}> {
  /** Requests SEND_SMS if not already granted, then sends silently via the device's own SIM. */
  sendDirect(options: { number: string; message: string }): Promise<{ sent: boolean }>;
}

export default requireNativeModule<SosSmsModule>('SosSms');
