/**
 * LocationPickerModal.tsx — the manual "tap to drop a pin" coordinate
 * picker for M3 Log Incident (Mobile Improvement Plan Phase 2.1).
 *
 * Reuses `LiveMapCanvas.tsx` (the same offline-MBTiles-first/online-OSM-
 * fallback renderer M7 Live Map and M6 Assignment Detail already use)
 * rather than a second map implementation. The picked point is rendered
 * through `LiveMapCanvas`'s existing `incidents` marker path (a synthetic
 * single-item array) instead of teaching that shared component a new
 * "picked pin" marker style it would carry for every other caller too —
 * this modal's own title and coordinate readout already make clear what
 * the pin means, so reusing the plain "normal priority" blue dot is
 * enough, not a new visual language.
 */

import { useEffect, useState } from 'react';
import { IonButton, IonContent, IonHeader, IonIcon, IonModal, IonTitle, IonToolbar } from '@ionic/react';
import { closeOutline } from 'ionicons/icons';
import LiveMapCanvas, { type FocusTarget } from './LiveMapCanvas';
import { Button } from './ui';
import type { NearbyIncident } from '../services/apiService';
import type { DevicePosition } from '../services/geolocation';

interface Props {
  isOpen: boolean;
  barangayId: number | null;
  selfPosition: DevicePosition | null;
  /** Pre-fills the pin if the caller already has a coordinate (e.g. adjusting a GPS fix). */
  initialPoint: FocusTarget | null;
  onCancel: () => void;
  onConfirm: (point: FocusTarget) => void;
}

const LocationPickerModal: React.FC<Props> = ({ isOpen, barangayId, selfPosition, initialPoint, onCancel, onConfirm }) => {
  const [picked, setPicked] = useState<FocusTarget | null>(initialPoint);

  // Re-seed the pin every time the modal opens — otherwise a previous
  // session's pick (or none) would linger across re-opens.
  useEffect(() => {
    if (isOpen) setPicked(initialPoint);
  }, [isOpen, initialPoint]);

  const pickedIncidents: NearbyIncident[] = picked
    ? [
        {
          incidentId: -1,
          incidentType: 'picked_location',
          priority: 'normal',
          status: 'pending',
          latitude: picked.latitude,
          longitude: picked.longitude,
          ageSeconds: 0,
        },
      ]
    : [];

  return (
    <IonModal isOpen={isOpen} onDidDismiss={onCancel}>
      <IonHeader>
        <IonToolbar>
          <IonTitle>Tap to Set Location</IonTitle>
          <IonButton slot="end" fill="clear" onClick={onCancel} aria-label="Close without choosing a location" className="lm-picker__close">
            <IonIcon icon={closeOutline} aria-hidden="true" />
          </IonButton>
        </IonToolbar>
      </IonHeader>
      <IonContent scrollY={false} style={{ '--background': 'var(--color-bg)' }}>
        <div className="lm-picker">
          <div className="lm-picker__map">
            <LiveMapCanvas
              barangayId={barangayId}
              position={selfPosition}
              incidents={pickedIncidents}
              tanods={[]}
              focusTarget={picked ?? undefined}
              onMapClick={setPicked}
              fullScreen={true}
              height="100%"
            />
          </div>
          <div className="lm-picker__panel">
            <p className="lm-picker__gps" role="status">
              {selfPosition
                ? `GPS fix: accuracy about ${Math.round(selfPosition.accuracyM)} m`
                : 'No GPS fix. Tap the map to place the pin yourself.'}
            </p>
            <p className="lm-picker__coords" aria-live="polite">
              {picked
                ? `${picked.latitude.toFixed(5)}, ${picked.longitude.toFixed(5)}`
                : 'Tap anywhere on the map to drop a pin at that spot.'}
            </p>
            <div className="lm-picker__actions">
              <Button variant="secondary" onClick={onCancel}>
                Cancel
              </Button>
              <Button disabled={!picked} onClick={() => picked && onConfirm(picked)}>
                Use This Location
              </Button>
            </div>
          </div>
        </div>
      </IonContent>
    </IonModal>
  );
};

export default LocationPickerModal;
