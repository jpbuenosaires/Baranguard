/**
 * new-incident.tsx — M3 Log New Incident (§9 Mobile).
 *
 * Flat intake form: type, location, narrative, then collapsed optional detail
 * (school link + C-1 notes, photos/audio). Saves on the phone first (Rule 7).
 * Sections live in components/home/*.
 */

import { useEffect, useRef, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { IonContent, IonIcon, IonPage } from '@ionic/react';
import {
  alertCircleOutline,
  carOutline,
  chevronDownOutline,
  chevronUpOutline,
  ellipsisHorizontalCircleOutline,
  flameOutline,
  hammerOutline,
  medicalOutline,
  medkitOutline,
  pawOutline,
  peopleOutline,
  personOutline,
  shieldCheckmarkOutline,
} from 'ionicons/icons';
import LocationPickerModal from '../components/LocationPickerModal';
import MobileHeader from '../components/MobileHeader';
import { Banner, Button } from '../components/ui';
import LocationSection from '../components/home/LocationSection';
import SchoolZoneSection from '../components/home/SchoolZoneSection';
import MediaDock from '../components/home/MediaDock';
import { useIncidentMedia } from '../components/home/useIncidentMedia';
import { saveIncidentLocally, type IncidentType } from '../services/db/incidentRepository';
import { saveEvidenceLocally } from '../services/db/evidenceRepository';
import { listCachedSchools } from '../services/db/schoolRepository';
import {
  clearIncidentDraft,
  isDraftEmpty,
  loadIncidentDraft,
  saveIncidentDraft,
  type IncidentDraft,
} from '../services/db/draftRepository';
import type { SchoolLocalRow } from '../services/db/localSchema';
import { refreshSchoolCache } from '../services/workflowRefresh';
import { getCurrentPosition, type DevicePosition } from '../services/geolocation';
import { loadSession } from '../services/session';
import tacticalFeedback from '../utils/tacticalFeedback';

const ALL_INCIDENT_TYPES: { type: IncidentType; label: string; icon: typeof alertCircleOutline }[] = [
  { type: 'disturbance', label: 'Disturbance', icon: alertCircleOutline },
  { type: 'theft', label: 'Theft', icon: shieldCheckmarkOutline },
  { type: 'physical_injury', label: 'Injury', icon: medkitOutline },
  { type: 'traffic_incident', label: 'Traffic', icon: carOutline },
  { type: 'medical_emergency', label: 'Medical', icon: medicalOutline },
  { type: 'fire', label: 'Fire', icon: flameOutline },
  { type: 'domestic_dispute', label: 'Domestic', icon: peopleOutline },
  { type: 'vandalism', label: 'Vandalism', icon: hammerOutline },
  { type: 'missing_person', label: 'Missing', icon: personOutline },
  { type: 'animal_complaint', label: 'Animal', icon: pawOutline },
  { type: 'other', label: 'Other', icon: ellipsisHorizontalCircleOutline },
];

const NARRATIVE_TEMPLATES = [
  'Public disturbance / noise complaint',
  'Theft / property loss reported',
  'Minor vehicular traffic accident',
  'Medical aid / ambulance requested',
  'Suspicious persons sighted',
];

const NewIncidentPage: React.FC = () => {
  const navigate = useNavigate();
  const [incidentType, setIncidentType] = useState<IncidentType | null>(null);
  const [narrative, setNarrative] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [narrativeError, setNarrativeError] = useState<string | null>(null);
  const [moreOpen, setMoreOpen] = useState(false);
  const [saving, setSaving] = useState(false);
  const {
    staged,
    setStaged,
    capturing,
    recording,
    recordDuration,
    captureError,
    handleAddPhoto,
    handleToggleVoice,
    handleRemoveStaged,
  } = useIncidentMedia();
  // Set when the incident row saved but an attachment didn't, so a retry
  // re-attaches to THAT incident instead of saving a duplicate report.
  const savedLocalIdRef = useRef<string | null>(null);

  // Location: real GPS fix or dropped pin
  const [location, setLocation] = useState<{ latitude: number; longitude: number; accuracyM: number | null } | null>(
    null
  );
  const [acquiringGps, setAcquiringGps] = useState(false);
  const [locationError, setLocationError] = useState<string | null>(null);
  const [pickerOpen, setPickerOpen] = useState(false);
  const [selfPosition, setSelfPosition] = useState<DevicePosition | null>(null);
  const [barangayId, setBarangayId] = useState<number | null>(null);

  // Safer School Zones: optional link to a cached school + the Annex C-1 notes.
  const [schools, setSchools] = useState<SchoolLocalRow[]>([]);
  const [schoolId, setSchoolId] = useState<string>('');
  const [c1Summary, setC1Summary] = useState('');
  const [c1ActionTaken, setC1ActionTaken] = useState('');
  const [c1StatusNotes, setC1StatusNotes] = useState('');

  // --- Draft autosave (schema v9). Not part of the draft: photos and voice notes. ---
  const [userId, setUserId] = useState<number | null>(null);
  const [draftReady, setDraftReady] = useState(false);
  const [draftRestored, setDraftRestored] = useState(false);
  const submittedRef = useRef(false);
  const latestDraftRef = useRef<IncidentDraft | null>(null);

  useEffect(() => {
    let cancelled = false;
    loadSession().then(async (session) => {
      if (cancelled) return;
      if (session) setBarangayId(session.barangayId);
      const uid = session?.userId ?? null;
      setUserId(uid);
      try {
        const draft = await loadIncidentDraft(uid);
        if (!cancelled && draft && !isDraftEmpty(draft)) {
          setIncidentType(ALL_INCIDENT_TYPES.find((t) => t.type === draft.incidentType)?.type ?? null);
          setNarrative(draft.narrative);
          if (draft.latitude !== null && draft.longitude !== null) {
            setLocation({ latitude: draft.latitude, longitude: draft.longitude, accuracyM: draft.accuracyM });
          }
          setSchoolId(draft.schoolId);
          setC1Summary(draft.c1Summary);
          setC1ActionTaken(draft.c1ActionTaken);
          setC1StatusNotes(draft.c1StatusNotes);
          if (draft.schoolId) setMoreOpen(true);
          setDraftRestored(true);
        }
      } catch {
        // Local store unavailable (web preview): the form simply starts blank.
      }
      if (!cancelled) setDraftReady(true);
    });
    return () => {
      cancelled = true;
    };
  }, []);

  useEffect(() => {
    if (!draftReady) return;
    const draft: IncidentDraft = {
      incidentType: incidentType ?? '',
      narrative,
      latitude: location?.latitude ?? null,
      longitude: location?.longitude ?? null,
      accuracyM: location?.accuracyM ?? null,
      schoolId,
      c1Summary,
      c1ActionTaken,
      c1StatusNotes,
    };
    latestDraftRef.current = draft;
    const timer = window.setTimeout(() => {
      if (!submittedRef.current) void saveIncidentDraft(userId, draft).catch(() => undefined);
    }, 800);
    return () => window.clearTimeout(timer);
  }, [draftReady, userId, incidentType, narrative, location, schoolId, c1Summary, c1ActionTaken, c1StatusNotes]);

  // Flush immediately when the page is hidden or the form unmounts.
  useEffect(() => {
    function flush() {
      const draft = latestDraftRef.current;
      if (draft && !submittedRef.current) void saveIncidentDraft(userId, draft).catch(() => undefined);
    }
    document.addEventListener('visibilitychange', flush);
    window.addEventListener('pagehide', flush);
    return () => {
      document.removeEventListener('visibilitychange', flush);
      window.removeEventListener('pagehide', flush);
      flush();
    };
  }, [userId]);

  function handleDiscardDraft() {
    tacticalFeedback.onTap();
    submittedRef.current = true; // stop pending autosaves until the form changes again
    void clearIncidentDraft(userId).catch(() => undefined);
    setIncidentType(null);
    setNarrative('');
    setLocation(null);
    setSchoolId('');
    setC1Summary('');
    setC1ActionTaken('');
    setC1StatusNotes('');
    setDraftRestored(false);
    latestDraftRef.current = null;
    submittedRef.current = false;
  }

  // The picker reads the local cache (works offline). If it has never been
  // filled, try one best-effort fetch — never blocks the form.
  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        let cached = await listCachedSchools();
        if (cached.length === 0 && (await refreshSchoolCache({ force: true }))) {
          cached = await listCachedSchools();
        }
        if (!cancelled) setSchools(cached);
      } catch {
        // Local store unavailable (web preview) — the school block simply stays empty.
      }
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  // Best-effort location on open: a dispatcher needs a pin, but the form never waits for it.
  useEffect(() => {
    let cancelled = false;
    getCurrentPosition({ maximumAge: 30000, timeout: 8000 }).then(
      (fix) => {
        if (cancelled) return;
        setSelfPosition(fix);
        setLocation((current) => current ?? { latitude: fix.latitude, longitude: fix.longitude, accuracyM: fix.accuracyM });
      },
      () => undefined
    );
    return () => {
      cancelled = true;
    };
  }, []);

  async function handleTagGps() {
    setLocationError(null);
    setAcquiringGps(true);
    tacticalFeedback.onTap();
    try {
      const fix = await getCurrentPosition();
      setSelfPosition(fix);
      setLocation({ latitude: fix.latitude, longitude: fix.longitude, accuracyM: fix.accuracyM });
      tacticalFeedback.vibrate([30, 40, 30]);
    } catch {
      setLocationError('Could not get your GPS location. Please check location permissions.');
    } finally {
      setAcquiringGps(false);
    }
  }

  async function handleOpenPicker() {
    tacticalFeedback.onTap();
    if (!selfPosition) {
      try {
        setSelfPosition(await getCurrentPosition());
      } catch {
        // Non-fatal
      }
    }
    setPickerOpen(true);
  }

  function handlePickerConfirm(point: { latitude: number; longitude: number }) {
    setLocation({ latitude: point.latitude, longitude: point.longitude, accuracyM: null });
    setPickerOpen(false);
    tacticalFeedback.onTap();
  }

  function handleClearLocation() {
    tacticalFeedback.onTap();
    setLocation(null);
    setLocationError(null);
  }

  async function handleSave() {
    setError(null);
    if (!incidentType) {
      setError('Choose the incident type before submitting.');
      document.getElementById('intake-type-grid')?.scrollIntoView({ block: 'center' });
      return;
    }
    if (!narrative.trim()) {
      setNarrativeError('Please describe what happened before submitting.');
      document.getElementById('narrative-error')?.scrollIntoView({ block: 'center' });
      return;
    }

    setSaving(true);
    tacticalFeedback.onTap();
    try {
      const session = await loadSession();
      const saved = savedLocalIdRef.current
        ? { localId: savedLocalIdRef.current }
        : await saveIncidentLocally({
            barangayId: session?.barangayId ?? 0,
            reportedBy: session?.userId ?? null,
            incidentType,
            rawNarrative: narrative.trim(),
            latitude: location?.latitude ?? null,
            longitude: location?.longitude ?? null,
            // C-1 notes only travel with a school link (they describe a school incident).
            schoolId: schoolId ? Number(schoolId) : null,
            c1Summary: schoolId ? c1Summary : null,
            c1ActionTaken: schoolId ? c1ActionTaken : null,
            c1StatusNotes: schoolId ? c1StatusNotes : null,
          });

      // The report itself is already durably saved above, so a failed
      // attachment save must not discard it — but it also must not be
      // swallowed: the Tanod believes the photo/voice note is attached, and
      // leaving would make that false. Stay on the form, say exactly how many
      // failed, and let them re-capture instead of silently losing evidence.
      const failedAttachments: typeof staged = [];
      for (const item of staged) {
        try {
          await saveEvidenceLocally(saved.localId, item.attachment);
        } catch {
          failedAttachments.push(item);
        }
      }

      if (failedAttachments.length > 0) {
        savedLocalIdRef.current = saved.localId;
        setError(
          `Report saved on this phone, will send when online. But ${failedAttachments.length} of ${staged.length} attachment${
            staged.length === 1 ? '' : 's'
          } could not be saved on this device. Tap Submit again to retry the attachment${
            failedAttachments.length === 1 ? '' : 's'
          }, or remove ${failedAttachments.length === 1 ? 'it' : 'them'} to continue without.`
        );
        setStaged(failedAttachments);
        return;
      }

      submittedRef.current = true;
      await clearIncidentDraft(userId).catch(() => undefined);
      tacticalFeedback.onSuccess();
      navigate(`/incidents/${encodeURIComponent(saved.localId)}/submitted`, { replace: true });
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Could not save report locally.');
    } finally {
      setSaving(false);
    }
  }

  return (
    <IonPage>
      <MobileHeader
        title="Report Incident"
        showBack
        defaultBackHref="/tabs/home"
      />

      <IonContent className="h4-content">
        <div className="intake-overhaul-container">
          {draftRestored && (
            <div className="draft-note" role="status">
              <span>Draft restored</span>
              <button type="button" className="draft-note__btn" onClick={handleDiscardDraft} disabled={saving}>
                Discard draft
              </button>
            </div>
          )}
          {/* Section 1: Incident Classification */}
          <div className="intake-block">
            <div className="intake-block-header">
              <span className="intake-block-title">
                <IonIcon icon={shieldCheckmarkOutline} />
                Incident Type (required)
              </span>
            </div>

            <div id="intake-type-grid" className="intake-grid-overhaul" role="radiogroup" aria-required="true" aria-label="Incident Type">
              {ALL_INCIDENT_TYPES.map(({ type, label, icon }) => {
                const isSelected = incidentType === type;
                return (
                  <button
                    key={type}
                    type="button"
                    role="radio"
                    aria-checked={isSelected}
                    className={`intake-tile-chip ${isSelected ? 'intake-tile-chip--active' : ''}`}
                    onClick={() => {
                      setIncidentType(type);
                      tacticalFeedback.vibrate(15);
                    }}
                    disabled={saving}
                  >
                    <IonIcon icon={icon} className="intake-tile-chip__icon" aria-hidden="true" />
                    <span>{label}</span>
                  </button>
                );
              })}
            </div>
          </div>

          <LocationSection
            location={location}
            locationError={locationError}
            saving={saving}
            acquiringGps={acquiringGps}
            onClear={handleClearLocation}
            onTagGps={handleTagGps}
            onOpenPicker={handleOpenPicker}
          />

          {/* Section 2: Narrative Description & Field Templates */}
          <div className="intake-block">
            <div className="intake-block-header">
              <span className="intake-block-title">What Happened <span className="h4-required">(required)</span></span>
              <span className="intake-char-count">
                {narrative.length} chars
              </span>
            </div>

            <textarea
              className="intake-textarea-box"
              rows={4}
              placeholder="Describe what happened (people involved, exact location, what you did)…"
              value={narrative}
              onChange={(e) => {
                setNarrative(e.target.value);
                if (narrativeError) setNarrativeError(null);
              }}
              disabled={saving}
              aria-label="Incident narrative description (required)"
              aria-required="true"
              aria-invalid={narrativeError ? 'true' : undefined}
              aria-describedby={narrativeError ? 'narrative-error' : undefined}
            />
            {narrativeError && (
              <div id="narrative-error" role="alert" className="text-field-error">
                {narrativeError}
              </div>
            )}

            {/* Quick 1-Tap Field Template Chips */}
            <div className="intake-template-strip" aria-label="Quick narrative templates">
              {NARRATIVE_TEMPLATES.map((tpl) => (
                <button
                  key={tpl}
                  type="button"
                  className="intake-template-chip"
                  onClick={() => {
                    tacticalFeedback.vibrate(15);
                    setNarrative((prev) => (prev ? `${prev}. ${tpl}` : tpl));
                  }}
                  disabled={saving}
                >
                  + {tpl}
                </button>
              ))}
            </div>
          </div>

          {/* Optional detail, collapsed: school link + C-1 notes, photos and audio. */}
          <div className="intake-block h4-more">
            <button
              type="button"
              className="h4-more__toggle"
              aria-expanded={moreOpen}
              aria-controls="h4-more-body"
              onClick={() => {
                tacticalFeedback.onTap();
                setMoreOpen((v) => !v);
              }}
            >
              <span>More details (optional)</span>
              {(staged.length > 0 || schoolId) && (
                <span className="status-pill status-pill--info">
                  {[schoolId ? 'School' : '', staged.length > 0 ? `${staged.length} attached` : ''].filter(Boolean).join(' + ')}
                </span>
              )}
              <IonIcon icon={moreOpen ? chevronUpOutline : chevronDownOutline} aria-hidden="true" />
            </button>
            {moreOpen && (
              <div id="h4-more-body" className="h4-more__body">
              <SchoolZoneSection
                schools={schools}
                schoolId={schoolId}
                c1Summary={c1Summary}
                c1ActionTaken={c1ActionTaken}
                c1StatusNotes={c1StatusNotes}
                saving={saving}
                onSchoolChange={setSchoolId}
                onC1SummaryChange={setC1Summary}
                onC1ActionChange={setC1ActionTaken}
                onC1StatusChange={setC1StatusNotes}
              />

              <MediaDock
                staged={staged}
                saving={saving}
                capturing={capturing}
                recording={recording}
                recordDuration={recordDuration}
                captureError={captureError}
                onAddPhoto={handleAddPhoto}
                onToggleVoice={handleToggleVoice}
                onRemove={handleRemoveStaged}
              />

              </div>
            )}
          </div>

          {/* Error Banner */}
          {error && (
            <Banner tone="error" role="alert">
              {error}
            </Banner>
          )}

          {/* Submit: saves on this phone first (Rule 7), sends when online. */}
          <div className="dispatch-action-dock h4-submit">
            <Button
              variant="primary"
              size="lg"
              fullWidth
              icon={shieldCheckmarkOutline}
              loading={saving}
              disabled={recording}
              onClick={handleSave}
            >
              {saving ? 'Saving on this phone…' : 'Submit report'}
            </Button>
            <p className="h4-submit__hint">
              {recording ? 'Stop the audio recording to submit.' : 'Saved on this phone, will send when online.'}
            </p>
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
