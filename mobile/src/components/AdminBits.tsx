/**
 * AdminBits.tsx — shared pieces of the Chief Tanod console (decision 15C,
 * stage 1): a required-reason sheet, the read-only incident sheet with the
 * dispatch actions, and a time formatter for server timestamps.
 *
 * Everything here is ONLINE-ONLY. No write is queued, and a success message
 * is only ever shown after the server answered 200/201.
 */

import { useCallback, useEffect, useRef, useState } from 'react';
import { IonIcon, IonModal, IonSpinner } from '@ionic/react';
import { closeOutline } from 'ionicons/icons';
import { Banner } from './WorkflowBits';
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
import { humanize, isActiveDispatchStatus, MAX_REASON, NEEDS_CONNECTION } from './adminFormat';
import { formatServerTime } from './adminFormat';

// ---------------------------------------------------------------------------

interface ReasonSheetProps {
  isOpen: boolean;
  title: string;
  hint: string;
  confirmLabel: string;
  busy: boolean;
  error: string | null;
  onConfirm: (reason: string) => void;
  onClose: () => void;
}

/** Required 1-255 character reason (cancel dispatch, assignment override). */
export const ReasonSheet: React.FC<ReasonSheetProps> = ({ isOpen, title, hint, confirmLabel, busy, error, onConfirm, onClose }) => {
  const online = useOnline();
  const [reason, setReason] = useState('');

  useEffect(() => {
    if (isOpen) setReason('');
  }, [isOpen]);

  const trimmed = reason.trim();
  const valid = trimmed.length >= 1 && trimmed.length <= MAX_REASON;

  return (
    <IonModal
      isOpen={isOpen}
      onDidDismiss={() => {
        if (!busy) onClose();
      }}
      initialBreakpoint={0.7}
      breakpoints={[0, 0.7, 1]}
      className="wf-sheet-modal"
    >
      <div className="wf-sheet">
        <div className="wf-sheet__head">
          <h3 className="wf-sheet__title">{title}</h3>
          <button type="button" className="wf-icon-btn" onClick={onClose} disabled={busy} aria-label="Close">
            <IonIcon icon={closeOutline} />
          </button>
        </div>
        <div className="wf-field">
          <label className="wf-label" htmlFor="admin-reason">
            Reason (required)
          </label>
          <textarea
            id="admin-reason"
            className="wf-input admin-textarea"
            rows={3}
            maxLength={MAX_REASON}
            value={reason}
            onChange={(e) => setReason(e.target.value)}
            disabled={busy}
          />
          <span className="wf-hint">
            {hint} <span className="wf-counter">{trimmed.length}/{MAX_REASON}</span>
          </span>
        </div>
        {!online && <Banner tone="warning">{NEEDS_CONNECTION}. This action is never queued.</Banner>}
        {error && <Banner tone="critical">{error}</Banner>}
        <button
          type="button"
          className="dispatch-primary-cta dispatch-primary-cta--blue"
          onClick={() => onConfirm(trimmed)}
          disabled={busy || !valid || !online}
        >
          {busy ? <IonSpinner name="dots" /> : <span>{online ? confirmLabel : NEEDS_CONNECTION}</span>}
        </button>
        <button type="button" className="dispatch-secondary-cta" onClick={onClose} disabled={busy}>
          Back
        </button>
      </div>
    </IonModal>
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
 * Read-only incident (no narrative is requested or rendered) with the
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

  return (
    <>
      <IonModal
        isOpen={incidentId !== null}
        onDidDismiss={() => {
          if (!busy) onClose();
        }}
        initialBreakpoint={0.92}
        breakpoints={[0, 0.92]}
        className="wf-sheet-modal"
      >
        <div className="wf-sheet admin-incident-sheet">
          <div className="wf-sheet__head">
            <h3 className="wf-sheet__title">{incident?.displayId ?? (incidentId ? `Incident #${incidentId}` : 'Incident')}</h3>
            <button type="button" className="wf-icon-btn" onClick={onClose} disabled={busy} aria-label="Close incident">
              <IonIcon icon={closeOutline} />
            </button>
          </div>

          {loading && !incident && (
            <div style={{ display: 'flex', justifyContent: 'center', padding: '24px 0' }}>
              <IonSpinner name="dots" />
            </div>
          )}
          {loadError && (
            <>
              <Banner tone="critical">{loadError}</Banner>
              <button type="button" className="wf-btn" onClick={() => incidentId !== null && void load(incidentId)}>
                Retry
              </button>
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
                <span className="wf-hint">Read-only. Narratives are never shown in this app.</span>
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
                      <button
                        type="button"
                        className="wf-btn wf-btn--small"
                        disabled={busy || !online}
                        onClick={() => {
                          setActionError(null);
                          cancelKey.current = null;
                          setCancelTarget({ dispatchId: d.dispatchId, tanodName: d.tanodName });
                        }}
                      >
                        {online ? 'Cancel dispatch' : NEEDS_CONNECTION}
                      </button>
                    )}
                  </div>
                ))}
              </div>

              {notice && <Banner tone="success">{notice}</Banner>}
              {actionError && !overrideOpen && !cancelTarget && <Banner tone="critical">{actionError}</Banner>}
              {!online && <Banner tone="warning">{NEEDS_CONNECTION}. Dispatch actions are never queued.</Banner>}

              {assigning ? (
                <div className="wf-card">
                  <strong className="wf-card__title">Assign another responder</strong>
                  {directoryError && <Banner tone="critical">{directoryError}</Banner>}
                  {directory && (
                    <div className="wf-field">
                      <label className="wf-label" htmlFor="admin-assign-tanod">
                        Responder
                      </label>
                      <select
                        id="admin-assign-tanod"
                        className="wf-select"
                        value={pickedTanod}
                        onChange={(e) => setPickedTanod(e.target.value)}
                        disabled={busy}
                      >
                        <option value="">Select a Tanod…</option>
                        {directory
                          .filter((u) => !assignedIds.has(u.userId))
                          .map((u) => (
                            <option key={u.userId} value={u.userId}>
                              {u.fullName}
                            </option>
                          ))}
                      </select>
                    </div>
                  )}
                  <div className="wf-row">
                    <button
                      type="button"
                      className="wf-btn wf-btn--primary"
                      disabled={busy || !online || !pickedTanod}
                      onClick={() => void submitAssign()}
                    >
                      {busy ? <IonSpinner name="dots" /> : online ? 'Assign' : NEEDS_CONNECTION}
                    </button>
                    <button type="button" className="wf-btn" disabled={busy} onClick={() => setAssigning(false)}>
                      Back
                    </button>
                  </div>
                </div>
              ) : (
                <div className="wf-dock admin-dock">
                  <button
                    type="button"
                    className="dispatch-primary-cta dispatch-primary-cta--blue"
                    disabled={busy || !online}
                    onClick={() => void openAssign()}
                  >
                    <span>{online ? 'Assign more responders' : NEEDS_CONNECTION}</span>
                  </button>
                  <button type="button" className="dispatch-secondary-cta" disabled={busy || !online} onClick={() => void takeOver()}>
                    {online ? 'Take over (offer to on-duty Tanods)' : NEEDS_CONNECTION}
                  </button>
                </div>
              )}
            </>
          )}
        </div>
      </IonModal>

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
        confirmLabel="Cancel dispatch"
        busy={busy}
        error={cancelTarget ? actionError : null}
        onConfirm={(reason) => void submitCancel(reason)}
        onClose={() => setCancelTarget(null)}
      />
    </>
  );
};
