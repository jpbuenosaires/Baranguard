import React, { useLayoutEffect, useRef } from 'react';
import { IonIcon } from '@ionic/react';
import {
  alertCircleOutline,
  closeOutline,
  flameOutline,
  locationOutline,
  navigateOutline,
  openOutline,
  peopleOutline,
  refreshOutline,
  shieldCheckmarkOutline,
  timeOutline,
} from 'ionicons/icons';
import type { NearbyIncident, NearbyTanod } from '../../services/apiService';
import type { DevicePosition } from '../../services/geolocation';
import { bearingLabel, distanceMeters, formatDistance, formatRelativeAge } from '../../utils/geo';
import tacticalFeedback from '../../utils/tacticalFeedback';
import type { DrawerMode, QuickFilterTab, SelectedItem } from '../../utils/mapFilters';
import { Chip } from '../ui';
import type { StatusLine } from '../../utils/mapStatusLine';

interface Props {
  drawerMode: DrawerMode;
  setDrawerMode: (mode: DrawerMode) => void;
  drawerTransform: string;
  isDragging: boolean;
  scrollListRef: React.RefObject<HTMLDivElement | null>;
  onTouchStart: (e: React.TouchEvent, fromScrollList?: boolean) => void;
  onTouchMove: (e: React.TouchEvent) => void;
  onTouchEnd: () => void;
  position: DevicePosition | null;
  /** True totals (not filtered) for the peek strip. */
  nearby: NearbyIncident[];
  nearbyTanods: NearbyTanod[];
  filteredIncidents: NearbyIncident[];
  filteredTanods: NearbyTanod[];
  selectedItem: SelectedItem | null;
  selectedTelemetry: string | null;
  quickFilter: QuickFilterTab;
  isFilterActive: boolean;
  onSelectIncident: (incident: NearbyIncident) => void;
  onSelectTanod: (tanod: NearbyTanod) => void;
  onDismissSelected: () => void;
  onDirections: (lat: number, lng: number) => void;
  onCenterOn: (lat: number, lng: number) => void;
  onResetFilters: () => void;
  /** Reports the collapsed height that fits the summary text. */
  onPeekHeight?: (px: number) => void;
  /** Status line shown inside the expanded drawer (the map has no room for it above). */
  statusInside?: StatusLine | null;
}

function incidentPillClass(priority: string): string {
  return priority === 'critical'
    ? 'status-pill--critical is-urgent'
    : priority === 'high'
    ? 'status-pill--pending'
    : 'status-pill--info';
}

function tanodPillClass(isStale: boolean): string {
  return isStale ? 'status-pill--neutral' : 'status-pill--success';
}

interface ListRowProps {
  title: string;
  distance: string | null;
  ageSeconds: number;
  pillClass: string;
  /** Null for a stale tanod: shown as "last seen ..." text beside the name instead of a chip. */
  pillText: string | null;
  lastSeen?: boolean;
  onSelect: () => void;
}

const ListRow: React.FC<ListRowProps> = ({ title, distance, ageSeconds, pillClass, pillText, lastSeen, onSelect }) => (
  <div
    className="live-map-list-item"
    role="button"
    tabIndex={0}
    onClick={onSelect}
    onKeyDown={(e) => {
      if (e.key === 'Enter' || e.key === ' ') {
        e.preventDefault();
        onSelect();
      }
    }}
  >
    <div>
      <div className="lm-item-title">
        {title}
        {lastSeen && <span className="lm-item-lastseen">last seen {formatRelativeAge(ageSeconds)}</span>}
      </div>
      <div className="lm-item-meta">
        {distance !== null && <span className="lm-item-dist">{distance}</span>}
        {!lastSeen && <span>{formatRelativeAge(ageSeconds)}</span>}
      </div>
    </div>
    {pillText !== null && <span className={`status-pill ${pillClass}`}>{pillText}</span>}
  </div>
);

/** Interactive sliding bottom sheet: peek strip, selected-marker card, or the full list. */
const MapDrawer: React.FC<Props> = (p) => {
  const { drawerMode, selectedItem, position, onPeekHeight } = p;
  const drawerRef = useRef<HTMLDivElement>(null);
  const peekRef = useRef<HTMLDivElement>(null);

  // Collapsed height = handle + summary text + safe-area padding, so no blank strip is left below it.
  useLayoutEffect(() => {
    const el = peekRef.current;
    const drawer = drawerRef.current;
    if (drawerMode !== 'peek' || !el || !drawer || !onPeekHeight) return;
    const measure = () => {
      const pad = parseFloat(getComputedStyle(drawer).paddingBottom) || 0;
      onPeekHeight(el.offsetTop + el.offsetHeight + pad);
    };
    measure();
    if (typeof ResizeObserver === 'undefined') return;
    const ro = new ResizeObserver(measure);
    ro.observe(el);
    return () => ro.disconnect();
  }, [drawerMode, onPeekHeight]);

  const distanceText = (lat: number, lng: number): string | null =>
    position
      ? `${formatDistance(distanceMeters(position.latitude, position.longitude, lat, lng))} · ${bearingLabel(position.latitude, position.longitude, lat, lng)}`
      : null;

  const clearFilters = () => {
    tacticalFeedback.onTap();
    p.onResetFilters();
  };

  return (
    <div
      ref={drawerRef}
      className={`live-map-drawer live-map-drawer--${drawerMode} ${p.isDragging ? 'live-map-drawer--dragging' : ''}`}
      style={{ transform: p.drawerTransform }}
      onTouchStart={(e) => p.onTouchStart(e, false)}
      onTouchMove={p.onTouchMove}
      onTouchEnd={p.onTouchEnd}
      onTouchCancel={p.onTouchEnd}
      role="region"
      aria-label="Map Details Drawer"
    >
      {/* Drag Handle Bar */}
      <div
        className="live-map-drawer__handle-bar"
        onClick={() => {
          tacticalFeedback.onTap();
          if (drawerMode === 'peek') p.setDrawerMode('expanded');
          else if (drawerMode === 'expanded') p.setDrawerMode('peek');
          else if (drawerMode === 'selected') p.setDrawerMode('peek');
        }}
        title="Toggle drawer"
        role="button"
        tabIndex={0}
        aria-label="Toggle map details drawer"
        onKeyDown={(e) => {
          if (e.key === 'Enter' || e.key === ' ') {
            e.preventDefault();
            e.currentTarget.click();
          }
        }}
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
        <div ref={peekRef} className="live-map-drawer__peek-content">
          <div className="live-map-drawer__peek-title">
            <IonIcon icon={peopleOutline} className="lm-icon-primary" />
            <span>
              {p.nearbyTanods.filter((t) => !t.isStale).length} active now &bull;{' '}
              {p.nearby.length === 0
                ? 'No incidents near your location'
                : `${p.nearby.length} ${p.nearby.length === 1 ? 'incident' : 'incidents'}`}
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
                <IonIcon icon={selectedItem.type === 'tanod' ? shieldCheckmarkOutline : alertCircleOutline} />
              </div>
              <div>
                <div className="live-map-selected-card__name">
                  {selectedItem.type === 'tanod'
                    ? selectedItem.item.fullName
                    : selectedItem.item.incidentType.replace(/_/g, ' ')}
                </div>
                <div className="live-map-selected-card__meta">
                  {p.selectedTelemetry && (
                    <span className="lm-meta-dist">
                      <IonIcon icon={locationOutline} />
                      {p.selectedTelemetry}
                    </span>
                  )}
                  <span>&bull;</span>
                  <span className="lm-meta-age">
                    <IonIcon icon={timeOutline} />
                    {formatRelativeAge(selectedItem.item.ageSeconds)}
                  </span>
                </div>
              </div>
            </div>

            <span
              className={`status-pill ${
                selectedItem.type === 'tanod'
                  ? tanodPillClass(selectedItem.item.isStale)
                  : incidentPillClass(selectedItem.item.priority)
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
                onClick={() => p.onDirections(selectedItem.item.latitude, selectedItem.item.longitude)}
              >
                <IonIcon icon={openOutline} />
                <span>Directions (Maps)</span>
              </button>
            ) : (
              <button
                type="button"
                className="live-map-btn-primary"
                onClick={() => p.onCenterOn(selectedItem.item.latitude, selectedItem.item.longitude)}
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
                p.onDismissSelected();
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
          {p.statusInside && (
            <div className="lm-status-inside" role="status">
              <Chip tone={p.statusInside.tone}>{p.statusInside.text}</Chip>
            </div>
          )}
          {/* Active filter context label — single source of truth is the map rail above */}
          {p.quickFilter !== 'all' && (
            <div className="lm-list-filter-context">
              <IonIcon
                icon={
                  p.quickFilter === 'tanods'
                    ? shieldCheckmarkOutline
                    : p.quickFilter === 'critical'
                    ? flameOutline
                    : alertCircleOutline
                }
              />
              <span>
                {p.quickFilter === 'tanods'
                  ? 'Tanods only'
                  : p.quickFilter === 'incidents'
                  ? 'Incidents only'
                  : 'Critical only'}
              </span>
              <button type="button" className="lm-list-filter-clear" onClick={clearFilters}>
                Clear
              </button>
            </div>
          )}

          {/* Scrollable Items List */}
          <div
            ref={p.scrollListRef}
            className="live-map-drawer__scroll-list"
            onTouchStart={(e) => p.onTouchStart(e, true)}
            onTouchMove={p.onTouchMove}
            onTouchEnd={p.onTouchEnd}
          >
            {p.filteredIncidents.map((incident) => (
              <ListRow
                key={`inc-${incident.incidentId}`}
                title={`#${incident.incidentId} • ${incident.incidentType.replace(/_/g, ' ')}`}
                distance={distanceText(incident.latitude, incident.longitude)}
                ageSeconds={incident.ageSeconds}
                pillClass={incidentPillClass(incident.priority)}
                pillText={incident.priority}
                onSelect={() => p.onSelectIncident(incident)}
              />
            ))}

            {p.filteredTanods.map((tanod) => (
              <ListRow
                key={`tanod-${tanod.userId}`}
                title={tanod.fullName}
                distance={distanceText(tanod.latitude, tanod.longitude)}
                ageSeconds={tanod.ageSeconds}
                pillClass={tanodPillClass(tanod.isStale)}
                pillText={tanod.isStale ? null : 'Active'}
                lastSeen={tanod.isStale}
                onSelect={() => p.onSelectTanod(tanod)}
              />
            ))}

            {p.filteredIncidents.length === 0 && p.filteredTanods.length === 0 && (
              <div className="lm-list-empty">
                <p className="lm-list-empty__title">No active incidents or Tanods match this filter.</p>
                {p.isFilterActive && (
                  <button type="button" className="live-map-btn-ghost lm-list-empty__reset" onClick={clearFilters}>
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
  );
};

export default MapDrawer;
