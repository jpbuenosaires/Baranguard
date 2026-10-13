import { IonIcon } from '@ionic/react';
import {
  checkmarkCircleOutline,
  cloudOfflineOutline,
  phonePortraitOutline,
  refreshOutline,
  sendOutline,
} from 'ionicons/icons';
import { cx } from './cx';
import { syncLabelText, type SyncState } from './syncText';

export interface SyncLabelProps {
  state: SyncState;
  /** For 'failed': false means it will not auto-retry and needs a person. Default true. */
  willRetry?: boolean;
  className?: string;
}

const ICON: Record<SyncState, string> = {
  saved_on_phone: phonePortraitOutline,
  sending: sendOutline,
  sent: checkmarkCircleOutline,
  failed: refreshOutline,
  waiting_connection: cloudOfflineOutline,
};

const TONE: Record<SyncState, string> = {
  saved_on_phone: 'warning',
  sending: 'info',
  sent: 'success',
  failed: 'critical',
  waiting_connection: 'neutral',
};

/** Only 'sent' may be shown once the server has confirmed receipt. */
export const SyncLabel: React.FC<SyncLabelProps> = ({ state, willRetry = true, className }) => (
  <span className={cx('ui-sync', `ui-sync--${TONE[state]}`, className)} role="status">
    <IonIcon icon={ICON[state]} aria-hidden="true" />
    <span>{syncLabelText(state, willRetry)}</span>
  </span>
);
