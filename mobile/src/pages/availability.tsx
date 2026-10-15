/**
 * availability.tsx — Availability submission (contract §3, docs/FEATURE_
 * CONTRACT_2026-10.md §9).
 *
 * A Tanod tells the desk which dates and time windows they can serve in a
 * period. Since 2026-10-12 this is the tanod's own FIXED statement: nobody at
 * the desk accepts it or asks for changes, and the desk can only schedule the
 * tanod inside these windows (the server refuses a shift outside them). The
 * tanod can change a period at any time (the server bumps its version). This
 * screen is OFFLINE-FIRST (Rule 7): Save writes to encrypted SQLite before the
 * form closes and the record goes out through `/sync/batch` (`availability[]`).
 * The chip beside every period says only what the row can prove — "Saved on
 * phone" until a sync confirms it. Legacy review fields from before
 * 2026-10-12 are kept in the local row but no longer shown.
 *
 * Dates are plain Manila `YYYY-MM-DD` strings (utils/manilaTime.ts); times are
 * `HH:MM`. Native <input type="date|time"> keep this working with the WebView's
 * own pickers.
 */

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { IonAlert, IonContent, IonIcon, IonPage, IonRefresher, IonRefresherContent, useIonViewWillEnter } from '@ionic/react';
import { addOutline, calendarOutline, checkmarkCircleOutline, closeOutline, createOutline, trashOutline } from 'ionicons/icons';
import MobileHeader from '../components/MobileHeader';
import { LoadingBlock } from '../components/LoadingBlock';
import { Banner, SyncChip } from '../components/WorkflowBits';
import { Button, EmptyState, ErrorState } from '../components/ui';
import {
  isPeriodPast,
  listAvailability,
  MAX_AVAILABILITY_WINDOWS,
  parseLocalWindows,
  saveAvailabilityLocally,
  validateAvailability,
} from '../services/db/availabilityRepository';
import { deriveWorkflowSyncState } from '../services/db/workflowSync';
import type { AvailabilityLocalRow, AvailabilityWindow } from '../services/db/localSchema';
import { forceSyncNow, subscribeSyncSummary } from '../services/syncScheduler';
import { refreshAvailabilityFromServer } from '../services/workflowRefresh';
import { addDays, daysBetween, eachDate, formatDayLabel, formatPeriodLabel, manilaToday } from '../utils/manilaTime';
import tacticalFeedback from '../utils/tacticalFeedback';
import { fillAllDays, fillWeekdays } from '../utils/workflowForm';

/** A single period longer than this is hard to read on a phone; the form asks for a shorter one. */
const MAX_PERIOD_DAYS = 31;
const DEFAULT_START = '08:00';
const DEFAULT_END = '17:00';

interface DraftWindow extends AvailabilityWindow {
  key: number;
}

let draftKey = 0;
const newDraft = (date: string, start = DEFAULT_START, end = DEFAULT_END): DraftWindow => ({
  key: (draftKey += 1),
  date,
  start,
  end,
});

/** Friendly overlap check: two windows on the same day that intersect. */
function findOverlap(windows: AvailabilityWindow[]): string | null {
  const byDay = new Map<string, AvailabilityWindow[]>();
  for (const w of windows) byDay.set(w.date, [...(byDay.get(w.date) ?? []), w]);
  for (const [date, list] of byDay) {
    const sorted = [...list].sort((a, b) => a.start.localeCompare(b.start));
    for (let i = 1; i < sorted.length; i += 1) {
      if (sorted[i].start < sorted[i - 1].end) return `Two time windows overlap on ${formatDayLabel(date)}.`;
    }
  }
  return null;
}

const AvailabilityPage: React.FC = () => {
  const [rows, setRows] = useState<AvailabilityLocalRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [serverCopyStale, setServerCopyStale] = useState(false);
  const [note, setNote] = useState<string | null>(null);

  // Editor state (null = list view)
  const [editing, setEditing] = useState<{ existing: AvailabilityLocalRow | null } | null>(null);
  const [periodStart, setPeriodStart] = useState('');
  const [periodEnd, setPeriodEnd] = useState('');
  const [drafts, setDrafts] = useState<DraftWindow[]>([]);
  const [saving, setSaving] = useState(false);
  const [formError, setFormError] = useState<string | null>(null);
  const [confirmDiscard, setConfirmDiscard] = useState(false);
  // A change that would drop or overwrite windows the Tanod already entered waits for a yes.
  const [pendingChange, setPendingChange] = useState<{ message: string; apply: () => void } | null>(null);
  // Snapshot taken when the editor opens, to tell whether the drafts changed.
  const initialSnapshot = useRef('');
  const snapshot = (s: string, e: string, d: DraftWindow[]) => JSON.stringify([s, e, d.map((w) => [w.date, w.start, w.end])]);

  const reload = useCallback(async () => {
    try {
      setRows(await listAvailability());
      setLoadError(null);
    } catch {
      setLoadError('Could not read saved availability from this phone.');
    }
  }, []);

  const loadedOnce = useRef(false);

  // Quiet refresh: the local list first, then the server copy; no loading flash after the first load.
  const refresh = useCallback(async () => {
    if (!loadedOnce.current) setLoading(true);
    await reload();
    loadedOnce.current = true;
    setLoading(false);
    const ok = await refreshAvailabilityFromServer({ force: true });
    setServerCopyStale(!ok);
    if (ok) await reload();
  }, [reload]);

  // Tab-stack page stays mounted: refresh on every visit.
  useIonViewWillEnter(() => {
    void refresh();
  });

  useEffect(() => {
    const unsubscribe = subscribeSyncSummary(() => void reload());
    return unsubscribe;
  }, [reload]);

  function openNew() {
    tacticalFeedback.onTap();
    const start = addDays(manilaToday(), 1);
    setPeriodStart(start);
    setPeriodEnd(addDays(start, 6));
    initialSnapshot.current = snapshot(start, addDays(start, 6), []);
    setDrafts([]);
    setFormError(null);
    setNote(null);
    setEditing({ existing: null });
  }

  function openEdit(row: AvailabilityLocalRow) {
    tacticalFeedback.onTap();
    setPeriodStart(row.period_start);
    setPeriodEnd(row.period_end);
    const loaded = parseLocalWindows(row).map((w) => newDraft(w.date, w.start, w.end));
    initialSnapshot.current = snapshot(row.period_start, row.period_end, loaded);
    setDrafts(loaded);
    setFormError(null);
    setNote(null);
    setEditing({ existing: row });
  }

  const isDirty = editing !== null && snapshot(periodStart, periodEnd, drafts) !== initialSnapshot.current;

  function closeEditor() {
    tacticalFeedback.onTap();
    if (isDirty && !saving) {
      setConfirmDiscard(true);
      return;
    }
    setEditing(null);
  }

  // Hardware back inside the editor closes the editor (not the screen).
  const closeEditorRef = useRef(closeEditor);
  closeEditorRef.current = closeEditor;
  const editorOpen = editing !== null;
  useEffect(() => {
    if (!editorOpen) return undefined;
    const onBack = (e: Event) => {
      e.preventDefault();
      if (!saving) closeEditorRef.current();
    };
    window.addEventListener('baranguard:hardware-back', onBack);
    return () => window.removeEventListener('baranguard:hardware-back', onBack);
  }, [editorOpen, saving]);

  const periodLength = periodStart && periodEnd ? daysBetween(periodStart, periodEnd) + 1 : 0;
  const periodValid = periodLength >= 1 && periodLength <= MAX_PERIOD_DAYS;
  const days = useMemo(() => (periodValid ? eachDate(periodStart, periodEnd) : []), [periodValid, periodStart, periodEnd]);

  function changePeriod(nextStart: string, nextEnd: string) {
    const apply = () => {
      setPeriodStart(nextStart);
      setPeriodEnd(nextEnd);
      // Windows must stay inside the period.
      setDrafts((prev) => prev.filter((w) => w.date >= nextStart && w.date <= nextEnd));
    };
    const dropped = drafts.filter((w) => w.date < nextStart || w.date > nextEnd).length;
    if (dropped > 0) {
      setPendingChange({
        message: `This period change removes ${dropped} window${dropped === 1 ? '' : 's'} that fall outside the new dates.`,
        apply,
      });
      return;
    }
    apply();
  }

  function quickFill(kind: 'all' | 'weekdays') {
    tacticalFeedback.onTap();
    const apply = () => {
      const filled = kind === 'all' ? fillAllDays(days, [{ from: DEFAULT_START, to: DEFAULT_END }]) : fillWeekdays(days, [{ from: DEFAULT_START, to: DEFAULT_END }]);
      setDrafts(days.flatMap((d) => (filled[d] ?? []).map((w) => newDraft(d, w.from, w.to))));
    };
    if (drafts.length > 0) {
      setPendingChange({ message: 'This replaces the days and times you have already set.', apply });
      return;
    }
    apply();
  }

  function toggleDay(date: string) {
    tacticalFeedback.vibrate(15);
    const dayWindows = drafts.filter((w) => w.date === date);
    const customised = dayWindows.length > 1 || dayWindows.some((w) => w.start !== DEFAULT_START || w.end !== DEFAULT_END);
    if (customised) {
      setPendingChange({
        message: `This clears the times you set for ${formatDayLabel(date)}.`,
        apply: () => setDrafts((prev) => prev.filter((w) => w.date !== date)),
      });
      return;
    }
    setDrafts((prev) =>
      prev.some((w) => w.date === date) ? prev.filter((w) => w.date !== date) : [...prev, newDraft(date)]
    );
  }

  function patchWindow(key: number, patch: Partial<AvailabilityWindow>) {
    setDrafts((prev) => prev.map((w) => (w.key === key ? { ...w, ...patch } : w)));
  }

  async function handleSave() {
    setFormError(null);
    const windows: AvailabilityWindow[] = drafts.map(({ date, start, end }) => ({ date, start, end }));
    if (!periodValid) {
      setFormError(`Choose a period of 1 to ${MAX_PERIOD_DAYS} days.`);
      return;
    }
    const problem = validateAvailability({ periodStart, periodEnd, windows }) ?? findOverlap(windows);
    if (problem) {
      setFormError(problem);
      return;
    }
    setSaving(true);
    tacticalFeedback.onTap();
    try {
      await saveAvailabilityLocally({ periodStart, periodEnd, windows });
      tacticalFeedback.onSuccess();
      setEditing(null);
      setNote('Saved on this phone, will send when online.');
      await reload();
      void forceSyncNow();
    } catch (err) {
      tacticalFeedback.onWarning();
      setFormError(err instanceof Error ? err.message : 'Could not save your availability on this phone.');
    } finally {
      setSaving(false);
    }
  }

  // ---------------------------------------------------------------- editor ---
  if (editing) {
    const isEdit = editing.existing !== null;
    return (
      <IonPage>
        <MobileHeader
          title={isEdit ? 'Edit Availability' : 'New Availability'}
          rightSlot={
            <button type="button" className="mobile-topbar__theme-toggle" aria-label="Close editor" disabled={saving} onClick={closeEditor}>
              <IonIcon icon={closeOutline} />
            </button>
          }
        />
        <IonAlert
          isOpen={confirmDiscard}
          onDidDismiss={() => setConfirmDiscard(false)}
          header="Discard changes?"
          message="Your changes to this availability have not been saved."
          buttons={[
            { text: 'Keep editing', role: 'cancel' },
            {
              text: 'Discard',
              role: 'destructive',
              handler: () => {
                setEditing(null);
              },
            },
          ]}
        />
        <IonAlert
          isOpen={pendingChange !== null}
          onDidDismiss={() => setPendingChange(null)}
          header="Replace your entries?"
          message={pendingChange?.message}
          buttons={[
            { text: 'Keep what I have', role: 'cancel' },
            {
              text: 'Continue',
              role: 'destructive',
              handler: () => pendingChange?.apply(),
            },
          ]}
        />
        <IonContent style={{ '--background': 'var(--color-bg)' }}>
          <div className="wf-page">
            <div className="intake-block">
              <div className="intake-block-header">
                <span className="intake-block-title">
                  <IonIcon icon={calendarOutline} />
                  Period
                </span>
              </div>
              <div className="wf-field-row">
                <div className="wf-field">
                  <label className="wf-label" htmlFor="avail-start">
                    From
                  </label>
                  <input
                    id="avail-start"
                    className="wf-input"
                    type="date"
                    value={periodStart}
                    min={isEdit ? undefined : manilaToday()}
                    disabled={saving || isEdit}
                    onChange={(e) => changePeriod(e.target.value, periodEnd < e.target.value ? e.target.value : periodEnd)}
                  />
                </div>
                <div className="wf-field">
                  <label className="wf-label" htmlFor="avail-end">
                    To
                  </label>
                  <input
                    id="avail-end"
                    className="wf-input"
                    type="date"
                    value={periodEnd}
                    min={periodStart}
                    disabled={saving || isEdit}
                    onChange={(e) => changePeriod(periodStart, e.target.value)}
                  />
                </div>
              </div>
              {isEdit && <span className="wf-hint">The period is fixed once submitted. Change the days and times below.</span>}
              {!isEdit && (
                <span className={!periodValid && periodStart && periodEnd ? 'p4w-error' : 'wf-hint'}>
                  Choose a period of 1 to {MAX_PERIOD_DAYS} days.
                </span>
              )}
            </div>

            {periodValid && (
              <div className="intake-block">
                <div className="intake-block-header">
                  <span className="intake-block-title">Days you can serve</span>
                  <span className="wf-muted">
                    {drafts.length}/{MAX_AVAILABILITY_WINDOWS} windows
                  </span>
                </div>
                <span className="wf-hint">Tap a day to mark it available, then set the hours. You can add more than one window per day.</span>
                <div className="p4w-quickfill">
                  <Button variant="secondary" disabled={saving} onClick={() => quickFill('weekdays')}>
                    Weekdays {DEFAULT_START}-{DEFAULT_END}
                  </Button>
                  <Button variant="secondary" disabled={saving} onClick={() => quickFill('all')}>
                    Every day {DEFAULT_START}-{DEFAULT_END}
                  </Button>
                </div>

                <div className="wf-stack">
                  {days.map((date) => {
                    const dayWindows = drafts.filter((w) => w.date === date);
                    const on = dayWindows.length > 0;
                    return (
                      <div key={date} className={`wf-day ${on ? 'wf-day--on' : ''}`}>
                        <div className="wf-day__head">
                          <span className="wf-day__label">{formatDayLabel(date)}</span>
                          <button
                            type="button"
                            className={`wf-btn wf-btn--small ${on ? '' : 'wf-btn--primary'}`}
                            onClick={() => toggleDay(date)}
                            disabled={saving}
                            aria-pressed={on}
                          >
                            {on ? 'Not available' : 'Available'}
                          </button>
                        </div>
                        {dayWindows.map((w) => (
                          <div key={w.key} className="wf-window">
                            <div className="wf-field">
                              <label className="wf-label" htmlFor={`avail-s-${w.key}`}>
                                Start
                              </label>
                              <input
                                id={`avail-s-${w.key}`}
                                className="wf-input"
                                type="time"
                                value={w.start}
                                disabled={saving}
                                onChange={(e) => patchWindow(w.key, { start: e.target.value })}
                              />
                            </div>
                            <div className="wf-field">
                              <label className="wf-label" htmlFor={`avail-e-${w.key}`}>
                                End
                              </label>
                              <input
                                id={`avail-e-${w.key}`}
                                className="wf-input"
                                type="time"
                                value={w.end}
                                disabled={saving}
                                onChange={(e) => patchWindow(w.key, { end: e.target.value })}
                              />
                            </div>
                            <button
                              type="button"
                              className="wf-icon-btn"
                              aria-label={`Remove window on ${formatDayLabel(date)}`}
                              disabled={saving}
                              onClick={() => setDrafts((prev) => prev.filter((x) => x.key !== w.key))}
                            >
                              <IonIcon icon={trashOutline} />
                            </button>
                          </div>
                        ))}
                        {on && (
                          <button
                            type="button"
                            className="wf-btn wf-btn--small"
                            disabled={saving || drafts.length >= MAX_AVAILABILITY_WINDOWS}
                            onClick={() => setDrafts((prev) => [...prev, newDraft(date, '18:00', '22:00')])}
                          >
                            <IonIcon icon={addOutline} />
                            <span>Add another window</span>
                          </button>
                        )}
                      </div>
                    );
                  })}
                </div>
              </div>
            )}

            {formError && <Banner tone="critical">{formError}</Banner>}
          </div>
        </IonContent>

        <div className="wf-dock">
          <Button variant="primary" size="lg" fullWidth loading={saving} onClick={handleSave}>
            {isEdit ? 'Save changes' : 'Submit availability'}
          </Button>
          <Button variant="ghost" fullWidth disabled={saving} onClick={closeEditor}>
            Cancel
          </Button>
        </div>
      </IonPage>
    );
  }

  // ------------------------------------------------------------------ list ---
  return (
    <IonPage>
      <MobileHeader title="My Availability" showBack defaultBackHref="/tabs/profile" />
      <IonContent style={{ '--background': 'var(--color-bg)' }}>
        <IonRefresher slot="fixed" onIonRefresh={(e) => void refresh().finally(() => e.detail.complete())}>
          <IonRefresherContent />
        </IonRefresher>
        <div className="wf-page">
          <div className="ui-banner wf-info-note" role="status">
            <div className="ui-banner__body">
              You set your own windows and can change them any time. Only published shifts appear in My Shifts.
            </div>
          </div>

          {note && <Banner tone="success">{note}</Banner>}
          {loadError && rows.length > 0 && <Banner tone="critical">{loadError}</Banner>}
          {serverCopyStale && !loadError && (
            <Banner tone="warning">
              Could not reach the workstation. Your saved submissions are shown.
            </Banner>
          )}

          {loading ? (
            <LoadingBlock label="Loading your availability…" />
          ) : loadError && rows.length === 0 ? (
            <ErrorState message={loadError} onRetry={() => void reload()} />
          ) : rows.length === 0 ? (
            <EmptyState
              title="No availability submitted yet"
              body="Submit the days and hours you can serve so the desk can build the roster."
            />
          ) : (
            rows.map((row) => {
              const windows = parseLocalWindows(row);
              const dayCount = new Set(windows.map((w) => w.date)).size;
              const ended = isPeriodPast(row.period_end);
              const period = formatPeriodLabel(row.period_start, row.period_end);
              const chip =
                deriveWorkflowSyncState(row) === 'synced' ? (
                  <span className="ui-sync ui-sync--success" role="status">
                    <IonIcon icon={checkmarkCircleOutline} aria-hidden="true" />
                    <span>Submitted</span>
                  </span>
                ) : (
                  <SyncChip row={row} />
                );
              const body = (
                <>
                  <div className="wf-card__head">
                    <div>
                      <h3 className="wf-card__title">{period}</h3>
                      <p className="wf-card__sub">
                        {dayCount} day{dayCount === 1 ? '' : 's'} · {windows.length} window{windows.length === 1 ? '' : 's'}
                        {ended ? ' · period ended' : ''}
                      </p>
                    </div>
                    {chip}
                  </div>
                  {row.last_sync_error && row.synced === 0 && (
                    <span className="wf-muted">The desk could not save this yet: {row.last_sync_error}</span>
                  )}
                  {!ended && (
                    <span className="wf-btn wf-btn--small wf-card__edit">
                      <IonIcon icon={createOutline} aria-hidden="true" />
                      <span>Edit</span>
                    </span>
                  )}
                </>
              );
              return ended ? (
                <div key={row.local_id} className="wf-card wf-card--ended">
                  {body}
                </div>
              ) : (
                <button
                  key={row.local_id}
                  type="button"
                  className="wf-card wf-card--tap"
                  aria-label={`Edit availability, ${period}`}
                  onClick={() => openEdit(row)}
                >
                  {body}
                </button>
              );
            })
          )}
        </div>
      </IonContent>

      <div className="wf-dock">
        <Button variant="primary" size="lg" fullWidth icon={addOutline} onClick={openNew}>
          New availability
        </Button>
      </div>
    </IonPage>
  );
};

export default AvailabilityPage;
