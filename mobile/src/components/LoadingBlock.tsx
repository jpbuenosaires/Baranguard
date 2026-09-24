/**
 * LoadingBlock — the full-page "fetching this screen's data" spinner every
 * screen was re-typing as its own inline `style={{ ... }}` object
 * (assignments.tsx, my-reports.tsx, my-shifts.tsx, assignment-detail.tsx,
 * incident-submitted.tsx, SyncQueueModal.tsx all had byte-for-byte or
 * near-identical copies). Covers only that one verified-duplicate shape —
 * NOT a generic error/empty component, since this app's error handling is
 * deliberately contextual (an offline banner over cached data on
 * assignments.tsx, an inline warning strip with no retry on my-shifts.tsx,
 * a sync-result banner on SyncQueueModal.tsx) rather than one uniform
 * blocking state, and forcing those into a shared shape would change
 * behavior, not just de-duplicate markup.
 */

import React from 'react';
import { IonSpinner } from '@ionic/react';

export function LoadingBlock({ label, compact = false }: { label?: string; compact?: boolean }) {
  if (compact) {
    return (
      <div style={{ display: 'flex', justifyContent: 'center', padding: '16px 0' }}>
        <IonSpinner name="dots" />
      </div>
    );
  }
  if (!label) {
    return (
      <div style={{ display: 'flex', justifyContent: 'center', paddingTop: 64 }}>
        <IonSpinner name="dots" />
      </div>
    );
  }
  return (
    <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', paddingTop: 64, gap: 12 }}>
      <IonSpinner name="dots" />
      <span style={{ fontSize: 'var(--font-size-sm)', color: 'var(--color-text-secondary)' }}>{label}</span>
    </div>
  );
}
