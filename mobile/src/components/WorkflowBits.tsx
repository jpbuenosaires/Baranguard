/**
 * WorkflowBits.tsx — two tiny presentational pieces the 2026-10 tanod
 * workflow screens share: the sync-state chip and the banner strip. Since the
 * Phase 2 UI overhaul both delegate to `components/ui` (SyncLabel, Banner), so
 * there is ONE implementation and one wording; the exports and props are
 * unchanged for existing callers.
 */

import type { ReactNode } from 'react';
import { deriveWorkflowSyncState, type WorkflowSyncState } from '../services/db/workflowSync';
import { Banner as UiBanner, type BannerTone as UiBannerTone } from './ui/Banner';
import { SyncLabel } from './ui/SyncLabel';
import type { SyncState } from './ui/syncText';

const SYNC_STATE: Record<WorkflowSyncState, SyncState> = {
  saved_locally: 'saved_on_phone',
  synced: 'sent',
  needs_attention: 'failed',
};

/**
 * "Saved on phone" / "Sent" / "Needs attention" — derived strictly from the
 * row's own flags, so it never claims server receipt the row cannot prove.
 * A permanent failure will not auto-retry, hence `willRetry={false}`.
 */
export const SyncChip: React.FC<{ row: { synced: number; permanent_failure: number } }> = ({ row }) => {
  const state = deriveWorkflowSyncState(row);
  return <SyncLabel state={SYNC_STATE[state]} willRetry={false} />;
};

type BannerTone = 'info' | 'warning' | 'critical' | 'success';

const TONE: Record<BannerTone, UiBannerTone> = {
  info: 'info',
  warning: 'warning',
  critical: 'error',
  success: 'success',
};

export const Banner: React.FC<{ tone?: BannerTone; children: ReactNode; role?: 'alert' | 'status' }> = ({
  tone = 'info',
  children,
  role = tone === 'critical' || tone === 'warning' ? 'alert' : 'status',
}) => (
  <UiBanner tone={TONE[tone]} role={role}>
    {children}
  </UiBanner>
);
