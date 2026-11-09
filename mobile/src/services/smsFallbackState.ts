/**
 * smsFallbackState.ts — the state model behind the SMS fallback confirmation indicator. The text
 * reflects the actual transport state ('Sent by SMS', 'SMS pending', 'SMS failed', or 'Saved locally
 * for retry') and never says successful merely because the fallback attempt was queued.
 *
 * `sent_by_sms`/`sms_pending`/`sms_failed` are reached only once `smsAttempted` is true; the function
 * never returns a state that claims more than what's true.
 */

export type SmsFallbackState = 'sent_by_sms' | 'sms_pending' | 'sms_failed' | 'saved_locally_for_retry';

export interface SmsFallbackInput {
  /** True once the record reached the workstation through ANY transport (direct POST or sync) — SMS fallback becomes moot the instant this is true. */
  reachedWorkstation: boolean;
  /** True once this device has attempted to send the record as a fallback SMS. */
  smsAttempted: boolean;
  smsStatus: 'pending' | 'sent' | 'failed' | null;
}

/**
 * Returns null when the record has already reached the workstation through its normal transport: this
 * is a fallback-specific indicator, not a general sync-state display (that's `deriveSyncState`); the
 * two are shown side by side, never merged into one pill, so neither misrepresents the other's question.
 */
export function deriveSmsFallbackState(input: SmsFallbackInput): SmsFallbackState | null {
  if (input.reachedWorkstation) {
    return null;
  }
  if (!input.smsAttempted) {
    return 'saved_locally_for_retry';
  }
  switch (input.smsStatus) {
    case 'sent':
      return 'sent_by_sms';
    case 'failed':
      return 'sms_failed';
    case 'pending':
    default:
      return 'sms_pending';
  }
}

export const SMS_FALLBACK_STATE_LABEL: Record<SmsFallbackState, string> = {
  sent_by_sms: 'Sent by SMS',
  sms_pending: 'SMS pending',
  sms_failed: 'SMS failed',
  saved_locally_for_retry: 'Saved locally for retry',
};

/** Status->token mapping. Only `sent_by_sms` reads as success; everything else is explicitly NOT success (never "successful" merely because queued). */
export const SMS_FALLBACK_STATE_PILL: Record<SmsFallbackState, string> = {
  sent_by_sms: 'status-pill--success',
  sms_pending: 'status-pill--info',
  sms_failed: 'status-pill--critical',
  saved_locally_for_retry: 'status-pill--pending',
};
