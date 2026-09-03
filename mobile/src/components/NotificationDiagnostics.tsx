/**
 * NotificationDiagnostics.tsx — the "visible in diagnostics" half of §9
 * M12: "Notification permission/channel state is visible in diagnostics."
 * M10 Profile itself is not built yet (still `NotBuiltYetPage`), so this
 * mounts as a real, working section on that otherwise-unbuilt page — same
 * precedent as building necessary plumbing ahead of the screen that
 * formally owns it (W2's minimal login page, Sprint 1; the Ionic scaffold,
 * Sprint 2).
 *
 * Reads the REAL permission state via `PushNotifications.checkPermissions()`
 * — never a hardcoded "Enabled" the way §8 forbids for any status
 * indicator. On the web platform (or if the plugin throws for any reason)
 * this reports 'unavailable' rather than guessing.
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
      <h3 className="card__title">Notification diagnostics</h3>
      <IonNote className="app-note">Push notification permission: {LABEL[state]}</IonNote>
    </div>
  );
};

export default NotificationDiagnostics;
