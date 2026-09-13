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
import { shield } from 'ionicons/icons';
import { checkHealth } from '../services/apiService';
import SyncQueueModal from './SyncQueueModal';

interface MobileHeaderProps {
  title?: string;
  subtitle?: string;
  showBack?: boolean;
  defaultBackHref?: string;
  rightSlot?: React.ReactNode;
}

export const MobileHeader: React.FC<MobileHeaderProps> = ({
  title,
  subtitle,
  showBack = false,
  defaultBackHref = '/home',
  rightSlot,
}) => {
  const [isOnline, setIsOnline] = useState<boolean | null>(null);
  const [showSyncModal, setShowSyncModal] = useState(false);

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
      <IonHeader>
        <IonToolbar className="mobile-topbar">
          {showBack && (
            <IonButtons slot="start">
              <IonBackButton defaultHref={defaultBackHref} color="light" />
            </IonButtons>
          )}

          <div className="mobile-topbar-content">
            <div className="mobile-brand">
              {!showBack && (
                <div className="mobile-brand__emblem">
                  <IonIcon icon={shield} />
                </div>
              )}
              <div className="mobile-brand__text">
                <span className="mobile-brand__title">{title || 'BARANGUARD'}</span>
                <span className="mobile-brand__subtitle">{subtitle || 'Field Console'}</span>
              </div>
            </div>

            <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
              {rightSlot}
              <button
                type="button"
                className="mobile-topbar__status"
                title={isOnline ? 'Workstation Connected — tap to inspect queue' : 'Offline Mode — tap to inspect queue'}
                onClick={() => setShowSyncModal(true)}
                style={{ cursor: 'pointer', border: 'none' }}
              >
                <span
                  className={`status-indicator-dot ${
                    isOnline ? 'status-indicator-dot--online' : 'status-indicator-dot--offline'
                  }`}
                />
                <span>{isOnline ? 'LIVE' : 'CACHE'}</span>
              </button>
            </div>
          </div>
        </IonToolbar>
      </IonHeader>

      <SyncQueueModal isOpen={showSyncModal} onClose={() => setShowSyncModal(false)} />
    </>
  );
};

export default MobileHeader;
