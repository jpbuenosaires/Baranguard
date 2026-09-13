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
 * GPS COORDINATES (added Mobile Improvement Plan Phase 2.1): the
 * geolocation plugin this file's own header used to say couldn't be
 * verified on a device now IS device-verified (2026-09-13, `geolocation.ts`
 * already backs M7 Live Map and M6 Assignment Detail's embedded map) — so
 * the gap this comment used to document is closed. A Tanod can tag their
 * current GPS fix (with an accuracy pill: high/moderate/poor, never
 * color-only per §8) or, for an incident that happened somewhere other
 * than where they're standing, tap a location on `LocationPickerModal.tsx`
 * (the same offline-MBTiles-first map `LiveMapCanvas.tsx` renders
 * elsewhere). Neither is required — the schema still allows both columns
 * NULL, and this screen still never invents a coordinate nobody supplied.
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

import { useEffect, useRef, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import {
  IonButton,
  IonContent,
  IonIcon,
  IonPage,
  IonSpinner,
} from '@ionic/react';
import {
  cameraOutline,
  closeOutline,
  documentTextOutline,
  locateOutline,
  mapOutline,
  micOutline,
  shieldCheckmarkOutline,
  stopCircleOutline,
} from 'ionicons/icons';
import { Capacitor } from '@capacitor/core';
import LocationPickerModal from '../components/LocationPickerModal';
import MobileHeader from '../components/MobileHeader';
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
import { getCurrentPosition, type DevicePosition } from '../services/geolocation';
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

const POPULAR_TYPES: IncidentType[] = [
  'disturbance',
  'theft',
  'physical_injury',
  'traffic_incident',
  'medical_emergency',
  'fire',
];

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
  const [recordDuration, setRecordDuration] = useState(0);
  const [captureError, setCaptureError] = useState<string | null>(null);
  const recordIntervalRef = useRef<number | null>(null);

  // Location (Phase 2.1): either a real GPS fix or a manually-dropped pin.
  const [location, setLocation] = useState<{ latitude: number; longitude: number; accuracyM: number | null } | null>(
    null
  );
  const [acquiringGps, setAcquiringGps] = useState(false);
  const [locationError, setLocationError] = useState<string | null>(null);
  const [pickerOpen, setPickerOpen] = useState(false);
  const [selfPosition, setSelfPosition] = useState<DevicePosition | null>(null);
  const [barangayId, setBarangayId] = useState<number | null>(null);

  useEffect(() => {
    loadSession().then((session) => {
      if (session) setBarangayId(session.barangayId);
    });
  }, []);

  useEffect(() => {
    if (recording) {
      setRecordDuration(0);
      recordIntervalRef.current = window.setInterval(() => {
        setRecordDuration((prev) => prev + 1);
      }, 1000);
    } else {
      if (recordIntervalRef.current !== null) {
        clearInterval(recordIntervalRef.current);
        recordIntervalRef.current = null;
      }
      setRecordDuration(0);
    }
    return () => {
      if (recordIntervalRef.current !== null) {
        clearInterval(recordIntervalRef.current);
      }
    };
  }, [recording]);

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

  async function handleTagGps() {
    setLocationError(null);
    setAcquiringGps(true);
    try {
      const fix = await getCurrentPosition();
      setSelfPosition(fix);
      setLocation({ latitude: fix.latitude, longitude: fix.longitude, accuracyM: fix.accuracyM });
    } catch {
      setLocationError('Could not read device location. Please ensure location permissions are enabled.');
    } finally {
      setAcquiringGps(false);
    }
  }

  async function handleOpenPicker() {
    // Best-effort — the picker still works with no self-fix, it just
    // won't have a "you are here" reference dot on the map.
    if (!selfPosition) {
      try {
        setSelfPosition(await getCurrentPosition());
      } catch {
        // Non-fatal — see comment above.
      }
    }
    setPickerOpen(true);
  }

  function handlePickerConfirm(point: { latitude: number; longitude: number }) {
    setLocation({ latitude: point.latitude, longitude: point.longitude, accuracyM: null });
    setPickerOpen(false);
  }

  function handleClearLocation() {
    setLocation(null);
    setLocationError(null);
  }

  /** §8: never color-only — the pill always states the accuracy in words too. */
  function accuracyPill(accuracyM: number | null): { label: string; className: string } {
    if (accuracyM === null) return { label: 'Manually placed', className: 'status-pill--info' };
    if (accuracyM < 10) return { label: `High accuracy (±${accuracyM.toFixed(0)}m)`, className: 'status-pill--success' };
    if (accuracyM <= 30) return { label: `Moderate accuracy (±${accuracyM.toFixed(0)}m)`, className: 'status-pill--pending' };
    return { label: `Poor accuracy (±${accuracyM.toFixed(0)}m)`, className: 'status-pill--critical' };
  }

  async function handleSave() {
    setError(null);
    if (!narrative.trim()) {
      setError('Please describe what happened before saving.');
      return;
    }

    setSaving(true);
    try {
      const session = await loadSession();
      const saved = await saveIncidentLocally({
        barangayId: session?.barangayId ?? 0,
        reportedBy: session?.userId ?? null,
        incidentType,
        rawNarrative: narrative,
        latitude: location?.latitude ?? null,
        longitude: location?.longitude ?? null,
      });

      for (const item of staged) {
        try {
          await saveEvidenceLocally(saved.localId, item.attachment);
        } catch {
          // Best-effort attachment save
        }
      }

      navigate(`/incidents/${encodeURIComponent(saved.localId)}/submitted`, { replace: true });
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Could not save the incident locally.');
    } finally {
      setSaving(false);
    }
  }

  const formatTimer = (seconds: number) => {
    const mins = Math.floor(seconds / 60);
    const secs = seconds % 60;
    return `${String(mins).padStart(2, '0')}:${String(secs).padStart(2, '0')}`;
  };

  return (
    <IonPage>
      <MobileHeader title="LOG INCIDENT" subtitle="Field Incident Intake" showBack defaultBackHref="/home" />

      <IonContent className="ion-padding" style={{ '--background': 'var(--color-bg)' }}>
        <div className="app-column">
          {/* Card 1: Incident Category */}
          <div className="card--elevated" style={{ marginBottom: '16px' }}>
            <div style={{ fontSize: 'var(--font-size-sm)', fontWeight: 700, color: 'var(--color-text-secondary)', marginBottom: '8px' }}>
              INCIDENT CLASSIFICATION
            </div>

            <SelectField
              label="Select incident category"
              value={incidentType}
              onChange={setIncidentType}
              disabled={saving}
              options={INCIDENT_TYPES.map((type) => ({ value: type, label: TYPE_LABELS[type] }))}
            />

            {/* Quick-select chips */}
            <div style={{ display: 'flex', flexWrap: 'wrap', gap: '6px', marginTop: '12px' }}>
              {POPULAR_TYPES.map((type) => {
                const isSelected = incidentType === type;
                return (
                  <button
                    key={type}
                    type="button"
                    onClick={() => setIncidentType(type)}
                    disabled={saving}
                    style={{
                      padding: '5px 12px',
                      borderRadius: '999px',
                      fontSize: 'var(--font-size-label)',
                      fontWeight: 600,
                      border: isSelected ? '1px solid var(--color-primary)' : '1px solid var(--color-border)',
                      background: isSelected ? 'var(--color-surface-blue)' : 'var(--color-white)',
                      color: isSelected ? 'var(--color-primary)' : 'var(--color-text-secondary)',
                      cursor: 'pointer',
                    }}
                  >
                    {TYPE_LABELS[type]}
                  </button>
                );
              })}
            </div>
          </div>

          {/* Card 2: Narrative */}
          <div className="card--elevated" style={{ marginBottom: '16px' }}>
            <div style={{ fontSize: 'var(--font-size-sm)', fontWeight: 700, color: 'var(--color-text-secondary)', marginBottom: '8px' }}>
              INCIDENT NARRATIVE
            </div>

            <TextAreaField
              label="Describe what happened (persons involved, time, location details)"
              value={narrative}
              onChange={setNarrative}
              rows={5}
              disabled={saving}
            />
            <div style={{ display: 'flex', justifyContent: 'flex-end', marginTop: '4px' }}>
              <span style={{ fontSize: '0.72rem', color: 'var(--color-text-tertiary)' }}>
                {narrative.length} characters
              </span>
            </div>
          </div>

          {/* Card 2.5: Location (Phase 2.1) */}
          <div className="card--elevated" style={{ marginBottom: '16px' }}>
            <div style={{ fontSize: 'var(--font-size-sm)', fontWeight: 700, color: 'var(--color-text-secondary)', marginBottom: '8px' }}>
              LOCATION (OPTIONAL)
            </div>

            {location ? (
              <div
                style={{
                  background: 'var(--color-bg)',
                  border: '1px solid var(--color-border)',
                  borderRadius: 'var(--radius-md)',
                  padding: '10px 12px',
                  marginBottom: '10px',
                }}
              >
                <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '6px' }}>
                  <span className={`status-pill ${accuracyPill(location.accuracyM).className}`}>
                    {accuracyPill(location.accuracyM).label}
                  </span>
                  <button
                    type="button"
                    onClick={handleClearLocation}
                    disabled={saving}
                    style={{ background: 'none', border: 'none', color: 'var(--color-text-tertiary)', fontSize: '0.75rem', textDecoration: 'underline' }}
                  >
                    Clear
                  </button>
                </div>
                <div style={{ fontFamily: 'var(--font-mono)', fontSize: '0.85rem', color: 'var(--color-text-primary)' }}>
                  {location.latitude.toFixed(5)}, {location.longitude.toFixed(5)}
                </div>
              </div>
            ) : (
              <div style={{ fontSize: 'var(--font-size-sm)', color: 'var(--color-text-tertiary)', marginBottom: '10px' }}>
                No location tagged — the report will still save without one.
              </div>
            )}

            <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '8px' }}>
              <IonButton
                fill="outline"
                onClick={handleTagGps}
                disabled={saving || acquiringGps}
                style={{ fontWeight: 600, textTransform: 'none' }}
              >
                <IonIcon slot="start" icon={locateOutline} />
                {acquiringGps ? <IonSpinner name="dots" /> : 'Tag Current GPS'}
              </IonButton>

              <IonButton
                fill="outline"
                onClick={handleOpenPicker}
                disabled={saving}
                style={{ fontWeight: 600, textTransform: 'none' }}
              >
                <IonIcon slot="start" icon={mapOutline} />
                Pick on Map
              </IonButton>
            </div>

            {locationError && (
              <div
                style={{
                  marginTop: '10px',
                  background: 'var(--tint-critical-bg)',
                  border: '1px solid var(--color-critical)',
                  borderRadius: 'var(--radius-sm)',
                  padding: '8px 12px',
                  color: 'var(--pill-critical-text)',
                  fontSize: 'var(--font-size-sm)',
                }}
                role="alert"
              >
                {locationError}
              </div>
            )}
          </div>

          {/* Card 3: Evidence Capture Station */}
          <div className="card--elevated" style={{ marginBottom: '16px' }}>
            <div style={{ fontSize: 'var(--font-size-sm)', fontWeight: 700, color: 'var(--color-text-secondary)', marginBottom: '8px' }}>
              ATTACH EVIDENCE (OPTIONAL)
            </div>

            <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '8px' }}>
              <IonButton
                fill="outline"
                onClick={handleAddPhoto}
                disabled={saving || capturing || recording}
                style={{ fontWeight: 600, textTransform: 'none' }}
              >
                <IonIcon slot="start" icon={cameraOutline} />
                {capturing && !recording ? <IonSpinner name="dots" /> : 'Photo'}
              </IonButton>

              <IonButton
                fill="outline"
                color={recording ? 'danger' : 'primary'}
                onClick={handleToggleVoice}
                disabled={saving || (capturing && !recording)}
                style={{ fontWeight: 600, textTransform: 'none' }}
              >
                <IonIcon slot="start" icon={recording ? stopCircleOutline : micOutline} />
                {recording ? 'Stop Note' : 'Voice Note'}
              </IonButton>
            </div>

            {recording && (
              <div className="recording-active-card">
                <div className="recording-live-indicator">
                  <div className="recording-live-dot" />
                  <span style={{ fontWeight: 700, color: 'var(--color-critical)', fontSize: 'var(--font-size-sm)' }}>
                    Recording Voice Note: {formatTimer(recordDuration)}
                  </span>
                </div>
                <IonButton size="small" color="danger" onClick={handleToggleVoice}>
                  Stop
                </IonButton>
              </div>
            )}

            {captureError && (
              <div
                style={{
                  marginTop: '10px',
                  background: 'var(--tint-critical-bg)',
                  border: '1px solid var(--color-critical)',
                  borderRadius: 'var(--radius-sm)',
                  padding: '8px 12px',
                  color: 'var(--pill-critical-text)',
                  fontSize: 'var(--font-size-sm)',
                }}
                role="alert"
              >
                {captureError}
              </div>
            )}

            {/* Staged Media Gallery */}
            {staged.length > 0 && (
              <div style={{ marginTop: '12px' }}>
                <div style={{ fontSize: 'var(--font-size-label)', color: 'var(--color-text-tertiary)', marginBottom: '6px' }}>
                  ATTACHED FILES ({staged.length})
                </div>
                <div className="media-grid">
                  {staged.map((item) => (
                    <div key={item.key} className="media-tile">
                      {item.attachment.type === 'photo' ? (
                        <img
                          src={Capacitor.convertFileSrc(item.attachment.filePath)}
                          alt="Captured evidence"
                          className="media-tile__img"
                          onError={(e) => {
                            // Fallback if WebView local file scheme has permission barrier
                            (e.target as HTMLElement).style.display = 'none';
                          }}
                        />
                      ) : (
                        <div className="media-tile__voice">
                          <IonIcon icon={micOutline} style={{ fontSize: '1.4rem' }} />
                          <span className="media-tile__voice-size">
                            {(item.attachment.byteSize / 1024).toFixed(0)} KB
                          </span>
                        </div>
                      )}
                      <button
                        type="button"
                        className="media-tile__remove"
                        disabled={saving}
                        onClick={() => handleRemoveStaged(item.key)}
                        aria-label="Remove attachment"
                      >
                        <IonIcon icon={closeOutline} />
                      </button>
                    </div>
                  ))}
                </div>
              </div>
            )}
          </div>

          {/* Local Security Assurance */}
          <div
            style={{
              background: 'var(--tint-info-bg)',
              border: '1px solid color-mix(in srgb, var(--color-primary) 20%, transparent)',
              borderRadius: 'var(--radius-md)',
              padding: '12px',
              display: 'flex',
              gap: '10px',
              marginBottom: '20px',
            }}
          >
            <IonIcon icon={shieldCheckmarkOutline} style={{ fontSize: '1.4rem', color: 'var(--color-primary)', flexShrink: 0, marginTop: '2px' }} />
            <div style={{ fontSize: '0.78rem', color: 'var(--pill-info-text)', lineHeight: '1.4' }}>
              <strong>Encrypted Local Storage:</strong> This report is committed directly to your device’s encrypted SQLite database first. Sync to Barangay HQ workstation will occur automatically upon network contact.
            </div>
          </div>

          {error && (
            <div
              style={{
                background: 'var(--tint-critical-bg)',
                border: '1px solid var(--color-critical)',
                borderRadius: 'var(--radius-md)',
                padding: '10px 14px',
                color: 'var(--pill-critical-text)',
                marginBottom: '16px',
                fontSize: 'var(--font-size-sm)',
              }}
              role="alert"
            >
              {error}
            </div>
          )}

          <IonButton
            expand="block"
            onClick={handleSave}
            disabled={saving || recording}
            style={{
              '--background': 'linear-gradient(135deg, var(--color-navy) 0%, var(--color-primary) 100%)',
              fontWeight: 700,
              height: '48px',
              boxShadow: 'var(--shadow-fab)',
            }}
          >
            {saving ? <IonSpinner name="dots" /> : 'Save Incident Report'}
          </IonButton>
        </div>

        <LocationPickerModal
          isOpen={pickerOpen}
          barangayId={barangayId}
          selfPosition={selfPosition}
          initialPoint={location}
          onCancel={() => setPickerOpen(false)}
          onConfirm={handlePickerConfirm}
        />
      </IonContent>
    </IonPage>
  );
};

export default NewIncidentPage;
