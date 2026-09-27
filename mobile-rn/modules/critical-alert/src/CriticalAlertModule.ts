import { NativeModule, requireNativeModule } from 'expo';

export interface PendingNativeAlert {
  pending: boolean;
  notificationId?: string | null;
  notificationType?: string | null;
  title?: string | null;
  body?: string | null;
}

declare class CriticalAlertModule extends NativeModule<{}> {
  showTest(title?: string, body?: string): Promise<{ shown: boolean }>;
  getPendingAlert(): Promise<PendingNativeAlert>;
  dismiss(): Promise<void>;
  /** True only once a real Firebase SDK is on the classpath — see the Kotlin module's own doc. */
  isFirebaseAvailable(): Promise<{ available: boolean }>;
}

export default requireNativeModule<CriticalAlertModule>('CriticalAlert');
