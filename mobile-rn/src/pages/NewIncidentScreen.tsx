/**
 * M3 Log New Incident. Port of ../mobile/src/pages/new-incident.tsx.
 *
 * Rule 2: the record is persisted to the encrypted local store BEFORE the
 * user can leave the capture flow — the Save button stays busy until the
 * transaction commits, and navigation to M4 only happens afterwards.
 * Nothing here touches the network; uploading is `syncService.ts`'s job.
 *
 * Photo/voice attachments are staged in component state while the form is
 * filled, then persisted to `evidence_attachment_local` only AFTER the
 * incident itself saves — an attachment can never exist locally without
 * its parent incident row.
 *
 * "Pick on Map" (the old app's `LocationPickerModal`, backed by
 * `LiveMapCanvas`) landed in Phase 5 as the `incidents/pick-location` modal
 * route, round-tripped via `locationPickerBridge.ts` — expo-router has no
 * built-in way to hand a value back from a pushed route.
 */
import { useEffect, useState } from 'react';
import { router } from 'expo-router';
import { ActivityIndicator, Image, Pressable, ScrollView, StyleSheet, Text, View } from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import MobileHeader from '../components/MobileHeader';
import { SelectField, TextAreaField } from '../components/FormFields';
import { useTheme } from '../theme/ThemeProvider';
import { INCIDENT_TYPES, saveIncidentLocally, type IncidentType } from '../services/db/incidentRepository';
import { saveEvidenceLocally } from '../services/db/evidenceRepository';
import { capturePhoto, useVoiceRecording, type StagedAttachment } from '../services/evidenceCapture';
import { getCurrentPosition } from '../services/geolocation';
import { requestLocationPick } from '../services/locationPickerBridge';
import { loadSession } from '../services/session';
import tacticalFeedback from '../utils/tacticalFeedback';

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

const POPULAR_TYPES: { type: IncidentType; label: string; icon: keyof typeof Ionicons.glyphMap }[] = [
  { type: 'disturbance', label: 'Disturbance', icon: 'alert-circle-outline' },
  { type: 'theft', label: 'Theft', icon: 'shield-checkmark-outline' },
  { type: 'physical_injury', label: 'Injury', icon: 'medkit-outline' },
  { type: 'traffic_incident', label: 'Traffic', icon: 'car-outline' },
  { type: 'medical_emergency', label: 'Medical', icon: 'medical-outline' },
  { type: 'fire', label: 'Fire', icon: 'flame-outline' },
];

interface StagedItem {
  key: string;
  attachment: StagedAttachment;
}

export default function NewIncidentScreen() {
  const { colors, tokens } = useTheme();
  const voiceRecording = useVoiceRecording();

  const [incidentType, setIncidentType] = useState<IncidentType>('theft');
  const [narrative, setNarrative] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const [staged, setStaged] = useState<StagedItem[]>([]);
  const [capturing, setCapturing] = useState(false);
  const [captureError, setCaptureError] = useState<string | null>(null);

  const [location, setLocation] = useState<{ latitude: number; longitude: number; accuracyM: number | null } | null>(null);
  const [acquiringGps, setAcquiringGps] = useState(false);
  const [locationError, setLocationError] = useState<string | null>(null);
  const [barangayId, setBarangayId] = useState<number | null>(null);
  const [reportedBy, setReportedBy] = useState<number | null>(null);

  useEffect(() => {
    void loadSession().then((session) => {
      if (session) {
        setBarangayId(session.barangayId);
        setReportedBy(session.userId);
      }
    });
  }, []);

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
    if (voiceRecording.isRecording) {
      setCapturing(true);
      try {
        const attachment = await voiceRecording.stop();
        setStaged((prev) => [...prev, { key: attachment.filePath, attachment }]);
      } catch (err) {
        setCaptureError(err instanceof Error ? err.message : 'Could not save the voice note.');
      } finally {
        setCapturing(false);
      }
      return;
    }
    try {
      await voiceRecording.start();
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
      setLocation({ latitude: fix.latitude, longitude: fix.longitude, accuracyM: fix.accuracyM });
    } catch {
      setLocationError('Could not read device location. Please ensure location permissions are enabled.');
    } finally {
      setAcquiringGps(false);
    }
  }

  async function handlePickOnMap() {
    setLocationError(null);
    const picked = await requestLocationPick(location ? { latitude: location.latitude, longitude: location.longitude } : null);
    if (picked) setLocation({ latitude: picked.latitude, longitude: picked.longitude, accuracyM: null });
  }

  function accuracyPill(accuracyM: number | null): { label: string; tone: 'success' | 'warning' | 'critical' } {
    if (accuracyM === null) return { label: 'Manually placed', tone: 'warning' };
    if (accuracyM < 10) return { label: `High accuracy (±${accuracyM.toFixed(0)}m)`, tone: 'success' };
    if (accuracyM <= 30) return { label: `Moderate accuracy (±${accuracyM.toFixed(0)}m)`, tone: 'warning' };
    return { label: `Poor accuracy (±${accuracyM.toFixed(0)}m)`, tone: 'critical' };
  }

  async function handleSave() {
    setError(null);
    if (!narrative.trim()) {
      setError('Please describe what happened before saving.');
      return;
    }

    setSaving(true);
    try {
      const saved = await saveIncidentLocally({
        barangayId: barangayId ?? 0,
        reportedBy,
        incidentType,
        rawNarrative: narrative,
        latitude: location?.latitude ?? null,
        longitude: location?.longitude ?? null,
      });

      for (const item of staged) {
        try {
          await saveEvidenceLocally(saved.localId, item.attachment);
        } catch {
          // Best-effort attachment save — the incident row itself is already safe.
        }
      }

      tacticalFeedback.onSuccess();
      router.replace(`/incidents/${encodeURIComponent(saved.localId)}/submitted`);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Could not save the incident locally.');
    } finally {
      setSaving(false);
    }
  }

  return (
    <View style={{ flex: 1, backgroundColor: colors.bg }}>
      <MobileHeader title="LOG INCIDENT" subtitle="Field Incident Intake" showBack />
      <ScrollView contentContainerStyle={styles.content} keyboardShouldPersistTaps="handled">
        {/* Classification */}
        <Section title="Incident Classification" trailing={TYPE_LABELS[incidentType]}>
          <View style={styles.chipGrid}>
            {POPULAR_TYPES.map(({ type, label, icon }) => {
              const selected = incidentType === type;
              return (
                <Pressable
                  key={type}
                  disabled={saving}
                  onPress={() => {
                    setIncidentType(type);
                    tacticalFeedback.onTap();
                  }}
                  style={[
                    styles.categoryChip,
                    {
                      borderRadius: tokens.radius.md,
                      borderColor: selected ? colors.primary : colors.border,
                      backgroundColor: selected ? colors.tintInfoBg : colors.surface,
                    },
                  ]}
                >
                  <Ionicons name={icon} size={20} color={selected ? colors.primary : colors.textSecondary} />
                  <Text style={{ color: selected ? colors.primary : colors.textSecondary, fontSize: 12, fontWeight: '600' }}>
                    {label}
                  </Text>
                </Pressable>
              );
            })}
          </View>
          <SelectField
            label="Or select from all categories"
            value={incidentType}
            onChange={setIncidentType}
            disabled={saving}
            options={INCIDENT_TYPES.map((type) => ({ value: type, label: TYPE_LABELS[type] }))}
          />
        </Section>

        {/* Narrative */}
        <Section title="Incident Narrative" trailing={`${narrative.length} characters`}>
          <TextAreaField
            label="Describe what happened (persons involved, time, location details)"
            value={narrative}
            onChange={setNarrative}
            rows={4}
            disabled={saving}
          />
        </Section>

        {/* Location */}
        <Section title="Incident Location (Optional)">
          {location ? (
            <View style={[styles.locationBadge, { borderRadius: tokens.radius.md, backgroundColor: colors.surfaceHover }]}>
              <View style={styles.locationRow}>
                <Ionicons name="location-outline" size={18} color={colors.primary} />
                <Text style={{ color: colors.textPrimary, fontSize: 13 }}>
                  {location.latitude.toFixed(5)}, {location.longitude.toFixed(5)}
                </Text>
              </View>
              <Pill {...accuracyPill(location.accuracyM)} />
              <Pressable disabled={saving} onPress={() => setLocation(null)}>
                <Text style={{ color: colors.critical, fontSize: 13 }}>Clear</Text>
              </Pressable>
            </View>
          ) : (
            <View style={styles.locationEmpty}>
              <Ionicons name="location-outline" size={18} color={colors.textTertiary} />
              <Text style={{ color: colors.textTertiary, fontSize: 13 }}>No coordinate tagged — report will save without location</Text>
            </View>
          )}

          <View style={styles.btnRow}>
            <ActionButton
              icon="locate-outline"
              label={acquiringGps ? undefined : 'Tag GPS Fix'}
              busy={acquiringGps}
              onPress={handleTagGps}
              disabled={saving}
            />
            <ActionButton icon="map-outline" label="Pick on Map" onPress={handlePickOnMap} disabled={saving} />
          </View>
          {locationError ? <ErrorBanner text={locationError} /> : null}
        </Section>

        {/* Evidence */}
        <Section title="Evidence Attachments" trailing={staged.length > 0 ? `${staged.length} ATTACHED` : undefined}>
          <View style={styles.btnRow}>
            <ActionButton
              icon="camera-outline"
              label={capturing && !voiceRecording.isRecording ? undefined : 'Photo Evidence'}
              busy={capturing && !voiceRecording.isRecording}
              onPress={handleAddPhoto}
              disabled={saving || capturing || voiceRecording.isRecording}
            />
            <ActionButton
              icon={voiceRecording.isRecording ? 'stop-circle-outline' : 'mic-outline'}
              label={voiceRecording.isRecording ? 'Stop Memo' : 'Voice Memo'}
              tone={voiceRecording.isRecording ? 'critical' : undefined}
              onPress={handleToggleVoice}
              disabled={saving || (capturing && !voiceRecording.isRecording)}
            />
          </View>

          {captureError ? <ErrorBanner text={captureError} /> : null}

          {staged.length > 0 ? (
            <View style={styles.mediaGrid}>
              {staged.map((item) => (
                <View key={item.key} style={[styles.mediaTile, { borderRadius: tokens.radius.sm, backgroundColor: colors.surfaceHover }]}>
                  {item.attachment.type === 'photo' ? (
                    <Image source={{ uri: item.attachment.filePath }} style={styles.mediaImg} />
                  ) : (
                    <View style={styles.mediaVoice}>
                      <Ionicons name="mic-outline" size={22} color={colors.textSecondary} />
                      <Text style={{ color: colors.textTertiary, fontSize: 11 }}>{(item.attachment.byteSize / 1024).toFixed(0)} KB</Text>
                    </View>
                  )}
                  <Pressable
                    disabled={saving}
                    onPress={() => handleRemoveStaged(item.key)}
                    style={[styles.mediaRemove, { backgroundColor: colors.critical }]}
                  >
                    <Ionicons name="close" size={12} color="#fff" />
                  </Pressable>
                </View>
              ))}
            </View>
          ) : null}
        </Section>

        {error ? <ErrorBanner text={error} big /> : null}
      </ScrollView>

      <View style={[styles.footer, { backgroundColor: colors.surface, borderTopColor: colors.border }]}>
        <Pressable
          onPress={handleSave}
          disabled={saving || voiceRecording.isRecording}
          style={[styles.saveBtn, { backgroundColor: colors.primary, opacity: saving || voiceRecording.isRecording ? 0.7 : 1 }]}
        >
          {saving ? <ActivityIndicator color="#fff" /> : <Text style={styles.saveBtnText}>Save Incident Report</Text>}
        </Pressable>
        <View style={styles.securityNote}>
          <Ionicons name="lock-closed-outline" size={12} color={colors.textTertiary} />
          <Text style={{ color: colors.textTertiary, fontSize: 11 }}>Encrypted SQLite · Local persistence guaranteed</Text>
        </View>
      </View>
    </View>
  );
}

function Section({ title, trailing, children }: { title: string; trailing?: string; children: React.ReactNode }) {
  const { colors } = useTheme();
  return (
    <View style={styles.section}>
      <View style={styles.sectionTitleRow}>
        <Text style={[styles.sectionTitle, { color: colors.textPrimary }]}>{title}</Text>
        {trailing ? <Text style={{ color: colors.primary, fontSize: 12, fontWeight: '600' }}>{trailing}</Text> : null}
      </View>
      {children}
    </View>
  );
}

function Pill({ label, tone }: { label: string; tone: 'success' | 'warning' | 'critical' }) {
  const { colors } = useTheme();
  const bg = { success: colors.tintSuccessBg, warning: colors.tintWarningBg, critical: colors.tintCriticalBg }[tone];
  const fg = { success: colors.pillSuccessText, warning: colors.pillWarningText, critical: colors.pillCriticalText }[tone];
  return (
    <View style={[styles.pill, { backgroundColor: bg }]}>
      <Text style={{ color: fg, fontSize: 11, fontWeight: '600' }}>{label}</Text>
    </View>
  );
}

function ActionButton({
  icon,
  label,
  busy,
  tone,
  onPress,
  disabled,
}: {
  icon: keyof typeof Ionicons.glyphMap;
  label?: string;
  busy?: boolean;
  tone?: 'critical';
  onPress: () => void;
  disabled?: boolean;
}) {
  const { colors, tokens } = useTheme();
  const solid = tone === 'critical';
  return (
    <Pressable
      onPress={onPress}
      disabled={disabled}
      style={[
        styles.actionBtn,
        {
          borderRadius: tokens.radius.sm,
          borderColor: solid ? colors.critical : colors.border,
          backgroundColor: solid ? colors.critical : colors.surface,
          opacity: disabled ? 0.5 : 1,
        },
      ]}
    >
      {busy ? (
        <ActivityIndicator size="small" color={colors.primary} />
      ) : (
        <>
          <Ionicons name={icon} size={16} color={solid ? '#fff' : colors.textPrimary} />
          <Text style={{ color: solid ? '#fff' : colors.textPrimary, fontSize: 13, fontWeight: '600' }}>{label}</Text>
        </>
      )}
    </Pressable>
  );
}

function ErrorBanner({ text, big }: { text: string; big?: boolean }) {
  const { colors, tokens } = useTheme();
  return (
    <View style={[styles.errorBanner, { backgroundColor: colors.tintCriticalBg, borderRadius: tokens.radius.sm, marginTop: big ? 0 : 8 }]}>
      <Text style={{ color: colors.pillCriticalText, fontSize: 13 }}>{text}</Text>
    </View>
  );
}

const styles = StyleSheet.create({
  content: { padding: 16, paddingBottom: 24, gap: 16 },
  section: { gap: 10 },
  sectionTitleRow: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center' },
  sectionTitle: { fontSize: 14, fontWeight: '700' },
  chipGrid: { flexDirection: 'row', flexWrap: 'wrap', gap: 8 },
  categoryChip: { width: '30%', borderWidth: 1, alignItems: 'center', paddingVertical: 12, gap: 4 },
  locationBadge: { flexDirection: 'row', alignItems: 'center', gap: 10, padding: 10, flexWrap: 'wrap' },
  locationRow: { flexDirection: 'row', alignItems: 'center', gap: 6 },
  locationEmpty: { flexDirection: 'row', alignItems: 'center', gap: 8, paddingVertical: 4 },
  pill: { paddingHorizontal: 8, paddingVertical: 3, borderRadius: 8 },
  btnRow: { flexDirection: 'row', gap: 8 },
  actionBtn: { flex: 1, flexDirection: 'row', alignItems: 'center', justifyContent: 'center', gap: 6, borderWidth: 1, paddingVertical: 12 },
  errorBanner: { padding: 10 },
  mediaGrid: { flexDirection: 'row', flexWrap: 'wrap', gap: 8, marginTop: 4 },
  mediaTile: { width: 76, height: 76, overflow: 'hidden' },
  mediaImg: { width: '100%', height: '100%' },
  mediaVoice: { flex: 1, alignItems: 'center', justifyContent: 'center', gap: 4 },
  mediaRemove: { position: 'absolute', top: 4, right: 4, width: 18, height: 18, borderRadius: 9, alignItems: 'center', justifyContent: 'center' },
  footer: { borderTopWidth: 1, padding: 14, gap: 8 },
  saveBtn: { borderRadius: 10, paddingVertical: 14, alignItems: 'center' },
  saveBtnText: { color: '#fff', fontWeight: '700', fontSize: 15 },
  securityNote: { flexDirection: 'row', alignItems: 'center', justifyContent: 'center', gap: 6 },
});
