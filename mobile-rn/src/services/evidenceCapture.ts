/**
 * M3's photo/voice attachment capture — the native-plugin edge. Mirrors
 * `db/localDatabase.ts`'s split: this file is the platform edge (camera,
 * manipulator, recorder, filesystem); `db/evidenceRepository.ts` owns the
 * SQLite write.
 *
 * Ported from ../mobile/src/services/evidenceCapture.ts. Every captured
 * file lands under the app's document directory (private, deleted on
 * uninstall), and every result carries the SHA-256 of the actual bytes on
 * disk, never a value trusted from a plugin.
 *
 * PHOTO COMPRESSION: camera sensors commonly produce 4-8MB originals; a
 * barangay's WiFi shouldn't have to move that much per photo. Downsampled
 * to a 1600px max dimension, re-encoded as JPEG @ 0.75, same numbers as
 * the old app. If compression fails, the original capture is saved
 * instead of losing the photo.
 *
 * VOICE: recording is inherently stateful across a React screen's
 * lifetime (start button -> stop button), so — unlike `capturePhoto()` —
 * it's exposed as a hook (`useVoiceRecording()`) wrapping expo-audio's
 * `useAudioRecorder`, not a bare async function; expo-audio has no
 * imperative recorder constructor outside that hook.
 */
import { useMemo } from 'react';
import * as ImagePicker from 'expo-image-picker';
import { manipulateAsync, SaveFormat } from 'expo-image-manipulator';
import { RecordingPresets, requestRecordingPermissionsAsync, setAudioModeAsync, useAudioRecorder, useAudioRecorderState } from 'expo-audio';
import { digest, CryptoDigestAlgorithm } from 'expo-crypto';
import { Directory, File, Paths } from 'expo-file-system';

const MAX_PHOTO_DIMENSION = 1600;
const PHOTO_JPEG_QUALITY = 0.75;
const EVIDENCE_SUBDIR = 'evidence';

export interface StagedAttachment {
  type: 'photo' | 'voice';
  /** file:// URI — self-sufficient, no separate directory needed to reopen it. */
  filePath: string;
  mimeType: string;
  byteSize: number;
  sha256: string;
}

function evidenceDir(): Directory {
  const dir = new Directory(Paths.document, EVIDENCE_SUBDIR);
  if (!dir.exists) dir.create({ intermediates: true, idempotent: true });
  return dir;
}

async function sha256Hex(file: File): Promise<string> {
  const bytes = await digest(CryptoDigestAlgorithm.SHA256, await file.arrayBuffer());
  return Array.from(new Uint8Array(bytes), (b) => b.toString(16).padStart(2, '0')).join('');
}

/**
 * Opens the device camera, compresses the result, and writes it into the
 * app's private evidence directory. Falls back to the uncompressed
 * original (still real evidence, just larger) if compression fails for
 * any reason.
 */
export async function capturePhoto(): Promise<StagedAttachment> {
  const permission = await ImagePicker.requestCameraPermissionsAsync();
  if (!permission.granted) {
    throw new Error('Camera permission was not granted.');
  }

  const result = await ImagePicker.launchCameraAsync({ quality: 0.8, exif: false });
  if (result.canceled || !result.assets?.[0]) {
    throw new Error('Camera did not return a photo.');
  }
  const asset = result.assets[0];

  let sourceFile: File;
  let mimeType: string;
  try {
    const manipulated = await manipulateAsync(
      asset.uri,
      asset.width > MAX_PHOTO_DIMENSION || asset.height > MAX_PHOTO_DIMENSION
        ? [{ resize: asset.width > asset.height ? { width: MAX_PHOTO_DIMENSION } : { height: MAX_PHOTO_DIMENSION } }]
        : [],
      { compress: PHOTO_JPEG_QUALITY, format: SaveFormat.JPEG },
    );
    sourceFile = new File(manipulated.uri);
    mimeType = 'image/jpeg';
  } catch {
    // Compression failed on this device — fall back to the original capture.
    sourceFile = new File(asset.uri);
    mimeType = asset.mimeType || 'image/jpeg';
  }

  const destination = new File(evidenceDir(), `${cryptoRandomName()}.jpg`);
  await sourceFile.copy(destination);
  const sha256 = await sha256Hex(destination);

  return { type: 'photo', filePath: destination.uri, mimeType, byteSize: destination.size, sha256 };
}

function cryptoRandomName(): string {
  return `${Date.now().toString(16)}-${Math.random().toString(16).slice(2)}`;
}

/**
 * Voice recording as a hook — the recording lifecycle (idle -> recording
 * -> stopped) lives across renders of whatever screen holds the record
 * button, which is exactly what a hook is for; expo-audio exposes no
 * recorder constructor outside `useAudioRecorder()`.
 */
export function useVoiceRecording() {
  const recorder = useAudioRecorder(RecordingPresets.HIGH_QUALITY);
  const state = useAudioRecorderState(recorder);

  return useMemo(
    () => ({
      isRecording: state.isRecording,

      async start(): Promise<void> {
        const permission = await requestRecordingPermissionsAsync();
        if (!permission.granted) {
          throw new Error('Microphone permission was not granted.');
        }
        await setAudioModeAsync({ allowsRecording: true, playsInSilentMode: true });
        await recorder.prepareToRecordAsync();
        recorder.record();
      },

      async stop(): Promise<StagedAttachment> {
        await recorder.stop();
        if (!recorder.uri) {
          throw new Error('The recorder produced no audio file.');
        }
        const source = new File(recorder.uri);
        const destination = new File(evidenceDir(), `${cryptoRandomName()}.m4a`);
        await source.copy(destination);
        const sha256 = await sha256Hex(destination);
        return { type: 'voice', filePath: destination.uri, mimeType: 'audio/mp4', byteSize: destination.size, sha256 };
      },

      /** Discards an in-progress recording without persisting anything. */
      async cancel(): Promise<void> {
        if (!state.isRecording) return;
        await recorder.stop();
      },
    }),
    [recorder, state.isRecording],
  );
}

/** Deletes a captured attachment's file off disk (30-day cleanup rule) — never the database row. */
export function deleteEvidenceFile(fileUri: string): void {
  try {
    const file = new File(fileUri);
    if (file.exists) file.delete();
  } catch {
    // Already gone — that's the goal.
  }
}
