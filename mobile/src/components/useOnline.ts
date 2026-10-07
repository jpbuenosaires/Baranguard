import { useEffect, useState } from 'react';
import { Network } from '@capacitor/network';

/**
 * Live connectivity flag for the online-only admin console. `true` until the
 * plugin says otherwise, so a slow plugin read never flashes "Needs a
 * connection" at a connected user; the request itself still fails honestly.
 */
export function useOnline(): boolean {
  const [online, setOnline] = useState(true);

  useEffect(() => {
    let active = true;
    let remove: (() => void) | null = null;
    Network.getStatus()
      .then((s) => {
        if (active) setOnline(s.connected);
      })
      .catch(() => undefined);
    Network.addListener('networkStatusChange', (s) => {
      if (active) setOnline(s.connected);
    })
      .then((handle) => {
        remove = () => void handle.remove();
        if (!active) remove();
      })
      .catch(() => undefined);
    return () => {
      active = false;
      if (remove) remove();
    };
  }, []);

  return online;
}
