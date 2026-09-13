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
          <IonButton slot="end" fill="clear" onClick={onCancel} aria-label="Close">
            <IonIcon icon={closeOutline} />
          </IonButton>
        </IonToolbar>
      </IonHeader>
      <IonContent className="ion-padding" style={{ '--background': 'var(--color-bg)' }}>
        <LiveMapCanvas
          barangayId={barangayId}
          position={selfPosition}
          incidents={pickedIncidents}
          tanods={[]}
          focusTarget={picked ?? undefined}
          onMapClick={setPicked}
        />
        <p style={{ fontSize: 'var(--font-size-sm)', color: 'var(--color-text-secondary)', marginTop: '10px' }}>
          Tap anywhere on the map to drop a pin at that spot.
        </p>
        {picked && (
          <p style={{ fontFamily: 'var(--font-mono)', fontSize: '0.85rem', color: 'var(--color-text-primary)' }}>
            {picked.latitude.toFixed(5)}, {picked.longitude.toFixed(5)}
          </p>
        )}
        <IonButton expand="block" disabled={!picked} onClick={() => picked && onConfirm(picked)} style={{ marginTop: '12px', fontWeight: 700 }}>
          Use This Location
        </IonButton>
      </IonContent>
    </IonModal>
  );
};

export default LocationPickerModal;
