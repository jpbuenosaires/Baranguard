import React, { useState } from 'react';
import { IonIcon } from '@ionic/react';
import { alertCircleOutline, chevronDownOutline, chevronUpOutline, informationCircleOutline, warningOutline } from 'ionicons/icons';
import tacticalFeedback from '../utils/tacticalFeedback';

export interface TacticalAlertItem {
  id: string;
  severity: 'critical' | 'warning' | 'info';
  message: string;
  actionLabel?: string;
  onAction?: () => void;
}

interface TacticalAlertBarProps {
  alerts: TacticalAlertItem[];
}

export const TacticalAlertBar: React.FC<TacticalAlertBarProps> = ({ alerts }) => {
  const [expanded, setExpanded] = useState(false);

  if (!alerts || alerts.length === 0) return null;

  // Sort: critical first, then warning, then info
  const severityRank: Record<string, number> = { critical: 0, warning: 1, info: 2 };
  const sorted = [...alerts].sort((a, b) => (severityRank[a.severity] ?? 3) - (severityRank[b.severity] ?? 3));

  const primary = sorted[0];
  const remaining = sorted.slice(1);

  function getIcon(severity: 'critical' | 'warning' | 'info') {
    switch (severity) {
      case 'critical':
        return alertCircleOutline;
      case 'warning':
        return warningOutline;
      default:
        return informationCircleOutline;
    }
  }

  return (
    <div className="tactical-alert-container tab-container">
      {/* Primary Alert Card */}
      <div
        className={`tab-card tab-card--${primary.severity}`}
        role={primary.severity === 'critical' ? 'alert' : 'status'}
      >
        <div className="tab-card__body">
          <IonIcon icon={getIcon(primary.severity)} className="tab-card__icon" aria-hidden="true" />
          <span>{primary.message}</span>
        </div>

        {primary.actionLabel && primary.onAction && (
          <button
            type="button"
            onClick={() => {
              tacticalFeedback.onTap();
              primary.onAction?.();
            }}
            className={`tab-action tab-action--${primary.severity}`}
          >
            {primary.actionLabel}
          </button>
        )}
      </div>

      {/* Multiple Notices Drawer / Toggle */}
      {remaining.length > 0 && (
        <>
          <button
            type="button"
            onClick={() => {
              tacticalFeedback.onTap();
              setExpanded(!expanded);
            }}
            className="tab-more"
            aria-expanded={expanded}
          >
            <span>{expanded ? 'Hide extra notices' : `+ ${remaining.length} more notice${remaining.length === 1 ? '' : 's'}`}</span>
            <IonIcon icon={expanded ? chevronUpOutline : chevronDownOutline} className="tab-more__icon" />
          </button>

          {expanded && (
            <div className="tab-list">
              {remaining.map((item) => (
                <div key={item.id} className={`tab-card tab-card--compact tab-card--${item.severity}`} role="status">
                  <div className="tab-card__body tab-card__body--center">
                    <IonIcon icon={getIcon(item.severity)} className="tab-card__icon tab-card__icon--sm" aria-hidden="true" />
                    <span>{item.message}</span>
                  </div>

                  {item.actionLabel && item.onAction && (
                    <button
                      type="button"
                      onClick={() => {
                        tacticalFeedback.onTap();
                        item.onAction?.();
                      }}
                      className={`tab-action tab-action--compact tab-action--${item.severity}`}
                    >
                      {item.actionLabel}
                    </button>
                  )}
                </div>
              ))}
            </div>
          )}
        </>
      )}
    </div>
  );
};

export default TacticalAlertBar;
