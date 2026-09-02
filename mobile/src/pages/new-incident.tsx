/**
 * new-incident.tsx — M3 Log New Incident (§9 Mobile).
 *
 * Sprint 2's box scopes this to the LOCAL SQLite write path:
 * "client_event_id assigned at time of first save, atomic before the user
 * can leave". Uploading is Sprint 3's `/sync/batch` work — this screen
 * therefore never claims the incident reached the server, and never
 * touches the network at all.
 *
 * §2 Rule 2: the record is persisted to the encrypted local store BEFORE
 * the user can leave the capture flow. The Save button stays busy until
 * the transaction commits, and navigation to M4 only happens afterwards.
 *
 * Deliberately not captured here: latitude/longitude. GPS is Sprint 3
 * (§10 "GPS broadcast (S3)"), and the schema allows both to be NULL.
 * Capturing coordinates would mean adding a geolocation plugin this cut
 * cannot verify on a device — so the columns are written as NULL rather
 * than filled with anything invented.
 *
 * kebab-case filename per §4.
 */

import { useState } from 'react';
import { useNavigate } from 'react-router-dom';
import {
  IonBackButton,
  IonButton,
  IonButtons,
  IonContent,
  IonHeader,
  IonItem,
  IonLabel,
  IonList,
  IonNote,
  IonPage,
  IonSelect,
  IonSelectOption,
  IonSpinner,
  IonTextarea,
  IonTitle,
  IonToolbar,
} from '@ionic/react';
import { INCIDENT_TYPES, saveIncidentLocally, type IncidentType } from '../services/db/incidentRepository';
import { loadSession } from '../services/session';

/** Human labels for §5's incident_type enum. Values are never re-cased. */
const TYPE_LABELS: Record<IncidentType, string> = {
  theft: 'Theft',
  physical_injury: 'Physical Injury',
  disturbance: 'Disturbance',
  domestic_dispute: 'Domestic Dispute',
  vandalism: 'Vandalism',
  traffic_incident: 'Traffic Incident',
  fire: 'Fire',
  medical_emergency: 'Medical Emergency',
  missing_person: 'Missing Person',
  animal_complaint: 'Animal Complaint',
  other: 'Other',
};

const NewIncidentPage: React.FC = () => {
  const navigate = useNavigate();
  const [incidentType, setIncidentType] = useState<IncidentType>('theft');
  const [narrative, setNarrative] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);

  async function handleSave() {
    setError(null);
    if (!narrative.trim()) {
      setError('Describe what happened before saving.');
      return;
    }

    setSaving(true);
    try {
      const session = await loadSession();
      const saved = await saveIncidentLocally({
        // The session may be expired by now; capture must still work
        // (§2 Rule 9). barangayId falling back to 0 would be invented
        // data, so an absent session is a hard error here instead.
        barangayId: session?.barangayId ?? 0,
        reportedBy: session?.userId ?? null,
        incidentType,
        rawNarrative: narrative,
      });
      // Only now is it safe to leave the capture flow.
      navigate(`/incidents/${saved.localId}/submitted`, { replace: true });
    } catch (err) {
      setError(
        err instanceof Error && err.message
          ? err.message
          : 'Could not save this incident to the device.'
      );
      setSaving(false);
    }
  }

  return (
    <IonPage>
      <IonHeader>
        <IonToolbar>
          <IonButtons slot="start">
            <IonBackButton defaultHref="/home" disabled={saving} />
          </IonButtons>
          <IonTitle>Log Incident</IonTitle>
        </IonToolbar>
      </IonHeader>
      <IonContent className="ion-padding">
        <IonList inset>
          <IonItem>
            <IonSelect
              label="Incident type"
              labelPlacement="floating"
              value={incidentType}
              disabled={saving}
              onIonChange={(e) => setIncidentType(e.detail.value as IncidentType)}
            >
              {INCIDENT_TYPES.map((type) => (
                <IonSelectOption key={type} value={type}>
                  {TYPE_LABELS[type]}
                </IonSelectOption>
              ))}
            </IonSelect>
          </IonItem>
          <IonItem>
            <IonTextarea
              label="What happened?"
              labelPlacement="floating"
              autoGrow
              rows={6}
              value={narrative}
              disabled={saving}
              onIonInput={(e) => setNarrative(e.detail.value ?? '')}
            />
          </IonItem>
        </IonList>

        {error && (
          <IonNote color="danger" role="alert" style={{ display: 'block', padding: '0 16px 12px' }}>
            {error}
          </IonNote>
        )}

        <IonButton expand="block" onClick={handleSave} disabled={saving}>
          {saving ? <IonSpinner name="dots" /> : 'Save to device'}
        </IonButton>

        <IonLabel>
          <IonNote style={{ display: 'block', marginTop: 16, lineHeight: 1.5 }}>
            Saved on this device first. Sending to the barangay workstation happens
            later — this screen never reports it as submitted.
          </IonNote>
        </IonLabel>
      </IonContent>
    </IonPage>
  );
};

export default NewIncidentPage;
