/** Safety confirmation sheet before completing a dispatch (Nielsen heuristic 5). Phase 6 split; markup unchanged. */
import { useEffect, useRef } from 'react';
import { IonIcon, IonSpinner } from '@ionic/react';
import { shieldCheckmarkOutline } from 'ionicons/icons';
import type { DispatchLocalRow } from '../../services/db/localSchema';
import { formatIncidentCode } from '../../utils/incidentCode';

export default function CompleteConfirmSheet({
  row,
  updating,
  onConfirm,
  onCancel,
}: {
  row: DispatchLocalRow;
  updating: boolean;
  onConfirm: () => void;
  onCancel: () => void;
}) {
  const sheetRef = useRef<HTMLDivElement>(null);
  // Manual dialog: move focus in, close on Escape, and hand focus back on close.
  useEffect(() => {
    const prev = document.activeElement as HTMLElement | null;
    sheetRef.current?.focus();
    return () => prev?.focus?.();
  }, []);

  return (
    <div
      className="dispatch-confirm-overlay"
      onKeyDown={(e) => {
        if (e.key === 'Escape' && !updating) onCancel();
      }}
      role="dialog"
      aria-modal="true"
      aria-labelledby="confirm-modal-title"
      onClick={(e) => {
        if (e.target === e.currentTarget) onCancel();
      }}
    >
      <div className="dispatch-confirm-sheet" ref={sheetRef} tabIndex={-1}>
        <div className="confirm-sheet-handle" aria-hidden="true" />
        <div className="confirm-sheet-header">
          <div className="confirm-icon-box" aria-hidden="true">
            <IonIcon icon={shieldCheckmarkOutline} />
          </div>
          <div>
            <h2 id="confirm-modal-title" className="dispatch-confirm-sheet__title">
              Complete Dispatch #{row.server_dispatch_id ?? row.local_id.slice(0, 6)}?
            </h2>
            <span className="confirm-sheet-sub">
              {formatIncidentCode({ displayId: row.incident_display_id, serverIncidentId: row.server_incident_id })} &bull; {row.redacted_incident_type?.replace(/_/g, ' ') || 'Incident'}
            </span>
          </div>
        </div>

        <p className="dispatch-confirm-sheet__desc">
          Confirm that you have finished responding to this incident. This will mark the dispatch as completed and notify the Barangay Desk.
        </p>

        <div className="dispatch-confirm-sheet__actions">
          <button
            type="button"
            className="dispatch-primary-cta dispatch-primary-cta--green"
            disabled={updating}
            onClick={onConfirm}
          >
            {updating ? <IonSpinner name="dots" /> : 'Confirm & Complete'}
          </button>
          <button
            type="button"
            className="dispatch-secondary-cta"
            disabled={updating}
            onClick={onCancel}
          >
            Cancel
          </button>
        </div>
      </div>
    </div>
  );
}
