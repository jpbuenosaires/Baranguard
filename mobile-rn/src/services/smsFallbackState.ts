/**
 * smsFallbackState.ts — the state model behind M13 SMS Fallback
 * Confirmation (§9). Ported verbatim from ../mobile — pure logic, no
 * platform dependency. Unlike the old app (which built this model ahead of
 * having a real SMS-sending native plugin), this rebuild's `sos-sms` module
 * makes `sent_by_sms`/`sms_failed` reachable from day one, not just typed.
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
 * Returns null when the record has already reached the workstation through
 * its normal transport — M13 is a fallback-specific indicator, not a
 * general sync-state display, shown side by side with M4's sync badge,
 * never merged into one pill.
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

/** Only `sent_by_sms` reads as success — everything else is explicitly NOT success, per §9 M13's "never says successful merely because queued" rule. */
export const SMS_FALLBACK_STATE_TONE: Record<SmsFallbackState, 'success' | 'info' | 'critical' | 'warning'> = {
  sent_by_sms: 'success',
  sms_pending: 'info',
  sms_failed: 'critical',
  saved_locally_for_retry: 'warning',
};
