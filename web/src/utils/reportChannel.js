/**
 * reportChannel.js — the four ways a report can reach the barangay
 * (`incident.report_channel`, migration 0036). Distinct from `incident.source`
 * (which client created the row): the channel records how the matter was
 * reported, e.g. a walk-in typed by the Secretary is channel `walk_in`.
 */

/** Order matters: it is the order of the Log-an-Incident select. */
export const REPORT_CHANNEL_OPTIONS = [
  { value: 'tanod_alerted', label: 'Tanod alerted' },
  { value: 'walk_in', label: 'Walk-in' },
  { value: 'sms', label: 'SMS' },
  { value: 'other', label: 'Other' },
];

/** What a web-created incident defaults to. */
export const DEFAULT_WEB_REPORT_CHANNEL = 'walk_in';

/**
 * @param {string|null|undefined} value
 * @returns {string|null} the display label, or null when the server sent none
 */
export function reportChannelLabel(value) {
  if (!value) return null;
  return REPORT_CHANNEL_OPTIONS.find((o) => o.value === value)?.label ?? 'Other';
}
