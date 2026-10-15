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
 * Status chip: open / prepared / returned (+ the return
 * reason, shown verbatim). While prepared the entries are locked
 * on this screen — the server would 409 any change. The text of an entry is
 * never logged, and the form tells the Tanod to leave out victim/student names.
 */

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { IonAlert, IonContent, IonIcon, IonPage, IonRefresher, IonRefresherContent, useIonViewWillEnter } from '@ionic/react';
import { addOutline, chevronBackOutline, chevronForwardOutline, paperPlaneOutline } from 'ionicons/icons';
import MobileHeader from '../components/MobileHeader';
import { LoadingBlock } from '../components/LoadingBlock';
import { Banner, SyncChip } from '../components/WorkflowBits';
import { Button, EmptyState, ErrorState } from '../components/ui';
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
  getCachedReportSummary,
  listEntriesForMonth,
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
import { emptyForm, formMinutes, splitMinutes, type FormState } from '../utils/accomplishmentForm';
import { AccomplishmentEntrySheet } from '../components/forms/AccomplishmentEntrySheet';

/** "0 hours logged", "45 minutes logged", "2 hours 30 minutes logged" (real totals). */
function hoursLogged(total: number): string {
  const h = Math.floor(total / 60);
  const m = total % 60;
  if (total === 0) return '0 hours logged';
  const parts = [h > 0 ? `${h} hour${h === 1 ? '' : 's'}` : '', m > 0 ? `${m} minute${m === 1 ? '' : 's'}` : ''];
  return `${parts.filter(Boolean).join(' ')} logged`;
}

/** Sync events can arrive in bursts; reload at most about once a second. */
const SYNC_REFRESH_DEBOUNCE_MS = 1000;

const STATUS_PILL: Record<AccomplishmentReportStatus, { label: string; className: string }> = {
  open: { label: 'Open', className: 'status-pill--info' },
  prepared: { label: 'Prepared', className: 'status-pill--success' },
  returned: { label: 'Returned', className: 'status-pill--critical' },
};

const LOCKED: AccomplishmentReportStatus[] = ['prepared'];

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
  const [timesOpen, setTimesOpen] = useState(false);

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

  // Tab-stack page stays mounted: re-read local entries and the server status on each visit,
  // without a loading flash. The first enter is covered by the month effect below.
  const firstEnter = useRef(true);
  useIonViewWillEnter(() => {
    if (firstEnter.current) {
      firstEnter.current = false;
      return;
    }
    void (async () => {
      await reloadEntries(month);
      const result = await refreshAccomplishmentMonth(month);
      setStatusFresh(result.fresh);
      setReport(result.report);
      if (result.fresh) await reloadEntries(month);
    })();
  });

  const pullRefresh = useCallback(
    async (done: () => void) => {
      try {
        await reloadEntries(month);
        const result = await refreshAccomplishmentMonth(month);
        setStatusFresh(result.fresh);
        setReport(result.report);
        if (result.fresh) await reloadEntries(month);
      } finally {
        done();
      }
    },
    [month, reloadEntries]
  );

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
    let syncTimer: ReturnType<typeof setTimeout> | null = null;
    const unsubscribe = subscribeSyncSummary(() => {
      // Debounced: same reload and refresh, just not once per sync event.
      if (syncTimer !== null) clearTimeout(syncTimer);
      syncTimer = setTimeout(() => {
        syncTimer = null;
        if (cancelled) return;
        void reloadEntries(month);
        void refreshAccomplishmentMonth(month).then((r) => {
          if (!cancelled) {
            setReport(r.report);
            setStatusFresh(r.fresh);
            void reloadEntries(month);
          }
        });
      }, SYNC_REFRESH_DEBOUNCE_MS);
    });
    return () => {
      cancelled = true;
      if (syncTimer !== null) clearTimeout(syncTimer);
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
    setTimesOpen(Boolean(existing?.start_time || existing?.end_time));
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
        setNote({ tone: 'success', text: 'Saved on this phone, will send when online.' });
        void forceSyncNow();
      } else if (existing.synced === 0) {
        await updateUnsyncedEntry(existing.local_id, input);
        setNote({ tone: 'success', text: 'Updated. Saved on this phone, will send when online.' });
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
  const pill = report ? STATUS_PILL[report.status] : null;
  const submitBlockedReason = entries.length === 0 ? 'Add an entry first. Submitting needs a connection.' : null;

  return (
    <IonPage>
      <MobileHeader title="My Accomplishments" showBack defaultBackHref="/tabs/profile" />
      <IonContent className="content-bg">
        <IonRefresher slot="fixed" onIonRefresh={(e) => void pullRefresh(() => e.detail.complete())}>
          <IonRefresherContent />
        </IonRefresher>
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
                {entries.length} entr{entries.length === 1 ? 'y' : 'ies'} · {hoursLogged(totalMinutes)}
              </span>
            </div>

            {report?.status === 'returned' && (
              <Banner tone="critical">
                Returned for changes{report.returnReason ? `: ${report.returnReason}` : '.'} Update your entries, then
                submit the month again.
              </Banner>
            )}
            {locked && (
              <Banner tone="info">
                Submitted. Print and sign it at the barangay hall. Entries stay locked unless it is returned.
              </Banner>
            )}
            {flaggedCount > 0 && !locked && (
              <Banner tone="warning">
                {flaggedCount} entr{flaggedCount === 1 ? 'y has' : 'ies have'} a duration that differs a lot from your
                on-duty time. Double-check before submitting.
              </Banner>
            )}
          </div>

          {loadError && entries.length > 0 && <Banner tone="critical">{loadError}</Banner>}

          {loading ? (
            <LoadingBlock label="Loading your entries…" />
          ) : loadError && entries.length === 0 ? (
            <ErrorState message={loadError} onRetry={() => void reloadEntries(month)} />
          ) : entries.length === 0 ? (
            <EmptyState
              title={`No entries for ${formatMonthLabel(month)}`}
              body="Add what you did on each work day. Entries are saved on your phone even without a signal."
              action={
                !locked ? (
                  <Button variant="primary" icon={addOutline} onClick={() => openEditor(null)} disabled={submitting}>
                    Add first entry
                  </Button>
                ) : undefined
              }
            />
          ) : (
            <div className="wf-stack">
              {entries.map((entry) => {
                const editable = !locked;
                const flagged = entry.duration_flag === 1;
                const body = (
                  <>
                    <div className="wf-row wf-row--between">
                      <strong className="p4w-entry__date">{formatDayLabel(entry.work_date)}</strong>
                      <SyncChip row={entry} />
                    </div>
                    <p className="wf-entry__text">{entry.accomplishment_text}</p>
                    <div className="wf-row">
                      <span className="status-pill status-pill--info">{formatMinutes(entry.duration_minutes)}</span>
                      {flagged && entry.suggested_duration_minutes !== null && (
                        <span className="status-pill status-pill--neutral">
                          Suggested {formatMinutes(entry.suggested_duration_minutes)}
                        </span>
                      )}
                      {flagged && <span className="status-pill status-pill--critical">Differs from the duty record</span>}
                    </div>
                    {entry.last_sync_error && entry.synced === 0 && (
                      <span className="wf-muted">The desk could not save this yet: {entry.last_sync_error}</span>
                    )}
                  </>
                );
                return editable ? (
                  <button
                    key={entry.local_id}
                    type="button"
                    className="wf-entry"
                    aria-label={`Edit entry ${formatDayLabel(entry.work_date)}`}
                    onClick={() => openEditor(entry)}
                  >
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
        {note && <Banner tone={note.tone}>{note.text}</Banner>}
        {!locked && (
          <>
            {entries.length > 0 && (
              <Button variant="primary" size="lg" fullWidth icon={addOutline} onClick={() => openEditor(null)} disabled={submitting}>
                Add entry
              </Button>
            )}
            <div className="p4w-dock-secondary">
              {submitBlockedReason && <span className="wf-hint p4w-dock-reason">{submitBlockedReason}</span>}
              <Button
                variant="secondary"
                icon={paperPlaneOutline}
                loading={submitting}
                disabled={!canSubmit}
                onClick={() => {
                  tacticalFeedback.onTap();
                  setConfirmSubmit(true);
                }}
              >
                {report?.status === 'returned' ? 'Resubmit month' : 'Submit month'}
              </Button>
            </div>
          </>
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

      <AccomplishmentEntrySheet
        isOpen={editor !== null}
        existing={editingExisting}
        form={form}
        saving={saving}
        formError={formError}
        timesOpen={timesOpen}
        onToggleTimes={() => setTimesOpen((v) => !v)}
        onPatch={patchForm}
        onDurationTouched={() => setDurationTouched(true)}
        onSave={handleSaveEntry}
        onClose={() => setEditor(null)}
      />
    </IonPage>
  );
};

export default AccomplishmentsPage;
