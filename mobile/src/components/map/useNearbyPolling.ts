import { useEffect, useRef, useState } from 'react';
import { useIonViewDidLeave, useIonViewWillEnter } from '@ionic/react';
import { getNearbyIncidents, getNearbyTanods, type NearbyIncident, type NearbyTanod } from '../../services/apiService';
import type { DevicePosition } from '../../services/geolocation';
import { shouldRefetchOnMove, type LatLng } from '../../utils/liveMapPolicy';
import { createPoller, type Poller } from '../../utils/pollLoop';

const NEARBY_REFRESH_INTERVAL_MS = 30000;

/**
 * Polls nearby incidents and tanods only while this page is the active route
 * AND the document is visible. Returning resumes with an immediate fetch.
 */
export function useNearbyPolling(position: DevicePosition | null) {
  const [nearby, setNearby] = useState<NearbyIncident[]>([]);
  const [nearbyTanods, setNearbyTanods] = useState<NearbyTanod[]>([]);

  const [pageActive, setPageActive] = useState(true);
  const [docVisible, setDocVisible] = useState(
    () => typeof document === 'undefined' || document.visibilityState !== 'hidden'
  );
  useIonViewWillEnter(() => setPageActive(true));
  useIonViewDidLeave(() => setPageActive(false));
  useEffect(() => {
    const onVisibility = () => setDocVisible(document.visibilityState !== 'hidden');
    document.addEventListener('visibilitychange', onVisibility);
    return () => document.removeEventListener('visibilitychange', onVisibility);
  }, []);
  const pollActive = pageActive && docVisible;

  const [deviceOnline, setDeviceOnline] = useState(() => typeof navigator === 'undefined' || navigator.onLine !== false);
  useEffect(() => {
    const up = () => setDeviceOnline(true);
    const down = () => setDeviceOnline(false);
    window.addEventListener('online', up);
    window.addEventListener('offline', down);
    return () => {
      window.removeEventListener('online', up);
      window.removeEventListener('offline', down);
    };
  }, []);

  // Real times of the last successful load of each list, and whether the
  // latest attempt failed. Drives the "Updated hh:mm" / offline chip.
  const [incidentsAt, setIncidentsAt] = useState<number | null>(null);
  const [tanodsAt, setTanodsAt] = useState<number | null>(null);
  const [fetchFailing, setFetchFailing] = useState(false);
  const [nowMs, setNowMs] = useState(() => Date.now());

  const positionRef = useRef<DevicePosition | null>(position);
  positionRef.current = position;
  const lastFetchPosRef = useRef<LatLng | null>(null);
  const pollerRef = useRef<Poller | null>(null);

  useEffect(() => {
    if (!pollActive) return;
    let cancelled = false;
    setNowMs(Date.now());

    const poller = createPoller(async () => {
      const pos = positionRef.current;
      if (pos) lastFetchPosRef.current = { latitude: pos.latitude, longitude: pos.longitude };
      const [inc, tan] = await Promise.allSettled([
        pos ? getNearbyIncidents({ latitude: pos.latitude, longitude: pos.longitude }) : Promise.resolve(null),
        getNearbyTanods(),
      ]);
      if (cancelled) return true;
      const at = Date.now();
      let ok = true;
      if (inc.status === 'fulfilled') {
        if (inc.value) {
          setNearby(inc.value);
          setIncidentsAt(at);
        }
      } else {
        ok = false;
      }
      if (tan.status === 'fulfilled') {
        setNearbyTanods(tan.value);
        setTanodsAt(at);
      } else {
        ok = false;
      }
      setFetchFailing(!ok);
      setNowMs(at);
      return ok;
    }, NEARBY_REFRESH_INTERVAL_MS);

    pollerRef.current = poller;
    poller.start();
    const clockId = window.setInterval(() => setNowMs(Date.now()), 15000);

    return () => {
      cancelled = true;
      poller.stop();
      pollerRef.current = null;
      clearInterval(clockId);
    };
  }, [pollActive]);

  // A GPS fix that moved far (or the first fix) fetches early; the timer above is independent.
  useEffect(() => {
    if (!pollActive || !position) return;
    if (shouldRefetchOnMove(lastFetchPosRef.current, position)) pollerRef.current?.trigger();
  }, [position, pollActive]);

  return { nearby, nearbyTanods, deviceOnline, incidentsAt, tanodsAt, fetchFailing, nowMs };
}
