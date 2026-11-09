/**
 * SmsFallbackBadge.tsx — the display half of the SMS fallback confirmation. Renders nothing when
 * `deriveSmsFallbackState` returns null (the record already reached the workstation — there is no
 * fallback state to confirm).
 */

import type { SmsFallbackInput } from '../services/smsFallbackState';
import { deriveSmsFallbackState, SMS_FALLBACK_STATE_LABEL, SMS_FALLBACK_STATE_PILL } from '../services/smsFallbackState';

const SmsFallbackBadge: React.FC<{ input: SmsFallbackInput }> = ({ input }) => {
  const state = deriveSmsFallbackState(input);
  if (!state) {
    return null;
  }
  return <span className={`status-pill ${SMS_FALLBACK_STATE_PILL[state]}`}>{SMS_FALLBACK_STATE_LABEL[state]}</span>;
};

export default SmsFallbackBadge;
