import { IonIcon } from '@ionic/react';
import { alertCircleOutline, schoolOutline } from 'ionicons/icons';
import { C1_FIELD_MAX } from '../../services/db/incidentRepository';
import type { SchoolLocalRow } from '../../services/db/localSchema';
import tacticalFeedback from '../../utils/tacticalFeedback';

interface Props {
  schools: SchoolLocalRow[];
  schoolId: string;
  c1Summary: string;
  c1ActionTaken: string;
  c1StatusNotes: string;
  saving: boolean;
  onSchoolChange: (value: string) => void;
  onC1SummaryChange: (value: string) => void;
  onC1ActionChange: (value: string) => void;
  onC1StatusChange: (value: string) => void;
}

/** Safer School Zones link + Annex C-1 notes (optional). */
const SchoolZoneSection: React.FC<Props> = ({
  schools,
  schoolId,
  c1Summary,
  c1ActionTaken,
  c1StatusNotes,
  saving,
  onSchoolChange,
  onC1SummaryChange,
  onC1ActionChange,
  onC1StatusChange,
}) => (
  <div className="intake-block">
    <div className="intake-block-header">
      <span className="intake-block-title">
        <IonIcon icon={schoolOutline} />
        School Zone (Optional)
      </span>
      {schoolId && (
        <button
          type="button"
          onClick={() => {
            tacticalFeedback.onTap();
            onSchoolChange('');
          }}
          disabled={saving}
          className="intake-clear-btn"
        >
          Clear
        </button>
      )}
    </div>

    {schools.length === 0 ? (
      <span className="wf-hint">
        No schools saved on this phone yet. Connect once and they will download automatically — you can still submit
        this report without one.
      </span>
    ) : (
      <div className="wf-field">
        <label className="wf-label" htmlFor="incident-school">
          Which school?
        </label>
        <select
          id="incident-school"
          className="wf-select"
          value={schoolId}
          onChange={(e) => onSchoolChange(e.target.value)}
          disabled={saving}
        >
          <option value="">Not a school-zone incident</option>
          {schools.map((s) => (
            <option key={s.school_id} value={String(s.school_id)}>
              {s.name}
            </option>
          ))}
        </select>
      </div>
    )}

    {schoolId && (
      <>
        <div className="wf-banner wf-banner--warning" role="note">
          <IonIcon icon={alertCircleOutline} aria-hidden="true" />
          <div>
            Keep these notes <strong>short and factual</strong>. Do <strong>not</strong> write the names of students or
            victims (Walang pangalan ng estudyante o biktima). Link a school only for what you met{' '}
            <strong>outside</strong> the school grounds: the gate, the perimeter or the road in front. What happens
            inside the school is a matter for the school, not for the tanod.
          </div>
        </div>

        <div className="wf-field">
          <label className="wf-label" htmlFor="c1-summary">
            What happened (C-1 summary)
          </label>
          <textarea
            id="c1-summary"
            className="intake-textarea-box"
            rows={3}
            maxLength={C1_FIELD_MAX}
            value={c1Summary}
            onChange={(e) => onC1SummaryChange(e.target.value)}
            disabled={saving}
            placeholder="e.g. Stray dogs gathered outside the school gate at dismissal"
          />
          <span className="wf-counter">
            {c1Summary.length}/{C1_FIELD_MAX}
          </span>
        </div>

        <div className="wf-field">
          <label className="wf-label" htmlFor="c1-action">
            Action taken
          </label>
          <textarea
            id="c1-action"
            className="intake-textarea-box"
            rows={2}
            maxLength={C1_FIELD_MAX}
            value={c1ActionTaken}
            onChange={(e) => onC1ActionChange(e.target.value)}
            disabled={saving}
            placeholder="e.g. Separated the parties and informed the school guard"
          />
          <span className="wf-counter">
            {c1ActionTaken.length}/{C1_FIELD_MAX}
          </span>
        </div>

        <div className="wf-field">
          <label className="wf-label" htmlFor="c1-status">
            Status / notes
          </label>
          <textarea
            id="c1-status"
            className="intake-textarea-box"
            rows={2}
            maxLength={C1_FIELD_MAX}
            value={c1StatusNotes}
            onChange={(e) => onC1StatusChange(e.target.value)}
            disabled={saving}
            placeholder="e.g. Situation calm, referred to school principal"
          />
          <span className="wf-counter">
            {c1StatusNotes.length}/{C1_FIELD_MAX}
          </span>
        </div>
      </>
    )}
  </div>
);

export default SchoolZoneSection;
