import type { ReactNode } from 'react';
import { IonIcon } from '@ionic/react';
import {
  alertCircleOutline,
  checkmarkCircleOutline,
  closeOutline,
  informationCircleOutline,
  warningOutline,
} from 'ionicons/icons';
import { cx } from './cx';

export type BannerTone = 'info' | 'success' | 'warning' | 'error';

const ICON: Record<BannerTone, string> = {
  info: informationCircleOutline,
  success: checkmarkCircleOutline,
  warning: warningOutline,
  error: alertCircleOutline,
};

export interface BannerProps {
  tone?: BannerTone;
  /** Defaults to "alert" for error, "status" otherwise. */
  role?: 'alert' | 'status';
  onDismiss?: () => void;
  dismissLabel?: string;
  action?: ReactNode;
  className?: string;
  children: ReactNode;
}

export const Banner: React.FC<BannerProps> = ({
  tone = 'info',
  role = tone === 'error' ? 'alert' : 'status',
  onDismiss,
  dismissLabel = 'Dismiss',
  action,
  className,
  children,
}) => (
  <div className={cx('ui-banner', `ui-banner--${tone}`, className)} role={role}>
    <IonIcon icon={ICON[tone]} aria-hidden="true" className="ui-banner__icon" />
    <div className="ui-banner__body">
      <div>{children}</div>
      {action && <div className="ui-banner__action">{action}</div>}
    </div>
    {onDismiss && (
      <button type="button" className="ui-banner__dismiss" onClick={onDismiss} aria-label={dismissLabel}>
        <IonIcon icon={closeOutline} aria-hidden="true" />
      </button>
    )}
  </div>
);
