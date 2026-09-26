/**
 * Derives a human-readable "where does this incident stand re: the
 * blotter" status purely from data the server already returns — no new
 * field, column, or endpoint. Not every incident should become a blotter
 * (some are legitimately just incident reports, closed without a
 * dispute); this exists so the Blotter tab and its workflow stepper can
 * say which of the three real situations applies instead of rendering a
 * flat "no blotter yet" note regardless of whether one is still pending,
 * was never needed, or already exists.
 */

export const TERMINAL_INCIDENT_STATUSES = ['resolved', 'cancelled', 'invalid', 'duplicate'];

/**
 * @param {{status?: string, redactionApprovedAt?: string|null}} incident
 * @param {{finalizedAt?: string|null}|null} blotter
 * @returns {{key: string, label: string, tone: 'positive'|'attention'|'neutral', description: string}}
 */
export function getBlotterStatusInfo(incident, blotter) {
  const finalized = Boolean(blotter?.finalizedAt);

  if (finalized) {
    return {
      key: 'finalized',
      label: 'Blotter finalized',
      tone: 'positive',
      description: 'This incident was finalized into a blotter entry.',
    };
  }

  if (TERMINAL_INCIDENT_STATUSES.includes(incident?.status)) {
    return {
      key: 'closed_no_blotter',
      label: 'Closed — no blotter',
      tone: 'neutral',
      description: 'This incident was closed as a report only; no blotter record was created.',
    };
  }

  if (incident?.redactionApprovedAt) {
    return {
      key: 'awaiting_decision',
      label: 'Awaiting blotter decision',
      tone: 'attention',
      description: 'Redaction is approved. A Secretary can finalize this into a blotter entry, or leave it as a report only.',
    };
  }

  return {
    key: 'not_started',
    label: 'No blotter yet',
    tone: 'neutral',
    description: 'This incident has not been recorded in the barangay blotter. A Secretary finalizes it into one from the Blotter tab, once the AI redaction is approved.',
  };
}
