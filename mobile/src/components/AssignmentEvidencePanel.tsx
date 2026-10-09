/**
 * AssignmentEvidencePanel.tsx — photo / voice evidence for an incident the
 * Tanod is already ASSIGNED to (Gap-X2). Before this, evidence could only be
 * attached on the New Incident screen, before submit.
 *
 * Reuses, rather than duplicating, the existing pipeline:
 *   - capture: `evidenceCapture.ts` (capturePhoto / voice recording), the
 *     same functions New Incident calls;
 *   - durability (Rule 7): the capture is written to the encrypted local
 *     `evidence_attachment_local` table FIRST (`saveEvidenceLocally`), keyed by
 *     the dispatch's `local_id`; `syncService.ts`'s existing evidence step then
 *     uploads it (`POST /incidents/:id/evidence`, X-Device-Id + signature,
 *     client_request_id idempotency) as soon as there is a connection, and
 *     retries on its own after that. A row is shown as "Uploaded" only after
 *     the server answered 2xx (`synced = 1`).
 * Only filenames-free thumbnails/icons and sizes are shown — no narrative.
 */

import { useCallback, useEffect, useRef, useState } from 'react';
import { IonIcon, IonSpinner } from '@ionic/react';
import { Capacitor } from '@capacitor/core';
import { cameraOutline, micOutline, stopCircleOutline, refreshOutline } from 'ionicons/icons';
import {
  getEvidenceForIncident,
  resetFailedEvidence,
  saveEvidenceLocally,
} from '../services/db/evidenceRepository';
import type { EvidenceAttachmentLocalRow } from '../services/db/localSchema';
import {
  capturePhoto,
  deleteEvidenceFile,
  isRecordingVoice,
  MAX_EVIDENCE_BYTES,
  startVoiceRecording,
  stopVoiceRecording,
} from '../services/evidenceCapture';
import { forceSyncNow, subscribeSyncSummary } from '../services/syncScheduler';
import tacticalFeedback from '../utils/tacticalFeedback';

interface Props {
  /** `dispatch_local.local_id` of the assignment — the sync worker resolves the server incident id from it. */
  dispatchLocalId: string;
}

function stateOf(row: EvidenceAttachmentLocalRow): { label: string; pill: string } {
  if (row.synced === 1) return { label: 'Uploaded', pill: 'status-pill--success' };
  if (row.permanent_failure === 1) return { label: 'Upload failed', pill: 'status-pill--critical' };
  return { label: 'Needs a connection to upload', pill: 'status-pill--pending' };
}

const TOO_LARGE_TEXT =
  'That file is larger than 25 MB, which is too big to upload. Nothing was saved. Try a shorter note or another photo.';

/** Plain-language message for a capture failure; null = the Tanod just backed out (nothing to show). */
function captureErrorText(err: unknown, fallback: string): string | null {
  const message = err instanceof Error ? err.message : '';
  if (message === TOO_LARGE_TEXT) return message;
  if (/cancel/i.test(message)) return null;
  if (/permission|denied|not granted/i.test(message)) {
    return /microphone|audio|record/i.test(message) || /voice/i.test(fallback)
      ? 'Microphone access is off. Allow it in the phone Settings for this app, then try again.'
      : 'Camera access is off. Allow it in the phone Settings for this app, then try again.';
  }
  return fallback;
}

const AssignmentEvidencePanel: React.FC<Props> = ({ dispatchLocalId }) => {
  const [items, setItems] = useState<EvidenceAttachmentLocalRow[]>([]);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [capturing, setCapturing] = useState(false);
  const [recording, setRecording] = useState(() => isRecordingVoice());
  const [syncing, setSyncing] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // Guards: no state updates after unmount, and no double-fire while a capture is in flight
  // (React state updates are async, so `disabled` alone doesn't stop a fast double tap).
  const mountedRef = useRef(true);
  const busyRef = useRef(false);
  const dispatchIdRef = useRef(dispatchLocalId);
  dispatchIdRef.current = dispatchLocalId;

  const reload = useCallback(async () => {
    try {
      const rows = await getEvidenceForIncident(dispatchLocalId);
      if (!mountedRef.current) return;
      setItems(rows);
      setLoadError(null);
    } catch {
      if (mountedRef.current) setLoadError('Could not read the evidence saved on this phone.');
    }
  }, [dispatchLocalId]);

  useEffect(() => {
    mountedRef.current = true;
    void reload();
    const unsubscribe = subscribeSyncSummary(() => void reload());
    return () => {
      mountedRef.current = false;
      unsubscribe();
    };
  }, [reload]);

  // Leaving the screen mid-recording must not lose the note (Rule 7): stop it and save it
  // to the encrypted local table, then let the sync worker upload it later.
  useEffect(() => {
    return () => {
      if (!isRecordingVoice()) return;
      const targetId = dispatchIdRef.current;
      void (async () => {
        try {
          const staged = await stopVoiceRecording();
          if (staged.byteSize > MAX_EVIDENCE_BYTES) {
            await deleteEvidenceFile(staged.filePath);
            return;
          }
          await saveEvidenceLocally(targetId, staged);
          void forceSyncNow().catch(() => undefined);
        } catch {
          // Nothing recoverable to save.
        }
      })();
    };
  }, []);

  async function pushUploads() {
    if (mountedRef.current) setSyncing(true);
    try {
      await forceSyncNow();
    } catch {
      // Offline or workstation unreachable: rows stay "Needs a connection" and retry on their own.
    } finally {
      if (mountedRef.current) setSyncing(false);
      await reload();
    }
  }

  async function saveAndUpload(staged: Parameters<typeof saveEvidenceLocally>[1]) {
    if (staged.byteSize > MAX_EVIDENCE_BYTES) {
      // The server rejects > 25 MB, so saving it would only produce a permanent "Upload failed".
      await deleteEvidenceFile(staged.filePath);
      throw new Error(TOO_LARGE_TEXT);
    }
    await saveEvidenceLocally(dispatchLocalId, staged);
    await reload();
    void pushUploads();
  }

  async function handleAddPhoto() {
    if (busyRef.current) return;
    busyRef.current = true;
    setError(null);
    setCapturing(true);
    tacticalFeedback.onTap();
    try {
      await saveAndUpload(await capturePhoto());
    } catch (err) {
      const text = captureErrorText(err, 'Could not capture the photo.');
      if (text && mountedRef.current) setError(text);
    } finally {
      busyRef.current = false;
      if (mountedRef.current) setCapturing(false);
    }
  }

  async function handleToggleVoice() {
    if (busyRef.current) return;
    busyRef.current = true;
    setError(null);
    tacticalFeedback.onTap();
    try {
      if (isRecordingVoice()) {
        setCapturing(true);
        try {
          await saveAndUpload(await stopVoiceRecording());
        } catch (err) {
          const text = captureErrorText(err, 'Could not save the voice note.');
          if (text && mountedRef.current) setError(text);
        } finally {
          if (mountedRef.current) {
            setRecording(false);
            setCapturing(false);
          }
        }
        return;
      }
      try {
        await startVoiceRecording();
        if (mountedRef.current) setRecording(true);
      } catch (err) {
        const text = captureErrorText(err, 'Could not start the voice note.');
        if (text && mountedRef.current) setError(text);
      }
    } finally {
      busyRef.current = false;
    }
  }

  async function handleRetry() {
    tacticalFeedback.onTap();
    try {
      await resetFailedEvidence();
    } catch {
      if (mountedRef.current) setError('Could not reset the failed uploads. Please try again.');
      return;
    }
    await pushUploads();
  }

  const waiting = items.filter((i) => i.synced !== 1);
  const failed = items.some((i) => i.synced !== 1 && i.permanent_failure === 1);

  return (
    <div className="dispatch-on-scene-tools" data-testid="assignment-evidence-panel">
      <span className="dispatch-section-title">Evidence</span>

      <div className="intake-action-btn-row">
        <button
          type="button"
          className="intake-btn-touch"
          onClick={() => void handleAddPhoto()}
          disabled={capturing || recording}
          aria-label="Add photo evidence"
        >
          {capturing && !recording ? (
            <IonSpinner name="dots" style={{ width: '16px', height: '16px' }} />
          ) : (
            <IonIcon icon={cameraOutline} style={{ fontSize: '1.1rem' }} aria-hidden="true" />
          )}
          <span>Add Photo</span>
        </button>
        <button
          type="button"
          className={`intake-btn-touch ${recording ? 'intake-btn-touch--active' : ''}`}
          onClick={() => void handleToggleVoice()}
          disabled={capturing && !recording}
          aria-pressed={recording}
          aria-label={recording ? 'Stop recording and save voice note' : 'Record voice note'}
          style={recording ? { borderColor: 'var(--color-critical)', color: 'var(--color-critical)' } : undefined}
        >
          <IonIcon icon={recording ? stopCircleOutline : micOutline} style={{ fontSize: '1.1rem' }} aria-hidden="true" />
          <span>{recording ? 'Stop & Save' : 'Record Audio'}</span>
        </button>
      </div>

      {recording && (
        <div role="status" style={{ fontSize: '0.78rem', marginTop: 6, fontWeight: 600 }}>
          Recording voice note. Tap Stop &amp; Save when done.
        </div>
      )}

      {error && (
        <div role="alert" style={{ color: 'var(--pill-critical-text)', fontSize: '0.78rem', marginTop: 6 }}>
          {error}
        </div>
      )}
      {loadError && (
        <div role="alert" style={{ color: 'var(--pill-critical-text)', fontSize: '0.78rem', marginTop: 6 }}>
          {loadError}{' '}
          <button type="button" className="dispatch-secondary-cta" onClick={() => void reload()}>
            Retry
          </button>
        </div>
      )}

      {items.length === 0 && !loadError ? (
        <p style={{ fontSize: '0.78rem', color: 'var(--color-text-secondary)', margin: '8px 0 0' }}>
          No evidence attached from this phone yet. Photos and voice notes are saved on the phone first and upload
          when a connection is available.
        </p>
      ) : (
        <div className="media-grid" style={{ marginTop: 8 }}>
          {items.map((item) => {
            const st = stateOf(item);
            return (
              <div key={item.local_id} className="media-tile" title={st.label}>
                {item.type === 'photo' && item.file_path ? (
                  <img
                    src={Capacitor.convertFileSrc(item.file_path)}
                    alt="Evidence photo"
                    className="media-tile__img"
                    onError={(e) => {
                      (e.target as HTMLElement).style.display = 'none';
                    }}
                  />
                ) : (
                  <div className="media-tile__voice">
                    <IonIcon icon={item.type === 'photo' ? cameraOutline : micOutline} style={{ fontSize: '1.1rem' }} aria-label={item.type === 'photo' ? 'Photo' : 'Voice note'} />
                    <span className="media-tile__voice-size">{(item.byte_size / 1024).toFixed(0)} KB</span>
                  </div>
                )}
                <span className={`status-pill ${st.pill}`} style={{ position: 'absolute', left: 2, bottom: 2 }}>
                  {st.label}
                </span>
              </div>
            );
          })}
        </div>
      )}

      {waiting.length > 0 && (
        <button
          type="button"
          className="dispatch-secondary-cta"
          style={{ marginTop: 8 }}
          disabled={syncing}
          onClick={() => void (failed ? handleRetry() : pushUploads())}
        >
          {syncing ? <IonSpinner name="dots" /> : <IonIcon icon={refreshOutline} aria-hidden="true" />}
          <span>{failed ? 'Retry upload' : 'Upload now'}</span>
        </button>
      )}
    </div>
  );
};

export default AssignmentEvidencePanel;
