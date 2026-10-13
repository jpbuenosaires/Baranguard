import type { ReactNode } from 'react';
import { IonIcon } from '@ionic/react';

export interface EmptyStateProps {
  icon?: string;
  title: string;
  body?: ReactNode;
  action?: ReactNode;
}

export const EmptyState: React.FC<EmptyStateProps> = ({ icon, title, body, action }) => (
  <div className="ui-empty">
    {icon && <IonIcon icon={icon} aria-hidden="true" className="ui-empty__icon" />}
    <h3 className="ui-empty__title">{title}</h3>
    {body && <p className="ui-empty__body">{body}</p>}
    {action && <div className="ui-empty__action">{action}</div>}
  </div>
);
