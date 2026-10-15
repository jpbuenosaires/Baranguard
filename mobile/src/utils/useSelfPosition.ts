import { useEffect, useState } from 'react';
import { getCurrentPosition, watchPosition, type DevicePosition } from '../services/geolocation';

/**
 * Foreground-only self position: one fix on mount, then a watch that stops on
 * unmount. Never posts to the server; null until a fix arrives.
 */
export function useSelfPosition(): DevicePosition | null {
  const [position, setPosition] = useState<DevicePosition | null>(null);

  useEffect(() => {
    let stopWatch: (() => void) | undefined;
    let cancelled = false;

    getCurrentPosition()
      .then((p) => {
        if (!cancelled) setPosition(p);
      })
      .catch(() => {
        // No fix yet: callers fall back to wording like "Distance unknown".
      });

    watchPosition((p) => {
      if (!cancelled) setPosition(p);
    })
      .then((stop) => {
        if (cancelled) stop();
        else stopWatch = stop;
      })
      .catch(() => {
        // Non-fatal watch failure.
      });

    return () => {
      cancelled = true;
      stopWatch?.();
    };
  }, []);

  return position;
}
