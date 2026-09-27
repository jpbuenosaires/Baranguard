import { NativeModule, requireNativeModule } from 'expo';

export interface PatrolLocationStartConfig {
  baseUrl: string;
  token: string;
  deviceId: string;
}

export interface FailedPoint {
  latitude: number;
  longitude: number;
  accuracyM: number;
  /** ISO 8601 UTC string. */
  recordedAt: string;
  clientEventId: string;
}

declare class PatrolLocationModule extends NativeModule<{}> {
  /** Rejects if ACCESS_FINE_LOCATION isn't granted. */
  start(config: PatrolLocationStartConfig): Promise<{ started: boolean }>;
  stop(): Promise<{ stopped: boolean }>;
  requestBatteryOptimizationExemption(): Promise<{ alreadyExempt: boolean; dialogShown?: boolean }>;
  /** Reads and clears the native failed-point buffer — fold the result into `gps_track_local`. */
  drainFailedPoints(): Promise<FailedPoint[]>;
}

export default requireNativeModule<PatrolLocationModule>('PatrolLocation');
