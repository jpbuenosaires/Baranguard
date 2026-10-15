/** Recent finished dispatches on the Dispatches list (Phase 6 split; markup unchanged). */
import type { DispatchLocalRow } from '../../services/db/localSchema';
import { dispatchStatusLabel } from '../../utils/dispatchList';
import { formatIncidentCode } from '../../utils/incidentCode';
import { formatManilaDateTime } from '../../utils/manilaFormat';
import { Chip } from '../ui';

export default function DispatchHistory({
  history,
  onOpen,
}: {
  history: DispatchLocalRow[];
  onOpen: (row: DispatchLocalRow) => void;
}) {
  return (
    <section className="dispatch-history" aria-label="Recent history">
      <h3 className="dispatch-empty-title dispatch-history__title">Recent history</h3>
      <div className="dispatch-card-list">
        {history.map((h) => (
          <article
            key={h.local_id}
            className="dispatch-card dispatch-card--p4 dispatch-card--history dispatch-card__open"
            role="link"
            tabIndex={0}
            aria-label={`Open past dispatch ${formatIncidentCode({ displayId: h.incident_display_id, serverIncidentId: h.server_incident_id })}, ${dispatchStatusLabel(h.status)}`}
            onClick={() => onOpen(h)}
            onKeyDown={(e) => {
              if (e.key === 'Enter' || e.key === ' ') {
                e.preventDefault();
                onOpen(h);
              }
            }}
          >
            <h4 className="dispatch-history__type">{(h.redacted_incident_type ?? 'incident').replace(/_/g, ' ')}</h4>
            <div className="dispatch-history__meta">
              <span className="dispatch-history__code">
                {formatIncidentCode({ displayId: h.incident_display_id, serverIncidentId: h.server_incident_id })}
              </span>
              <Chip tone={h.status === 'completed' ? 'success' : 'neutral'}>{dispatchStatusLabel(h.status)}</Chip>
            </div>
            <span className="dispatch-history__date">
              {formatManilaDateTime(h.completed_at ?? h.arrived_at ?? h.dispatched_at)}
            </span>
          </article>
        ))}
      </div>
    </section>
  );
}
