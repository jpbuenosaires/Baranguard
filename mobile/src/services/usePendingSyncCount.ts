import { useEffect, useState } from 'react';
import { listUnsyncedIncidents } from './db/incidentRepository';
import { listPendingDispatchStatusUpdates, listPendingSosItems } from './db/offlineQueueRepository';
import { subscribeSyncSummary } from './syncScheduler';
import { visibleInterval } from '../utils/visibleInterval';

/** Reports, status changes and SOS items saved on this phone and not yet confirmed by the server. */
export function usePendingSyncCount(): number {
  const [count, setCount] = useState(0);
  useEffect(() => {
    let alive = true;
    const read = async () => {
      try {
        const [incidents, statuses, sos] = await Promise.all([
          listUnsyncedIncidents(),
          listPendingDispatchStatusUpdates(),
          listPendingSosItems(),
        ]);
        if (alive) setCount(incidents.length + statuses.length + sos.length);
      } catch {
        // Local store unavailable: keep the last count.
      }
    };
    void read();
    const unsubscribe = subscribeSyncSummary(() => void read());
    const stop = visibleInterval(() => void read(), 20000);
    return () => {
      alive = false;
      unsubscribe();
      stop();
    };
  }, []);
  return count;
}
