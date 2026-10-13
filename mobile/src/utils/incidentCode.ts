/**
 * incidentCode.ts — the one place a Tanod-facing incident label is built.
 *
 * The official code is the server's `display_id` (`INC-YYYY-NNN`, numbered
 * per barangay and year). It can NOT be derived from the numeric incident id,
 * so it is never invented here:
 *   - display_id known            -> the official code;
 *   - synced, code not fetched yet -> `INC-#<id>` (visibly unofficial);
 *   - not synced yet              -> null (screens show "Saved on Phone").
 */
export function formatIncidentCode(input: {
  displayId?: string | null;
  serverIncidentId?: number | null;
}): string | null {
  const code = input.displayId?.trim();
  if (code) return code;
  if (input.serverIncidentId !== null && input.serverIncidentId !== undefined) {
    return `INC-#${input.serverIncidentId}`;
  }
  return null;
}

/** Short device-local reference for a report that has no server id yet; always labelled "Local". */
export function localReportRef(clientEventId: string): string {
  return `Local ${clientEventId.slice(0, 6)}`;
}
