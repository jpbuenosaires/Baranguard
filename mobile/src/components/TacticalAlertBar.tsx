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

  function getStyles(severity: 'critical' | 'warning' | 'info') {
    switch (severity) {
      case 'critical':
        return {
          bg: 'var(--tint-critical-bg)',
          border: '1px solid var(--color-critical)',
          text: 'var(--pill-critical-text)',
        };
      case 'warning':
        return {
          bg: 'var(--tint-warning-bg)',
          border: '1px solid var(--color-warning)',
          text: 'var(--pill-warning-text)',
        };
      default:
        return {
          bg: 'var(--tint-info-bg)',
          border: '1px solid var(--color-border-blue)',
          text: 'var(--pill-info-text)',
        };
    }
  }

  const primaryStyle = getStyles(primary.severity);

  return (
    <div className="tactical-alert-container" style={{ display: 'flex', flexDirection: 'column', gap: '8px', margin: '4px 0 10px' }}>
      {/* Primary Alert Card */}
      <div
        style={{
          background: primaryStyle.bg,
          border: primaryStyle.border,
          borderRadius: 'var(--radius-md, 8px)',
          padding: '10px 14px',
          color: primaryStyle.text,
          fontSize: '0.8125rem',
          fontWeight: 600,
          lineHeight: 1.4,
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'space-between',
          gap: '12px',
        }}
        role={primary.severity === 'critical' ? 'alert' : 'status'}
      >
        <div style={{ display: 'flex', alignItems: 'flex-start', gap: '10px', flex: 1 }}>
          <IonIcon
            icon={getIcon(primary.severity)}
            style={{ fontSize: '1.25rem', flexShrink: 0, marginTop: '2px' }}
            aria-hidden="true"
          />
          <span>{primary.message}</span>
        </div>

        {primary.actionLabel && primary.onAction && (
          <button
            type="button"
            onClick={() => {
              tacticalFeedback.onTap();
              primary.onAction?.();
            }}
            style={{
              minHeight: '44px',
              padding: '0 14px',
              borderRadius: 'var(--radius-sm, 6px)',
              background: 'currentColor',
              color: primaryStyle.bg,
              border: 'none',
              fontWeight: 700,
              fontSize: '0.8125rem',
              cursor: 'pointer',
              flexShrink: 0,
              display: 'inline-flex',
              alignItems: 'center',
              justifyContent: 'center',
            }}
          >
            <span style={{ color: primary.severity === 'warning' ? '#000000' : '#ffffff' }}>
              {primary.actionLabel}
            </span>
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
            style={{
              background: 'var(--color-surface)',
              border: '1px solid var(--color-border)',
              borderRadius: 'var(--radius-full, 9999px)',
              padding: '6px 14px',
              color: 'var(--color-text-secondary)',
              fontSize: '0.75rem',
              fontWeight: 700,
              display: 'inline-flex',
              alignItems: 'center',
              justifyContent: 'center',
              gap: '6px',
              cursor: 'pointer',
              alignSelf: 'flex-start',
              minHeight: '36px',
            }}
            aria-expanded={expanded}
          >
            <span>{expanded ? 'Hide extra notices' : `+ ${remaining.length} more notice${remaining.length === 1 ? '' : 's'}`}</span>
            <IonIcon icon={expanded ? chevronUpOutline : chevronDownOutline} style={{ fontSize: '0.9rem' }} />
          </button>

          {expanded && (
            <div style={{ display: 'flex', flexDirection: 'column', gap: '6px', paddingLeft: '4px' }}>
              {remaining.map((item) => {
                const s = getStyles(item.severity);
                return (
                  <div
                    key={item.id}
                    style={{
                      background: s.bg,
                      border: s.border,
                      borderRadius: 'var(--radius-md, 8px)',
                      padding: '8px 12px',
                      color: s.text,
                      fontSize: '0.75rem',
                      fontWeight: 600,
                      lineHeight: 1.35,
                      display: 'flex',
                      alignItems: 'center',
                      justifyContent: 'space-between',
                      gap: '10px',
                    }}
                    role="status"
                  >
                    <div style={{ display: 'flex', alignItems: 'center', gap: '8px', flex: 1 }}>
                      <IonIcon icon={getIcon(item.severity)} style={{ fontSize: '1.1rem', flexShrink: 0 }} aria-hidden="true" />
                      <span>{item.message}</span>
                    </div>

                    {item.actionLabel && item.onAction && (
                      <button
                        type="button"
                        onClick={() => {
                          tacticalFeedback.onTap();
                          item.onAction?.();
                        }}
                        style={{
                          minHeight: '40px',
                          padding: '0 10px',
                          borderRadius: 'var(--radius-sm, 6px)',
                          background: 'currentColor',
                          border: 'none',
                          fontWeight: 700,
                          fontSize: '0.75rem',
                          cursor: 'pointer',
                          flexShrink: 0,
                        }}
                      >
                        <span style={{ color: item.severity === 'warning' ? '#000000' : '#ffffff' }}>
                          {item.actionLabel}
                        </span>
                      </button>
                    )}
                  </div>
                );
              })}
            </div>
          )}
        </>
      )}
    </div>
  );
};

export default TacticalAlertBar;
