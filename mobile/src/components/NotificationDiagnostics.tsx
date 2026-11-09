/**
 * NotificationDiagnostics.tsx — makes notification permission/channel state visible in diagnostics.
 *
 * Reads the REAL permission state via `PushNotifications.checkPermissions()`, never a hardcoded
 * "Enabled". On the web platform (or if the plugin throws for any reason) it reports 'unavailable'
 * rather than guessing.
 */

import { useEffect, useState } from 'react';
import { IonNote } from '@ionic/react';
import { Capacitor } from '@capacitor/core';
import { PushNotifications } from '@capacitor/push-notifications';

type PermissionDisplay = 'checking' | 'granted' | 'denied' | 'prompt' | 'unavailable';

const LABEL: Record<PermissionDisplay, string> = {
  checking: 'Checking…',
  granted: 'Granted',
  denied: 'Denied — critical alerts will fall back to SMS only',
  prompt: 'Not yet requested',
  unavailable: 'Not available on this platform',
};

const NotificationDiagnostics: React.FC = () => {
  const [state, setState] = useState<PermissionDisplay>('checking');

  useEffect(() => {
    let active = true;
    if (Capacitor.getPlatform() !== 'android') {
      setState('unavailable');
      return;
    }
    PushNotifications.checkPermissions()
      .then((result) => {
        if (!active) return;
        if (result.receive === 'granted') setState('granted');
        else if (result.receive === 'denied') setState('denied');
        else setState('prompt');
      })
      .catch(() => {
        if (active) setState('unavailable');
      });
    return () => {
      active = false;
    };
  }, []);

  return (
    <div className="app-section">
      <h3 className="card__title">Push notifications</h3>
      <IonNote className="app-note">Push notification permission: {LABEL[state]}</IonNote>
    </div>
  );
};

export default NotificationDiagnostics;
