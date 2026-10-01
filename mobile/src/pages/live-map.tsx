import React, { useEffect, useRef, useState, useMemo } from 'react';
import {
  IonContent,
  IonIcon,
  IonPage,
  IonToast,
} from '@ionic/react';
import {
  alertCircleOutline,
  closeOutline,
  flameOutline,
  layersOutline,
  locateOutline,
  locationOutline,
  navigateOutline,
  openOutline,
  optionsOutline,
  peopleOutline,
  refreshOutline,
  shieldCheckmarkOutline,
  timeOutline,
} from 'ionicons/icons';
import LiveMapCanvas, { type BasemapStatus, type LiveMapCanvasHandle } from '../components/LiveMapCanvas';
import MobileHeader from '../components/MobileHeader';
import {
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

type DrawerMode = 'peek' | 'selected' | 'expanded';
export type QuickFilterTab = 'all' | 'tanods' | 'incidents' | 'critical' | 'custom';

export interface AdvancedFilterState {
  showTanods: boolean;
  hideStaleTanods: boolean;
  showIncidents: boolean;
  priority: 'all' | 'critical_high' | 'critical_only';
  selectedTypes: string[];
  maxAgeHours: number;
}

const DEFAULT_ADVANCED_FILTERS: AdvancedFilterState = {
  showTanods: true,
  hideStaleTanods: false,
  showIncidents: true,
  priority: 'all',
  selectedTypes: [],
  maxAgeHours: 0,
};

type SelectedItem =
  | { type: 'incident'; item: NearbyIncident }
  | { type: 'tanod'; item: NearbyTanod };

const LiveMapPage: React.FC = () => {
  const [position, setPosition] = useState<DevicePosition | null>(null);
  const [positionError, setPositionError] = useState<string | null>(null);
  const [nearby, setNearby] = useState<NearbyIncident[]>([]);
  const [nearbyTanods, setNearbyTanods] = useState<NearbyTanod[]>([]);
  const [barangayId, setBarangayId] = useState<number | null>(null);
  const [basemapStatus, setBasemapStatus] = useState<BasemapStatus>({ kind: 'loading' });
  const [toastMessage, setToastMessage] = useState<string | null>(null);

  // Interactive Bottom Sheet Drawer State
  const [drawerMode, setDrawerMode] = useState<DrawerMode>('peek');
  const [quickFilter, setQuickFilter] = useState<QuickFilterTab>('all');
  const [advancedFilters, setAdvancedFilters] = useState<AdvancedFilterState>(DEFAULT_ADVANCED_FILTERS);
  const [tempAdvancedFilters, setTempAdvancedFilters] = useState<AdvancedFilterState>(DEFAULT_ADVANCED_FILTERS);
  const [isFilterModalOpen, setIsFilterModalOpen] = useState(false);
  const [selectedItem, setSelectedItem] = useState<SelectedItem | null>(null);

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
        // Fall back to one-shot fix
      }
    }

    void start();

    return () => {
      cancelled = true;
      stopWatch?.();
    };
  }, []);

  useEffect(() => {
    let cancelled = false;

    async function fetchNearby() {
      if (!position) return;
      try {
        const result = await getNearbyIncidents({
          latitude: position.latitude,
          longitude: position.longitude,
        });
        if (!cancelled) {
          setNearby(result);
        }
      } catch {
        // Keep cached
      }
    }

    async function fetchNearbyTanods() {
      try {
        const result = await getNearbyTanods();
        if (!cancelled) {
          setNearbyTanods(result);
        }
      } catch {
        // Keep cached
      }
    }

    void fetchNearby();
    void fetchNearbyTanods();

    const intervalId = window.setInterval(() => {
      void fetchNearby();
      void fetchNearbyTanods();
    }, NEARBY_REFRESH_INTERVAL_MS);

    return () => {
      cancelled = true;
      clearInterval(intervalId);
    };
  }, [position]);

  const ageSeconds = position
    ? Math.max(0, Math.floor((Date.now() - new Date(position.recordedAt).getTime()) / 1000))
    : null;
  const isLive = ageSeconds !== null && ageSeconds < STALE_AFTER_SECONDS;

  // Handlers for interactive selection
  const handleSelectIncident = (incident: NearbyIncident) => {
    tacticalFeedback.onTap();
    setSelectedItem({ type: 'incident', item: incident });
    setDrawerMode('selected');
    mapCanvasRef.current?.focusCoordinates(incident.latitude, incident.longitude, 16.5);
  };

  const handleSelectTanod = (tanod: NearbyTanod) => {
    tacticalFeedback.onTap();
    setSelectedItem({ type: 'tanod', item: tanod });
    setDrawerMode('selected');
    mapCanvasRef.current?.focusCoordinates(tanod.latitude, tanod.longitude, 16.5);
  };

  const handleDeselect = () => {
    if (drawerMode === 'selected') {
      setDrawerMode('peek');
      setSelectedItem(null);
    }
  };

  const handleRecenter = () => {
    tacticalFeedback.onTap();
    mapCanvasRef.current?.recenter();
  };

  const openExternalDirections = (lat: number, lng: number) => {
    tacticalFeedback.onTap();
    const url = `https://www.google.com/maps/dir/?api=1&destination=${lat},${lng}`;
    window.open(url, '_system');
  };

  // Selected item computed distance & bearing
  const selectedTelemetry = useMemo(() => {
    if (!selectedItem || !position) return null;
    const targetLat = selectedItem.item.latitude;
    const targetLng = selectedItem.item.longitude;
    const dist = distanceMeters(position.latitude, position.longitude, targetLat, targetLng);
    const bearing = bearingLabel(position.latitude, position.longitude, targetLat, targetLng);
    return `${formatDistance(dist)} · ${bearing}`;
  }, [selectedItem, position]);

  // Unique available incident types
  const availableIncidentTypes = useMemo(() => {
    const types = new Set<string>();
    nearby.forEach((inc) => {
      if (inc.incidentType) types.add(inc.incidentType);
    });
    return Array.from(types).sort();
  }, [nearby]);

  // Reactive Multi-Layer Filter Engine
  const { filteredIncidents, filteredTanods, criticalCount, criticalOrHighCount, isFilterActive } = useMemo(() => {
    let incList = nearby;
    let tanodList = nearbyTanods;

    // Two DIFFERENT counts, not one blurred together: the quick-filter
    // rail's flame button is labeled "Critical only" (aria-label below),
    // so its badge and its actual filter must both mean literally
    // priority==='critical' — not critical-or-high. The broader
    // combined tier still exists, but only inside the advanced filter
    // sheet's own explicit "Critical & High" option, which names itself
    // correctly and won't be confused with the rail's "Critical only".
    const critCount = nearby.filter((i) => i.priority === 'critical').length;
    const critOrHighCount = nearby.filter(
      (i) => i.priority === 'critical' || i.priority === 'high'
    ).length;

    if (quickFilter === 'tanods') {
      incList = [];
      if (advancedFilters.hideStaleTanods) {
        tanodList = tanodList.filter((t) => !t.isStale);
      }
    } else if (quickFilter === 'incidents') {
      tanodList = [];
    } else if (quickFilter === 'critical') {
      tanodList = [];
      incList = incList.filter((i) => i.priority === 'critical');
    } else if (quickFilter === 'all') {
      if (advancedFilters.hideStaleTanods) {
        tanodList = tanodList.filter((t) => !t.isStale);
      }
    } else {
      // Custom filters applied via modal
      if (!advancedFilters.showTanods) {
        tanodList = [];
      } else if (advancedFilters.hideStaleTanods) {
        tanodList = tanodList.filter((t) => !t.isStale);
      }

      if (!advancedFilters.showIncidents) {
        incList = [];
      } else {
        if (advancedFilters.priority === 'critical_only') {
          incList = incList.filter((i) => i.priority === 'critical');
        } else if (advancedFilters.priority === 'critical_high') {
          incList = incList.filter((i) => i.priority === 'critical' || i.priority === 'high');
        }

        if (advancedFilters.selectedTypes.length > 0) {
          incList = incList.filter((i) => advancedFilters.selectedTypes.includes(i.incidentType));
        }

        if (advancedFilters.maxAgeHours > 0) {
          const maxSec = advancedFilters.maxAgeHours * 3600;
          incList = incList.filter((i) => i.ageSeconds <= maxSec);
        }
      }
    }

    const active =
      quickFilter !== 'all' ||
      advancedFilters.hideStaleTanods ||
      !advancedFilters.showTanods ||
      !advancedFilters.showIncidents ||
      advancedFilters.priority !== 'all' ||
      advancedFilters.selectedTypes.length > 0 ||
      advancedFilters.maxAgeHours > 0;

    return {
      filteredIncidents: incList,
      filteredTanods: tanodList,
      criticalCount: critCount,
      criticalOrHighCount: critOrHighCount,
      isFilterActive: active,
    };
  }, [nearby, nearbyTanods, quickFilter, advancedFilters]);

  // Auto-deselect when a selected item is filtered out
  useEffect(() => {
    if (!selectedItem) return;
    if (selectedItem.type === 'incident') {
      const stillThere = filteredIncidents.some(
        (i) => i.incidentId === selectedItem.item.incidentId
      );
      if (!stillThere) {
        setSelectedItem(null);
        if (drawerMode === 'selected') setDrawerMode('peek');
      }
    } else if (selectedItem.type === 'tanod') {
      const stillThere = filteredTanods.some(
        (t) => t.userId === selectedItem.item.userId
      );
      if (!stillThere) {
        setSelectedItem(null);
        if (drawerMode === 'selected') setDrawerMode('peek');
      }
    }
  }, [filteredIncidents, filteredTanods, selectedItem, drawerMode]);

  // Real-Time Gesture & Touch Engine (Direct 1:1 finger tracking & momentum)
  const [dragY, setDragY] = useState(0);
  const [isDragging, setIsDragging] = useState(false);
  const touchStartY = useRef(0);
  const touchStartTime = useRef(0);
  const currentDragY = useRef(0);
  const isInterceptionFromScroll = useRef(false);
  const scrollListRef = useRef<HTMLDivElement>(null);

  const handleTouchStart = (e: React.TouchEvent, fromScrollList = false) => {
    if (e.touches.length !== 1) return;
    touchStartY.current = e.touches[0].clientY;
    touchStartTime.current = Date.now();
    currentDragY.current = 0;
    isInterceptionFromScroll.current = fromScrollList;
    setIsDragging(false);
  };

  const handleTouchMove = (e: React.TouchEvent) => {
    if (e.touches.length !== 1) return;
    const clientY = e.touches[0].clientY;
    const rawDelta = clientY - touchStartY.current;

    if (isInterceptionFromScroll.current) {
      const scrollEl = scrollListRef.current;
      // If user has scrolled down into the list, let native scroll work
      if (scrollEl && scrollEl.scrollTop > 0) {
        return;
      }
      // If at top of list and dragging downwards, intercept to collapse sheet
      if (rawDelta > 0) {
        currentDragY.current = rawDelta;
        setDragY(rawDelta);
        setIsDragging(true);
      }
      return;
    }

    // Dragging from handle bar, header, or preview card
    let effectiveDelta = rawDelta;
    if (drawerMode === 'peek' && rawDelta > 0) {
      effectiveDelta = Math.pow(rawDelta, 0.7);
    } else if (drawerMode === 'expanded' && rawDelta < 0) {
      effectiveDelta = -Math.pow(Math.abs(rawDelta), 0.7);
    }

    currentDragY.current = effectiveDelta;
    setDragY(effectiveDelta);
    setIsDragging(true);
  };

  const handleTouchEnd = () => {
    if (!isDragging && Math.abs(currentDragY.current) < 5) {
      setIsDragging(false);
      setDragY(0);
      return;
    }

    const elapsedMs = Math.max(1, Date.now() - touchStartTime.current);
    const velocity = currentDragY.current / elapsedMs;
    const delta = currentDragY.current;

    setIsDragging(false);
    setDragY(0);

    // Fast flick velocity detection
    if (velocity < -0.3) {
      tacticalFeedback.onTap();
      setDrawerMode('expanded');
      return;
    }

    if (velocity > 0.3) {
      tacticalFeedback.onTap();
      if (drawerMode === 'expanded') {
        if (selectedItem) {
          setDrawerMode('selected');
        } else {
          setDrawerMode('peek');
        }
      } else if (drawerMode === 'selected') {
        setSelectedItem(null);
        setDrawerMode('peek');
      }
      return;
    }

    // Distance-based snapping
    if (drawerMode === 'peek') {
      if (delta < -45) {
        tacticalFeedback.onTap();
        setDrawerMode('expanded');
      }
    } else if (drawerMode === 'expanded') {
      if (delta > 70) {
        tacticalFeedback.onTap();
        if (selectedItem) {
          setDrawerMode('selected');
        } else {
          setDrawerMode('peek');
        }
      }
    } else if (drawerMode === 'selected') {
      if (delta < -50) {
        tacticalFeedback.onTap();
        setDrawerMode('expanded');
      } else if (delta > 50) {
        tacticalFeedback.onTap();
        setSelectedItem(null);
        setDrawerMode('peek');
      }
    }
  };

  const fabYStyle = useMemo(() => {
    let base = '0px';
    if (drawerMode === 'selected') base = '-139px';
    else if (drawerMode === 'expanded') base = 'calc(76px - 65vh)';

    if (isDragging) {
      return `translateY(${base}) translateY(${dragY}px)`;
    }
    return `translateY(${base})`;
  }, [drawerMode, isDragging, dragY]);

  const drawerYStyle = useMemo(() => {
    let base = 'calc(100% - 76px)';
    if (drawerMode === 'selected') base = 'calc(100% - 215px)';
    else if (drawerMode === 'expanded') base = '0%';

    if (isDragging) {
      return `translateY(${base}) translateY(${dragY}px)`;
    }
    return `translateY(${base})`;
  }, [drawerMode, isDragging, dragY]);

  return (
    <IonPage>
      <MobileHeader title="Live Map" subtitle="On-Duty GPS" />

      <IonContent scrollY={false} style={{ '--background': 'var(--color-bg)', overflow: 'hidden' }}>
        <div className="live-map-screen">
          {/* Edge-to-Edge Full Screen Map Canvas */}
          <div className="live-map-canvas-fill">
            <LiveMapCanvas
              ref={mapCanvasRef}
              barangayId={barangayId}
              position={position}
              incidents={filteredIncidents}
              tanods={filteredTanods}
              onStatusChange={setBasemapStatus}
              fullScreen={true}
              height="100%"
              hideRecenterFab={true}
              onSelectIncident={handleSelectIncident}
              onSelectTanod={handleSelectTanod}
              onDeselect={handleDeselect}
              selectedIncidentId={selectedItem?.type === 'incident' ? selectedItem.item.incidentId : null}
              selectedTanodId={selectedItem?.type === 'tanod' ? selectedItem.item.userId : null}
            />
          </div>

          {/* Semi-Transparent Backdrop Scrim (Tap to Dismiss to Peek) */}
          <div
            className={`live-map-scrim ${drawerMode === 'expanded' ? 'live-map-scrim--active' : ''}`}
            onClick={() => {
              tacticalFeedback.onTap();
              setDrawerMode('peek');
            }}
            aria-hidden="true"
          />

          {/* Floating Top-Left Status HUD Pill */}
          <div className="live-map-hud-status" role="status" aria-live="polite">
            <span
              className={`live-map-status-dot ${
                positionError
                  ? 'live-map-status-dot--error'
                  : isLive
                  ? 'live-map-status-dot--live'
                  : 'live-map-status-dot--stale'
              }`}
            />
            <span>
              {position
                ? `Sharing Location · ±${position.accuracyM.toFixed(0)}m`
                : positionError
                ? 'GPS Unavailable'
                : 'Acquiring GPS…'}
            </span>
          </div>

          {/* Compact Icon+Count Filter Rail — Option A */}
          {/* Icon-only chips: no text labels = never clips, maximum map visibility.   */}
          {/* ARIA labels carry full readable names for assistive tech.                */}
          <div className="lm-rail" role="tablist" aria-label="Filter live map markers">
            <button
              type="button"
              role="tab"
              aria-selected={quickFilter === 'all'}
              aria-label={`All markers — ${nearby.length + nearbyTanods.length} total`}
              className={`lm-rail-btn ${quickFilter === 'all' ? 'lm-rail-btn--active' : ''}`}
              onClick={() => {
                tacticalFeedback.onSelection();
                setQuickFilter('all');
                setAdvancedFilters(DEFAULT_ADVANCED_FILTERS);
              }}
            >
              <IonIcon icon={layersOutline} />
              <span className="lm-rail-count">{nearby.length + nearbyTanods.length}</span>
            </button>

            <button
              type="button"
              role="tab"
              aria-selected={quickFilter === 'tanods'}
              aria-label={`Tanods — ${nearbyTanods.length} nearby`}
              className={`lm-rail-btn ${quickFilter === 'tanods' ? 'lm-rail-btn--active' : ''}`}
              onClick={() => {
                tacticalFeedback.onSelection();
                setQuickFilter('tanods');
              }}
            >
              <IonIcon icon={shieldCheckmarkOutline} />
              <span className="lm-rail-count">{nearbyTanods.length}</span>
            </button>

            <button
              type="button"
              role="tab"
              aria-selected={quickFilter === 'incidents'}
              aria-label={`Incidents — ${nearby.length} active`}
              className={`lm-rail-btn ${quickFilter === 'incidents' ? 'lm-rail-btn--active' : ''}`}
              onClick={() => {
                tacticalFeedback.onSelection();
                setQuickFilter('incidents');
              }}
            >
              <IonIcon icon={alertCircleOutline} />
              <span className="lm-rail-count">{nearby.length}</span>
            </button>

            <button
              type="button"
              role="tab"
              aria-selected={quickFilter === 'critical'}
              aria-label={`Critical only — ${criticalCount} critical`}
              className={`lm-rail-btn lm-rail-btn--critical ${quickFilter === 'critical' ? 'lm-rail-btn--active lm-rail-btn--critical-active' : ''}`}
              onClick={() => {
                tacticalFeedback.onSelection();
                setQuickFilter('critical');
              }}
            >
              <IonIcon icon={flameOutline} />
              <span className="lm-rail-count">{criticalCount}</span>
            </button>

            {/* Vertical divider separates filter tier from settings tier */}
            <span className="lm-rail-divider" aria-hidden="true" />

            <button
              type="button"
              aria-label="Advanced filter options"
              aria-pressed={isFilterActive && quickFilter === 'custom'}
              className={`lm-rail-btn lm-rail-btn--settings ${isFilterActive && quickFilter === 'custom' ? 'lm-rail-btn--active' : ''}`}
              onClick={() => {
                tacticalFeedback.onTap();
                setTempAdvancedFilters(advancedFilters);
                setIsFilterModalOpen(true);
              }}
            >
              <IonIcon icon={optionsOutline} />
              {isFilterActive && <span className="lm-rail-dot" aria-hidden="true" />}
            </button>
          </div>


          {/* Floating Pill when 0 Markers match active filter */}
          {isFilterActive && filteredIncidents.length === 0 && filteredTanods.length === 0 && (
            <div className="live-map-empty-filter-pill" role="status">
              <span>No markers match active filter</span>
              <button
                type="button"
                className="live-map-reset-btn"
                onClick={() => {
                  tacticalFeedback.onTap();
                  setQuickFilter('all');
                  setAdvancedFilters(DEFAULT_ADVANCED_FILTERS);
                }}
              >
                <IonIcon icon={refreshOutline} />
                <span>Reset</span>
              </button>
            </div>
          )}

          {/* Floating Recenter GPS FAB (Glides dynamically with drawer) */}
          <button
            type="button"
            className={`live-map-recenter-fab ${isDragging ? 'live-map-recenter-fab--dragging' : ''}`}
            onClick={handleRecenter}
            style={{ transform: fabYStyle }}
            aria-label="Center map on your location"
            title="Center on my location"
          >
            <IonIcon icon={locateOutline} />
          </button>

          {/* Interactive Sliding Bottom Sheet Drawer (Real-Time Touch Draggable) */}
          <div
            className={`live-map-drawer live-map-drawer--${drawerMode} ${
              isDragging ? 'live-map-drawer--dragging' : ''
            }`}
            style={{ transform: drawerYStyle }}
            onTouchStart={(e) => handleTouchStart(e, false)}
            onTouchMove={handleTouchMove}
            onTouchEnd={handleTouchEnd}
            onTouchCancel={handleTouchEnd}
            role="region"
            aria-label="Map Details Drawer"
          >
            {/* Drag Handle Bar */}
            <div
              className="live-map-drawer__handle-bar"
              onClick={() => {
                tacticalFeedback.onTap();
                if (drawerMode === 'peek') setDrawerMode('expanded');
                else if (drawerMode === 'expanded') setDrawerMode('peek');
                else if (drawerMode === 'selected') setDrawerMode('peek');
              }}
              title="Toggle drawer"
            >
              <div className="live-map-drawer__handle-pill" />
            </div>

            {/* State 1: Peek Mode Header — deliberately the TRUE totals
                (nearbyTanods/nearby), not filteredTanods/filteredIncidents.
                This strip reads as a situational-awareness status line
                ("how many colleagues are on duty right now"), not an echo
                of whatever the filter rail above happens to be showing —
                the two quick-filters that hide tanods (Incidents, Critical)
                used to make this say "0 on duty" even when tanods were
                genuinely on duty, just filtered off the map. */}
            {drawerMode === 'peek' && (
              <div className="live-map-drawer__peek-content">
                <div className="live-map-drawer__peek-title">
                  <IonIcon icon={peopleOutline} style={{ color: 'var(--color-primary)' }} />
                  <span>
                    {nearbyTanods.length} on duty &bull; {nearby.length}{' '}
                    {nearby.length === 1 ? 'incident' : 'incidents'}
                  </span>
                </div>
              </div>
            )}

            {/* State 2: Selected Marker Preview Card */}
            {drawerMode === 'selected' && selectedItem && (
              <div className="live-map-selected-card">
                <div className="live-map-selected-card__top">
                  <div className="live-map-selected-card__title-row">
                    <div
                      className={`live-map-selected-card__icon ${
                        selectedItem.type === 'tanod'
                          ? 'live-map-selected-card__icon--tanod'
                          : selectedItem.item.priority === 'critical'
                          ? 'live-map-selected-card__icon--critical'
                          : 'live-map-selected-card__icon--incident'
                      }`}
                    >
                      <IonIcon
                        icon={
                          selectedItem.type === 'tanod'
                            ? shieldCheckmarkOutline
                            : alertCircleOutline
                        }
                      />
                    </div>
                    <div>
                      <div className="live-map-selected-card__name">
                        {selectedItem.type === 'tanod'
                          ? selectedItem.item.fullName
                          : selectedItem.item.incidentType.replace(/_/g, ' ')}
                      </div>
                      <div className="live-map-selected-card__meta">
                        {selectedTelemetry && (
                          <span style={{ display: 'inline-flex', alignItems: 'center', gap: '3px', fontWeight: 600, color: 'var(--color-primary)' }}>
                            <IonIcon icon={locationOutline} />
                            {selectedTelemetry}
                          </span>
                        )}
                        <span>&bull;</span>
                        <span style={{ display: 'inline-flex', alignItems: 'center', gap: '3px' }}>
                          <IonIcon icon={timeOutline} />
                          {formatRelativeAge(selectedItem.item.ageSeconds)}
                        </span>
                      </div>
                    </div>
                  </div>

                  <span
                    className={`status-pill ${
                      selectedItem.type === 'tanod'
                        ? selectedItem.item.isStale
                          ? 'status-pill--neutral'
                          : 'status-pill--success'
                        : selectedItem.item.priority === 'critical'
                        ? 'status-pill--critical is-urgent'
                        : selectedItem.item.priority === 'high'
                        ? 'status-pill--pending'
                        : 'status-pill--info'
                    }`}
                  >
                    {selectedItem.type === 'tanod'
                      ? selectedItem.item.isStale
                        ? 'Offline'
                        : 'Active'
                      : selectedItem.item.priority}
                  </span>
                </div>

                <div className="live-map-selected-card__actions">
                  {selectedItem.type === 'incident' ? (
                    <button
                      type="button"
                      className="live-map-btn-primary"
                      onClick={() => openExternalDirections(selectedItem.item.latitude, selectedItem.item.longitude)}
                    >
                      <IonIcon icon={openOutline} />
                      <span>Directions (Maps)</span>
                    </button>
                  ) : (
                    <button
                      type="button"
                      className="live-map-btn-primary"
                      onClick={() => mapCanvasRef.current?.focusCoordinates(selectedItem.item.latitude, selectedItem.item.longitude, 17)}
                    >
                      <IonIcon icon={navigateOutline} />
                      <span>Center on Map</span>
                    </button>
                  )}

                  <button
                    type="button"
                    className="live-map-btn-ghost"
                    onClick={() => {
                      tacticalFeedback.onTap();
                      setSelectedItem(null);
                      setDrawerMode('peek');
                    }}
                  >
                    <IonIcon icon={closeOutline} />
                    <span>Dismiss</span>
                  </button>
                </div>
              </div>
            )}

            {/* State 3: Expanded List Mode */}
            {drawerMode === 'expanded' && (
              <div className="live-map-drawer__expanded-content">
                {/* Active filter context label — single source of truth is the map rail above */}
                {quickFilter !== 'all' && (
                  <div className="lm-list-filter-context">
                    <IonIcon
                      icon={quickFilter === 'tanods' ? shieldCheckmarkOutline : quickFilter === 'critical' ? flameOutline : alertCircleOutline}
                    />
                    <span>
                      {quickFilter === 'tanods' ? 'Tanods only' : quickFilter === 'incidents' ? 'Incidents only' : 'Critical only'}
                    </span>
                    <button
                      type="button"
                      className="lm-list-filter-clear"
                      onClick={() => {
                        tacticalFeedback.onTap();
                        setQuickFilter('all');
                        setAdvancedFilters(DEFAULT_ADVANCED_FILTERS);
                      }}
                    >
                      Clear
                    </button>
                  </div>
                )}

                {/* Scrollable Items List */}
                <div
                  ref={scrollListRef}
                  className="live-map-drawer__scroll-list"
                  onTouchStart={(e) => handleTouchStart(e, true)}
                  onTouchMove={handleTouchMove}
                  onTouchEnd={handleTouchEnd}
                >
                  {filteredIncidents.map((incident) => {
                    const distM = position ? distanceMeters(position.latitude, position.longitude, incident.latitude, incident.longitude) : null;
                    const bearing = position ? bearingLabel(position.latitude, position.longitude, incident.latitude, incident.longitude) : '';
                    const isCritical = incident.priority === 'critical';

                    return (
                      <div
                        key={`inc-${incident.incidentId}`}
                        className="live-map-list-item"
                        onClick={() => handleSelectIncident(incident)}
                      >
                        <div>
                          <div style={{ fontWeight: 700, fontSize: '0.86rem', color: 'var(--color-text-primary)' }}>
                            #{incident.incidentId} &bull; {incident.incidentType.replace(/_/g, ' ')}
                          </div>
                          <div style={{ fontSize: '0.72rem', color: 'var(--color-text-secondary)', marginTop: '2px', display: 'flex', gap: '8px' }}>
                            {distM !== null && (
                              <span style={{ color: 'var(--color-primary)', fontWeight: 600 }}>
                                {formatDistance(distM)} · {bearing}
                              </span>
                            )}
                            <span>{formatRelativeAge(incident.ageSeconds)}</span>
                          </div>
                        </div>

                        <span className={`status-pill ${isCritical ? 'status-pill--critical is-urgent' : incident.priority === 'high' ? 'status-pill--pending' : 'status-pill--info'}`}>
                          {incident.priority}
                        </span>
                      </div>
                    );
                  })}

                  {filteredTanods.map((tanod) => {
                    const distM = position ? distanceMeters(position.latitude, position.longitude, tanod.latitude, tanod.longitude) : null;
                    const bearing = position ? bearingLabel(position.latitude, position.longitude, tanod.latitude, tanod.longitude) : '';

                    return (
                      <div
                        key={`tanod-${tanod.userId}`}
                        className="live-map-list-item"
                        onClick={() => handleSelectTanod(tanod)}
                      >
                        <div>
                          <div style={{ fontWeight: 700, fontSize: '0.86rem', color: 'var(--color-text-primary)' }}>
                            {tanod.fullName}
                          </div>
                          <div style={{ fontSize: '0.72rem', color: 'var(--color-text-secondary)', marginTop: '2px', display: 'flex', gap: '8px' }}>
                            {distM !== null && (
                              <span style={{ color: 'var(--color-primary)', fontWeight: 600 }}>
                                {formatDistance(distM)} · {bearing}
                              </span>
                            )}
                            <span>{formatRelativeAge(tanod.ageSeconds)}</span>
                          </div>
                        </div>

                        <span className={`status-pill ${tanod.isStale ? 'status-pill--neutral' : 'status-pill--success'}`}>
                          {tanod.isStale ? 'Offline' : 'Active'}
                        </span>
                      </div>
                    );
                  })}

                  {filteredIncidents.length === 0 && filteredTanods.length === 0 && (
                    <div style={{ textAlign: 'center', padding: '32px 16px', color: 'var(--color-text-secondary)', fontSize: '0.85rem' }}>
                      <p style={{ margin: 0, fontWeight: 600 }}>No active incidents or Tanods match this filter.</p>
                      {isFilterActive && (
                        <button
                          type="button"
                          className="live-map-btn-ghost"
                          style={{ margin: '12px auto 0', display: 'inline-flex' }}
                          onClick={() => {
                            tacticalFeedback.onTap();
                            setQuickFilter('all');
                            setAdvancedFilters(DEFAULT_ADVANCED_FILTERS);
                          }}
                        >
                          <IonIcon icon={refreshOutline} />
                          <span>Reset Filters</span>
                        </button>
                      )}
                    </div>
                  )}
                </div>
              </div>
            )}
          </div>
        </div>

        {/* Detailed Filter Sheet Modal */}
        {isFilterModalOpen && (
          <>
            <div
              className="live-map-modal-backdrop"
              onClick={() => {
                tacticalFeedback.onTap();
                setIsFilterModalOpen(false);
              }}
              aria-hidden="true"
            />
            <div
              className="live-map-filter-sheet"
              role="dialog"
              aria-modal="true"
              aria-labelledby="filter-sheet-title"
            >
              <div className="live-map-filter-sheet__header">
                <span id="filter-sheet-title" className="live-map-filter-sheet__title">
                  Filter Live Patrol Map
                </span>
                <div style={{ display: 'flex', alignItems: 'center', gap: '8px' }}>
                  <button
                    type="button"
                    className="live-map-reset-btn"
                    onClick={() => {
                      tacticalFeedback.onTap();
                      setTempAdvancedFilters(DEFAULT_ADVANCED_FILTERS);
                    }}
                  >
                    <IonIcon icon={refreshOutline} />
                    <span>Reset</span>
                  </button>
                  <button
                    type="button"
                    className="topbar-btn"
                    style={{ width: '32px', height: '32px' }}
                    onClick={() => {
                      tacticalFeedback.onTap();
                      setIsFilterModalOpen(false);
                    }}
                    aria-label="Close filters"
                  >
                    <IonIcon icon={closeOutline} />
                  </button>
                </div>
              </div>

              <div className="live-map-filter-sheet__body">
                {/* Section 1: Entities to show */}
                <div>
                  <div className="live-map-filter-section-title">Show On Map</div>
                  <div style={{ display: 'flex', flexDirection: 'column', gap: '8px' }}>
                    <label className="live-map-filter-toggle-row">
                      <span style={{ fontWeight: 650, fontSize: '0.82rem', display: 'flex', alignItems: 'center', gap: '6px' }}>
                        <IonIcon icon={shieldCheckmarkOutline} style={{ color: 'var(--color-primary)' }} />
                        On-Duty Tanod Patrols ({nearbyTanods.length})
                      </span>
                      <input
                        type="checkbox"
                        checked={tempAdvancedFilters.showTanods}
                        onChange={(e) =>
                          setTempAdvancedFilters((prev) => ({ ...prev, showTanods: e.target.checked }))
                        }
                        style={{ width: '18px', height: '18px', accentColor: 'var(--color-primary)' }}
                      />
                    </label>

                    {tempAdvancedFilters.showTanods && (
                      <label className="live-map-filter-toggle-row live-map-filter-toggle-row--sub">
                        <span style={{ fontSize: '0.78rem', color: 'var(--color-text-secondary)' }}>
                          Hide stale patrols (GPS older than 2m)
                        </span>
                        <input
                          type="checkbox"
                          checked={tempAdvancedFilters.hideStaleTanods}
                          onChange={(e) =>
                            setTempAdvancedFilters((prev) => ({ ...prev, hideStaleTanods: e.target.checked }))
                          }
                          style={{ width: '16px', height: '16px', accentColor: 'var(--color-primary)' }}
                        />
                      </label>
                    )}

                    <label className="live-map-filter-toggle-row">
                      <span style={{ fontWeight: 650, fontSize: '0.82rem', display: 'flex', alignItems: 'center', gap: '6px' }}>
                        <IonIcon icon={alertCircleOutline} style={{ color: 'var(--color-warning)' }} />
                        Reported Incidents ({nearby.length})
                      </span>
                      <input
                        type="checkbox"
                        checked={tempAdvancedFilters.showIncidents}
                        onChange={(e) =>
                          setTempAdvancedFilters((prev) => ({ ...prev, showIncidents: e.target.checked }))
                        }
                        style={{ width: '18px', height: '18px', accentColor: 'var(--color-primary)' }}
                      />
                    </label>
                  </div>
                </div>

                {/* Section 2: Priority */}
                {tempAdvancedFilters.showIncidents && (
                  <div>
                    <div className="live-map-filter-section-title">Incident Priority</div>
                    <div className="live-map-filter-segment" role="group" aria-label="Filter by priority">
                      <button
                        type="button"
                        className={`live-map-filter-segment-btn ${
                          tempAdvancedFilters.priority === 'all' ? 'live-map-filter-segment-btn--active' : ''
                        }`}
                        onClick={() =>
                          setTempAdvancedFilters((prev) => ({ ...prev, priority: 'all' }))
                        }
                      >
                        All ({nearby.length})
                      </button>
                      <button
                        type="button"
                        className={`live-map-filter-segment-btn ${
                          tempAdvancedFilters.priority === 'critical_high' ? 'live-map-filter-segment-btn--active' : ''
                        }`}
                        onClick={() =>
                          setTempAdvancedFilters((prev) => ({ ...prev, priority: 'critical_high' }))
                        }
                      >
                        Critical &amp; High ({criticalOrHighCount})
                      </button>
                      <button
                        type="button"
                        className={`live-map-filter-segment-btn ${
                          tempAdvancedFilters.priority === 'critical_only' ? 'live-map-filter-segment-btn--active' : ''
                        }`}
                        onClick={() =>
                          setTempAdvancedFilters((prev) => ({ ...prev, priority: 'critical_only' }))
                        }
                      >
                        Critical Only
                      </button>
                    </div>
                  </div>
                )}

                {/* Section 3: Incident Types */}
                {tempAdvancedFilters.showIncidents && availableIncidentTypes.length > 0 && (
                  <div>
                    <div className="live-map-filter-section-title">Incident Types</div>
                    <div className="live-map-filter-types-grid">
                      <button
                        type="button"
                        className={`live-map-filter-type-pill ${
                          tempAdvancedFilters.selectedTypes.length === 0 ? 'live-map-filter-type-pill--active' : ''
                        }`}
                        onClick={() =>
                          setTempAdvancedFilters((prev) => ({ ...prev, selectedTypes: [] }))
                        }
                      >
                        All Types
                      </button>
                      {availableIncidentTypes.map((type) => {
                        const isSelected = tempAdvancedFilters.selectedTypes.includes(type);
                        return (
                          <button
                            key={type}
                            type="button"
                            className={`live-map-filter-type-pill ${
                              isSelected ? 'live-map-filter-type-pill--active' : ''
                            }`}
                            onClick={() => {
                              setTempAdvancedFilters((prev) => {
                                const exists = prev.selectedTypes.includes(type);
                                return {
                                  ...prev,
                                  selectedTypes: exists
                                    ? prev.selectedTypes.filter((t) => t !== type)
                                    : [...prev.selectedTypes, type],
                                };
                              });
                            }}
                          >
                            {type.replace(/_/g, ' ')}
                          </button>
                        );
                      })}
                    </div>
                  </div>
                )}

                {/* Section 4: Incident Freshness */}
                {tempAdvancedFilters.showIncidents && (
                  <div>
                    <div className="live-map-filter-section-title">Reported Time</div>
                    <div className="live-map-filter-segment" role="group" aria-label="Filter by time">
                      <button
                        type="button"
                        className={`live-map-filter-segment-btn ${
                          tempAdvancedFilters.maxAgeHours === 0 ? 'live-map-filter-segment-btn--active' : ''
                        }`}
                        onClick={() =>
                          setTempAdvancedFilters((prev) => ({ ...prev, maxAgeHours: 0 }))
                        }
                      >
                        All Active
                      </button>
                      <button
                        type="button"
                        className={`live-map-filter-segment-btn ${
                          tempAdvancedFilters.maxAgeHours === 1 ? 'live-map-filter-segment-btn--active' : ''
                        }`}
                        onClick={() =>
                          setTempAdvancedFilters((prev) => ({ ...prev, maxAgeHours: 1 }))
                        }
                      >
                        &lt; 1 Hour
                      </button>
                      <button
                        type="button"
                        className={`live-map-filter-segment-btn ${
                          tempAdvancedFilters.maxAgeHours === 6 ? 'live-map-filter-segment-btn--active' : ''
                        }`}
                        onClick={() =>
                          setTempAdvancedFilters((prev) => ({ ...prev, maxAgeHours: 6 }))
                        }
                      >
                        &lt; 6 Hours
                      </button>
                    </div>
                  </div>
                )}
              </div>

              <div className="live-map-filter-sheet__footer">
                <button
                  type="button"
                  className="live-map-btn-primary"
                  style={{ width: '100%', height: '44px' }}
                  onClick={() => {
                    tacticalFeedback.onTap();
                    setAdvancedFilters(tempAdvancedFilters);
                    setQuickFilter('custom');
                    setIsFilterModalOpen(false);
                  }}
                >
                  <span>Apply Filters</span>
                </button>
              </div>
            </div>
          </>
        )}

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
