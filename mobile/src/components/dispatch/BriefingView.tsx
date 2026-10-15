/** Field briefing and operation mode of the assignment detail page (Phase 6 split; markup unchanged). */
import { IonIcon } from '@ionic/react';
import { callOutline, checkmarkOutline, copyOutline, navigateOutline } from 'ionicons/icons';
import type { RefObject } from 'react';
import LiveMapCanvas, { type FocusTarget, type LiveMapCanvasHandle } from '../LiveMapCanvas';
import AssignmentEvidencePanel from '../AssignmentEvidencePanel';
import CollapsibleSection from '../CollapsibleSection';
import DispatchNextCard from '../DispatchNextCard';
import ReferralPanel from '../ReferralPanel';
import { Banner, Button } from '../ui';
import type { NearbyIncident, RouteData } from '../../services/apiService';
import type { DispatchLocalRow } from '../../services/db/localSchema';
import type { DevicePosition } from '../../services/geolocation';
import { formatDistance, formatRelativeAge } from '../../utils/geo';
import { formatIncidentCode } from '../../utils/incidentCode';
import tacticalFeedback from '../../utils/tacticalFeedback';
import { STAGES, STAGE_ORDER, STATUS_LABEL, type NextDispatchStatus, type NoteKind } from '../../utils/dispatchStages';

export interface BriefingViewProps {
  row: DispatchLocalRow;
  next: NextDispatchStatus;
  note: string | null;
  noteKind: NoteKind;
  distanceM: number | null;
  bearing: string | null;
  updating: boolean;
  focusTarget: FocusTarget | null;
  copiedCoords: boolean;
  backupContact: string | null;
  mapRef: RefObject<LiveMapCanvasHandle | null>;
  barangayId: number | null;
  position: DevicePosition | null;
  destinationIncidents: NearbyIncident[];
  route: RouteData | null;
  onDismissNote: () => void;
  onAdvance: () => void;
  onCopyCoords: () => void;
  onOpenNavigation: () => void;
}

export default function BriefingView({
  row,
  next,
  note,
  noteKind,
  distanceM,
  bearing,
  updating,
  focusTarget,
  copiedCoords,
  backupContact,
  mapRef,
  barangayId,
  position,
  destinationIncidents,
  route,
  onDismissNote,
  onAdvance,
  onCopyCoords,
  onOpenNavigation,
}: BriefingViewProps) {
  const currentStageIndex = STAGES.indexOf(row.status as (typeof STAGES)[number]);
  const stageNum = STAGE_ORDER[row.status] ?? 1;
  const elapsedSeconds = Math.max(0, Math.floor((Date.now() - new Date(row.dispatched_at).getTime()) / 1000));

  return (
  <div className="dispatch-redesign-container p4d-stack">
    {note && (
      <Banner
        tone={noteKind === 'error' ? 'error' : noteKind === 'queued' ? 'warning' : 'info'}
        onDismiss={noteKind !== 'info' ? () => onDismissNote() : undefined}
        dismissLabel="Dismiss message"
      >
        {note}
      </Banner>
    )}

    <DispatchNextCard
      next={next}
      incidentCode={formatIncidentCode({ displayId: row.incident_display_id, serverIncidentId: row.server_incident_id }) ?? 'Incident'}
      incidentType={row.redacted_incident_type}
      priority={row.priority}
      statusLabel={STATUS_LABEL[row.status] ?? row.status}
      locationLine={
        row.redacted_incident_summary
          ? row.redacted_incident_summary.split(/[\n.]/)[0].trim() || 'Incident location'
          : 'Incident location'
      }
      telemetry={distanceM !== null ? `${formatDistance(distanceM)} away, bearing ${bearing ?? 'N'}` : 'Locating...'}
      age={formatRelativeAge(elapsedSeconds)}
      synced={row.synced !== 0}
      serverDispatchId={row.server_dispatch_id}
      updating={updating}
      onAdvance={onAdvance}
    />

    <div className="dispatch-stage-bar">
      <div className="dispatch-stage-bar__header">
        <span className="dispatch-stage-bar__title">
          Stage {stageNum} of 4: {STATUS_LABEL[row.status] ?? row.status}
        </span>
      </div>
      <div
        className="dispatch-stage-segments"
        role="progressbar"
        aria-valuenow={stageNum}
        aria-valuemin={1}
        aria-valuemax={4}
        aria-label="Dispatch stage"
      >
        {STAGES.map((s, idx) => {
          const isDone = idx < currentStageIndex || (row.status === 'completed' && idx === currentStageIndex);
          const isActive = idx === currentStageIndex && row.status !== 'completed';
          return (
            <div
              key={s}
              className={`dispatch-stage-segment ${
                isDone ? 'dispatch-stage-segment--done' : isActive ? 'dispatch-stage-segment--active' : ''
              }`}
            />
          );
        })}
      </div>
    </div>

    <CollapsibleSection title="Details" defaultOpen>
      <p className="dispatch-briefing-body">
        {row.redacted_incident_summary || 'Patrol dispatched to check the area and assist with the incident.'}
      </p>
      {focusTarget && (
        <div className="dispatch-coords-strip">
          <span>
            GPS: {focusTarget.latitude.toFixed(5)}, {focusTarget.longitude.toFixed(5)}
          </span>
          <button
            type="button"
            className="coords-copy-btn"
            onClick={onCopyCoords}
            aria-label="Copy coordinates"
          >
            <IonIcon icon={copiedCoords ? checkmarkOutline : copyOutline} aria-hidden="true" />
            <span>{copiedCoords ? 'Copied' : 'Copy'}</span>
          </button>
        </div>
      )}
      {row.status === 'arrived' && backupContact && (
        <a
          href={`tel:${backupContact}`}
          className="p4d-call"
          onClick={() => tacticalFeedback.onTap()}
        >
          <IonIcon icon={callOutline} aria-hidden="true" />
          <span>Call backup contact {backupContact}</span>
        </a>
      )}
    </CollapsibleSection>

    {focusTarget && (
      <CollapsibleSection title="Route and map">
        <div className="dispatch-map-preview-card">
          <LiveMapCanvas
            ref={mapRef}
            barangayId={barangayId}
            position={position}
            incidents={destinationIncidents}
            tanods={[]}
            focusTarget={focusTarget}
            routeGeometry={route?.geometry ?? null}
            navigationMode={false}
            height="200px"
            hideRecenterFab={true}
          />
        </div>
        <Button
          variant="secondary"
          fullWidth
          icon={navigateOutline}
          onClick={onOpenNavigation}
        >
          Open turn-by-turn guidance
        </Button>
      </CollapsibleSection>
    )}

    <CollapsibleSection title="Evidence">
      <AssignmentEvidencePanel dispatchLocalId={row.local_id} hideTitle />
    </CollapsibleSection>

    <CollapsibleSection title="Referral">
      <ReferralPanel
        link={{ serverIncidentId: row.server_incident_id }}
        incidentLabel={formatIncidentCode({ displayId: row.incident_display_id, serverIncidentId: row.server_incident_id }) ?? 'this incident'}
        hideTitle
      />
    </CollapsibleSection>
  </div>
  );
}
