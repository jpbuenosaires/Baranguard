import React, { useEffect, useMemo, useRef, useState } from 'react';
import { IonContent, IonIcon, IonPage, IonToast } from '@ionic/react';
import { alertCircleOutline, checkmarkCircleOutline, locateOutline, refreshOutline, timeOutline } from 'ionicons/icons';
import LiveMapCanvas, { type BasemapStatus, type LiveMapCanvasHandle } from '../components/LiveMapCanvas';
import { Chip } from '../components/ui';
import MobileHeader from '../components/MobileHeader';
import MapDrawer from '../components/map/MapDrawer';
import MapFilterRail from '../components/map/MapFilterRail';
import MapFilterSheet from '../components/map/MapFilterSheet';
import { useDeviceBroadcast } from '../components/map/useDeviceBroadcast';
import { useDrawerGestures } from '../components/map/useDrawerGestures';
import { useNearbyPolling } from '../components/map/useNearbyPolling';
import type { NearbyIncident, NearbyTanod } from '../services/apiService';
import { ensureMapPackageDownloaded } from '../services/mapPackageService';
import { loadSession } from '../services/session';
import { bearingLabel, distanceMeters, formatDistance } from '../utils/geo';
import tacticalFeedback from '../utils/tacticalFeedback';
import { basemapChip, freshnessLine } from '../utils/liveMapHud';
import { combinedLastOk } from '../utils/liveMapPolicy';
import {
  DEFAULT_ADVANCED_FILTERS,
  applyMapFilters,
  type AdvancedFilterState,
  type DrawerMode,
  type QuickFilterTab,
  type SelectedItem,
} from '../utils/mapFilters';

const STALE_AFTER_SECONDS = 120;

export type { QuickFilterTab, AdvancedFilterState };

const LiveMapPage: React.FC = () => {
  const [barangayId, setBarangayId] = useState<number | null>(null);
  const [toastMessage, setToastMessage] = useState<string | null>(null);

  // Interactive Bottom Sheet Drawer State
  const [drawerMode, setDrawerMode] = useState<DrawerMode>('peek');
  const [quickFilter, setQuickFilter] = useState<QuickFilterTab>('all');
  const [advancedFilters, setAdvancedFilters] = useState<AdvancedFilterState>(DEFAULT_ADVANCED_FILTERS);
  const [tempAdvancedFilters, setTempAdvancedFilters] = useState<AdvancedFilterState>(DEFAULT_ADVANCED_FILTERS);
  const [isFilterModalOpen, setIsFilterModalOpen] = useState(false);
  const [selectedItem, setSelectedItem] = useState<SelectedItem | null>(null);

  const mapCanvasRef = useRef<LiveMapCanvasHandle | null>(null);
  const [basemap, setBasemap] = useState<BasemapStatus>({ kind: 'loading' });

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

  const { position, positionError, broadcastState } = useDeviceBroadcast();
  const { nearby, nearbyTanods, deviceOnline, incidentsAt, tanodsAt, fetchFailing, nowMs } = useNearbyPolling(position);

  const freshness = freshnessLine(combinedLastOk(incidentsAt, tanodsAt, position !== null), fetchFailing, nowMs);
  const basemapInfo = basemapChip(
    basemap.kind === 'offline' ? { kind: 'offline', version: basemap.version } : { kind: basemap.kind },
    deviceOnline
  );

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

  const resetFilters = () => {
    setQuickFilter('all');
    setAdvancedFilters(DEFAULT_ADVANCED_FILTERS);
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
  const { filteredIncidents, filteredTanods, criticalCount, criticalOrHighCount, isFilterActive } = useMemo(
    () => applyMapFilters(nearby, nearbyTanods, quickFilter, advancedFilters),
    [nearby, nearbyTanods, quickFilter, advancedFilters]
  );

  // Auto-deselect when a selected item is filtered out
  useEffect(() => {
    if (!selectedItem) return;
    if (selectedItem.type === 'incident') {
      const stillThere = filteredIncidents.some((i) => i.incidentId === selectedItem.item.incidentId);
      if (!stillThere) {
        setSelectedItem(null);
        if (drawerMode === 'selected') setDrawerMode('peek');
      }
    } else if (selectedItem.type === 'tanod') {
      const stillThere = filteredTanods.some((t) => t.userId === selectedItem.item.userId);
      if (!stillThere) {
        setSelectedItem(null);
        if (drawerMode === 'selected') setDrawerMode('peek');
      }
    }
  }, [filteredIncidents, filteredTanods, selectedItem, drawerMode]);

  const { isDragging, scrollListRef, handleTouchStart, handleTouchMove, handleTouchEnd, fabYStyle, drawerYStyle } =
    useDrawerGestures({ drawerMode, setDrawerMode, selectedItem, setSelectedItem });

  return (
    <IonPage>
      <MobileHeader title="Live Map" subtitle="On-Duty GPS" />

      <IonContent scrollY={false} className="lm-content">
        <div className="live-map-screen">
          {/* Edge-to-Edge Full Screen Map Canvas */}
          <div className="live-map-canvas-fill">
            <LiveMapCanvas
              ref={mapCanvasRef}
              barangayId={barangayId}
              position={position}
              incidents={filteredIncidents}
              tanods={filteredTanods}
              fullScreen={true}
              height="100%"
              hideRecenterFab={true}
              onStatusChange={setBasemap}
              dataStale={freshness.offline}
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
              aria-hidden="true"
            />
            <IonIcon
              icon={
                !position || positionError || !isLive || broadcastState === 'saved'
                  ? positionError || !position
                    ? alertCircleOutline
                    : timeOutline
                  : checkmarkCircleOutline
              }
              aria-hidden="true"
            />
            <span>
              {positionError
                ? 'No GPS fix'
                : !position
                ? 'Acquiring GPS…'
                : !isLive
                ? 'Location stale'
                : broadcastState === 'saved'
                ? 'Saved on phone, will send'
                : broadcastState === 'confirmed'
                ? `Sharing location · ±${position.accuracyM.toFixed(0)}m`
                : `GPS fix · ±${position.accuracyM.toFixed(0)}m`}
            </span>
          </div>

          {/* Data freshness and basemap in use. Glides with the drawer like the recenter FAB. */}
          <div className="lm-info" style={{ transform: fabYStyle }} role="status" aria-live="polite">
            <Chip tone={freshness.offline ? 'warning' : 'neutral'}>{freshness.text}</Chip>
            <Chip tone={basemapInfo.tone}>{basemapInfo.label}</Chip>
          </div>

          <MapFilterRail
            quickFilter={quickFilter}
            incidentCount={nearby.length}
            tanodCount={nearbyTanods.length}
            criticalCount={criticalCount}
            isFilterActive={isFilterActive}
            onSelectAll={resetFilters}
            onSelectTab={setQuickFilter}
            onOpenAdvanced={() => {
              setTempAdvancedFilters(advancedFilters);
              setIsFilterModalOpen(true);
            }}
          />

          {/* Floating Pill when 0 Markers match active filter */}
          {isFilterActive && filteredIncidents.length === 0 && filteredTanods.length === 0 && (
            <div className="live-map-empty-filter-pill" role="status">
              <span>No markers match active filter</span>
              <button
                type="button"
                className="live-map-reset-btn"
                onClick={() => {
                  tacticalFeedback.onTap();
                  resetFilters();
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

          <MapDrawer
            drawerMode={drawerMode}
            setDrawerMode={setDrawerMode}
            drawerTransform={drawerYStyle}
            isDragging={isDragging}
            scrollListRef={scrollListRef}
            onTouchStart={handleTouchStart}
            onTouchMove={handleTouchMove}
            onTouchEnd={handleTouchEnd}
            position={position}
            nearby={nearby}
            nearbyTanods={nearbyTanods}
            filteredIncidents={filteredIncidents}
            filteredTanods={filteredTanods}
            selectedItem={selectedItem}
            selectedTelemetry={selectedTelemetry}
            quickFilter={quickFilter}
            isFilterActive={isFilterActive}
            onSelectIncident={handleSelectIncident}
            onSelectTanod={handleSelectTanod}
            onDismissSelected={() => {
              setSelectedItem(null);
              setDrawerMode('peek');
            }}
            onDirections={openExternalDirections}
            onCenterOn={(lat, lng) => mapCanvasRef.current?.focusCoordinates(lat, lng, 17)}
            onResetFilters={resetFilters}
          />
        </div>

        {/* Detailed Filter Sheet Modal */}
        {isFilterModalOpen && (
          <MapFilterSheet
            filters={tempAdvancedFilters}
            setFilters={setTempAdvancedFilters}
            tanodCount={nearbyTanods.length}
            incidentCount={nearby.length}
            criticalOrHighCount={criticalOrHighCount}
            availableIncidentTypes={availableIncidentTypes}
            onClose={() => setIsFilterModalOpen(false)}
            onApply={() => {
              setAdvancedFilters(tempAdvancedFilters);
              setQuickFilter('custom');
              setIsFilterModalOpen(false);
            }}
          />
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
