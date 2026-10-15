import { IonIcon, IonModal, IonSpinner } from '@ionic/react';
import { chevronDownOutline, closeOutline } from 'ionicons/icons';
import { Banner } from '../WorkflowBits';
import { earliestWorkDate, MAX_ENTRY_TEXT } from '../../services/db/accomplishmentRepository';
import type { AccomplishmentEntryLocalRow } from '../../services/db/localSchema';
import { splitMinutes, type FormState } from '../../utils/accomplishmentForm';
import { formatMinutes, manilaToday } from '../../utils/manilaTime';
import { clampHours, clampMinutes, formatDurationTotal, routeAccomplishmentProblem } from '../../utils/workflowForm';

interface AccomplishmentEntrySheetProps {
  isOpen: boolean;
  /** The entry being edited, or null when adding a new one. */
  existing: AccomplishmentEntryLocalRow | null;
  form: FormState;
  saving: boolean;
  formError: string | null;
  timesOpen: boolean;
  onToggleTimes: () => void;
  onPatch: (patch: Partial<FormState>) => void;
  /** Called when the Tanod types their own duration (stops auto-fill from start/end). */
  onDurationTouched: () => void;
  onSave: () => void;
  onClose: () => void;
}

export function AccomplishmentEntrySheet({
  isOpen,
  existing,
  form,
  saving,
  formError,
  timesOpen,
  onToggleTimes,
  onPatch,
  onDurationTouched,
  onSave,
  onClose,
}: AccomplishmentEntrySheetProps) {
  const suggestion = existing?.suggested_duration_minutes ?? null;
  const durationTotal = formatDurationTotal(form.hours, form.minutes);
  const problemField = formError ? routeAccomplishmentProblem(formError) : null;
  const errFor = (f: 'date' | 'text' | 'duration' | 'times') => (problemField === f ? formError : null);

  return (
<IonModal
  isOpen={isOpen}
  onDidDismiss={() => {
    if (!saving) onClose();
  }}
  initialBreakpoint={0.92}
  breakpoints={[0, 0.92, 1]}
  className="wf-sheet-modal"
>
  <div className="wf-sheet">
    <div className="wf-sheet__head">
      <h3 className="wf-sheet__title">{existing ? 'Edit Entry' : 'Add Entry'}</h3>
      <button type="button" className="wf-icon-btn" onClick={onClose} disabled={saving} aria-label="Close entry form">
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
        disabled={saving || existing !== null}
        aria-invalid={errFor('date') ? true : undefined}
        aria-describedby="acc-date-hint"
        onChange={(e) => onPatch({ workDate: e.target.value })}
      />
      <span id="acc-date-hint" className={errFor('date') ? 'p4w-error' : 'wf-hint'}>
        {errFor('date') ?? 'Not in the future, and no more than 62 days back.'}
      </span>
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
        aria-invalid={errFor('text') ? true : undefined}
        aria-describedby="acc-text-hint"
        onChange={(e) => onPatch({ text: e.target.value })}
        placeholder="e.g. Night patrol of Purok 3; assisted traffic at the school gate"
      />
      <span id="acc-text-hint" className={errFor('text') ? 'p4w-error' : 'wf-hint'}>
        {errFor('text') ?? 'Describe the work only. Leave out names of victims, complainants or students.'}
      </span>
      <span className="wf-counter">
        {form.text.length}/{MAX_ENTRY_TEXT}
      </span>
    </div>

    <button
      type="button"
      className="p4w-expander"
      aria-expanded={timesOpen}
      aria-controls="acc-times"
      onClick={() => onToggleTimes()}
    >
      <IonIcon
        icon={chevronDownOutline}
        aria-hidden="true"
        className={timesOpen ? 'p4w-expander__icon p4w-expander__icon--open' : 'p4w-expander__icon'}
      />
      <span>Add start and end time</span>
    </button>
    {timesOpen && (
      <div id="acc-times" className="p4w-times">
    <div className="wf-field-row">
      <div className="wf-field">
        <label className="wf-label" htmlFor="acc-start">
          Start
        </label>
        <input id="acc-start" className="wf-input" type="time" value={form.startTime} disabled={saving} onChange={(e) => onPatch({ startTime: e.target.value })} />
      </div>
      <div className="wf-field">
        <label className="wf-label" htmlFor="acc-end">
          End
        </label>
        <input id="acc-end" className="wf-input" type="time" value={form.endTime} disabled={saving} onChange={(e) => onPatch({ endTime: e.target.value })} />
      </div>
    </div>

    <span className="wf-hint">
      Fill in both times or neither. If the work ran past midnight, enter the end time as it appears on the clock
      the next day — it counts as the following day.
    </span>

      </div>
    )}

    <div className="wf-field">
      <span className="wf-label">Confirmed duration</span>
      <div className="p4w-duration">
        <div className="p4w-duration__part">
          <label className="wf-label" htmlFor="acc-hours">
            Hours
          </label>
          <input
            id="acc-hours"
            className="wf-input"
            type="text"
            inputMode="numeric"
            pattern="[0-9]*"
            maxLength={2}
            value={form.hours}
            disabled={saving}
            onChange={(e) => {
              onDurationTouched();
              onPatch({ hours: clampHours(e.target.value) });
            }}
          />
        </div>
        <div className="p4w-duration__part">
          <label className="wf-label" htmlFor="acc-minutes">
            Minutes
          </label>
          <input
            id="acc-minutes"
            className="wf-input"
            type="text"
            inputMode="numeric"
            pattern="[0-9]*"
            maxLength={2}
            value={form.minutes}
            disabled={saving}
            onChange={(e) => {
              onDurationTouched();
              onPatch({ minutes: clampMinutes(e.target.value) });
            }}
          />
        </div>
        <span className="p4w-duration__total" aria-live="polite">
          {durationTotal ?? ''}
        </span>
      </div>
      <span className={errFor('duration') ? 'p4w-error' : 'wf-hint'}>
        {errFor('duration') ?? 'You confirm this yourself. Between 1 minute and 24 hours.'}
      </span>
    </div>

    {suggestion !== null ? (
      <Banner tone="info">
        Suggested from your on-duty time that day: <strong>{formatMinutes(suggestion)}</strong>.
        {existing?.duration_flag === 1 ? ' Your confirmed time differs from the duty record.' : ''}{' '}
        <button
          type="button"
          className="wf-btn wf-btn--small"
          onClick={() => {
            onDurationTouched();
            onPatch(splitMinutes(suggestion));
          }}
        >
          Use suggested
        </button>
      </Banner>
    ) : null}

    {formError && (problemField === 'general' || problemField === 'times') && <Banner tone="critical">{formError}</Banner>}

    <button type="button" className="dispatch-primary-cta dispatch-primary-cta--blue" onClick={onSave} disabled={saving}>
      {saving ? <IonSpinner name="dots" /> : <span>{existing ? 'Save changes' : 'Save entry'}</span>}
    </button>
    <button type="button" className="dispatch-secondary-cta" onClick={onClose} disabled={saving}>
      Cancel
    </button>
  </div>
</IonModal>
  );
}
