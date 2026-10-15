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
      <div role="status" aria-busy="true" aria-label="Loading" className="loading-block--inline">
        <IonSpinner name="dots" />
      </div>
    );
  }
  if (!label) {
    return (
      <div role="status" aria-busy="true" aria-label="Loading" className="loading-block--page">
        <IonSpinner name="dots" />
      </div>
    );
  }
  return (
    <div role="status" aria-busy="true" className="loading-block--labelled">
      <IonSpinner name="dots" />
      <span className="loading-block__label">{label}</span>
    </div>
  );
}
