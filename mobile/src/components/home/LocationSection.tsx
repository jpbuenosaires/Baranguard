import { IonIcon, IonSpinner } from '@ionic/react';
import { locateOutline, locationOutline, mapOutline } from 'ionicons/icons';
import { Banner } from '../ui';

export interface IncidentLocation {
  latitude: number;
  longitude: number;
  accuracyM: number | null;
}

interface Props {
  location: IncidentLocation | null;
  locationError: string | null;
  saving: boolean;
  acquiringGps: boolean;
  onClear: () => void;
  onTagGps: () => void;
  onOpenPicker: () => void;
}

function accuracyPill(accuracyM: number | null): { label: string; className: string } {
  if (accuracyM === null) return { label: 'Manual Pin', className: 'status-pill--info' };
  if (accuracyM < 10) return { label: `High (±${accuracyM.toFixed(0)}m)`, className: 'status-pill--success' };
  if (accuracyM <= 30) return { label: `Moderate (±${accuracyM.toFixed(0)}m)`, className: 'status-pill--pending' };
  return { label: `Coarse (±${accuracyM.toFixed(0)}m)`, className: 'status-pill--critical' };
}

/** Smart tactical location: GPS fix or map pin. */
const LocationSection: React.FC<Props> = ({
  location,
  locationError,
  saving,
  acquiringGps,
  onClear,
  onTagGps,
  onOpenPicker,
}) => (
  <div className="intake-block">
    <div className="intake-block-header">
      <span className="intake-block-title">
        <IonIcon icon={locationOutline} />
        Incident Location (Optional)
      </span>
      {location && (
        <button type="button" onClick={onClear} disabled={saving} className="intake-clear-btn">
          Clear Tag
        </button>
      )}
    </div>

    <div className="intake-loc-preview">
      {location ? (
        <div className="intake-loc-info">
          <IonIcon icon={locationOutline} className="intake-loc-icon" />
          <div>
            <div className="intake-loc-coords">
              {location.latitude.toFixed(5)}, {location.longitude.toFixed(5)}
            </div>
            <span className={`status-pill intake-pill-sm ${accuracyPill(location.accuracyM).className}`}>
              {accuracyPill(location.accuracyM).label}
            </span>
          </div>
        </div>
      ) : (
        <div className="intake-loc-empty-text">
          <IonIcon icon={locationOutline} />
          <span>No location added &bull; will save without map pin</span>
        </div>
      )}
    </div>

    <div className="intake-action-btn-row">
      <button
        type="button"
        className={`intake-btn-touch ${location && location.accuracyM !== null ? 'intake-btn-touch--active' : ''}`}
        onClick={onTagGps}
        disabled={saving || acquiringGps}
      >
        {acquiringGps ? (
          <IonSpinner name="dots" className="intake-spinner" />
        ) : (
          <IonIcon icon={locateOutline} className="intake-btn-icon" />
        )}
        <span>Use Current GPS</span>
      </button>

      <button
        type="button"
        className={`intake-btn-touch ${location && location.accuracyM === null ? 'intake-btn-touch--active' : ''}`}
        onClick={onOpenPicker}
        disabled={saving}
      >
        <IonIcon icon={mapOutline} className="intake-btn-icon" />
        <span>Choose on Map</span>
      </button>
    </div>

    {locationError && (
      <Banner tone="error" role="alert">
        {locationError}
      </Banner>
    )}
  </div>
);

export default LocationSection;
