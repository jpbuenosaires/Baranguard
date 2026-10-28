import { useEffect, useRef, useState } from 'react';
import { postGps } from '../../services/apiService';
import { saveGpsPointLocally } from '../../services/db/gpsTrackRepository';
import { getCurrentPosition, watchPosition, type DevicePosition } from '../../services/geolocation';
import { getKnownDutyStatus } from '../../services/syncScheduler';
import { uuid } from '../../services/uuid';

const MIN_BROADCAST_INTERVAL_MS = 15000;

export type BroadcastState = 'unknown' | 'confirmed' | 'saved';

/** Tracks the device GPS fix and broadcasts it (throttled), saving on-phone when the server is unreachable. */
export function useDeviceBroadcast() {
  const [position, setPosition] = useState<DevicePosition | null>(null);
  const [positionError, setPositionError] = useState<string | null>(null);
  /** Outcome of the most recent location broadcast: server confirmed, or only saved on the phone. */
  const [broadcastState, setBroadcastState] = useState<BroadcastState>('unknown');
  const lastBroadcastAt = useRef(0);

  useEffect(() => {
    let stopWatch: (() => void) | undefined;
    let cancelled = false;

    async function broadcast(point: DevicePosition) {
      // Off duty (or not yet known) the position stays on this phone: never sent to HQ.
      const duty = getKnownDutyStatus();
      if (duty !== 'on_duty' && duty !== 'responding') return;
      const now = Date.now();
      if (now - lastBroadcastAt.current < MIN_BROADCAST_INTERVAL_MS) return;
      lastBroadcastAt.current = now;

      try {
        await postGps({
          latitude: point.latitude,
          longitude: point.longitude,
          accuracyM: point.accuracyM,
          recordedAt: point.recordedAt,
          clientEventId: uuid(),
        });
        setBroadcastState('confirmed');
      } catch {
        setBroadcastState('saved');
        await saveGpsPointLocally({
          latitude: point.latitude,
          longitude: point.longitude,
          accuracyM: point.accuracyM,
          recordedAt: point.recordedAt,
        });
      }
    }

    async function start() {
      try {
        const initial = await getCurrentPosition();
        if (cancelled) return;
        setPosition(initial);
        setPositionError(null);
        await broadcast(initial);
      } catch {
        setPositionError('Unable to read device location. Ensure GPS is enabled.');
      }

      try {
        stopWatch = await watchPosition((update) => {
          if (cancelled) return;
          setPosition(update);
          setPositionError(null);
          void broadcast(update);
        });
      } catch {
        // Fall back to one-shot fix
      }
    }

    void start();

    return () => {
      cancelled = true;
      stopWatch?.();
    };
  }, []);

  return { position, positionError, broadcastState };
}
