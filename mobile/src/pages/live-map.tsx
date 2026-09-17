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
  IonToast,
} from '@ionic/react';
import {
  copyOutline,
  expandOutline,
  contractOutline,
  locateOutline,
  locationOutline,
  navigateOutline,
  radioOutline,
  shieldCheckmarkOutline,
  timeOutline,
  warningOutline,
  alertCircleOutline,
  peopleOutline,
} from 'ionicons/icons';
import LiveMapCanvas, { type BasemapStatus, type LiveMapCanvasHandle } from '../components/LiveMapCanvas';
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
import { bearingLabel, distanceMeters, formatDistance, formatRelativeAge } from '../utils/geo';
import tacticalFeedback from '../utils/tacticalFeedback';

const MIN_BROADCAST_INTERVAL_MS = 15000;
const NEARBY_REFRESH_INTERVAL_MS = 30000;
const STALE_AFTER_SECONDS = 120;

const PRIORITY_PILL_CLASS: Record<string, string> = {
  normal: 'status-pill--info',
  high: 'status-pill--pending',
  critical: 'status-pill--critical is-urgent',
};

type RadarSegment = 'incidents' | 'tanods';

const LiveMapPage: React.FC = () => {
  const [position, setPosition] = useState<DevicePosition | null>(null);
  const [positionError, setPositionError] = useState<string | null>(null);
  const [nearby, setNearby] = useState<NearbyIncident[]>([]);
  const [nearbyError, setNearbyError] = useState<string | null>(null);
  const [nearbyTanods, setNearbyTanods] = useState<NearbyTanod[]>([]);
  const [tanodsError, setTanodsError] = useState<string | null>(null);
  const [barangayId, setBarangayId] = useState<number | null>(null);
  const [basemapStatus, setBasemapStatus] = useState<BasemapStatus>({ kind: 'loading' });
  const [activeSegment, setActiveSegment] = useState<RadarSegment>('incidents');
  const [isExpanded, setIsExpanded] = useState(false);
  const [toastMessage, setToastMessage] = useState<string | null>(null);

  const lastBroadcastAt = useRef(0);
  const mapCanvasRef = useRef<LiveMapCanvasHandle | null>(null);

  useEffect(() => {
    let cancelled = false;
    async function loadBarangay() {
      const session = await loadSession();
      if (cancelled || !session) return;
      setBarangayId(session.barangayId);
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
      ? `Offline MBTiles v${basemapStatus.version}`
      : basemapStatus.kind === 'online'
        ? 'Online OpenStreetMap'
        : basemapStatus.kind === 'unavailable'
          ? 'Basemap Unavailable'
          : 'Loading Tiles…';

  function handleCopyCoords() {
    if (!position) return;
    const coordsStr = `${position.latitude.toFixed(5)}, ${position.longitude.toFixed(5)}`;
    void navigator.clipboard.writeText(coordsStr);
    tacticalFeedback.onTap();
    setToastMessage(`Copied: ${coordsStr} (Ready for radio dispatch)`);
  }

  function handleFocusTarget(lat: number, lng: number) {
    tacticalFeedback.onTap();
    mapCanvasRef.current?.focusCoordinates(lat, lng, 16);
    // Scroll map smoothly into view if scrolled down
    window.scrollTo({ top: 0, behavior: 'smooth' });
  }

  return (
    <IonPage>
      <MobileHeader title="LIVE RADAR" subtitle="Field Telemetry" />

      <IonContent className="ion-padding" style={{ '--background': 'var(--color-bg)' }}>
        <div className="app-column radar-layout">
          {/* 1. Tactical Map Viewport Container */}
          <div className="radar-map-wrapper">
            <LiveMapCanvas
              ref={mapCanvasRef}
              barangayId={barangayId}
              position={position}
              incidents={nearby}
              tanods={nearbyTanods}
              onStatusChange={setBasemapStatus}
              height={isExpanded ? '60vh' : '330px'}
            />

            {/* Top-Left Floating Basemap Status Pill */}
            <div className="radar-map-badge">
              <IonIcon icon={navigateOutline} style={{ color: 'var(--color-primary)' }} />
              <span>{basemapLabel}</span>
            </div>

            {/* Floating Map Utility Stack */}
            <div className="radar-map-controls">
              <button
                type="button"
                className="radar-map-btn"
                onClick={() => {
                  tacticalFeedback.onTap();
                  setIsExpanded((prev) => !prev);
                }}
                aria-label={isExpanded ? 'Collapse Map' : 'Expand Map'}
              >
                <IonIcon icon={isExpanded ? contractOutline : expandOutline} />
              </button>
            </div>
          </div>

          {/* 2. Tactical GPS Telemetry Lock HUD */}
          <div className="radar-gps-hud">
            <div className="radar-gps-hud-header">
              <div className="radar-gps-hud-title-wrap">
                <div
                  className={`radar-gps-hud-icon ${
                    isLive ? 'radar-gps-hud-icon--live' : 'radar-gps-hud-icon--stale'
                  }`}
                >
                  <IonIcon icon={locateOutline} />
                </div>
                <div>
                  <div className="radar-gps-hud-title">GPS Telemetry Lock</div>
                  <div className="radar-gps-hud-sub">
                    {isLive ? 'Continuous GPS lock active' : 'Acquiring satellite fix…'}
                  </div>
                </div>
              </div>

              <span className={`status-pill ${isLive ? 'status-pill--success' : 'status-pill--neutral'}`}>
                {isLive ? 'LIVE SATELLITE LOCK' : 'SIGNAL STALE'}
              </span>
            </div>

            {position ? (
              <div className="radar-coords-pill">
                <div style={{ minWidth: 0, flex: 1 }}>
                  <div className="radar-coords-text">
                    {position.latitude.toFixed(5)}, {position.longitude.toFixed(5)}
                  </div>
                  <div className="radar-coords-meta">
                    <span>Accuracy: ±{position.accuracyM.toFixed(0)}m</span>
                    <span>·</span>
                    <span>{ageSeconds !== null ? formatRelativeAge(ageSeconds) : 'Live'}</span>
                  </div>
                </div>

                <button
                  type="button"
                  className="radar-copy-btn"
                  onClick={handleCopyCoords}
                  aria-label="Copy Coordinates"
                >
                  <IonIcon icon={copyOutline} />
                  <span>Copy</span>
                </button>
              </div>
            ) : positionError ? (
              <div
                style={{
                  background: 'var(--tint-critical-bg)',
                  border: '1px solid var(--color-critical)',
                  borderRadius: 'var(--radius-sm)',
                  padding: '8px 10px',
                  color: 'var(--pill-critical-text)',
                  fontSize: 'var(--font-size-sm)',
                }}
              >
                {positionError}
              </div>
            ) : (
              <div style={{ display: 'flex', alignItems: 'center', gap: '8px', padding: '10px 0' }}>
                <IonSpinner name="dots" color="light" />
                <span style={{ fontSize: 'var(--font-size-sm)', color: 'rgba(255, 255, 255, 0.8)' }}>
                  Triangulating satellite coordinates…
                </span>
              </div>
            )}

            <div className="radar-broadcast-indicator">
              <IonIcon icon={radioOutline} style={{ color: '#38bdf8' }} />
              <span>Transmitting live coordinates to Barangay HQ every 15s</span>
            </div>
          </div>

          {/* 3. Tactical Segment Filter Bar */}
          <div className="radar-segment-bar">
            <button
              type="button"
              className={`radar-segment-tab ${activeSegment === 'incidents' ? 'radar-segment-tab--active' : ''}`}
              onClick={() => {
                tacticalFeedback.onTap();
                setActiveSegment('incidents');
              }}
            >
              <IonIcon icon={alertCircleOutline} />
              <span>Nearby Incidents</span>
              <span className="radar-segment-badge">{nearby.length}</span>
            </button>

            <button
              type="button"
              className={`radar-segment-tab ${activeSegment === 'tanods' ? 'radar-segment-tab--active' : ''}`}
              onClick={() => {
                tacticalFeedback.onTap();
                setActiveSegment('tanods');
              }}
            >
              <IonIcon icon={peopleOutline} />
              <span>Peer Tanods</span>
              <span className="radar-segment-badge">{nearbyTanods.length}</span>
            </button>
          </div>

          {/* 4. Filtered Perimeter Feed */}
          {activeSegment === 'incidents' && (
            <div>
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
                    padding: '36px 16px',
                    color: 'var(--color-text-secondary)',
                    fontSize: 'var(--font-size-sm)',
                    borderRadius: 'var(--radius-md)',
                    background: 'var(--color-surface)',
                    border: '1px solid var(--color-border)',
                  }}
                >
                  No active incidents detected in your immediate perimeter.
                </div>
              ) : (
                <div className="card-list">
                  {nearby.map((incident) => {
                    const pillClass = PRIORITY_PILL_CLASS[incident.priority] ?? 'status-pill--info';
                    const priorityModifier = `radar-item-card--${incident.priority}`;

                    return (
                      <div
                        key={incident.incidentId}
                        className={`radar-item-card ${priorityModifier}`}
                        onClick={() => handleFocusTarget(incident.latitude, incident.longitude)}
                      >
                        <div className="radar-item-top">
                          <div className="radar-item-title">
                            <span>{incident.incidentType.replace(/_/g, ' ').toUpperCase()}</span>
                          </div>
                          <span className={`status-pill ${pillClass}`}>{incident.priority}</span>
                        </div>

                        <div className="radar-item-meta">
                          <div style={{ display: 'flex', alignItems: 'center', gap: '8px' }}>
                            <span className="radar-distance-chip">
                              <IonIcon icon={locationOutline} />
                              {position
                                ? `${formatDistance(distanceMeters(position.latitude, position.longitude, incident.latitude, incident.longitude))} · ${bearingLabel(position.latitude, position.longitude, incident.latitude, incident.longitude)}`
                                : `${incident.latitude.toFixed(4)}, ${incident.longitude.toFixed(4)}`}
                            </span>

                            <span style={{ display: 'flex', alignItems: 'center', gap: '4px', fontSize: '0.72rem' }}>
                              <IonIcon icon={timeOutline} />
                              {formatRelativeAge(incident.ageSeconds)}
                            </span>
                          </div>

                          <button
                            type="button"
                            className="radar-focus-btn"
                            onClick={(e) => {
                              e.stopPropagation();
                              handleFocusTarget(incident.latitude, incident.longitude);
                            }}
                          >
                            <IonIcon icon={locateOutline} />
                            <span>View</span>
                          </button>
                        </div>
                      </div>
                    );
                  })}
                </div>
              )}
            </div>
          )}

          {activeSegment === 'tanods' && (
            <div>
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
                    padding: '36px 16px',
                    color: 'var(--color-text-secondary)',
                    fontSize: 'var(--font-size-sm)',
                    borderRadius: 'var(--radius-md)',
                    background: 'var(--color-surface)',
                    border: '1px solid var(--color-border)',
                  }}
                >
                  No other Tanods have a recorded position right now.
                </div>
              ) : (
                <div className="card-list">
                  {nearbyTanods.map((tanod) => {
                    const cardModifier = tanod.isStale ? 'radar-item-card--tanod-stale' : 'radar-item-card--tanod';

                    return (
                      <div
                        key={tanod.userId}
                        className={`radar-item-card ${cardModifier}`}
                        onClick={() => handleFocusTarget(tanod.latitude, tanod.longitude)}
                      >
                        <div className="radar-item-top">
                          <div className="radar-item-title">
                            <IonIcon icon={shieldCheckmarkOutline} style={{ color: 'var(--color-primary)' }} />
                            <span>{tanod.fullName}</span>
                          </div>
                          <span
                            className={`status-pill ${tanod.isStale ? 'status-pill--neutral' : 'status-pill--success'}`}
                          >
                            {tanod.isStale ? 'STALE' : 'LIVE'}
                          </span>
                        </div>

                        <div className="radar-item-meta">
                          <div style={{ display: 'flex', alignItems: 'center', gap: '8px' }}>
                            <span className="radar-distance-chip">
                              <IonIcon icon={locationOutline} />
                              {position
                                ? `${formatDistance(distanceMeters(position.latitude, position.longitude, tanod.latitude, tanod.longitude))} · ${bearingLabel(position.latitude, position.longitude, tanod.latitude, tanod.longitude)}`
                                : `${tanod.latitude.toFixed(4)}, ${tanod.longitude.toFixed(4)}`}
                            </span>

                            <span style={{ display: 'flex', alignItems: 'center', gap: '4px', fontSize: '0.72rem' }}>
                              <IonIcon icon={timeOutline} />
                              {formatRelativeAge(tanod.ageSeconds)}
                            </span>
                          </div>

                          <button
                            type="button"
                            className="radar-focus-btn"
                            onClick={(e) => {
                              e.stopPropagation();
                              handleFocusTarget(tanod.latitude, tanod.longitude);
                            }}
                          >
                            <IonIcon icon={locateOutline} />
                            <span>View</span>
                          </button>
                        </div>

                        {tanod.dispatchId !== null && (
                          <div
                            style={{
                              marginTop: '8px',
                              fontSize: '0.72rem',
                              color: 'var(--color-primary)',
                              fontWeight: 700,
                              display: 'flex',
                              alignItems: 'center',
                              gap: '4px',
                            }}
                          >
                            <span>🚔 Assigned to Dispatch #{tanod.dispatchId}</span>
                          </div>
                        )}
                      </div>
                    );
                  })}
                </div>
              )}
            </div>
          )}
        </div>

        <IonToast
          isOpen={toastMessage !== null}
          message={toastMessage ?? ''}
          duration={2500}
          color="primary"
          onDidDismiss={() => setToastMessage(null)}
        />
      </IonContent>
    </IonPage>
  );
};

export default LiveMapPage;

