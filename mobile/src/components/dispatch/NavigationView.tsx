/** Full-bleed turn-by-turn navigation surface of the assignment detail page (Phase 6 split; markup unchanged). */
import { IonIcon, IonSpinner } from '@ionic/react';
import {
  checkmarkCircle,
  checkmarkCircleOutline,
  checkmarkOutline,
  closeOutline,
  copyOutline,
  documentTextOutline,
  locateOutline,
  locationOutline,
  navigateOutline,
  openOutline,
  refreshOutline,
  shieldCheckmarkOutline,
  syncOutline,
} from 'ionicons/icons';
import type { RefObject } from 'react';
import LiveMapCanvas, { type FocusTarget, type LiveMapCanvasHandle } from '../LiveMapCanvas';
import ActiveStepCard from '../ActiveStepCard';
import type { NearbyIncident, RouteData } from '../../services/apiService';
import type { DispatchLocalRow } from '../../services/db/localSchema';
import type { DevicePosition } from '../../services/geolocation';
import { formatDistance } from '../../utils/geo';
import { priorityChip, sceneSubline } from '../../utils/navScene';
import { formatNavDistance, formatRemainingTime, type NavigationState } from '../../utils/routeProgress';
import type { NextDispatchStatus, NoteKind } from '../../utils/dispatchStages';

// MapLibre auto-follow pauses internally on pan; nothing to do here.
const handleUserPan = () => undefined;

export interface NavigationViewProps {
  row: DispatchLocalRow;
  focusTarget: FocusTarget | null;
  mapRef: RefObject<LiveMapCanvasHandle | null>;
  barangayId: number | null;
  position: DevicePosition | null;
  destinationIncidents: NearbyIncident[];
  route: RouteData | null;
  navState: NavigationState | null;
  note: string | null;
  noteKind: NoteKind;
  distanceM: number | null;
  bearing: string | null;
  next: NextDispatchStatus;
  updating: boolean;
  fetchingRoute: boolean;
  onDismissNote: () => void;
  onPrimaryAction: () => void;
  onRecenter: () => void;
  onOpenExternalMaps: () => void;
  onReroute: () => void;
  onExit: () => void;
  onCopyCoords: () => void;
  copiedCoords: boolean;
}

export default function NavigationView({
  row,
  focusTarget,
  mapRef,
  barangayId,
  position,
  destinationIncidents,
  route,
  navState,
  note,
  noteKind,
  distanceM,
  bearing,
  next,
  updating,
  fetchingRoute,
  onDismissNote,
  onPrimaryAction,
  onRecenter,
  onOpenExternalMaps,
  onReroute,
  onExit,
  onCopyCoords,
  copiedCoords,
}: NavigationViewProps) {
  const priority = priorityChip(row.priority);
  const subline = sceneSubline(bearing, distanceM);
  return (
  <div className="nav-viewport-container">
    {focusTarget && (
      <LiveMapCanvas
        ref={mapRef}
        barangayId={barangayId}
        position={position}
        incidents={destinationIncidents}
        tanods={[]}
        focusTarget={focusTarget}
        routeGeometry={route?.geometry ?? null}
        navigationMode={true}
        fullScreen={true}
        hideRecenterFab={true}
        height="100%"
        routeProgress={
          navState
            ? {
                snappedPoint: navState.snappedPoint,
                routeBearing: navState.routeBearing,
                snappedSegmentIndex: navState.snappedSegmentIndex,
                progressFraction: navState.progressFraction,
              }
            : null
        }
        onUserPan={handleUserPan}
      />
    )}

    {navState && route && (
      <ActiveStepCard
        navState={navState}
        steps={route.steps}
        mode={route.mode}
        onReroute={onReroute}
      />
    )}

    {/* Single 48px Recenter FAB */}
    <button
      type="button"
      className="nav-recenter-fab"
      onClick={onRecenter}
      title="Recenter Camera on GPS"
      aria-label="Recenter map on my location"
    >
      <IonIcon icon={locateOutline} />
    </button>

    {note && (
      <div
        className={`toast--tactical${noteKind !== 'info' ? ' toast--tactical--warning' : ''} p1-note-toast`}
        role={noteKind === 'error' ? 'alert' : 'status'}
      >
        <span>{note}</span>
        {noteKind !== 'info' && (
          <button type="button" className="p1-note-dismiss" aria-label="Dismiss message" onClick={() => onDismissNote()}>
            <IonIcon icon={closeOutline} aria-hidden="true" />
          </button>
        )}
      </div>
    )}

    <div className="nav-bottom-sheet">
      <div className="nav-bottom-sheet__drag-handle" />

      <div className="nav-bottom-sheet__header">
        <div className="nav-bottom-sheet__eta-group">
          {navState ? (
            <>
              <span className="nav-bottom-sheet__eta">
                {formatRemainingTime(navState.remainingTimeS)}
              </span>
              <span className="nav-bottom-sheet__meta">
                · {formatNavDistance(navState.remainingDistanceM)} remaining
              </span>
            </>
          ) : (
            <span className="nav-bottom-sheet__meta">
              {distanceM !== null ? `${formatDistance(distanceM)} away` : 'Calculating distance…'}
            </span>
          )}
        </div>

        <div className="nav-bottom-sheet__badge-group">
          <span className={`nav-priority-chip nav-priority-chip--${priority.tone}`}>{priority.label}</span>
          <span className="nav-type-chip">
            {row.redacted_incident_type ? row.redacted_incident_type.replace(/_/g, ' ') : 'Incident'}
          </span>
        </div>
      </div>

      {/* Destination Landmark & Info */}
      <div className="nav-bottom-sheet__destination">
        <IonIcon icon={locationOutline} className="nav-bottom-sheet__dest-icon" />
        <div className="nav-bottom-sheet__dest-info">
          <div className="nav-bottom-sheet__dest-name">
            {row.redacted_incident_summary
              ? row.redacted_incident_summary.split(/[\n.]/)[0].trim() || 'Incident Scene'
              : 'Incident Scene'}
          </div>
          <div className="nav-bottom-sheet__dest-coords">{subline ?? 'Location on the map'}</div>
        </div>
        {focusTarget && (
          <button type="button" className="nav-copy-btn" onClick={onCopyCoords} aria-label="Copy coordinates">
            <IonIcon icon={copiedCoords ? checkmarkOutline : copyOutline} aria-hidden="true" />
            <span>{copiedCoords ? 'Copied' : 'Copy'}</span>
          </button>
        )}
      </div>

      {/* Primary Context-Aware Action Button */}
      {next ? (
        <button
          type="button"
          className={`nav-primary-action-btn ${
            next === 'arrived' || next === 'en_route' ? 'nav-primary-action-btn--arrived' : 'nav-primary-action-btn--complete'
          }`}
          disabled={updating}
          onClick={onPrimaryAction}
        >
          {updating ? (
            <IonSpinner name="dots" />
          ) : next === 'arrived' ? (
            <>
              <IonIcon icon={checkmarkCircle} />
              <span>Mark Arrived at Scene</span>
            </>
          ) : next === 'en_route' ? (
            <>
              <IonIcon icon={navigateOutline} />
              <span>Go En Route</span>
            </>
          ) : (
            <>
              <IonIcon icon={shieldCheckmarkOutline} />
              <span>Mark Completed</span>
            </>
          )}
        </button>
      ) : (
        <div className="nav-complete-note">
          <IonIcon icon={checkmarkCircleOutline} className="nav-complete-note__icon" />
          Dispatch assignment completed
        </div>
      )}

      {/* Secondary Navigation Tools */}
      <div className="nav-bottom-sheet__tools">
        <button
          type="button"
          className="nav-tool-btn"
          onClick={onExit}
          title="Exit Navigation to Briefing"
        >
          <IonIcon icon={documentTextOutline} />
          <span>Briefing</span>
        </button>

        <button
          type="button"
          className="nav-tool-btn"
          onClick={onOpenExternalMaps}
          title="Open in Google Maps"
        >
          <IonIcon icon={openOutline} />
          <span>Google Maps</span>
        </button>

        <button
          type="button"
          className="nav-tool-btn"
          onClick={onReroute}
          disabled={fetchingRoute || !position}
          title="Recalculate Route"
        >
          {fetchingRoute ? (
            <IonSpinner name="dots" className="nav-tool-spinner" />
          ) : (
            <IonIcon icon={refreshOutline} />
          )}
          <span>Re-route</span>
        </button>
      </div>

      {row.synced === 0 && (
        <div className="nav-pending-sync">
          <IonIcon icon={syncOutline} />
          <span>Pending sync with Barangay HQ</span>
        </div>
      )}
    </div>
  </div>
  );
}
