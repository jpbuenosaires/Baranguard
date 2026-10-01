/**
 * MobileHeader.tsx — Branded Topbar for Baranguard Mobile.
 *
 * Provides brand continuity with the Web Command Center:
 * - Baranguard Shield insignia
 * - Bold wordmark + role/console indicator
 * - Live connection/sync status indicator
 * - Contextual title and back button support
 */

import React, { useEffect, useState } from 'react';
import {
  IonButtons,
  IonBackButton,
  IonHeader,
  IonIcon,
  IonToolbar,
} from '@ionic/react';
import { moonOutline, shield, sunnyOutline } from 'ionicons/icons';
import { checkHealth } from '../services/apiService';
import SyncQueueModal from './SyncQueueModal';
import { isCurrentlyDark, toggleTheme, THEME_CHANGED_EVENT } from '../utils/theme';

interface MobileHeaderProps {
  title?: string;
  subtitle?: string;
  showBack?: boolean;
  defaultBackHref?: string;
  rightSlot?: React.ReactNode;
  hideThemeToggle?: boolean;
  hideStatusIndicator?: boolean;
}

export const MobileHeader: React.FC<MobileHeaderProps> = ({
  title,
  subtitle,
  showBack = false,
  defaultBackHref = '/tabs/home',
  rightSlot,
  hideThemeToggle = false,
  hideStatusIndicator = false,
}) => {
  const [isOnline, setIsOnline] = useState<boolean | null>(null);
  const [showSyncModal, setShowSyncModal] = useState(false);
  const [dark, setDark] = useState<boolean>(() => isCurrentlyDark());

  useEffect(() => {
    const handleThemeChanged = () => {
      setDark(isCurrentlyDark());
    };
    window.addEventListener(THEME_CHANGED_EVENT, handleThemeChanged);
    return () => window.removeEventListener(THEME_CHANGED_EVENT, handleThemeChanged);
  }, []);

  useEffect(() => {
    let cancelled = false;

    async function probe() {
      try {
        const ok = await checkHealth();
        if (!cancelled) setIsOnline(ok);
      } catch {
        if (!cancelled) setIsOnline(false);
      }
    }

    probe();
    const interval = setInterval(probe, 30000);
    return () => {
      cancelled = true;
      clearInterval(interval);
    };
  }, []);

  return (
    <>
      <IonHeader className="mobile-header-ion ion-no-border">
        <IonToolbar className="mobile-topbar">
          {showBack && (
            <IonButtons slot="start">
              <IonBackButton defaultHref={defaultBackHref} className="mobile-topbar__back-btn" />
            </IonButtons>
          )}

          <div className="mobile-topbar-content">
            <div className="mobile-brand">
              {!showBack && (
                <IonIcon icon={shield} className="mobile-brand__shield-icon" aria-hidden="true" />
              )}
              <div className="mobile-brand__text">
                <span className="mobile-brand__title">{title || 'Baranguard'}</span>
                {subtitle && <span className="mobile-brand__subtitle">{subtitle}</span>}
              </div>
            </div>

            <div className="mobile-topbar__actions">
              {rightSlot}
              {!hideThemeToggle && (
                <button
                  type="button"
                  className="mobile-topbar__theme-toggle"
                  aria-label={dark ? 'Switch to light theme' : 'Switch to dark theme'}
                  title={dark ? 'Switch to light theme' : 'Switch to dark theme'}
                  onClick={() => {
                    toggleTheme();
                    setDark(isCurrentlyDark());
                  }}
                >
                  <IonIcon icon={dark ? sunnyOutline : moonOutline} />
                </button>
              )}
              {!hideStatusIndicator && (
                <button
                  type="button"
                  className={`mobile-topbar__status ${isOnline ? 'mobile-topbar__status--online' : 'mobile-topbar__status--offline'}`}
                  aria-label={isOnline ? 'Workstation Connected — tap to inspect sync queue' : 'Offline Cache Mode — tap to inspect sync queue'}
                  title={isOnline ? 'Workstation Connected — tap to inspect queue' : 'Offline Cache Mode — tap to inspect queue'}
                  onClick={() => setShowSyncModal(true)}
                >
                  <span
                    className={`status-indicator-dot ${
                      isOnline ? 'status-indicator-dot--online' : 'status-indicator-dot--offline'
                    }`}
                    aria-hidden="true"
                  />
                  <span className="mobile-topbar__status-text">{isOnline ? 'LIVE' : 'CACHE'}</span>
                </button>
              )}
            </div>
          </div>
        </IonToolbar>
      </IonHeader>

      <SyncQueueModal isOpen={showSyncModal} onClose={() => setShowSyncModal(false)} />
    </>
  );
};

export default MobileHeader;
