/**
 * WorkflowBits.tsx — two tiny presentational pieces the 2026-10 tanod
 * workflow screens share: the sync-state chip and the banner strip. Both are
 * thin wrappers over classes that already exist (`.status-pill`,
 * `tanod-workflow.css`'s `.wf-banner`), so every screen words and colours a
 * record's journey to the server identically.
 */

import type { ReactNode } from 'react';
import { IonIcon } from '@ionic/react';
import {
  alertCircleOutline,
  checkmarkCircleOutline,
  informationCircleOutline,
  warningOutline,
} from 'ionicons/icons';
import {
  deriveWorkflowSyncState,
  WORKFLOW_SYNC_STATE_LABEL,
  type WorkflowSyncState,
} from '../services/db/workflowSync';

const CHIP_CLASS: Record<WorkflowSyncState, string> = {
  saved_locally: 'status-pill--pending',
  synced: 'status-pill--success',
  needs_attention: 'status-pill--critical',
};

/**
 * "Saved on phone" / "Synced" / "Needs attention" — derived strictly from the
 * row's own flags, so it never claims server receipt the row cannot prove.
 */
export const SyncChip: React.FC<{ row: { synced: number; permanent_failure: number } }> = ({ row }) => {
  const state = deriveWorkflowSyncState(row);
  return <span className={`status-pill ${CHIP_CLASS[state]}`}>{WORKFLOW_SYNC_STATE_LABEL[state]}</span>;
};

type BannerTone = 'info' | 'warning' | 'critical' | 'success';

const BANNER_ICON: Record<BannerTone, string> = {
  info: informationCircleOutline,
  warning: warningOutline,
  critical: alertCircleOutline,
  success: checkmarkCircleOutline,
};

export const Banner: React.FC<{ tone?: BannerTone; children: ReactNode; role?: 'alert' | 'status' }> = ({
  tone = 'info',
  children,
  role = tone === 'critical' || tone === 'warning' ? 'alert' : 'status',
}) => (
  <div className={`wf-banner wf-banner--${tone}`} role={role}>
    <IonIcon icon={BANNER_ICON[tone]} aria-hidden="true" />
    <div>{children}</div>
  </div>
);
