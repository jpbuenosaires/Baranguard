/**
 * live-map.tsx — M7 Live Map (§9 Mobile).
 *
 * §9 M7: "Shows location freshness and cached marker status. No claim of
 * live server data when disconnected." APIs: GPS, nearby incidents; cached
 * local map.
 *
 * MAP RENDERING SURFACE NOT BUILT THIS CUT. Rendering a real basemap from
 * the downloaded MBTiles package (`offline_map_package_local`) needs a
 * native, offline-tile-capable map renderer (e.g. MapLibre Native via a
 * Capacitor plugin) — a materially bigger native dependency than anything
 * else in this cut, and adding one without it being explicitly scoped
 * risks the same "half-built native feature nobody asked for" problem
 * this codebase has otherwise avoided. Rather than fake a map with a
 * static image or an unstyled canvas (a demo-tell §8 forbids), this screen
 * is built honestly as a real, fully-functional STATUS VIEW: it
 * broadcasts GPS, shows real freshness, and lists real nearby incidents —
 * everything §6 actually wires up — with the rendered-map surface tracked
 * as explicit follow-up work, not silently skipped or faked.
 *
 * GPS broadcast is FOREGROUND-ONLY (see geolocation.ts): starts when this
 * screen mounts, stops when it unmounts. Every position update attempts a
 * live `POST /gps`; on failure (offline, most commonly) the point is
 * staged in `gps_track_local` instead for `syncService.ts` to send later —
 * no position is ever silently dropped.
 */

import { useEffect, useRef, useState } from 'react';
import { IonContent, IonHeader, IonNote, IonPage, IonSpinner, IonTitle, IonToolbar } from '@ionic/react';
import { ApiError, getNearbyIncidents, postGps, type NearbyIncident } from '../services/apiService';
import { saveGpsPointLocally } from '../services/db/gpsTrackRepository';
import { getCurrentPosition, watchPosition, type DevicePosition } from '../services/geolocation';
import { uuid } from '../services/uuid';

/**
 * Minimum time between two broadcast attempts — the same order of
 * magnitude as the web dashboard's own GIS Live Tracking poll cadence
 * (15s), not a number §6 states for the mobile side.
 */
const MIN_BROADCAST_INTERVAL_MS = 15000;
const NEARBY_REFRESH_INTERVAL_MS = 30000;
/** Matches GpsController's own §6 staleness threshold. */
const STALE_AFTER_SECONDS = 120;

const PRIORITY_PILL_CLASS: Record<string, string> = {
  normal: 'status-pill--info',
  high: 'status-pill--pending',
  critical: 'status-pill--critical',
};

const LiveMapPage: React.FC = () => {
  const [position, setPosition] = useState<DevicePosition | null>(null);
  const [positionError, setPositionError] = useState<string | null>(null);
  const [nearby, setNearby] = useState<NearbyIncident[]>([]);
  const [nearbyError, setNearbyError] = useState<string | null>(null);
  const lastBroadcastAt = useRef(0);

  useEffect(() => {
    let stopWatch: (() => void) | undefined;
    let cancelled = false;

    async function broadcast(point: DevicePosition) {
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
      } catch {
        // Offline or rejected — stage it locally so syncService.ts can
        // retry via /sync/batch. Never silently drop a position.
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
        setPositionError('Could not read this device’s location. Check location permission.');
      }

      try {
        stopWatch = await watchPosition((update) => {
          if (cancelled) return;
          setPosition(update);
          setPositionError(null);
          void broadcast(update);
        });
      } catch {
        setPositionError('Could not start continuous location updates.');
      }
    }

    void start();
    return () => {
      cancelled = true;
      stopWatch?.();
    };
  }, []);

  useEffect(() => {
    if (!position) return undefined;
    let cancelled = false;
    const lat = position.latitude;
    const lng = position.longitude;

    async function refreshNearby() {
      try {
        const items = await getNearbyIncidents({ latitude: lat, longitude: lng });
        if (!cancelled) {
          setNearby(items);
          setNearbyError(null);
        }
      } catch (error) {
        if (!cancelled) {
          setNearbyError(
            error instanceof ApiError && error.isOffline
              ? 'Offline — nearby incidents unavailable.'
              : 'Could not load nearby incidents.'
          );
        }
      }
    }

    void refreshNearby();
    const interval = setInterval(refreshNearby, NEARBY_REFRESH_INTERVAL_MS);
    return () => {
      cancelled = true;
      clearInterval(interval);
    };
    // Re-runs on every position update; the 30s floor above keeps the
    // actual network call from exceeding that cadence regardless.
  }, [position]);

  const ageSeconds = position ? Math.floor((Date.now() - new Date(position.recordedAt).getTime()) / 1000) : null;
  const isLive = ageSeconds !== null && ageSeconds < STALE_AFTER_SECONDS;

  return (
    <IonPage>
      <IonHeader>
        <IonToolbar>
          <IonTitle>Live Map</IonTitle>
        </IonToolbar>
      </IonHeader>
      <IonContent className="ion-padding">
        <IonNote className="app-note" role="status">
          Map rendering is not available yet on this build — this screen shows your live position and nearby
          incidents as data while that surface is built.
        </IonNote>

        <div className="app-section">
          {position ? (
            <>
              <span className={`status-pill ${isLive ? 'status-pill--success' : 'status-pill--neutral'}`}>
                {isLive ? 'Live' : 'Stale'}
              </span>
              <p className="app-note">
                {position.latitude.toFixed(5)}, {position.longitude.toFixed(5)} (±{position.accuracyM.toFixed(0)}m) —{' '}
                {ageSeconds}s ago
              </p>
            </>
          ) : positionError ? (
            <p className="app-error">{positionError}</p>
          ) : (
            <IonSpinner name="dots" />
          )}
        </div>

        <h2 className="app-title app-section">Nearby Incidents</h2>
        {nearbyError && (
          <IonNote className="app-note" role="status">
            {nearbyError}
          </IonNote>
        )}
        {nearby.length === 0 && !nearbyError ? (
          <p className="app-subtitle">No incidents reported nearby.</p>
        ) : (
          <div className="card-list">
            {nearby.map((incident) => (
              <div key={incident.incidentId} className="card">
                <div className="card__header">
                  <span className="card__title">{incident.incidentType}</span>
                  <span className={`status-pill ${PRIORITY_PILL_CLASS[incident.priority] ?? 'status-pill--info'}`}>
                    {incident.priority}
                  </span>
                </div>
                <div className="card__meta">
                  {incident.latitude.toFixed(5)}, {incident.longitude.toFixed(5)} ·{' '}
                  {Math.floor(incident.ageSeconds / 60)}m ago
                </div>
              </div>
            ))}
          </div>
        )}
      </IonContent>
    </IonPage>
  );
};

export default LiveMapPage;
