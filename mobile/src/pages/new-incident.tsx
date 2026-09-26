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
  alertCircleOutline,
  cameraOutline,
  carOutline,
  closeOutline,
  flameOutline,
  locateOutline,
  locationOutline,
  lockClosedOutline,
  mapOutline,
  medicalOutline,
  medkitOutline,
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
import tacticalFeedback from '../utils/tacticalFeedback';

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

const POPULAR_TYPE_CONFIG: { type: IncidentType; label: string; icon: typeof alertCircleOutline }[] = [
  { type: 'disturbance', label: 'Disturbance', icon: alertCircleOutline },
  { type: 'theft', label: 'Theft', icon: shieldCheckmarkOutline },
  { type: 'physical_injury', label: 'Injury', icon: medkitOutline },
  { type: 'traffic_incident', label: 'Traffic', icon: carOutline },
  { type: 'medical_emergency', label: 'Medical', icon: medicalOutline },
  { type: 'fire', label: 'Fire', icon: flameOutline },
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

      tacticalFeedback.onSuccess();
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
      <MobileHeader title="LOG INCIDENT" subtitle="Field Incident Intake" showBack defaultBackHref="/tabs/home" />

      <IonContent className="ion-padding" style={{ '--background': 'var(--color-bg)' }}>
        <div className="app-column">
          <div className="intake-card">
            {/* Section 1: Classification */}
            <div className="intake-section">
              <div className="intake-section-title">
                <span>Incident Classification</span>
                <span style={{ fontSize: '0.75rem', fontWeight: 600, color: 'var(--color-primary)' }}>
                  {TYPE_LABELS[incidentType]}
                </span>
              </div>

              {/* Quick-select Category Grid */}
              <div className="intake-category-grid">
                {POPULAR_TYPE_CONFIG.map(({ type, label, icon }) => {
                  const isSelected = incidentType === type;
                  return (
                    <button
                      key={type}
                      type="button"
                      className={`intake-category-chip ${isSelected ? 'intake-category-chip--active' : ''}`}
                      onClick={() => {
                        setIncidentType(type);
                        tacticalFeedback.vibrate(15);
                      }}
                      disabled={saving}
                    >
                      <IonIcon icon={icon} className="intake-category-chip__icon" />
                      <span>{label}</span>
                    </button>
                  );
                })}
              </div>

              {/* Extended Dropdown for all incident types */}
              <SelectField
                label="Or select from all categories"
                value={incidentType}
                onChange={setIncidentType}
                disabled={saving}
                options={INCIDENT_TYPES.map((type) => ({ value: type, label: TYPE_LABELS[type] }))}
              />
            </div>

            {/* Section 2: Narrative */}
            <div className="intake-section">
              <div className="intake-section-title">
                <span>Incident Narrative</span>
                <span style={{ fontSize: '0.72rem', color: 'var(--color-text-tertiary)', fontWeight: 500 }}>
                  {narrative.length} characters
                </span>
              </div>

              <TextAreaField
                label="Describe what happened (persons involved, time, location details)"
                value={narrative}
                onChange={setNarrative}
                rows={4}
                disabled={saving}
              />
            </div>

            {/* Section 3: Smart Location Strip */}
            <div className="intake-section">
              <div className="intake-section-title">
                <span>Incident Location (Optional)</span>
              </div>

              <div className="intake-location-box">
                {location ? (
                  <div className="intake-location-badge">
                    <div className="intake-location-coords">
                      <IonIcon icon={locationOutline} style={{ color: 'var(--color-primary)', fontSize: '1.1rem' }} />
                      <span>{location.latitude.toFixed(5)}, {location.longitude.toFixed(5)}</span>
                      <span className={`status-pill ${accuracyPill(location.accuracyM).className}`}>
                        {accuracyPill(location.accuracyM).label}
                      </span>
                    </div>
                    <button
                      type="button"
                      className="intake-location-clear-btn"
                      onClick={handleClearLocation}
                      disabled={saving}
                    >
                      Clear
                    </button>
                  </div>
                ) : (
                  <div className="intake-location-empty">
                    <IonIcon icon={locationOutline} style={{ fontSize: '1.1rem' }} />
                    <span>No coordinate tagged — report will save without location</span>
                  </div>
                )}

                <div className="intake-btn-grid">
                  <IonButton
                    fill={location && location.accuracyM !== null ? 'solid' : 'outline'}
                    className="intake-btn-action"
                    onClick={handleTagGps}
                    disabled={saving || acquiringGps}
                  >
                    <IonIcon slot="start" icon={locateOutline} />
                    {acquiringGps ? <IonSpinner name="dots" /> : 'Tag GPS Fix'}
                  </IonButton>

                  <IonButton
                    fill={location && location.accuracyM === null ? 'solid' : 'outline'}
                    className="intake-btn-action"
                    onClick={handleOpenPicker}
                    disabled={saving}
                  >
                    <IonIcon slot="start" icon={mapOutline} />
                    Pick on Map
                  </IonButton>
                </div>

                {locationError && (
                  <div
                    style={{
                      marginTop: '8px',
                      background: 'var(--tint-critical-bg)',
                      border: '1px solid var(--color-critical)',
                      borderRadius: 'var(--radius-sm)',
                      padding: '6px 10px',
                      color: 'var(--pill-critical-text)',
                      fontSize: 'var(--font-size-label)',
                    }}
                    role="alert"
                  >
                    {locationError}
                  </div>
                )}
              </div>
            </div>

            {/* Section 4: Evidence Attachments */}
            <div className="intake-section">
              <div className="intake-section-title">
                <span>Evidence Attachments</span>
                {staged.length > 0 && (
                  <span className="status-pill status-pill--info">{staged.length} ATTACHED</span>
                )}
              </div>

              <div className="intake-media-bar">
                <IonButton
                  fill="outline"
                  className="intake-btn-action"
                  onClick={handleAddPhoto}
                  disabled={saving || capturing || recording}
                >
                  <IonIcon slot="start" icon={cameraOutline} />
                  {capturing && !recording ? <IonSpinner name="dots" /> : 'Photo Evidence'}
                </IonButton>

                <IonButton
                  fill={recording ? 'solid' : 'outline'}
                  color={recording ? 'danger' : 'primary'}
                  className="intake-btn-action"
                  onClick={handleToggleVoice}
                  disabled={saving || (capturing && !recording)}
                >
                  <IonIcon slot="start" icon={recording ? stopCircleOutline : micOutline} />
                  {recording ? 'Stop Memo' : 'Voice Memo'}
                </IonButton>
              </div>

              {recording && (
                <div className="intake-recording-chip">
                  <div className="intake-recording-chip__status">
                    <div className="recording-live-dot" />
                    <span>Recording voice note: {formatTimer(recordDuration)}</span>
                  </div>
                  <IonButton className="btn-touch-compact" color="danger" fill="solid" onClick={handleToggleVoice}>
                    Finish
                  </IonButton>
                </div>
              )}

              {captureError && (
                <div
                  style={{
                    marginTop: '8px',
                    background: 'var(--tint-critical-bg)',
                    border: '1px solid var(--color-critical)',
                    borderRadius: 'var(--radius-sm)',
                    padding: '6px 10px',
                    color: 'var(--pill-critical-text)',
                    fontSize: 'var(--font-size-label)',
                  }}
                  role="alert"
                >
                  {captureError}
                </div>
              )}

              {staged.length > 0 && (
                <div style={{ marginTop: '12px' }}>
                  <div className="media-grid">
                    {staged.map((item) => (
                      <div key={item.key} className="media-tile">
                        {item.attachment.type === 'photo' ? (
                          <img
                            src={Capacitor.convertFileSrc(item.attachment.filePath)}
                            alt="Captured evidence"
                            className="media-tile__img"
                            onError={(e) => {
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
          </div>

          {error && (
            <div
              style={{
                background: 'var(--tint-critical-bg)',
                border: '1px solid var(--color-critical)',
                borderRadius: 'var(--radius-md)',
                padding: '10px 14px',
                color: 'var(--pill-critical-text)',
                marginBottom: '12px',
                fontSize: 'var(--font-size-sm)',
              }}
              role="alert"
            >
              {error}
            </div>
          )}

          {/* Sticky Tactical Footer */}
          <div className="intake-sticky-footer">
            <IonButton
              expand="block"
              onClick={handleSave}
              disabled={saving || recording}
              style={{
                '--background': 'linear-gradient(135deg, var(--color-navy) 0%, var(--color-primary) 100%)',
                fontWeight: 700,
                height: '46px',
                boxShadow: 'var(--shadow-fab)',
                margin: 0,
              }}
            >
              {saving ? <IonSpinner name="dots" /> : 'Save Incident Report'}
            </IonButton>

            <div className="intake-security-note">
              <IonIcon icon={lockClosedOutline} />
              <span>Encrypted SQLite · Local persistence guaranteed</span>
            </div>
          </div>
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
