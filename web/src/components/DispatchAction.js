/**
 * DispatchAction.js — the Tanod-picker-dialog + `POST /dispatch` flow,
 * extracted from `dispatch-center.js`'s Pending Incidents queue so
 * `incident-management.js`'s detail pane can trigger the exact same
 * dispatch (§9 W3) instead of growing a second, drifting copy of it.
 *
 * Admin-only by construction: `createDispatch` -> `POST /dispatch` 403s
 * for any other role server-side (`DispatchController::create`), so this
 * is only ever wired up behind an `user.role === 'admin'` check by its
 * callers — it does not re-check the role itself, same as
 * `createDispatch` in apiClient.js doesn't either.
 */

import { createDispatch, ApiClientError } from '../api/apiClient.js';
import { promptSelect } from './ConfirmDialog.js';
import { showToast } from './Toast.js';

const PRIORITY_LABELS = { normal: 'Normal', high: 'High', critical: 'Critical' };

/**
 * @param {{incidentId:number, priority:string}} incident
 * @param {string} incidentTypeLabel - already-resolved display label (caller owns INCIDENT_TYPE_LABELS)
 * @param {Array<{userId:number, fullName:string}>} eligibleTanods - same-barangay, active, on-duty
 * @returns {Promise<boolean>} true if a dispatch was created; false if cancelled or failed (toast already shown)
 */
export async function promptDispatchTanod({ incident, incidentTypeLabel, eligibleTanods }) {
  if (eligibleTanods.length === 0) return false;

  const tanodId = await promptSelect({
    title: `Assign incident #${incident.incidentId}`,
    description: `${incidentTypeLabel} · ${PRIORITY_LABELS[incident.priority] || incident.priority} priority. The assigned Tanod is notified immediately.`,
    label: 'On-duty Tanod',
    options: eligibleTanods.map((t) => ({ value: t.userId, label: t.fullName })),
    confirmLabel: 'Assign',
  });
  if (tanodId === null) return false;

  try {
    await createDispatch({
      incidentId: incident.incidentId,
      tanodId: Number(tanodId),
      requestId: crypto.randomUUID(),
    });
    const tanodName = eligibleTanods.find((t) => String(t.userId) === String(tanodId))?.fullName || 'Tanod';
    showToast(`Dispatch assigned to ${tanodName}`, { variant: 'success' });
    return true;
  } catch (err) {
    const message = err instanceof ApiClientError ? err.message : 'Could not create the dispatch.';
    showToast(message, { variant: 'error' });
    return false;
  }
}
