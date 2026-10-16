/**
 * AdminBits.tsx — shared pieces of the Chief Tanod console (decision 15C,
 * stage 1): a required-reason sheet, the read-only incident sheet with the
 * dispatch actions, and a time formatter for server timestamps.
 *
 * Everything here is ONLINE-ONLY. No write is queued, and a success message
 * is only ever shown after the server answered 200/201.
 */

import { useCallback, useEffect, useId, useRef, useState } from 'react';
import { IonSpinner } from '@ionic/react';
import { Banner, Button, SheetModal } from './ui';
import { useOnline } from './useOnline';
import {
  adminErrorMessage,
  ApiError,
  assignResponder,
  cancelDispatch,
  getAdminIncident,
  getTanodDirectory,
  openDispatchOffer,
  type AdminIncidentDetail,
  type DirectoryUser,
} from '../services/apiService';
import { uuid } from '../services/uuid';
import { formatIncidentCode } from '../utils/incidentCode';
import { buildAssignOptions, formatServerTime, humanize, isActiveDispatchStatus, MAX_REASON, NEEDS_CONNECTION } from './adminFormat';

// ---------------------------------------------------------------------------

interface ReasonSheetProps {
  isOpen: boolean;
  title: string;
  hint: string;
  confirmLabel: string;
  /** Label of the dismiss button (default "Back"). */
  dismissLabel?: string;
  /** "danger" for destructive confirmations such as cancelling a dispatch. */
  tone?: 'primary' | 'danger';
  busy: boolean;
  error: string | null;
  onConfirm: (reason: string) => void;
  onClose: () => void;
}

/** Required 1-255 character reason (cancel dispatch, assignment override). */
export const ReasonSheet: React.FC<ReasonSheetProps> = ({
  isOpen,
  title,
  hint,
  confirmLabel,
  dismissLabel = 'Back',
  tone = 'primary',
  busy,
  error,
  onConfirm,
  onClose,
}) => {
  const online = useOnline();
  const [reason, setReason] = useState('');
  const fieldId = `${useId()}-reason`;

  useEffect(() => {
    if (isOpen) setReason('');
  }, [isOpen]);

  const trimmed = reason.trim();
  const valid = trimmed.length >= 1 && trimmed.length <= MAX_REASON;

  return (
    <SheetModal
      isOpen={isOpen}
      onClose={onClose}
      title={title}
      busy={busy}
      footer={
        <div className="admin-sheet-footer">
          <Button
            variant={tone === 'danger' ? 'danger' : 'primary'}
            size="lg"
            fullWidth
            loading={busy}
            disabled={!valid || !online}
            onClick={() => onConfirm(trimmed)}
          >
            {confirmLabel}
          </Button>
          <Button variant="secondary" fullWidth disabled={busy} onClick={onClose}>
            {dismissLabel}
          </Button>
        </div>
      }
    >
      <div className="admin-sheet-stack">
        <div className="wf-field">
          <label className="wf-label" htmlFor={fieldId}>
            Reason (required)
          </label>
          <textarea
            id={fieldId}
            className="wf-input admin-textarea"
            rows={3}
            maxLength={MAX_REASON}
            value={reason}
            onChange={(e) => setReason(e.target.value)}
            disabled={busy}
            aria-describedby={`${fieldId}-hint`}
          />
          <span id={`${fieldId}-hint`} className="wf-hint">
            {hint} <span className="wf-counter">{trimmed.length}/{MAX_REASON}</span>
          </span>
        </div>
        {!online && <Banner tone="warning">{NEEDS_CONNECTION}. This action is never queued, so the button is disabled.</Banner>}
        {error && <Banner tone="error">{error}</Banner>}
      </div>
    </SheetModal>
  );
};

// ---------------------------------------------------------------------------

interface IncidentSheetProps {
  incidentId: number | null;
  onClose: () => void;
  /** Called after a write the server confirmed, so the parent list refreshes. */
  onChanged: () => void;
}

/**
 * Incident summary (no narrative is requested or rendered) with the
 * Chief Tanod's dispatch controls: assign another responder, cancel a
 * responder's dispatch, and "Take over" (a manual night-dispatch offer).
 */
export const AdminIncidentSheet: React.FC<IncidentSheetProps> = ({ incidentId, onClose, onChanged }) => {
  const online = useOnline();
  const [incident, setIncident] = useState<AdminIncidentDetail | null>(null);
  const [loading, setLoading] = useState(false);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  // Assign flow
  const [assigning, setAssigning] = useState(false);
  const [directory, setDirectory] = useState<DirectoryUser[] | null>(null);
  const [directoryError, setDirectoryError] = useState<string | null>(null);
  const [pickedTanod, setPickedTanod] = useState('');
  const [overrideOpen, setOverrideOpen] = useState(false);
  const assignRequestId = useRef<string | null>(null);

  // Cancel flow
  const [cancelTarget, setCancelTarget] = useState<{ dispatchId: number; tanodName: string | null } | null>(null);
  const cancelKey = useRef<string | null>(null);
  const takeOverKey = useRef<string | null>(null);

  const load = useCallback(async (id: number) => {
    setLoading(true);
    setLoadError(null);
    try {
      setIncident(await getAdminIncident(id));
    } catch (err) {
      setLoadError(adminErrorMessage(err, 'Could not load this incident.'));
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    if (incidentId === null) {
      setIncident(null);
      return;
    }
    setNotice(null);
    setActionError(null);
    setAssigning(false);
    setOverrideOpen(false);
    setCancelTarget(null);
    setPickedTanod('');
    assignRequestId.current = null;
    takeOverKey.current = null;
    void load(incidentId);
  }, [incidentId, load]);

  async function openAssign() {
    setAssigning(true);
    setActionError(null);
    setDirectoryError(null);
    if (directory === null) {
      try {
        setDirectory(await getTanodDirectory());
      } catch (err) {
        setDirectoryError(adminErrorMessage(err, 'Could not load the responder list.'));
      }
    }
  }

  async function submitAssign(overrideReason?: string) {
    if (!incident || !pickedTanod) return;
    if (!assignRequestId.current) assignRequestId.current = uuid();
    setBusy(true);
    setActionError(null);
    try {
      await assignResponder({
        incidentId: incident.incidentId,
        tanodId: Number(pickedTanod),
        requestId: assignRequestId.current,
        overrideReason,
      });
      assignRequestId.current = null;
      setOverrideOpen(false);
      setAssigning(false);
      setPickedTanod('');
      setNotice('Responder assigned.');
      onChanged();
      await load(incident.incidentId);
    } catch (err) {
      if (err instanceof ApiError && err.status === 422 && err.code === 'NO_PUBLISHED_SHIFT' && !overrideReason) {
        // No published shift covers now: ask for a written override reason, then resend.
        setOverrideOpen(true);
      } else {
        setActionError(adminErrorMessage(err, 'Could not assign this responder.'));
      }
    } finally {
      setBusy(false);
    }
  }

  async function submitCancel(reason: string) {
    if (!cancelTarget || !incident) return;
    if (!cancelKey.current) cancelKey.current = uuid();
    setBusy(true);
    setActionError(null);
    try {
      await cancelDispatch(cancelTarget.dispatchId, reason, cancelKey.current);
      cancelKey.current = null;
      setCancelTarget(null);
      setNotice('Dispatch cancelled.');
      onChanged();
      await load(incident.incidentId);
    } catch (err) {
      setActionError(adminErrorMessage(err, 'Could not cancel this dispatch.'));
    } finally {
      setBusy(false);
    }
  }

  async function takeOver() {
    if (!incident) return;
    if (!takeOverKey.current) takeOverKey.current = uuid();
    setBusy(true);
    setActionError(null);
    try {
      await openDispatchOffer(incident.incidentId, takeOverKey.current);
      takeOverKey.current = null;
      setNotice('Offer opened to on-duty Tanods.');
      onChanged();
    } catch (err) {
      setActionError(adminErrorMessage(err, 'Could not open an offer.'));
    } finally {
      setBusy(false);
    }
  }

  const activeDispatches = incident?.dispatches.filter((d) => isActiveDispatchStatus(d.status)) ?? [];
  const assignedIds = new Set(activeDispatches.map((d) => d.tanodId));
  const assignFieldId = `${useId()}-assign-tanod`;
  // Only one sheet at a time: the incident sheet steps aside while a reason sheet is up.
  const subSheetOpen = overrideOpen || cancelTarget !== null;

  return (
    <>
      <SheetModal
        isOpen={incidentId !== null && !subSheetOpen}
        onClose={() => {
          if (!subSheetOpen) onClose();
        }}
        title={(incidentId ? formatIncidentCode({ displayId: incident?.displayId, serverIncidentId: incidentId }) : null) ?? 'Incident'}
        busy={busy}
        closeLabel="Close incident"
      >
        <div className="admin-sheet-stack">
          {loading && !incident && (
            <div className="admin-sheet-loading">
              <IonSpinner name="dots" />
            </div>
          )}
          {loadError && (
            <>
              <Banner tone="error">{loadError}</Banner>
              <Button variant="secondary" onClick={() => incidentId !== null && void load(incidentId)}>
                Retry
              </Button>
            </>
          )}

          {incident && (
            <>
              <div className="wf-card">
                <div className="wf-row wf-row--between">
                  <strong className="wf-card__title">{humanize(incident.incidentType)}</strong>
                  <span className="status-pill status-pill--info">{humanize(incident.status)}</span>
                </div>
                <div className="wf-card__sub">Priority: {humanize(incident.priority)}</div>
                <div className="wf-card__sub">Reported: {formatServerTime(incident.createdAt)}</div>
                {incident.reportChannel && <div className="wf-card__sub">Channel: {humanize(incident.reportChannel)}</div>}
                <div className="wf-card__sub">Location: {incident.locationDescription ?? 'No description recorded'}</div>
                <span className="wf-hint">Narratives are never shown in this app.</span>
              </div>

              <div className="wf-card">
                <strong className="wf-card__title">Responders</strong>
                {incident.dispatches.length === 0 && <span className="wf-muted">No responder has been dispatched.</span>}
                {incident.dispatches.map((d) => (
                  <div key={d.dispatchId} className="wf-row wf-row--between">
                    <div>
                      <div>{d.tanodName ?? `Tanod #${d.tanodId}`}</div>
                      <span className="wf-card__sub">{humanize(d.status)}</span>
                    </div>
                    {isActiveDispatchStatus(d.status) && (
                      <Button
                        variant="danger"
                        disabled={busy || !online}
                        onClick={() => {
                          setActionError(null);
                          cancelKey.current = null;
                          setCancelTarget({ dispatchId: d.dispatchId, tanodName: d.tanodName });
                        }}
                      >
                        Cancel dispatch
                      </Button>
                    )}
                  </div>
                ))}
              </div>

              {notice && <Banner tone="success">{notice}</Banner>}
              {actionError && !subSheetOpen && <Banner tone="error">{actionError}</Banner>}
              {!online && <Banner tone="warning">{NEEDS_CONNECTION}. Dispatch actions are disabled and never queued.</Banner>}

              {assigning ? (
                <div className="wf-card">
                  <strong className="wf-card__title">Assign another responder</strong>
                  {directoryError && <Banner tone="error">{directoryError}</Banner>}
                  {directory && (
                    <div className="wf-field">
                      <label className="wf-label" htmlFor={assignFieldId}>
                        Responder
                      </label>
                      <select
                        id={assignFieldId}
                        className="wf-select"
                        value={pickedTanod}
                        onChange={(e) => setPickedTanod(e.target.value)}
                        disabled={busy}
                      >
                        <option value="">Select a Tanod…</option>
                        {buildAssignOptions(directory, assignedIds).map((u) => (
                          <option key={u.userId} value={u.userId} disabled={u.assigned}>
                            {u.label}
                          </option>
                        ))}
                      </select>
                      <span className="wf-hint">Shift availability is not available on the phone. Check the roster on the dashboard if unsure.</span>
                    </div>
                  )}
                  <div className="admin-actions">
                    <Button loading={busy} disabled={!online || !pickedTanod} onClick={() => void submitAssign()}>
                      Assign
                    </Button>
                    <Button variant="secondary" disabled={busy} onClick={() => setAssigning(false)}>
                      Back
                    </Button>
                  </div>
                </div>
              ) : (
                <div className="admin-sheet-footer">
                  <Button size="lg" fullWidth disabled={busy || !online} onClick={() => void openAssign()}>
                    Assign more responders
                  </Button>
                  <Button variant="secondary" fullWidth disabled={busy || !online} onClick={() => void takeOver()}>
                    Take over (offer to on-duty Tanods)
                  </Button>
                </div>
              )}
            </>
          )}
        </div>
      </SheetModal>

      <ReasonSheet
        isOpen={overrideOpen}
        title="No published shift"
        hint="This Tanod has no published shift covering now. State why you are assigning them anyway; it is recorded."
        confirmLabel="Assign with override"
        busy={busy}
        error={overrideOpen ? actionError : null}
        onConfirm={(reason) => void submitAssign(reason)}
        onClose={() => setOverrideOpen(false)}
      />
      <ReasonSheet
        isOpen={cancelTarget !== null}
        title={`Cancel dispatch${cancelTarget?.tanodName ? ` for ${cancelTarget.tanodName}` : ''}`}
        hint="Required. Say why this responder is being pulled off."
        confirmLabel="Confirm cancellation"
        dismissLabel="Keep dispatch"
        tone="danger"
        busy={busy}
        error={cancelTarget ? actionError : null}
        onConfirm={(reason) => void submitCancel(reason)}
        onClose={() => setCancelTarget(null)}
      />
    </>
  );
};
