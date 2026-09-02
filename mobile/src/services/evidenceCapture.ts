/**
 * evidenceCapture.ts — the native-plugin edge for M3's photo/voice
 * attachment capture (§9 M3: "Voice/photo files use app-private
 * storage").
 *
 * Deliberately mirrors `localDatabase.ts`'s split: this file is the thin
 * platform edge (Capacitor Camera / Filesystem / voice-recorder plugin
 * calls), while `evidenceRepository.ts` owns the SQLite write. Nothing
 * here has ever executed on a device — same NOT DEVICE-VERIFIED caveat as
 * the rest of this local-storage layer (no Android SDK in this
 * environment; see DEVLOG.md). Built and type-checked against each
 * plugin's documented contract, not assumed to work.
 *
 * Every captured file lands under `Directory.Data` (§5/§9: app-private,
 * deleted on uninstall — never the public Documents/gallery directory),
 * and every result carries the SHA-256 of the actual bytes on disk, not a
 * value trusted from the plugin — the same "verify, don't assume"
 * discipline `evidenceRepository.ts`'s eventual upload path will depend
 * on.
 */

import { Camera } from '@capacitor/camera';
import { Directory, Filesystem } from '@capacitor/filesystem';
import { VoiceRecorder } from 'capacitor-voice-recorder';
import { uuid } from './uuid';

export interface StagedAttachment {
  type: 'photo' | 'voice';
  /** Resolved, self-sufficient path — no separate Directory needed to reopen it later. */
  filePath: string;
  mimeType: string;
  byteSize: number;
  sha256: string;
}

const EVIDENCE_SUBDIR = 'evidence';

async function ensureEvidenceDir(): Promise<void> {
  try {
    await Filesystem.mkdir({ path: EVIDENCE_SUBDIR, directory: Directory.Data, recursive: true });
  } catch {
    // Filesystem.mkdir throws if the directory already exists — that's the
    // common case after the first capture, not an error worth surfacing.
  }
}

async function sha256OfBase64(base64: string): Promise<string> {
  const binary = atob(base64);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i += 1) bytes[i] = binary.charCodeAt(i);
  const digest = await crypto.subtle.digest('SHA-256', bytes);
  return Array.from(new Uint8Array(digest), (b) => b.toString(16).padStart(2, '0')).join('');
}

/**
 * Opens the device camera, then copies the result out of the Camera
 * plugin's own temp storage into app-private `Directory.Data` — the temp
 * URI is never referenced again after this returns.
 */
export async function capturePhoto(): Promise<StagedAttachment> {
  const result = await Camera.takePhoto({ quality: 80, saveToGallery: false, includeMetadata: true });
  if (!result.uri) {
    throw new Error('Camera did not return a photo.');
  }
  // The plugin's own format note: Android/iOS may report 'jpg' instead of
  // 'jpeg' for the same format — normalize both to the one MIME type.
  const format = (result.metadata?.format ?? 'jpeg').toLowerCase();
  const mimeType = format === 'png' ? 'image/png' : 'image/jpeg';
  const extension = format === 'png' ? 'png' : 'jpg';
  const relativePath = `${EVIDENCE_SUBDIR}/${uuid()}.${extension}`;

  await ensureEvidenceDir();
  await Filesystem.copy({ from: result.uri, to: relativePath, toDirectory: Directory.Data });

  const stat = await Filesystem.stat({ path: relativePath, directory: Directory.Data });
  const read = await Filesystem.readFile({ path: relativePath, directory: Directory.Data });
  const sha256 = await sha256OfBase64(typeof read.data === 'string' ? read.data : '');

  return { type: 'photo', filePath: stat.uri, mimeType, byteSize: stat.size, sha256 };
}

let activeRecording = false;

/** True while a voice note is actively recording — for the UI's record/stop button state. */
export function isRecordingVoice(): boolean {
  return activeRecording;
}

export async function startVoiceRecording(): Promise<void> {
  const permission = await VoiceRecorder.hasAudioRecordingPermission();
  if (!permission.value) {
    const granted = await VoiceRecorder.requestAudioRecordingPermission();
    if (!granted.value) {
      throw new Error('Microphone permission was not granted.');
    }
  }
  // Passing `directory` makes the plugin write straight to app-private
  // storage and return a real file path from stopRecording(), instead of
  // holding the whole recording in memory as base64 (its own README flags
  // the base64 fallback as a real performance cost for longer recordings).
  await VoiceRecorder.startRecording({ directory: Directory.Data, subDirectory: EVIDENCE_SUBDIR });
  activeRecording = true;
}

export async function stopVoiceRecording(): Promise<StagedAttachment> {
  const result = await VoiceRecorder.stopRecording();
  activeRecording = false;
  const { path, mimeType, recordDataBase64 } = result.value;

  if (path) {
    const stat = await Filesystem.stat({ path });
    const read = await Filesystem.readFile({ path });
    const sha256 = await sha256OfBase64(typeof read.data === 'string' ? read.data : '');
    return { type: 'voice', filePath: path, mimeType: mimeType || 'audio/aac', byteSize: stat.size, sha256 };
  }

  // No `path` means the plugin fell back to an in-memory base64 recording
  // (its documented Web behavior) — write it into app-private storage
  // ourselves so a StagedAttachment always resolves to a real file on disk.
  if (!recordDataBase64) {
    throw new Error('The recorder returned neither a file path nor audio data.');
  }
  await ensureEvidenceDir();
  const relativePath = `${EVIDENCE_SUBDIR}/${uuid()}.aac`;
  await Filesystem.writeFile({ path: relativePath, directory: Directory.Data, data: recordDataBase64 });
  const stat = await Filesystem.stat({ path: relativePath, directory: Directory.Data });
  const sha256 = await sha256OfBase64(recordDataBase64);
  return { type: 'voice', filePath: stat.uri, mimeType: mimeType || 'audio/aac', byteSize: stat.size, sha256 };
}

/** Cancels an in-progress recording without persisting anything. */
export async function cancelVoiceRecording(): Promise<void> {
  if (!activeRecording) return;
  try {
    await VoiceRecorder.stopRecording();
  } finally {
    activeRecording = false;
  }
}
