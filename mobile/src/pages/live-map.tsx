/**
 * live-map.tsx — M7 Live Map (§9 Mobile).
 *
 * §9 M7: "Shows location freshness and cached marker status. No claim of
 * live server data when disconnected." APIs: GPS, nearby incidents; cached
 * local map.
 *
 * RENDERED BASEMAP (2026-09-12): the screen now plots real pins on a real
 * map via `LiveMapCanvas.tsx` — MapLibre GL JS, installed as a normal npm
 * dependency (mobile has a genuine Vite bundle, unlike `web/`, which has
 * none at all). The offline-tile-capable renderer this file used to say
 * needed a native Capacitor plugin (REMAINING.md C4) turned out not to:
 * `mbtilesReader.ts` reads the downloaded MBTiles package via sql.js
 * (also pure JS/WASM in the same WebView) and feeds tiles to MapLibre
 * through a custom protocol, with online OpenStreetMap tiles as the
 * fallback when no package is installed yet. No AndroidManifest change,
 * no new native plugin. The STATUS VIEW this screen was built as instead
 * (GPS lock card, nearby-incident/-Tanod lists with distance+bearing) is
 * kept below the map, not replaced — it stays useful when the map itself
 * can't render (e.g. WebGL unavailable), and §8 still wants real numbers
 * stated in words, not color-only.
 *
 * GPS broadcast is FOREGROUND-ONLY (see geolocation.ts): starts when this
 * screen mounts, stops when it unmounts. Every position update attempts a
 * live `POST /gps`; on failure (offline, most commonly) the point is
 * staged in `gps_track_local` instead for `syncService.ts` to send later —
 * no position is ever silently dropped.
 *
 * PEER TANOD VISIBILITY (2026-09-12, explicit user decision): `GET
 * /gps/live` was opened to the `tanod` role (previously admin/PB only —
 * see GpsController::live()'s own doc comment) so this screen can list
 * other on-duty Tanods in the same barangay — now shown both as map pins
 * and as the distance/bearing list (utils/geo.ts, haversine —
 * straight-line, NOT road-routed).
 */

import { useEffect, useRef, useState } from 'react';
import {
  IonContent,
  IonIcon,
  IonPage,
  IonSpinner,
} from '@ionic/react';
import {
  locateOutline,
  locationOutline,
  navigateOutline,
  radioOutline,
  timeOutline,
  warningOutline,
} from 'ionicons/icons';
import LiveMapCanvas, { type BasemapStatus } from '../components/LiveMapCanvas';
import MobileHeader from '../components/MobileHeader';
import {
  ApiError,
  getNearbyIncidents,
  getNearbyTanods,
  postGps,
  type NearbyIncident,
  type NearbyTanod,
} from '../services/apiService';
import { saveGpsPointLocally } from '../services/db/gpsTrackRepository';
import { getCurrentPosition, watchPosition, type DevicePosition } from '../services/geolocation';
import { ensureMapPackageDownloaded } from '../services/mapPackageService';
import { loadSession } from '../services/session';
import { uuid } from '../services/uuid';
import { bearingLabel, distanceMeters, formatDistance } from '../utils/geo';

const MIN_BROADCAST_INTERVAL_MS = 15000;
const NEARBY_REFRESH_INTERVAL_MS = 30000;
const STALE_AFTER_SECONDS = 120;

const PRIORITY_PILL_CLASS: Record<string, string> = {
  normal: 'status-pill--info',
  high: 'status-pill--pending',
  critical: 'status-pill--critical is-urgent',
};

const PRIORITY_ACCENT_CLASS: Record<string, string> = {
  normal: 'card--info-accent',
  high: 'card--warning-accent',
  critical: 'card--critical-accent',
};

const LiveMapPage: React.FC = () => {
  const [position, setPosition] = useState<DevicePosition | null>(null);
  const [positionError, setPositionError] = useState<string | null>(null);
  const [nearby, setNearby] = useState<NearbyIncident[]>([]);
  const [nearbyError, setNearbyError] = useState<string | null>(null);
  const [nearbyTanods, setNearbyTanods] = useState<NearbyTanod[]>([]);
  const [tanodsError, setTanodsError] = useState<string | null>(null);
  const [barangayId, setBarangayId] = useState<number | null>(null);
  const [basemapStatus, setBasemapStatus] = useState<BasemapStatus>({ kind: 'loading' });
  const lastBroadcastAt = useRef(0);

  useEffect(() => {
    let cancelled = false;
    async function loadBarangay() {
      const session = await loadSession();
      if (cancelled || !session) return;
      setBarangayId(session.barangayId);
      // Safety-net re-check: login.tsx already kicks this off in the
      // background on sign-in, but a long-lived session (no fresh login
      // since an admin published a new package) should still pick up an
      // update when this screen is opened. Never awaited/blocking — same
      // non-fatal, offline-tolerant contract as ensureMapPackageDownloaded()
      // itself.
      void ensureMapPackageDownloaded(session.barangayId);
    }
    void loadBarangay();
    return () => {
      cancelled = true;
    };
  }, []);

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
        setPositionError('Unable to read device location. Please ensure location permissions are enabled.');
      }

      try {
        stopWatch = await watchPosition((update) => {
          if (cancelled) return;
          setPosition(update);
          setPositionError(null);
          void broadcast(update);
        });
      } catch {
        setPositionError('Could not initialize real-time location tracking.');
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
              ? 'Offline — nearby incident telemetry unavailable.'
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
  }, [position]);

  useEffect(() => {
    if (!position) return undefined;
    let cancelled = false;

    async function refreshTanods() {
      try {
        const items = await getNearbyTanods();
        if (!cancelled) {
          setNearbyTanods(items);
          setTanodsError(null);
        }
      } catch (error) {
        if (!cancelled) {
          setTanodsError(
            error instanceof ApiError && error.isOffline
              ? 'Offline — nearby Tanod telemetry unavailable.'
              : 'Could not load nearby Tanods.'
          );
        }
      }
    }

    void refreshTanods();
    const interval = setInterval(refreshTanods, NEARBY_REFRESH_INTERVAL_MS);
    return () => {
      cancelled = true;
      clearInterval(interval);
    };
  }, [position]);

  const ageSeconds = position ? Math.floor((Date.now() - new Date(position.recordedAt).getTime()) / 1000) : null;
  const isLive = ageSeconds !== null && ageSeconds < STALE_AFTER_SECONDS;

  const basemapLabel =
    basemapStatus.kind === 'offline'
      ? `Offline basemap · package v${basemapStatus.version}`
      : basemapStatus.kind === 'online'
        ? 'Online basemap · OpenStreetMap (no package downloaded)'
        : basemapStatus.kind === 'unavailable'
          ? 'Basemap unavailable'
          : 'Loading basemap…';

  return (
    <IonPage>
      <MobileHeader title="LIVE RADAR" subtitle="Field Telemetry" />

      <IonContent className="ion-padding" style={{ '--background': 'var(--color-bg)' }}>
        <div className="app-column">
          {/* Rendered basemap */}
          <LiveMapCanvas
            barangayId={barangayId}
            position={position}
            incidents={nearby}
            tanods={nearbyTanods}
            onStatusChange={setBasemapStatus}
          />
          <div
            style={{
              display: 'flex',
              alignItems: 'center',
              gap: '6px',
              margin: '8px 0 20px',
              fontSize: '0.72rem',
              color: 'var(--color-text-tertiary)',
            }}
          >
            <IonIcon icon={navigateOutline} />
            <span>{basemapLabel}</span>
          </div>

          {/* Radar Telemetry Card */}
          <div className="card--tactical card--elevated" style={{ marginBottom: '20px' }}>
            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '12px' }}>
              <div style={{ display: 'flex', alignItems: 'center', gap: '8px' }}>
                <div
                  style={{
                    width: '36px',
                    height: '36px',
                    borderRadius: '50%',
                    background: isLive ? 'var(--tint-success-bg)' : 'var(--tint-neutral-bg)',
                    color: isLive ? 'var(--color-success)' : 'var(--color-text-secondary)',
                    display: 'flex',
                    alignItems: 'center',
                    justifyContent: 'center',
                    fontSize: '1.25rem',
                  }}
                >
                  <IonIcon icon={locateOutline} />
                </div>
                <div>
                  <div style={{ fontSize: 'var(--font-size-md)', fontWeight: 700, color: 'var(--color-text-primary)' }}>
                    GPS Telemetry Lock
                  </div>
                  <div style={{ fontSize: '0.72rem', color: 'var(--color-text-tertiary)' }}>
                    {isLive ? 'Continuous GPS lock active' : 'Waiting for satellite acquisition'}
                  </div>
                </div>
              </div>

              <span className={`status-pill ${isLive ? 'status-pill--success' : 'status-pill--neutral'}`}>
                {isLive ? 'LIVE LOCK' : 'SIGNAL STALE'}
              </span>
            </div>

            {position ? (
              <div
                style={{
                  background: 'var(--color-bg)',
                  border: '1px solid var(--color-border)',
                  borderRadius: 'var(--radius-md)',
                  padding: '12px',
                  marginBottom: '10px',
                }}
              >
                <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '6px' }}>
                  <span style={{ fontSize: 'var(--font-size-label)', fontWeight: 700, color: 'var(--color-text-secondary)' }}>
                    CURRENT COORDINATES
                  </span>
                  <span style={{ fontSize: '0.72rem', color: 'var(--color-text-tertiary)', fontFamily: 'var(--font-mono)' }}>
                    Accuracy ±{position.accuracyM.toFixed(0)}m
                  </span>
                </div>
                <div style={{ fontFamily: 'var(--font-mono)', fontSize: 'var(--font-size-md)', fontWeight: 700, color: 'var(--color-text-primary)' }}>
                  {position.latitude.toFixed(5)}, {position.longitude.toFixed(5)}
                </div>
                <div style={{ fontSize: '0.72rem', color: 'var(--color-text-tertiary)', marginTop: '4px' }}>
                  Last recorded: {ageSeconds}s ago
                </div>
              </div>
            ) : positionError ? (
              <div
                style={{
                  background: 'var(--tint-critical-bg)',
                  border: '1px solid var(--color-critical)',
                  borderRadius: 'var(--radius-sm)',
                  padding: '10px',
                  color: 'var(--pill-critical-text)',
                  fontSize: 'var(--font-size-sm)',
                  marginBottom: '10px',
                }}
              >
                {positionError}
              </div>
            ) : (
              <div style={{ display: 'flex', alignItems: 'center', gap: '8px', padding: '12px 0' }}>
                <IonSpinner name="dots" />
                <span style={{ fontSize: 'var(--font-size-sm)', color: 'var(--color-text-secondary)' }}>
                  Acquiring GPS fix…
                </span>
              </div>
            )}

            <div style={{ display: 'flex', alignItems: 'center', gap: '6px', fontSize: '0.75rem', color: 'var(--color-text-secondary)' }}>
              <IonIcon icon={radioOutline} style={{ color: 'var(--color-primary)' }} />
              <span>Transmitting coordinates to Barangay HQ every 15s</span>
            </div>
          </div>

          {/* Nearby Incidents Feed */}
          <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '12px' }}>
            <h3 style={{ margin: 0, fontSize: 'var(--font-size-md)', fontWeight: 700, color: 'var(--color-text-primary)' }}>
              Nearby Incidents
            </h3>
            {nearby.length > 0 && (
              <span className="status-pill status-pill--info">{nearby.length} WITHIN RANGE</span>
            )}
          </div>

          {nearbyError && (
            <div
              style={{
                background: 'var(--tint-warning-bg)',
                border: '1px solid var(--color-warning)',
                borderRadius: 'var(--radius-md)',
                padding: '10px 14px',
                marginBottom: '14px',
                display: 'flex',
                alignItems: 'center',
                gap: '8px',
                color: 'var(--pill-warning-text)',
                fontSize: 'var(--font-size-sm)',
              }}
              role="status"
            >
              <IonIcon icon={warningOutline} />
              <span>{nearbyError}</span>
            </div>
          )}

          {nearby.length === 0 && !nearbyError ? (
            <div
              className="card--elevated"
              style={{
                textAlign: 'center',
                padding: '32px 16px',
                color: 'var(--color-text-secondary)',
                fontSize: 'var(--font-size-sm)',
              }}
            >
              No active incidents detected in your immediate perimeter.
            </div>
          ) : (
            <div className="card-list">
              {nearby.map((incident) => {
                const accentClass = PRIORITY_ACCENT_CLASS[incident.priority] ?? 'card--info-accent';
                const pillClass = PRIORITY_PILL_CLASS[incident.priority] ?? 'status-pill--info';

                return (
                  <div key={incident.incidentId} className={`card ${accentClass}`} style={{ padding: '14px' }}>
                    <div className="card__header" style={{ marginBottom: '6px' }}>
                      <span style={{ fontSize: 'var(--font-size-md)', fontWeight: 700, color: 'var(--color-text-primary)' }}>
                        {incident.incidentType.replace(/_/g, ' ').toUpperCase()}
                      </span>
                      <span className={`status-pill ${pillClass}`} style={{ marginLeft: 'auto' }}>
                        {incident.priority}
                      </span>
                    </div>

                    <div style={{ display: 'flex', alignItems: 'center', gap: '6px', fontSize: 'var(--font-size-sm)', color: 'var(--color-text-secondary)' }}>
                      <IonIcon icon={locationOutline} style={{ color: 'var(--color-primary)' }} />
                      <span style={{ fontFamily: 'var(--font-mono)', fontSize: '0.8rem' }}>
                        {position
                          ? `${formatDistance(distanceMeters(position.latitude, position.longitude, incident.latitude, incident.longitude))} · ${bearingLabel(position.latitude, position.longitude, incident.latitude, incident.longitude)}`
                          : `${incident.latitude.toFixed(4)}, ${incident.longitude.toFixed(4)}`}
                      </span>
                      <span style={{ marginLeft: 'auto', display: 'flex', alignItems: 'center', gap: '4px', fontSize: '0.75rem' }}>
                        <IonIcon icon={timeOutline} />
                        {Math.floor(incident.ageSeconds / 60)}m ago
                      </span>
                    </div>
                  </div>
                );
              })}
            </div>
          )}

          {/* Nearby Tanods Feed */}
          <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', margin: '20px 0 12px' }}>
            <h3 style={{ margin: 0, fontSize: 'var(--font-size-md)', fontWeight: 700, color: 'var(--color-text-primary)' }}>
              Nearby Tanods
            </h3>
            {nearbyTanods.length > 0 && (
              <span className="status-pill status-pill--info">{nearbyTanods.length} IN BARANGAY</span>
            )}
          </div>

          {tanodsError && (
            <div
              style={{
                background: 'var(--tint-warning-bg)',
                border: '1px solid var(--color-warning)',
                borderRadius: 'var(--radius-md)',
                padding: '10px 14px',
                marginBottom: '14px',
                display: 'flex',
                alignItems: 'center',
                gap: '8px',
                color: 'var(--pill-warning-text)',
                fontSize: 'var(--font-size-sm)',
              }}
              role="status"
            >
              <IonIcon icon={warningOutline} />
              <span>{tanodsError}</span>
            </div>
          )}

          {nearbyTanods.length === 0 && !tanodsError ? (
            <div
              className="card--elevated"
              style={{
                textAlign: 'center',
                padding: '32px 16px',
                color: 'var(--color-text-secondary)',
                fontSize: 'var(--font-size-sm)',
              }}
            >
              No other Tanods have a recorded position right now.
            </div>
          ) : (
            <div className="card-list">
              {nearbyTanods.map((tanod) => (
                <div key={tanod.userId} className={`card ${tanod.isStale ? '' : 'card--info-accent'}`} style={{ padding: '14px' }}>
                  <div className="card__header" style={{ marginBottom: '6px' }}>
                    <span style={{ fontSize: 'var(--font-size-md)', fontWeight: 700, color: 'var(--color-text-primary)' }}>
                      {tanod.fullName}
                    </span>
                    <span className={`status-pill ${tanod.isStale ? 'status-pill--neutral' : 'status-pill--success'}`} style={{ marginLeft: 'auto' }}>
                      {tanod.isStale ? 'STALE' : 'LIVE'}
                    </span>
                  </div>

                  <div style={{ display: 'flex', alignItems: 'center', gap: '6px', fontSize: 'var(--font-size-sm)', color: 'var(--color-text-secondary)' }}>
                    <IonIcon icon={locationOutline} style={{ color: 'var(--color-primary)' }} />
                    <span style={{ fontFamily: 'var(--font-mono)', fontSize: '0.8rem' }}>
                      {position
                        ? `${formatDistance(distanceMeters(position.latitude, position.longitude, tanod.latitude, tanod.longitude))} · ${bearingLabel(position.latitude, position.longitude, tanod.latitude, tanod.longitude)}`
                        : `${tanod.latitude.toFixed(4)}, ${tanod.longitude.toFixed(4)}`}
                    </span>
                    <span style={{ marginLeft: 'auto', display: 'flex', alignItems: 'center', gap: '4px', fontSize: '0.75rem' }}>
                      <IonIcon icon={timeOutline} />
                      {Math.floor(tanod.ageSeconds / 60)}m ago
                    </span>
                  </div>

                  {tanod.dispatchId !== null && (
                    <div style={{ marginTop: '6px', fontSize: '0.72rem', color: 'var(--color-text-tertiary)' }}>
                      On an active dispatch
                    </div>
                  )}
                </div>
              ))}
            </div>
          )}
        </div>
      </IonContent>
    </IonPage>
  );
};

export default LiveMapPage;
