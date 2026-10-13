/**
 * syncQueueSummary.ts: pure formatting for the Sync queue sheet. No I/O, no
 * React. It only re-words counts the sync layer already produced; it never
 * renames or alters the underlying statuses (success, duplicate, failed).
 */

import type { SyncState } from './ui/syncText';

export interface SyncResultCounts {
  succeeded: number;
  duplicates: number;
  failed: number;
  evidenceUploaded: number;
  evidenceFailed: number;
  dispatchRejected: number;
  dutyRejected: number;
}

export interface SyncResultView {
  /** 'success' only when nothing failed or was rejected. */
  tone: 'success' | 'warning';
  headline: string;
  /** Extra plain sentences (evidence, rejected status changes). */
  details: string[];
}

const plural = (n: number, one: string, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;

/** "3 sent, 1 already received by the server, 2 not sent". Never says "finished" while anything failed. */
export function formatSyncResult(r: SyncResultCounts): SyncResultView {
  const parts: string[] = [];
  if (r.succeeded > 0) parts.push(`${r.succeeded} sent`);
  if (r.duplicates > 0) parts.push(`${r.duplicates} already received by the server`);
  if (r.failed > 0) parts.push(`${r.failed} not sent`);

  const details: string[] = [];
  if (r.dispatchRejected > 0) {
    details.push(`${plural(r.dispatchRejected, 'status change')} rejected by HQ and reverted.`);
  }
  if (r.dutyRejected > 0) {
    details.push(`${plural(r.dutyRejected, 'offline off-duty change')} rejected by HQ. See Home.`);
  }
  if (r.evidenceUploaded > 0 || r.evidenceFailed > 0) {
    details.push(
      `${plural(r.evidenceUploaded, 'evidence file')} sent` +
        (r.evidenceFailed > 0 ? `, ${r.evidenceFailed} not sent and will retry` : '') +
        '.'
    );
  }

  const problem = r.failed > 0 || r.dispatchRejected > 0 || r.dutyRejected > 0 || r.evidenceFailed > 0;
  let headline: string;
  if (parts.length === 0) {
    headline = problem ? 'Nothing was sent.' : 'Nothing was waiting to send.';
  } else {
    headline = `${parts.join(', ')}.`;
  }
  return { tone: problem ? 'warning' : 'success', headline, details };
}

export interface QueueKindCounts {
  sos: number;
  incidents: number;
  dispatchAndDuty: number;
  referrals: number;
  workflowRecords: number;
  gps: number;
}

export interface QueueAttentionCounts {
  sos: number;
  incidents: number; // incident reports + evidence files
  dispatchAndDuty: number;
  referrals: number;
  workflowRecords: number;
  gps: number;
}

export type QueueKind = keyof QueueKindCounts;

export interface QueueRowView {
  kind: QueueKind;
  label: string;
  pending: number;
  failed: number;
  /** Null when nothing is waiting or failed for this kind. */
  state: SyncState | null;
  /** Extra guidance shown under a failed row. */
  note: string | null;
}

/** SOS first, always. */
export const QUEUE_ORDER: readonly QueueKind[] = ['sos', 'incidents', 'dispatchAndDuty', 'referrals', 'workflowRecords', 'gps'];

const LABEL: Record<QueueKind, string> = {
  sos: 'Emergency SOS alerts',
  incidents: 'Incident reports',
  dispatchAndDuty: 'Dispatch and duty status updates',
  referrals: 'Referrals',
  workflowRecords: 'Availability, accomplishments and school check-ins',
  gps: 'Location history',
};

const FAILED_NOTE: Partial<Record<QueueKind, string>> = {
  sos: 'Call the barangay desk.',
  dispatchAndDuty: 'Status changes that could not be confirmed were reverted. Check your assignment and Home.',
};

export function buildQueueRows(
  pending: QueueKindCounts,
  failed: QueueAttentionCounts,
  online: boolean | null
): QueueRowView[] {
  return QUEUE_ORDER.map((kind) => {
    const p = pending[kind];
    const f = failed[kind];
    let state: SyncState | null = null;
    if (f > 0) state = 'failed';
    else if (p > 0) state = online ? 'saved_on_phone' : 'waiting_connection';
    return { kind, label: LABEL[kind], pending: p, failed: f, state, note: f > 0 ? FAILED_NOTE[kind] ?? null : null };
  });
}

/** Header line: "5 waiting, 2 need attention". */
export function formatQueueHeader(totalPending: number, attentionTotal: number): string {
  if (totalPending === 0 && attentionTotal === 0) return 'Nothing is waiting to send.';
  const parts: string[] = [];
  parts.push(`${totalPending} waiting to send`);
  if (attentionTotal > 0) parts.push(`${attentionTotal} need${attentionTotal === 1 ? 's' : ''} attention`);
  return parts.join(', ');
}
