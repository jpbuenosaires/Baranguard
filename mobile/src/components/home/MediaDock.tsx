import { IonIcon, IonSpinner } from '@ionic/react';
import { cameraOutline, closeOutline, micOutline, stopCircleOutline } from 'ionicons/icons';
import { Capacitor } from '@capacitor/core';
import { Banner } from '../ui';
import type { StagedItem } from './useIncidentMedia';

interface Props {
  staged: StagedItem[];
  saving: boolean;
  capturing: boolean;
  recording: boolean;
  recordDuration: number;
  captureError: string | null;
  onAddPhoto: () => void;
  onToggleVoice: () => void;
  onRemove: (key: string) => void;
}

const formatTimer = (seconds: number) => {
  const mins = Math.floor(seconds / 60);
  const secs = seconds % 60;
  return `${String(mins).padStart(2, '0')}:${String(secs).padStart(2, '0')}`;
};

/** Evidence attachments: photo capture, voice recorder and the staged gallery. */
const MediaDock: React.FC<Props> = ({
  staged,
  saving,
  capturing,
  recording,
  recordDuration,
  captureError,
  onAddPhoto,
  onToggleVoice,
  onRemove,
}) => (
  <div className="intake-block">
    <div className="intake-block-header">
      <span className="intake-block-title">
        <IonIcon icon={cameraOutline} />
        Photos & Audio (Optional)
      </span>
      {staged.length > 0 && <span className="status-pill status-pill--info">{staged.length} Added</span>}
    </div>

    <div className="intake-action-btn-row">
      <button
        type="button"
        className="intake-btn-touch"
        onClick={onAddPhoto}
        disabled={saving || capturing || recording}
      >
        {capturing && !recording ? (
          <IonSpinner name="dots" className="intake-spinner" />
        ) : (
          <IonIcon icon={cameraOutline} className="intake-btn-icon" />
        )}
        <span>Add Photo</span>
      </button>

      <button
        type="button"
        className={`intake-btn-touch ${recording ? 'intake-btn-touch--active intake-btn-touch--recording' : ''}`}
        onClick={onToggleVoice}
        disabled={saving || (capturing && !recording)}
      >
        <IonIcon icon={recording ? stopCircleOutline : micOutline} className="intake-btn-icon" />
        <span>{recording ? 'Stop Recording' : 'Record Audio'}</span>
      </button>
    </div>

    {/* Active Voice Recording Status Bar */}
    {recording && (
      <div className="intake-recording-chip">
        <div className="intake-recording-chip__status">
          <div className="recording-live-dot" />
          <span>Recording audio: {formatTimer(recordDuration)}</span>
        </div>
        <button type="button" onClick={onToggleVoice} className="intake-recording-done">
          Done
        </button>
      </div>
    )}

    {captureError && (
      <Banner tone="error" role="alert">
        {captureError}
      </Banner>
    )}

    {/* Staged Evidence Items Gallery */}
    {staged.length > 0 && (
      <div className="media-grid media-grid--staged">
        {staged.map((item, stagedIndex) => (
          <div key={item.key} className="media-tile">
            {item.attachment.type === 'photo' ? (
              <img
                src={Capacitor.convertFileSrc(item.attachment.filePath)}
                alt={`Photo attached to this report, ${stagedIndex + 1} of ${staged.length}`}
                className="media-tile__img"
                onError={(e) => {
                  (e.target as HTMLElement).style.display = 'none';
                }}
              />
            ) : (
              <div className="media-tile__voice">
                <IonIcon icon={micOutline} className="intake-btn-icon" />
                <span className="media-tile__voice-size">{(item.attachment.byteSize / 1024).toFixed(0)} KB</span>
              </div>
            )}
            <button
              type="button"
              className="media-tile__remove"
              disabled={saving}
              onClick={() => onRemove(item.key)}
              aria-label="Remove attachment"
            >
              <IonIcon icon={closeOutline} />
            </button>
          </div>
        ))}
      </div>
    )}
  </div>
);

export default MediaDock;
