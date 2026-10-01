/**
 * ReferralPanel.tsx — the "Refer" action (contract §5) shared by Assignment
 * Detail and the submitted-incident view.
 *
 * A referral RECORDS A HANDOFF: the Tanod handed this incident to PNP, BFP,
 * EMS, a barangay official, etc. It does not change the dispatch or incident
 * status, and the wording on this panel never implies the receiving agency
 * accepted, acknowledged or acted on it — the Tanod can only attest that they
 * made the referral. `contact_name` is the receiving unit/official, never a
 * citizen, and the form says so.
 *
 * Offline-first (Rule 7): Save persists to encrypted SQLite and only then
 * closes the sheet; the row's chip says "Saved on phone" until a sync pass
 * confirms it. A referral for an incident captured on this phone is linked by
 * its local id and resolved at sync time (see referralRepository.ts).
 */

import { useCallback, useEffect, useState } from 'react';
import { IonIcon, IonModal, IonSpinner } from '@ionic/react';
import { closeOutline, swapHorizontalOutline } from 'ionicons/icons';
import { Banner, SyncChip } from './WorkflowBits';
import {
  listReferralsForIncident,
  MAX_CONTACT_NAME,
  MAX_OTHER_TEXT,
  MAX_REFERENCE_NO,
  referralTargetLabel,
  REFERRAL_TARGETS,
  saveReferralLocally,
} from '../services/db/referralRepository';
import type { ReferralLocalRow, ReferralTarget } from '../services/db/localSchema';
import { forceSyncNow, subscribeSyncSummary } from '../services/syncScheduler';
import { formatManilaDateTime } from '../utils/manilaTime';
import tacticalFeedback from '../utils/tacticalFeedback';

interface ReferralPanelProps {
  /** The incident being referred: its server id (from a dispatch) and/or its phone-local id. */
  link: { serverIncidentId?: number | null; incidentLocalId?: string | null };
  /** Short label for the sheet header, e.g. "Case #42". */
  incidentLabel?: string;
}

export const ReferralPanel: React.FC<ReferralPanelProps> = ({ link, incidentLabel }) => {
  const { serverIncidentId = null, incidentLocalId = null } = link;
  const [referrals, setReferrals] = useState<ReferralLocalRow[]>([]);
  const [sheetOpen, setSheetOpen] = useState(false);
  const [note, setNote] = useState<string | null>(null);

  const reload = useCallback(async () => {
    try {
      setReferrals(await listReferralsForIncident({ serverIncidentId, incidentLocalId }));
    } catch {
      // Local store unavailable (web preview) — show the action with no history.
      setReferrals([]);
    }
  }, [serverIncidentId, incidentLocalId]);

  useEffect(() => {
    void reload();
    return subscribeSyncSummary(() => void reload());
  }, [reload]);

  const canRefer = serverIncidentId !== null || incidentLocalId !== null;

  return (
    <div className="wf-card" aria-label="Referral">
      <div className="wf-card__head">
        <div>
          <h3 className="wf-card__title">Refer / Hand Off</h3>
          <p className="wf-card__sub">
            Record that you handed this case to another agency or official. This logs the handoff only — it does not
            mean they accepted it.
          </p>
        </div>
      </div>

      {note && <Banner tone="success">{note}</Banner>}

      {referrals.length > 0 && (
        <div className="wf-stack" aria-label="Referrals recorded for this incident">
          {referrals.map((r) => (
            <div key={r.local_id} className="wf-entry">
              <div className="wf-row wf-row--between">
                <strong style={{ fontSize: '0.86rem' }}>
                  {referralTargetLabel(r.referred_to)}
                  {r.other_text ? ` · ${r.other_text}` : ''}
                </strong>
                <SyncChip row={r} />
              </div>
              <span className="wf-muted">
                Handed over {formatManilaDateTime(r.referred_at)}
                {r.reference_no ? ` · Ref ${r.reference_no}` : ''}
              </span>
              {r.last_sync_error && r.synced === 0 && (
                <span className="wf-muted">The desk could not save this yet: {r.last_sync_error}</span>
              )}
            </div>
          ))}
        </div>
      )}

      <button
        type="button"
        className="wf-btn wf-btn--primary wf-btn--block"
        disabled={!canRefer}
        onClick={() => {
          tacticalFeedback.onTap();
          setNote(null);
          setSheetOpen(true);
        }}
      >
        <IonIcon icon={swapHorizontalOutline} />
        <span>{referrals.length > 0 ? 'Add Another Referral' : 'Refer This Case'}</span>
      </button>

      <ReferralSheet
        isOpen={sheetOpen}
        incidentLabel={incidentLabel}
        onClose={() => setSheetOpen(false)}
        onSave={async (values) => {
          await saveReferralLocally({ serverIncidentId, incidentLocalId, ...values });
          tacticalFeedback.onSuccess();
          setSheetOpen(false);
          setNote('Referral recorded on this phone. It will be sent to the barangay desk when connected.');
          await reload();
          void forceSyncNow();
        }}
      />
    </div>
  );
};

interface SheetValues {
  referredTo: ReferralTarget;
  otherText: string;
  contactName: string;
  referenceNo: string;
}

const ReferralSheet: React.FC<{
  isOpen: boolean;
  incidentLabel?: string;
  onClose: () => void;
  onSave: (values: SheetValues) => Promise<void>;
}> = ({ isOpen, incidentLabel, onClose, onSave }) => {
  const [referredTo, setReferredTo] = useState<ReferralTarget | ''>('');
  const [otherText, setOtherText] = useState('');
  const [contactName, setContactName] = useState('');
  const [referenceNo, setReferenceNo] = useState('');
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (isOpen) {
      setReferredTo('');
      setOtherText('');
      setContactName('');
      setReferenceNo('');
      setError(null);
    }
  }, [isOpen]);

  async function handleSave() {
    if (referredTo === '') {
      setError('Choose who the case was referred to.');
      return;
    }
    setSaving(true);
    setError(null);
    try {
      await onSave({ referredTo, otherText, contactName, referenceNo });
    } catch (err) {
      tacticalFeedback.onWarning();
      setError(err instanceof Error ? err.message : 'Could not save the referral on this phone.');
    } finally {
      setSaving(false);
    }
  }

  const isOther = referredTo === 'other';

  return (
    <IonModal
      isOpen={isOpen}
      onDidDismiss={() => {
        if (!saving) onClose();
      }}
      initialBreakpoint={0.9}
      breakpoints={[0, 0.9, 1]}
      className="wf-sheet-modal"
    >
      <div className="wf-sheet">
        <div className="wf-sheet__head">
          <h3 className="wf-sheet__title">Refer {incidentLabel ?? 'Case'}</h3>
          <button type="button" className="wf-icon-btn" onClick={onClose} disabled={saving} aria-label="Close referral form">
            <IonIcon icon={closeOutline} />
          </button>
        </div>

        <div className="wf-field">
          <label className="wf-label" htmlFor="referral-to">
            Referred to
          </label>
          <select
            id="referral-to"
            className="wf-select"
            value={referredTo}
            onChange={(e) => setReferredTo(e.target.value as ReferralTarget | '')}
            disabled={saving}
          >
            <option value="">Select agency / office…</option>
            {REFERRAL_TARGETS.map((t) => (
              <option key={t.value} value={t.value}>
                {t.label}
              </option>
            ))}
          </select>
        </div>

        <div className="wf-field">
          <label className="wf-label" htmlFor="referral-other">
            {isOther ? 'Agency / person (required)' : 'Office or branch (optional)'}
          </label>
          <input
            id="referral-other"
            className="wf-input"
            type="text"
            maxLength={MAX_OTHER_TEXT}
            value={otherText}
            onChange={(e) => setOtherText(e.target.value)}
            placeholder={isOther ? 'Who did you hand the case to?' : 'e.g. Pilar Municipal Station'}
            disabled={saving}
          />
        </div>

        <div className="wf-field">
          <label className="wf-label" htmlFor="referral-contact">
            Receiving unit / official (optional)
          </label>
          <input
            id="referral-contact"
            className="wf-input"
            type="text"
            maxLength={MAX_CONTACT_NAME}
            value={contactName}
            onChange={(e) => setContactName(e.target.value)}
            placeholder="Responder, unit or official"
            disabled={saving}
          />
          <span className="wf-hint">Name the agency's responder or unit only — never a complainant, victim or citizen.</span>
        </div>

        <div className="wf-field">
          <label className="wf-label" htmlFor="referral-ref">
            Reference no. (optional)
          </label>
          <input
            id="referral-ref"
            className="wf-input"
            type="text"
            maxLength={MAX_REFERENCE_NO}
            value={referenceNo}
            onChange={(e) => setReferenceNo(e.target.value)}
            placeholder="Blotter / case / ticket number they gave you"
            disabled={saving}
          />
        </div>

        <Banner tone="info">
          This records that <strong>you handed the case over</strong>. It does not change the dispatch status and does
          not confirm the agency accepted it.
        </Banner>

        {error && <Banner tone="critical">{error}</Banner>}

        <button type="button" className="dispatch-primary-cta dispatch-primary-cta--blue" onClick={handleSave} disabled={saving}>
          {saving ? <IonSpinner name="dots" /> : <span>Record Referral</span>}
        </button>
        <button type="button" className="dispatch-secondary-cta" onClick={onClose} disabled={saving}>
          Cancel
        </button>
      </div>
    </IonModal>
  );
};

export default ReferralPanel;
