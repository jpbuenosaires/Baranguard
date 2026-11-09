/** One active dispatch card on the Dispatches list. */
import { IonIcon } from '@ionic/react';
import {
  alertCircleOutline,
  carOutline,
  chevronForwardOutline,
  documentTextOutline,
  flameOutline,
  flashOutline,
  locationOutline,
  mapOutline,
  medkitOutline,
  pawOutline,
  shieldCheckmarkOutline,
  timeOutline,
} from 'ionicons/icons';
import { isCacheStale } from '../../services/db/dispatchRepository';
import type { DispatchLocalRow } from '../../services/db/localSchema';
import type { DevicePosition } from '../../services/geolocation';
import { bearingLabel, distanceMeters, formatDistanceDirection, formatRelativeAge } from '../../utils/geo';
import { formatIncidentCode } from '../../utils/incidentCode';
import { dispatchStatusLabel } from '../../utils/dispatchList';
import { DEFAULT_DISPATCH_SUMMARY } from '../../utils/dispatchStages';

function getCategoryIcon(type?: string | null) {
  const normalized = (type ?? '').toLowerCase();
  if (normalized.includes('injury') || normalized.includes('medical') || normalized.includes('health')) {
    return medkitOutline;
  }
  if (normalized.includes('theft') || normalized.includes('vandalism') || normalized.includes('robbery')) {
    return shieldCheckmarkOutline;
  }
  if (normalized.includes('traffic') || normalized.includes('vehic') || normalized.includes('car')) {
    return carOutline;
  }
  if (normalized.includes('animal') || normalized.includes('dog')) {
    return pawOutline;
  }
  if (normalized.includes('fire') || normalized.includes('smoke')) {
    return flameOutline;
  }
  if (normalized.includes('disturbance') || normalized.includes('dispute') || normalized.includes('noise')) {
    return alertCircleOutline;
  }
  return documentTextOutline;
}

export default function DispatchCard({
  row,
  position,
  onOpen,
  onDirections,
}: {
  row: DispatchLocalRow;
  position: DevicePosition | null;
  onOpen: (row: DispatchLocalRow) => void;
  onDirections: (row: DispatchLocalRow) => void;
}) {
  const stale = isCacheStale(row);
  const isCritical = row.priority === 'critical';
  const isHigh = row.priority === 'high';

  const cardUrgencyClass = isCritical
    ? 'dispatch-card--critical'
    : isHigh
      ? 'dispatch-card--high'
      : 'dispatch-card--routine';

  const hasCoords = row.latitude !== null && row.longitude !== null;
  const distanceStr =
    hasCoords && position
      ? formatDistanceDirection(
          distanceMeters(position.latitude, position.longitude, row.latitude!, row.longitude!),
          bearingLabel(position.latitude, position.longitude, row.latitude!, row.longitude!),
        )
      : hasCoords
        ? 'Location available'
        : 'Location not set';

  const elapsedSeconds = row.dispatched_at
    ? Math.max(0, Math.floor((Date.now() - new Date(row.dispatched_at).getTime()) / 1000))
    : null;

  const dispatchNo = row.server_dispatch_id ?? row.local_id.slice(0, 6);
  const incidentCode = formatIncidentCode({ displayId: row.incident_display_id, serverIncidentId: row.server_incident_id });

  return (
    <article key={row.local_id} className={`dispatch-card dispatch-card--p4 ${cardUrgencyClass}`}>
      {/* The whole top of the card is ONE link-like control; the action buttons below are siblings, never nested. */}
      <div
        className="dispatch-card__open"
        role="link"
        tabIndex={0}
        aria-label={`Open dispatch #${dispatchNo}: ${row.redacted_incident_type?.replace(/_/g, ' ') ?? 'Incident'}, priority ${row.priority}, status ${dispatchStatusLabel(row.status)}`}
        onClick={() => onOpen(row)}
        onKeyDown={(e) => {
          if (e.key === 'Enter' || e.key === ' ') {
            e.preventDefault();
            onOpen(row);
          }
        }}
      >
      {/* Top Scannable Header */}
      <div className="dispatch-card__header">
        <div className="dispatch-card__badge-row">
          {isCritical ? (
            <span className="dispatch-badge dispatch-badge--critical">
              <IonIcon icon={flashOutline} aria-hidden="true" />
              <span>Critical</span>
            </span>
          ) : isHigh ? (
            <span className="dispatch-badge dispatch-badge--high">
              <IonIcon icon={alertCircleOutline} aria-hidden="true" />
              <span>High priority</span>
            </span>
          ) : (
            <span className="dispatch-badge dispatch-badge--routine">
              <span>Normal priority</span>
            </span>
          )}

          <span className={`dispatch-badge dispatch-badge--status dispatch-badge--status-${row.status}`}>
            {dispatchStatusLabel(row.status)}
          </span>
        </div>

        <div className="dispatch-card__id-age">
          <span className="dispatch-card__id">
            {incidentCode ?? `#${dispatchNo}`}
          </span>
          {elapsedSeconds !== null && (
            <span className="dispatch-card__age">
              {formatRelativeAge(elapsedSeconds)}
            </span>
          )}
        </div>
      </div>

      {/* Incident Type & Category Title */}
      <div className="dispatch-card__body">
        <div className="dispatch-card__type-row">
          <div className="dispatch-card__category-icon" aria-hidden="true">
            <IonIcon icon={getCategoryIcon(row.redacted_incident_type)} />
          </div>
          <div className="dispatch-card__title-group">
            <h4 className="dispatch-card__title">
              {row.redacted_incident_type
                ? row.redacted_incident_type.replace(/_/g, ' ')
                : 'Incident Dispatch'}
            </h4>
            <span className="dispatch-card__location-sub">
              <IonIcon icon={locationOutline} className="dispatch-card__loc-icon" aria-hidden="true" />
              <span>{distanceStr}</span>
            </span>
          </div>
        </div>

        {/* The default instruction repeats on every card, so the list shows only real summaries. */}
        {row.redacted_incident_summary && row.redacted_incident_summary !== DEFAULT_DISPATCH_SUMMARY && (
          <p className="dispatch-card__summary">{row.redacted_incident_summary}</p>
        )}

        {stale && (
          <div className="dispatch-card__telemetry-row dispatch-card__telemetry-row--stale">
            <div className="dispatch-card__stale-chip">
              <IonIcon icon={timeOutline} aria-hidden="true" />
              <span>Cached copy, may be out of date</span>
            </div>
          </div>
        )}
      </div>

      </div>

      {/* Action bar: siblings of the link area */}
      <div className="dispatch-card__actions">
        {hasCoords && row.status !== 'arrived' && (
          <button
            type="button"
            className="dispatch-card__btn-directions"
            onClick={() => onDirections(row)}
            aria-label={`Open turn-by-turn directions to incident #${dispatchNo}`}
          >
            <IonIcon icon={mapOutline} aria-hidden="true" />
            <span>Directions</span>
          </button>
        )}

        <button
          type="button"
          className="dispatch-card__btn-primary"
          onClick={() => onOpen(row)}
          aria-label={`Open dispatch #${dispatchNo}`}
        >
          <IonIcon icon={chevronForwardOutline} aria-hidden="true" />
          <span>Open</span>
        </button>
      </div>
    </article>
  );
}
