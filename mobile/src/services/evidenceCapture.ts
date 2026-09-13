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
 *
 * PHOTO COMPRESSION (Mobile Improvement Plan Phase 3.1): camera sensors
 * commonly produce 4-8MB originals; a barangay's WiFi/hotspot sync
 * shouldn't have to move that much per photo for a record that only
 * needs to stay legible, not print-resolution. `capturePhoto()` downsamples
 * to a 1600px max dimension and re-encodes as JPEG @ 0.75 quality via an
 * in-memory `<canvas>` BEFORE the file ever touches disk — the SHA-256 is
 * computed over the compressed bytes actually written, same as before. If
 * compression fails for any reason (a WebView/canvas limitation on some
 * device), the ORIGINAL uncompressed capture is saved instead of losing
 * the photo — still real evidence, just larger, never silently dropped.
 * Voice notes are NOT compressed: AAC recordings are already compact
 * relative to a multi-MB camera photo, so there is no equivalent problem
 * to solve there.
 */

import { Camera } from '@capacitor/camera';
import { Capacitor } from '@capacitor/core';
import { Directory, Filesystem } from '@capacitor/filesystem';
import { VoiceRecorder } from 'capacitor-voice-recorder';
import { uuid } from './uuid';

const MAX_PHOTO_DIMENSION = 1600;
const PHOTO_JPEG_QUALITY = 0.75;

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
  const digest = await crypto.subtle.digest('SHA-256', bytes as BufferSource);
  return Array.from(new Uint8Array(digest), (b) => b.toString(16).padStart(2, '0')).join('');
}

function blobToBase64(blob: Blob): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onloadend = () => {
      const result = typeof reader.result === 'string' ? reader.result : '';
      // FileReader's data URL is "data:<mime>;base64,<payload>" —
      // Filesystem.writeFile wants just the payload.
      resolve(result.slice(result.indexOf(',') + 1));
    };
    reader.onerror = () => reject(reader.error ?? new Error('Could not read compressed image data.'));
    reader.readAsDataURL(blob);
  });
}

/**
 * Downsamples and re-encodes a captured photo via an in-memory canvas.
 * Reads through `Capacitor.convertFileSrc()` so the plugin's own temp URI
 * (a native file:// path) is loadable as an <img> source inside the
 * WebView.
 */
async function compressPhoto(sourceUri: string): Promise<Blob> {
  const image = new Image();
  const loaded = new Promise<void>((resolve, reject) => {
    image.onload = () => resolve();
    image.onerror = () => reject(new Error('Could not load the captured photo for compression.'));
  });
  image.src = Capacitor.convertFileSrc(sourceUri);
  await loaded;

  let { naturalWidth: width, naturalHeight: height } = image;
  if (width > MAX_PHOTO_DIMENSION || height > MAX_PHOTO_DIMENSION) {
    const scale = MAX_PHOTO_DIMENSION / Math.max(width, height);
    width = Math.round(width * scale);
    height = Math.round(height * scale);
  }

  const canvas = document.createElement('canvas');
  canvas.width = width;
  canvas.height = height;
  const ctx = canvas.getContext('2d');
  if (!ctx) throw new Error('Canvas 2D context unavailable.');
  ctx.drawImage(image, 0, 0, width, height);

  const blob = await new Promise<Blob | null>((resolve) => canvas.toBlob(resolve, 'image/jpeg', PHOTO_JPEG_QUALITY));
  if (!blob) throw new Error('Could not encode the compressed photo.');
  return blob;
}

/**
 * Opens the device camera, compresses the result (see this file's header
 * comment), and writes it into app-private `Directory.Data` — the Camera
 * plugin's own temp URI is never referenced again after this returns.
 */
export async function capturePhoto(): Promise<StagedAttachment> {
  const result = await Camera.takePhoto({ quality: 80, saveToGallery: false, includeMetadata: true });
  if (!result.uri) {
    throw new Error('Camera did not return a photo.');
  }
  // The plugin's own format note: Android/iOS may report 'jpg' instead of
  // 'jpeg' for the same format — normalize both to the one MIME type.
  // Only relevant to the uncompressed FALLBACK path below; the compressed
  // path always re-encodes to JPEG regardless of the original format.
  const originalFormat = (result.metadata?.format ?? 'jpeg').toLowerCase();
  const originalMimeType = originalFormat === 'png' ? 'image/png' : 'image/jpeg';
  const originalExtension = originalFormat === 'png' ? 'png' : 'jpg';

  await ensureEvidenceDir();

  let relativePath: string;
  let mimeType: string;
  try {
    const compressed = await compressPhoto(result.uri);
    relativePath = `${EVIDENCE_SUBDIR}/${uuid()}.jpg`;
    mimeType = 'image/jpeg';
    await Filesystem.writeFile({ path: relativePath, directory: Directory.Data, data: await blobToBase64(compressed) });
  } catch {
    // Compression failed (canvas/WebView limitation on this device) —
    // fall back to the original capture rather than losing the photo.
    relativePath = `${EVIDENCE_SUBDIR}/${uuid()}.${originalExtension}`;
    mimeType = originalMimeType;
    await Filesystem.copy({ from: result.uri, to: relativePath, toDirectory: Directory.Data });
  }

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

/**
 * Deletes a captured attachment's file off disk (Phase 3.3's 30-day
 * cleanup rule) — never the database row, which is
 * `evidenceRepository.ts`'s job. Tolerant of the file already being gone
 * (a repeat prune pass, or a partial previous run) — that is the
 * intended end state, not a failure.
 */
export async function deleteEvidenceFile(filePath: string): Promise<void> {
  try {
    await Filesystem.deleteFile({ path: filePath });
  } catch {
    // Already gone — fine, that's the goal.
  }
}

/**
 * Reads a previously-captured attachment's bytes back off disk, for
 * `syncService.ts`'s evidence-upload step (Phase 3.2). `filePath` here is
 * always the FULL URI `StagedAttachment.filePath` already carries (both
 * capture paths above return `stat.uri`, not a `Directory.Data`-relative
 * path), so no `directory` option is passed — same convention
 * `stopVoiceRecording()` above already uses when reopening a path the
 * recorder plugin returned directly.
 */
export async function readEvidenceFile(filePath: string, mimeType: string): Promise<Blob> {
  const read = await Filesystem.readFile({ path: filePath });
  if (typeof read.data === 'string') {
    const binary = atob(read.data);
    const bytes = new Uint8Array(binary.length);
    for (let i = 0; i < binary.length; i += 1) bytes[i] = binary.charCodeAt(i);
    return new Blob([bytes], { type: mimeType });
  }
  // Web platform's Filesystem implementation returns a Blob directly.
  return read.data;
}
