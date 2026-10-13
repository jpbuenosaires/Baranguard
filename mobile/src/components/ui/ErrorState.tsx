import { alertCircleOutline, refreshOutline } from 'ionicons/icons';
import { IonIcon } from '@ionic/react';
import { Button } from './Button';

export interface ErrorStateProps {
  message: string;
  onRetry: () => void;
  retryLabel?: string;
  retrying?: boolean;
}

/** Always offers Retry: an error with no way forward is a dead end. */
export const ErrorState: React.FC<ErrorStateProps> = ({ message, onRetry, retryLabel = 'Try again', retrying = false }) => (
  <div className="ui-empty ui-error" role="alert">
    <IonIcon icon={alertCircleOutline} aria-hidden="true" className="ui-empty__icon ui-error__icon" />
    <p className="ui-empty__body">{message}</p>
    <div className="ui-empty__action">
      <Button variant="secondary" icon={refreshOutline} onClick={onRetry} loading={retrying}>
        {retryLabel}
      </Button>
    </div>
  </div>
);
