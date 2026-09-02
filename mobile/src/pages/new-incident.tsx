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
 * Photo/voice attachments (added 2026-09-03, §9 M3's own API list):
 * captured and staged in component state WHILE the form is being filled,
 * then persisted to `evidence_attachment_local` only AFTER the incident
 * itself saves — an attachment can never exist locally without its parent
 * incident row, mirroring the ordering §9 M3 already requires for the
 * incident's own save. If an individual evidence write fails after the
 * incident saved successfully, that failure is surfaced but does NOT
 * block navigation to M4 — the incident record (the atomicity guarantee
 * this screen exists to provide) is already safe either way.
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
  IonIcon,
  IonItem,
  IonLabel,
  IonList,
  IonNote,
  IonPage,
  IonSpinner,
  IonTitle,
  IonToolbar,
} from '@ionic/react';
import { cameraOutline, closeCircle, micOutline, stopCircleOutline } from 'ionicons/icons';
import { SelectField, TextAreaField } from '../components/FormFields';
import { INCIDENT_TYPES, saveIncidentLocally, type IncidentType } from '../services/db/incidentRepository';
import { saveEvidenceLocally } from '../services/db/evidenceRepository';
import {
  capturePhoto,
  isRecordingVoice,
  startVoiceRecording,
  stopVoiceRecording,
  type StagedAttachment,
} from '../services/evidenceCapture';
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

interface StagedItem {
  key: string;
  attachment: StagedAttachment;
}

const NewIncidentPage: React.FC = () => {
  const navigate = useNavigate();
  const [incidentType, setIncidentType] = useState<IncidentType>('theft');
  const [narrative, setNarrative] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const [staged, setStaged] = useState<StagedItem[]>([]);
  const [capturing, setCapturing] = useState(false);
  const [recording, setRecording] = useState(false);
  const [captureError, setCaptureError] = useState<string | null>(null);

  async function handleAddPhoto() {
    setCaptureError(null);
    setCapturing(true);
    try {
      const attachment = await capturePhoto();
      setStaged((prev) => [...prev, { key: attachment.filePath, attachment }]);
    } catch (err) {
      setCaptureError(err instanceof Error ? err.message : 'Could not capture a photo.');
    } finally {
      setCapturing(false);
    }
  }

  async function handleToggleVoice() {
    setCaptureError(null);
    if (isRecordingVoice()) {
      setCapturing(true);
      try {
        const attachment = await stopVoiceRecording();
        setStaged((prev) => [...prev, { key: attachment.filePath, attachment }]);
      } catch (err) {
        setCaptureError(err instanceof Error ? err.message : 'Could not save the voice note.');
      } finally {
        setRecording(false);
        setCapturing(false);
      }
      return;
    }
    try {
      await startVoiceRecording();
      setRecording(true);
    } catch (err) {
      setCaptureError(err instanceof Error ? err.message : 'Could not start recording.');
    }
  }

  function handleRemoveStaged(key: string) {
    setStaged((prev) => prev.filter((item) => item.key !== key));
  }

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

      // Attachments are best-effort against an already-saved incident: a
      // failure here must not undo or block the incident save above, which
      // is the actual atomicity guarantee this screen exists to provide.
      const evidenceFailures: string[] = [];
      for (const item of staged) {
        try {
          await saveEvidenceLocally(saved.localId, item.attachment);
        } catch {
          evidenceFailures.push(item.attachment.type);
        }
      }
      if (evidenceFailures.length > 0) {
        console.error(`Failed to save ${evidenceFailures.length} evidence attachment(s) locally.`);
      }

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
            <SelectField
              label="Incident type"
              value={incidentType}
              onChange={setIncidentType}
              disabled={saving}
              options={INCIDENT_TYPES.map((type) => ({ value: type, label: TYPE_LABELS[type] }))}
            />
          </IonItem>
          <IonItem>
            <TextAreaField
              label="What happened?"
              value={narrative}
              onChange={setNarrative}
              disabled={saving}
            />
          </IonItem>
        </IonList>

        <div className="app-section">
          <IonButton
            fill="outline"
            onClick={handleAddPhoto}
            disabled={saving || capturing || recording}
          >
            <IonIcon slot="start" icon={cameraOutline} />
            {capturing && !recording ? <IonSpinner name="dots" /> : 'Add Photo'}
          </IonButton>
          <IonButton
            fill="outline"
            color={recording ? 'danger' : undefined}
            onClick={handleToggleVoice}
            disabled={saving || (capturing && !recording)}
          >
            <IonIcon slot="start" icon={recording ? stopCircleOutline : micOutline} />
            {recording ? 'Stop Recording' : 'Record Voice Note'}
          </IonButton>

          {captureError && (
            <IonNote className="app-error" role="alert">
              {captureError}
            </IonNote>
          )}

          {staged.length > 0 && (
            <IonList inset>
              {staged.map((item) => (
                <IonItem key={item.key}>
                  <IonLabel>
                    {item.attachment.type === 'photo' ? 'Photo' : 'Voice note'} —{' '}
                    {(item.attachment.byteSize / 1024).toFixed(0)} KB
                  </IonLabel>
                  <IonButton
                    fill="clear"
                    color="medium"
                    slot="end"
                    disabled={saving}
                    onClick={() => handleRemoveStaged(item.key)}
                    aria-label="Remove attachment"
                  >
                    <IonIcon icon={closeCircle} />
                  </IonButton>
                </IonItem>
              ))}
            </IonList>
          )}
          <IonNote className="app-note">
            Photos and voice notes are stored on this device only, the same as
            the incident text — they are not uploaded yet.
          </IonNote>
        </div>

        {error && (
          <IonNote className="app-error" role="alert">
            {error}
          </IonNote>
        )}

        <IonButton expand="block" onClick={handleSave} disabled={saving || recording}>
          {saving ? <IonSpinner name="dots" /> : 'Save to device'}
        </IonButton>

        <IonLabel>
          <IonNote className="app-note">
            Saved on this device first. Sending to the barangay workstation happens
            later — this screen never reports it as submitted.
          </IonNote>
        </IonLabel>
      </IonContent>
    </IonPage>
  );
};

export default NewIncidentPage;
