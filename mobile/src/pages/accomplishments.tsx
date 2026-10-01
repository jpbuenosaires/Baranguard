/**
 * accomplishments.tsx — My Accomplishment Report (contract §4, §9).
 *
 * A Tanod logs what they did on each work day and how long it took; at the end
 * of the month they SUBMIT the month for noting/approval by the barangay
 * officials. Entry capture is OFFLINE-FIRST (Rule 7): Save persists to encrypted
 * SQLite before the sheet closes and goes out via `/sync/batch`. The duration
 * the Tanod enters is the CONFIRMED one; the server separately computes a
 * suggestion from the Tanod's on-duty time and flags a large disagreement —
 * that suggestion only exists after the entry has synced, so it is shown "when
 * available" and the screen says why it is missing otherwise.
 *
 * SUBMIT MONTH IS ONLINE-ONLY by contract: there is deliberately no offline
 * queue behind it. Offline, the button explains that entries are safe on the
 * phone and the month can be submitted once connected. Before submitting, any
 * entries still waiting to sync are pushed first (the server can only submit
 * what it has).
 *
 * Status chip: open / prepared / noted / approved / returned (+ the return
 * reason, shown verbatim). While prepared/noted/approved the entries are locked
 * on this screen — the server would 409 any change. The text of an entry is
 * never logged, and the form tells the Tanod to leave out victim/student names.
 */

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { IonAlert, IonContent, IonIcon, IonModal, IonPage, IonSpinner } from '@ionic/react';
import { addOutline, chevronBackOutline, chevronForwardOutline, closeOutline, paperPlaneOutline } from 'ionicons/icons';
import MobileHeader from '../components/MobileHeader';
import { LoadingBlock } from '../components/LoadingBlock';
import { Banner, SyncChip } from '../components/WorkflowBits';
import {
  ApiError,
  checkHealth,
  submitAccomplishmentReport,
  updateAccomplishmentEntry,
  type AccomplishmentReportStatus,
  type AccomplishmentReportSummary,
} from '../services/apiService';
import {
  applyAcceptedEntryEdit,
  cacheReportSummary,
  countUnsyncedEntriesForMonth,
  earliestWorkDate,
  getCachedReportSummary,
  listEntriesForMonth,
  MAX_ENTRY_TEXT,
  saveEntryLocally,
  updateUnsyncedEntry,
  validateAccomplishment,
} from '../services/db/accomplishmentRepository';
import type { AccomplishmentEntryLocalRow } from '../services/db/localSchema';
import { forceSyncNow, subscribeSyncSummary } from '../services/syncScheduler';
import { refreshAccomplishmentMonth } from '../services/workflowRefresh';
import {
  formatDayLabel,
  formatMinutes,
  formatMonthLabel,
  manilaToday,
  minutesBetweenTimes,
  monthOf,
  shiftMonth,
} from '../utils/manilaTime';
import tacticalFeedback from '../utils/tacticalFeedback';
import { uuid } from '../services/uuid';

const STATUS_PILL: Record<AccomplishmentReportStatus, { label: string; className: string }> = {
  open: { label: 'Open — add your entries', className: 'status-pill--info' },
  prepared: { label: 'Submitted — waiting to be noted', className: 'status-pill--pending' },
  noted: { label: 'Noted — waiting for approval', className: 'status-pill--pending' },
  approved: { label: 'Approved', className: 'status-pill--success' },
  returned: { label: 'Returned for changes', className: 'status-pill--critical' },
};

const LOCKED: AccomplishmentReportStatus[] = ['prepared', 'noted', 'approved'];

interface FormState {
  workDate: string;
  text: string;
  startTime: string;
  endTime: string;
  hours: string;
  minutes: string;
}

const emptyForm = (): FormState => ({ workDate: manilaToday(), text: '', startTime: '', endTime: '', hours: '', minutes: '' });

function splitMinutes(total: number): { hours: string; minutes: string } {
  return { hours: String(Math.floor(total / 60)), minutes: String(total % 60) };
}

function formMinutes(form: FormState): number {
  return (Number(form.hours) || 0) * 60 + (Number(form.minutes) || 0);
}

const AccomplishmentsPage: React.FC = () => {
  const currentMonth = monthOf(manilaToday());
  const [month, setMonth] = useState(currentMonth);
  const [entries, setEntries] = useState<AccomplishmentEntryLocalRow[]>([]);
  const [report, setReport] = useState<AccomplishmentReportSummary | null>(null);
  const [statusFresh, setStatusFresh] = useState(true);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [note, setNote] = useState<{ tone: 'success' | 'info' | 'warning' | 'critical'; text: string } | null>(null);

  const [editor, setEditor] = useState<{ existing: AccomplishmentEntryLocalRow | null } | null>(null);
  const [form, setForm] = useState<FormState>(emptyForm());
  const [durationTouched, setDurationTouched] = useState(false);
  const [saving, setSaving] = useState(false);
  const [formError, setFormError] = useState<string | null>(null);

  const [confirmSubmit, setConfirmSubmit] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  // One Idempotency-Key per submit ACTION: a retry of the same attempt (lost response, dropped
  // link) reuses it so the server replays the original outcome; cleared on success so a
  // resubmit after a return is a fresh action with a fresh key.
  const submitKeyRef = useRef<{ reportId: number; status: AccomplishmentReportStatus; key: string } | null>(null);

  const reloadEntries = useCallback(async (m: string) => {
    try {
      setEntries(await listEntriesForMonth(m));
      setLoadError(null);
    } catch {
      setLoadError('Could not read your saved entries from this phone.');
    }
  }, []);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      setLoading(true);
      setNote(null);
      setReport(await getCachedReportSummary(month));
      await reloadEntries(month);
      if (!cancelled) setLoading(false);
      const result = await refreshAccomplishmentMonth(month);
      if (cancelled) return;
      setStatusFresh(result.fresh);
      setReport(result.report);
      if (result.fresh) await reloadEntries(month);
    })();
    const unsubscribe = subscribeSyncSummary(() => {
      void reloadEntries(month);
      void refreshAccomplishmentMonth(month).then((r) => {
        if (!cancelled) {
          setReport(r.report);
          setStatusFresh(r.fresh);
          void reloadEntries(month);
        }
      });
    });
    return () => {
      cancelled = true;
      unsubscribe();
    };
  }, [month, reloadEntries]);

  const locked = report !== null && LOCKED.includes(report.status);
  const totalMinutes = useMemo(() => entries.reduce((sum, e) => sum + e.duration_minutes, 0), [entries]);
  const flaggedCount = useMemo(() => entries.filter((e) => e.duration_flag === 1).length, [entries]);

  function openEditor(existing: AccomplishmentEntryLocalRow | null) {
    tacticalFeedback.onTap();
    setFormError(null);
    setNote(null);
    setDurationTouched(existing !== null);
    if (existing) {
      setForm({
        workDate: existing.work_date,
        text: existing.accomplishment_text,
        startTime: existing.start_time ?? '',
        endTime: existing.end_time ?? '',
        ...splitMinutes(existing.duration_minutes),
      });
    } else {
      const today = manilaToday();
      // New entries default to today when browsing the current month, else the month's first day.
      setForm({ ...emptyForm(), workDate: monthOf(today) === month ? today : `${month}-01` });
    }
    setEditor({ existing });
  }

  function patchForm(patch: Partial<FormState>) {
    setForm((prev) => {
      const next = { ...prev, ...patch };
      // Auto-fill the duration from start/end until the Tanod types their own.
      if (!durationTouched && ('startTime' in patch || 'endTime' in patch)) {
        const auto = minutesBetweenTimes(next.startTime, next.endTime);
        if (auto !== null) return { ...next, ...splitMinutes(auto) };
      }
      return next;
    });
  }

  async function handleSaveEntry() {
    if (!editor) return;
    setFormError(null);
    const input = {
      workDate: form.workDate,
      text: form.text,
      startTime: form.startTime || null,
      endTime: form.endTime || null,
      durationMinutes: formMinutes(form),
    };
    const existing = editor.existing;
    const problem = validateAccomplishment(input, { allowDateChange: existing === null });
    if (problem) {
      setFormError(problem);
      return;
    }
    setSaving(true);
    tacticalFeedback.onTap();
    try {
      if (!existing) {
        await saveEntryLocally(input);
        setNote({ tone: 'success', text: 'Entry saved on this phone. It will sync when you are connected.' });
        void forceSyncNow();
      } else if (existing.synced === 0) {
        await updateUnsyncedEntry(existing.local_id, input);
        setNote({ tone: 'success', text: 'Entry updated on this phone. It will sync when you are connected.' });
        void forceSyncNow();
      } else if (existing.server_entry_id !== null) {
        // Already on the server: the edit is an online PATCH (contract §4).
        await updateAccomplishmentEntry(existing.server_entry_id, {
          accomplishment_text: input.text.trim(),
          start_time: input.startTime,
          end_time: input.endTime,
          duration_minutes: input.durationMinutes,
        });
        await applyAcceptedEntryEdit(existing.local_id, input);
        setNote({ tone: 'success', text: 'Entry updated.' });
        void refreshAccomplishmentMonth(month).then(() => reloadEntries(month));
      } else {
        throw new Error('This entry is still being confirmed by the server. Try again in a moment.');
      }
      tacticalFeedback.onSuccess();
      setEditor(null);
      await reloadEntries(month);
    } catch (err) {
      tacticalFeedback.onWarning();
      if (err instanceof ApiError && err.isOffline) {
        setFormError('Editing an entry that is already on the server needs a connection. Try again when you are online.');
      } else if (err instanceof ApiError && err.status === 409) {
        setFormError('This report was just submitted or locked, so entries can no longer be changed.');
        void refreshAccomplishmentMonth(month).then((r) => setReport(r.report));
      } else {
        setFormError(err instanceof Error ? err.message : 'Could not save the entry.');
      }
    } finally {
      setSaving(false);
    }
  }

  async function handleSubmitMonth() {
    setConfirmSubmit(false);
    setNote(null);
    setSubmitting(true);
    tacticalFeedback.onTap();
    try {
      // Online-only action (contract §4): say so plainly instead of queueing it.
      if (!(await checkHealth())) {
        setNote({
          tone: 'warning',
          text: 'Submitting the month needs a connection to the barangay workstation. Your entries are saved on this phone — try again when you are online.',
        });
        return;
      }
      // The server can only submit what it has: push waiting entries first.
      if ((await countUnsyncedEntriesForMonth(month)) > 0) {
        await forceSyncNow();
        await reloadEntries(month);
        if ((await countUnsyncedEntriesForMonth(month)) > 0) {
          setNote({
            tone: 'warning',
            text: 'Some entries have not reached the desk yet. Wait for them to sync (see the chips below), then submit again.',
          });
          return;
        }
      }
      const fresh = await refreshAccomplishmentMonth(month);
      setReport(fresh.report);
      setStatusFresh(fresh.fresh);
      if (!fresh.report) {
        setNote({ tone: 'warning', text: 'The desk has not received this month’s entries yet. Try again in a moment.' });
        return;
      }
      if (LOCKED.includes(fresh.report.status)) {
        setNote({ tone: 'info', text: 'This month has already been submitted.' });
        return;
      }
      const pending = submitKeyRef.current;
      const key =
        pending && pending.reportId === fresh.report.reportId && pending.status === fresh.report.status
          ? pending.key
          : uuid();
      submitKeyRef.current = { reportId: fresh.report.reportId, status: fresh.report.status, key };
      const submitted = await submitAccomplishmentReport(fresh.report.reportId, key);
      submitKeyRef.current = null;
      await cacheReportSummary(submitted);
      setReport(submitted);
      tacticalFeedback.onSuccess();
      setNote({ tone: 'success', text: 'Month submitted. The Chief Tanod / officials will review it.' });
    } catch (err) {
      tacticalFeedback.onWarning();
      if (err instanceof ApiError && err.isOffline) {
        setNote({ tone: 'warning', text: 'Lost connection while submitting. Your entries are safe — try again when online.' });
      } else if (err instanceof ApiError && err.status === 409) {
        submitKeyRef.current = null;
        const fresh = await refreshAccomplishmentMonth(month);
        setReport(fresh.report);
        setNote({ tone: 'info', text: 'This month was already submitted or can no longer be submitted. Status refreshed.' });
      } else if (err instanceof ApiError && err.status >= 400 && err.status < 500) {
        // A rejected request will not succeed by replaying it unchanged; the next tap is a new attempt.
        submitKeyRef.current = null;
        setNote({
          tone: 'critical',
          text:
            err.status === 401
              ? 'Your session expired. Sign in again, then submit the month.'
              : `The desk could not accept the submission${err.message ? `: ${err.message}` : '.'} Your entries are safe on this phone.`,
        });
      } else if (err instanceof ApiError) {
        // 5xx: the server may or may not have applied it — keep the key so the retry replays safely.
        setNote({ tone: 'critical', text: 'The barangay workstation had a problem handling the submission. Your entries are safe — try again in a moment.' });
      } else {
        setNote({ tone: 'critical', text: err instanceof Error ? err.message : 'Could not submit the month.' });
      }
    } finally {
      setSubmitting(false);
    }
  }

  const canSubmit = !locked && entries.length > 0;
  const editingExisting = editor?.existing ?? null;
  const suggestion = editingExisting?.suggested_duration_minutes ?? null;
  const pill = report ? STATUS_PILL[report.status] : null;

  return (
    <IonPage>
      <MobileHeader title="My Accomplishments" showBack defaultBackHref="/tabs/profile" />
      <IonContent style={{ '--background': 'var(--color-bg)' }}>
        <div className="wf-page">
          <div className="wf-card">
            <div className="wf-month-stepper">
              <button
                type="button"
                className="wf-icon-btn"
                aria-label="Previous month"
                onClick={() => {
                  tacticalFeedback.onTap();
                  setMonth(shiftMonth(month, -1));
                }}
              >
                <IonIcon icon={chevronBackOutline} />
              </button>
              <span className="wf-month-stepper__label">{formatMonthLabel(month)}</span>
              <button
                type="button"
                className="wf-icon-btn"
                aria-label="Next month"
                disabled={month >= currentMonth}
                onClick={() => {
                  tacticalFeedback.onTap();
                  setMonth(shiftMonth(month, 1));
                }}
              >
                <IonIcon icon={chevronForwardOutline} />
              </button>
            </div>

            <div className="wf-row wf-row--between">
              {pill ? (
                <span className={`status-pill ${pill.className}`}>{pill.label}</span>
              ) : (
                <span className="status-pill status-pill--neutral">
                  {statusFresh ? 'Not submitted yet' : 'Status unavailable offline'}
                </span>
              )}
              <span className="wf-muted">
                {entries.length} entr{entries.length === 1 ? 'y' : 'ies'} · {formatMinutes(totalMinutes)} confirmed
              </span>
            </div>

            {report?.status === 'returned' && (
              <Banner tone="critical">
                Returned for changes{report.returnReason ? `: ${report.returnReason}` : '.'} Update your entries, then
                submit the month again.
              </Banner>
            )}
            {locked && (
              <Banner tone="info">Entries are locked while the report is with the officials. They will unlock only if it is returned.</Banner>
            )}
            {flaggedCount > 0 && !locked && (
              <Banner tone="warning">
                {flaggedCount} entr{flaggedCount === 1 ? 'y has' : 'ies have'} a duration that differs a lot from your
                on-duty time. Double-check before submitting.
              </Banner>
            )}
          </div>

          {note && <Banner tone={note.tone}>{note.text}</Banner>}
          {loadError && <Banner tone="critical">{loadError}</Banner>}

          {loading ? (
            <LoadingBlock label="Loading your entries…" />
          ) : entries.length === 0 ? (
            <div className="wf-card" style={{ textAlign: 'center', alignItems: 'center' }}>
              <h3 className="wf-card__title">No entries for {formatMonthLabel(month)}</h3>
              <p className="wf-card__sub">
                Add what you did on each work day. Entries are saved on your phone even without a signal.
              </p>
            </div>
          ) : (
            <div className="wf-stack">
              {entries.map((entry) => {
                const editable = !locked;
                const body = (
                  <>
                    <div className="wf-row wf-row--between">
                      <strong style={{ fontSize: '0.88rem' }}>{formatDayLabel(entry.work_date)}</strong>
                      <SyncChip row={entry} />
                    </div>
                    <p className="wf-entry__text">{entry.accomplishment_text}</p>
                    <div className="wf-row">
                      <span className="status-pill status-pill--info">Confirmed {formatMinutes(entry.duration_minutes)}</span>
                      {entry.suggested_duration_minutes !== null && (
                        <span className="status-pill status-pill--neutral">
                          Suggested {formatMinutes(entry.suggested_duration_minutes)}
                        </span>
                      )}
                      {entry.duration_flag === 1 && <span className="status-pill status-pill--critical">Check duration</span>}
                    </div>
                    {entry.suggested_duration_minutes === null && (
                      <span className="wf-muted">
                        {entry.synced === 0
                          ? 'A suggested duration (from your on-duty time) appears after this entry syncs.'
                          : 'No suggested duration available for this entry.'}
                      </span>
                    )}
                    {entry.last_sync_error && entry.synced === 0 && (
                      <span className="wf-muted">The desk could not save this yet: {entry.last_sync_error}</span>
                    )}
                  </>
                );
                return editable ? (
                  <button key={entry.local_id} type="button" className="wf-entry" onClick={() => openEditor(entry)}>
                    {body}
                  </button>
                ) : (
                  <div key={entry.local_id} className="wf-entry">
                    {body}
                  </div>
                );
              })}
            </div>
          )}
        </div>
      </IonContent>

      <div className="wf-dock">
        {!locked && (
          <button type="button" className="dispatch-primary-cta dispatch-primary-cta--blue" onClick={() => openEditor(null)} disabled={submitting}>
            <IonIcon icon={addOutline} style={{ fontSize: '1.2rem' }} />
            <span>Add Entry</span>
          </button>
        )}
        {!locked && (
          <button
            type="button"
            className="dispatch-secondary-cta"
            disabled={!canSubmit || submitting}
            onClick={() => {
              tacticalFeedback.onTap();
              setConfirmSubmit(true);
            }}
          >
            {submitting ? <IonSpinner name="dots" /> : <IonIcon icon={paperPlaneOutline} />}
            <span>{report?.status === 'returned' ? 'Resubmit Month' : 'Submit Month'} (needs connection)</span>
          </button>
        )}
      </div>

      <IonAlert
        isOpen={confirmSubmit}
        onDidDismiss={() => setConfirmSubmit(false)}
        header={`Submit ${formatMonthLabel(month)}?`}
        message="This sends your month to the Chief Tanod / officials for noting and approval. Entries are locked until they approve it or return it to you."
        buttons={[
          { text: 'Not yet', role: 'cancel' },
          { text: 'Submit', handler: () => void handleSubmitMonth() },
        ]}
      />

      <IonModal
        isOpen={editor !== null}
        onDidDismiss={() => {
          if (!saving) setEditor(null);
        }}
        initialBreakpoint={0.92}
        breakpoints={[0, 0.92, 1]}
        className="wf-sheet-modal"
      >
        <div className="wf-sheet">
          <div className="wf-sheet__head">
            <h3 className="wf-sheet__title">{editingExisting ? 'Edit Entry' : 'Add Entry'}</h3>
            <button type="button" className="wf-icon-btn" onClick={() => setEditor(null)} disabled={saving} aria-label="Close entry form">
              <IonIcon icon={closeOutline} />
            </button>
          </div>

          <div className="wf-field">
            <label className="wf-label" htmlFor="acc-date">
              Date worked
            </label>
            <input
              id="acc-date"
              className="wf-input"
              type="date"
              value={form.workDate}
              min={earliestWorkDate()}
              max={manilaToday()}
              disabled={saving || editingExisting !== null}
              onChange={(e) => patchForm({ workDate: e.target.value })}
            />
          </div>

          <div className="wf-field">
            <label className="wf-label" htmlFor="acc-text">
              What you did
            </label>
            <textarea
              id="acc-text"
              className="intake-textarea-box"
              rows={4}
              maxLength={MAX_ENTRY_TEXT}
              value={form.text}
              disabled={saving}
              onChange={(e) => patchForm({ text: e.target.value })}
              placeholder="e.g. Night patrol of Purok 3; assisted traffic at the school gate"
            />
            <span className="wf-hint">Describe the work only — leave out names of victims, complainants or students.</span>
            <span className="wf-counter">
              {form.text.length}/{MAX_ENTRY_TEXT}
            </span>
          </div>

          <div className="wf-field-row">
            <div className="wf-field">
              <label className="wf-label" htmlFor="acc-start">
                Start (with end, optional)
              </label>
              <input id="acc-start" className="wf-input" type="time" value={form.startTime} disabled={saving} onChange={(e) => patchForm({ startTime: e.target.value })} />
            </div>
            <div className="wf-field">
              <label className="wf-label" htmlFor="acc-end">
                End (with start, optional)
              </label>
              <input id="acc-end" className="wf-input" type="time" value={form.endTime} disabled={saving} onChange={(e) => patchForm({ endTime: e.target.value })} />
            </div>
          </div>

          <span className="wf-hint">
            Fill in both times or neither. If the work ran past midnight, enter the end time as it appears on the clock
            the next day — it counts as the following day.
          </span>

          <div className="wf-field">
            <span className="wf-label">Confirmed duration</span>
            <div className="wf-field-row">
              <input
                className="wf-input"
                type="number"
                inputMode="numeric"
                min={0}
                max={24}
                placeholder="Hours"
                aria-label="Hours"
                value={form.hours}
                disabled={saving}
                onChange={(e) => {
                  setDurationTouched(true);
                  patchForm({ hours: e.target.value });
                }}
              />
              <input
                className="wf-input"
                type="number"
                inputMode="numeric"
                min={0}
                max={59}
                placeholder="Minutes"
                aria-label="Minutes"
                value={form.minutes}
                disabled={saving}
                onChange={(e) => {
                  setDurationTouched(true);
                  patchForm({ minutes: e.target.value });
                }}
              />
            </div>
            <span className="wf-hint">
              You confirm this time yourself. {formMinutes(form) > 0 ? `Total: ${formatMinutes(formMinutes(form))}.` : ''}
            </span>
          </div>

          {suggestion !== null ? (
            <Banner tone="info">
              Suggested from your on-duty time that day: <strong>{formatMinutes(suggestion)}</strong>.
              {editingExisting?.duration_flag === 1 ? ' Your confirmed time differs a lot from it.' : ''}{' '}
              <button
                type="button"
                className="wf-btn wf-btn--small"
                onClick={() => {
                  setDurationTouched(true);
                  patchForm(splitMinutes(suggestion));
                }}
              >
                Use suggested
              </button>
            </Banner>
          ) : (
            <span className="wf-hint">
              A suggested duration (from your on-duty time) is shown once the entry has synced to the desk.
            </span>
          )}

          {formError && <Banner tone="critical">{formError}</Banner>}

          <button type="button" className="dispatch-primary-cta dispatch-primary-cta--blue" onClick={handleSaveEntry} disabled={saving}>
            {saving ? <IonSpinner name="dots" /> : <span>{editingExisting ? 'Save Changes' : 'Save Entry'}</span>}
          </button>
          <button type="button" className="dispatch-secondary-cta" onClick={() => setEditor(null)} disabled={saving}>
            Cancel
          </button>
        </div>
      </IonModal>
    </IonPage>
  );
};

export default AccomplishmentsPage;
