import { useEffect, useRef, useState } from 'react';
import {
  capturePhoto,
  isRecordingVoice,
  startVoiceRecording,
  stopVoiceRecording,
  type StagedAttachment,
} from '../../services/evidenceCapture';
import tacticalFeedback from '../../utils/tacticalFeedback';

export interface StagedItem {
  key: string;
  attachment: StagedAttachment;
}

/** Photo + voice-note staging for the New Incident form (audio recorder timer included). */
export function useIncidentMedia() {
  const [staged, setStaged] = useState<StagedItem[]>([]);
  const [capturing, setCapturing] = useState(false);
  const [recording, setRecording] = useState(false);
  const [recordDuration, setRecordDuration] = useState(0);
  const [captureError, setCaptureError] = useState<string | null>(null);
  const recordIntervalRef = useRef<number | null>(null);

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
    tacticalFeedback.onTap();
    try {
      const attachment = await capturePhoto();
      setStaged((prev) => [...prev, { key: attachment.filePath, attachment }]);
    } catch (err) {
      setCaptureError(err instanceof Error ? err.message : 'Could not capture photo.');
    } finally {
      setCapturing(false);
    }
  }

  async function handleToggleVoice() {
    setCaptureError(null);
    tacticalFeedback.onTap();
    if (isRecordingVoice()) {
      setCapturing(true);
      try {
        const attachment = await stopVoiceRecording();
        setStaged((prev) => [...prev, { key: attachment.filePath, attachment }]);
      } catch (err) {
        setCaptureError(err instanceof Error ? err.message : 'Could not save voice note.');
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
    tacticalFeedback.onTap();
    setStaged((prev) => prev.filter((item) => item.key !== key));
  }

  return {
    staged,
    setStaged,
    capturing,
    recording,
    recordDuration,
    captureError,
    handleAddPhoto,
    handleToggleVoice,
    handleRemoveStaged,
  };
}
