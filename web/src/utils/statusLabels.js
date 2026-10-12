/**
 * statusLabels.js — the ONE place incident and dispatch statuses get their
 * plain-English wording, so every screen names the same state the same way
 * (audit D-05). Labels only: API values and CSS class names that derive from
 * the raw status are never changed.
 */

export const INCIDENT_STATUS_LABELS = Object.freeze({
  pending: 'Pending',
  dispatched: 'Responding',
  resolved: 'Resolved',
  duplicate: 'Duplicate',
  invalid: 'Invalid',
  cancelled: 'Cancelled',
  reopened: 'Reopened',
});

export const DISPATCH_STATUS_LABELS = Object.freeze({
  assigned: 'Assigned',
  dispatched: 'Assigned', // legacy spelling some payloads use for a fresh dispatch
  en_route: 'On the way',
  arrived: 'On scene',
  completed: 'Completed',
  cancelled: 'Cancelled',
});
