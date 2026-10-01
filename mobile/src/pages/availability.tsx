/**
 * availability.tsx — Availability submission (contract §3, docs/FEATURE_
 * CONTRACT_2026-10.md §9).
 *
 * A Tanod tells the desk which dates and time windows they can serve in a
 * period; the Admin/Secretary accepts it or asks for a revision, and builds
 * the published roster from it. This screen is OFFLINE-FIRST (Rule 7): Save
 * writes to encrypted SQLite before the form closes and the record goes out
 * through `/sync/batch` (`availability[]`). The chip beside every period says
 * only what the row can prove — "Saved on phone" until a sync confirms it.
 * The desk's own verdict (submitted / accepted / revised + note) comes back via
 * `refreshAvailabilityFromServer()`; an accepted period is read-only (the server
 * would 409 a change).
 *
 * Dates are plain Manila `YYYY-MM-DD` strings (utils/manilaTime.ts); times are
 * `HH:MM`. Native <input type="date|time"> keep this working with the WebView's
 * own pickers.
 */

import { useCallback, useEffect, useMemo, useState } from 'react';
import { IonContent, IonIcon, IonPage, IonSpinner } from '@ionic/react';
import { addOutline, calendarOutline, closeOutline, createOutline, trashOutline } from 'ionicons/icons';
import MobileHeader from '../components/MobileHeader';
import { LoadingBlock } from '../components/LoadingBlock';
import { Banner, SyncChip } from '../components/WorkflowBits';
import {
  isAvailabilityEditable,
  isPeriodPast,
  listAvailability,
  MAX_AVAILABILITY_WINDOWS,
  parseLocalWindows,
  saveAvailabilityLocally,
  validateAvailability,
} from '../services/db/availabilityRepository';
import type { AvailabilityLocalRow, AvailabilityStatus, AvailabilityWindow } from '../services/db/localSchema';
import { forceSyncNow, subscribeSyncSummary } from '../services/syncScheduler';
import { refreshAvailabilityFromServer } from '../services/workflowRefresh';
import { addDays, daysBetween, eachDate, formatDayLabel, formatPeriodLabel, manilaToday } from '../utils/manilaTime';
import tacticalFeedback from '../utils/tacticalFeedback';

/** A single period longer than this is hard to review on a phone; the form asks for a shorter one. */
const MAX_PERIOD_DAYS = 31;
const DEFAULT_START = '08:00';
const DEFAULT_END = '17:00';

const STATUS_PILL: Record<AvailabilityStatus, { label: string; className: string }> = {
  submitted: { label: 'Submitted — waiting for review', className: 'status-pill--info' },
  accepted: { label: 'Accepted by the desk', className: 'status-pill--success' },
  revised: { label: 'Desk asked for changes', className: 'status-pill--pending' },
};

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

  const reload = useCallback(async () => {
    try {
      setRows(await listAvailability());
      setLoadError(null);
    } catch {
      setLoadError('Could not read saved availability from this phone.');
    }
  }, []);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      setLoading(true);
      await reload();
      if (!cancelled) setLoading(false);
      const ok = await refreshAvailabilityFromServer({ force: true });
      if (cancelled) return;
      setServerCopyStale(!ok);
      if (ok) await reload();
    })();
    const unsubscribe = subscribeSyncSummary(() => void reload());
    return () => {
      cancelled = true;
      unsubscribe();
    };
  }, [reload]);

  function openNew() {
    tacticalFeedback.onTap();
    const start = addDays(manilaToday(), 1);
    setPeriodStart(start);
    setPeriodEnd(addDays(start, 6));
    setDrafts([]);
    setFormError(null);
    setNote(null);
    setEditing({ existing: null });
  }

  function openEdit(row: AvailabilityLocalRow) {
    tacticalFeedback.onTap();
    setPeriodStart(row.period_start);
    setPeriodEnd(row.period_end);
    setDrafts(parseLocalWindows(row).map((w) => newDraft(w.date, w.start, w.end)));
    setFormError(null);
    setNote(null);
    setEditing({ existing: row });
  }

  const periodLength = periodStart && periodEnd ? daysBetween(periodStart, periodEnd) + 1 : 0;
  const periodValid = periodLength >= 1 && periodLength <= MAX_PERIOD_DAYS;
  const days = useMemo(() => (periodValid ? eachDate(periodStart, periodEnd) : []), [periodValid, periodStart, periodEnd]);

  function changePeriod(nextStart: string, nextEnd: string) {
    setPeriodStart(nextStart);
    setPeriodEnd(nextEnd);
    // Windows must stay inside the period.
    setDrafts((prev) => prev.filter((w) => w.date >= nextStart && w.date <= nextEnd));
  }

  function toggleDay(date: string) {
    tacticalFeedback.vibrate(15);
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
      setNote('Saved on this phone. It will be sent to the desk as soon as you are connected.');
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
        <MobileHeader title={isEdit ? 'Edit Availability' : 'New Availability'} />
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
              {!periodValid && periodStart && periodEnd && (
                <Banner tone="warning">Choose a period of 1 to {MAX_PERIOD_DAYS} days.</Banner>
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
          <button type="button" className="dispatch-primary-cta dispatch-primary-cta--blue" onClick={handleSave} disabled={saving}>
            {saving ? <IonSpinner name="dots" /> : <span>{isEdit ? 'Save Changes' : 'Submit Availability'}</span>}
          </button>
          <button
            type="button"
            className="dispatch-secondary-cta"
            onClick={() => setEditing(null)}
            disabled={saving}
          >
            <IonIcon icon={closeOutline} />
            <span>Cancel</span>
          </button>
        </div>
      </IonPage>
    );
  }

  // ------------------------------------------------------------------ list ---
  return (
    <IonPage>
      <MobileHeader title="My Availability" showBack defaultBackHref="/tabs/shifts" />
      <IonContent style={{ '--background': 'var(--color-bg)' }}>
        <div className="wf-page">
          <Banner tone="info">
            Tell the desk when you can serve. The desk reviews it and publishes the duty roster — only published shifts
            appear in My Shifts.
          </Banner>

          {note && <Banner tone="success">{note}</Banner>}
          {loadError && <Banner tone="critical">{loadError}</Banner>}
          {serverCopyStale && !loadError && (
            <Banner tone="warning">
              Could not reach the workstation, so review status may be out of date. Your saved submissions are shown.
            </Banner>
          )}

          {loading ? (
            <LoadingBlock label="Loading your availability…" />
          ) : rows.length === 0 ? (
            <div className="wf-card" style={{ textAlign: 'center', alignItems: 'center' }}>
              <h3 className="wf-card__title">No availability submitted yet</h3>
              <p className="wf-card__sub">Submit the days and hours you can serve so the desk can build the roster.</p>
            </div>
          ) : (
            rows.map((row) => {
              const windows = parseLocalWindows(row);
              const pill = STATUS_PILL[row.status] ?? STATUS_PILL.submitted;
              const dayCount = new Set(windows.map((w) => w.date)).size;
              return (
                <div key={row.local_id} className="wf-card">
                  <div className="wf-card__head">
                    <div>
                      <h3 className="wf-card__title">{formatPeriodLabel(row.period_start, row.period_end)}</h3>
                      <p className="wf-card__sub">
                        {dayCount} day{dayCount === 1 ? '' : 's'} · {windows.length} window{windows.length === 1 ? '' : 's'}
                        {isPeriodPast(row.period_end) ? ' · period ended' : ''}
                      </p>
                    </div>
                    <SyncChip row={row} />
                  </div>
                  <div className="wf-row">
                    <span className={`status-pill ${pill.className}`}>{pill.label}</span>
                  </div>
                  {row.status === 'revised' && (
                    <Banner tone="warning">
                      {row.review_note ? `Desk note: ${row.review_note}` : 'The desk asked for changes. Update and resubmit.'}
                    </Banner>
                  )}
                  {row.last_sync_error && row.synced === 0 && (
                    <span className="wf-muted">The desk could not save this yet: {row.last_sync_error}</span>
                  )}
                  {isAvailabilityEditable(row.status) && !isPeriodPast(row.period_end) && (
                    <button type="button" className="wf-btn wf-btn--small" onClick={() => openEdit(row)}>
                      <IonIcon icon={createOutline} />
                      <span>{row.status === 'revised' ? 'Revise & Resubmit' : 'Edit'}</span>
                    </button>
                  )}
                </div>
              );
            })
          )}
        </div>
      </IonContent>

      <div className="wf-dock">
        <button type="button" className="dispatch-primary-cta dispatch-primary-cta--blue" onClick={openNew}>
          <IonIcon icon={addOutline} style={{ fontSize: '1.2rem' }} />
          <span>New Availability</span>
        </button>
      </div>
    </IonPage>
  );
};

export default AvailabilityPage;
