/**
 * smsFallbackState.ts — the state model behind M13 SMS Fallback
 * Confirmation (§9, "Persistent element"): "Text reflects the actual
 * transport state: 'Sent by SMS,' 'SMS pending,' 'SMS failed,' or 'Saved
 * locally for retry.' It never says successful merely because the
 * fallback attempt was queued."
 *
 * SCOPE, STATED PLAINLY: this file implements the full 4-state model
 * correctly and completely, but on-device SMS SENDING (Android's
 * SmsManager, via a native plugin, with the SEND_SMS runtime permission)
 * is NOT built this cut — the same scoping decision this session already
 * made for the SERVER's GSM-modem OUTBOUND transport, for the identical
 * reason: no hardware/credentials exist here to build or test it against,
 * and it is a genuinely separate, sizeable native integration (comparable
 * to Sprint 2's Camera/Voice work), not a rider on this cut. See
 * DEVLOG.md.
 *
 * Consequence: `sent_by_sms`/`sms_pending`/`sms_failed` are real, typed,
 * reachable states in this function's contract — ready the moment SMS
 * sending is wired up — but in THIS build, only `saved_locally_for_retry`
 * is ever actually produced, because nothing yet sets `smsAttempted`. That
 * is the honest, current-capability answer, not a placeholder pretending
 * otherwise — the function still never returns a state that claims more
 * than what's true.
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
 * Returns null when the record has already reached the workstation
 * through its normal transport — M13 is a fallback-specific indicator,
 * not a general sync-state display (that's M4's `deriveSyncState`); the
 * two are shown side by side, never merged into one pill, so neither
 * misrepresents the other's question.
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

/** §8's status→token mapping. Only `sent_by_sms` reads as success — everything else is explicitly NOT success, per §9 M13's own "never says successful merely because queued" rule. */
export const SMS_FALLBACK_STATE_PILL: Record<SmsFallbackState, string> = {
  sent_by_sms: 'status-pill--success',
  sms_pending: 'status-pill--info',
  sms_failed: 'status-pill--critical',
  saved_locally_for_retry: 'status-pill--pending',
};
