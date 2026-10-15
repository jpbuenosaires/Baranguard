/**
 * DispatchNextCard.tsx - the first thing on the assignment detail: what the
 * Tanod does next. One status button (the server-defined next status), the
 * incident code, type, priority and location. Never claims "sent": an unsynced
 * row says "Saved on this phone" via SyncLabel.
 */
import { IonIcon } from '@ionic/react';
import { checkmarkCircleOutline, locationOutline, timeOutline } from 'ionicons/icons';
import { Button, Chip, SyncLabel } from './ui';
import { nextActionBlockedReason, nextActionFor } from '../utils/dispatchNext';

interface Props {
  next: string | null;
  incidentCode: string;
  incidentType: string | null;
  priority: string;
  statusLabel: string;
  locationLine: string;
  telemetry: string;
  age: string;
  synced: boolean;
  serverDispatchId: number | null;
  updating: boolean;
  onAdvance: () => void;
}

const DispatchNextCard: React.FC<Props> = ({
  next, incidentCode, incidentType, priority, statusLabel, locationLine, telemetry, age,
  synced, serverDispatchId, updating, onAdvance,
}) => {
  const action = nextActionFor(next);
  const blocked = nextActionBlockedReason({ serverDispatchId, updating });
  const tone = priority === 'critical' ? 'critical' : priority === 'high' ? 'warning' : 'info';
  const priorityText = priority === 'critical' ? 'Critical' : priority === 'high' ? 'High priority' : 'Normal priority';

  return (
    <section className="p4d-next" aria-label="Next step">
      <div className="p4d-next__chips">
        <Chip tone={tone}>{priorityText}</Chip>
        <Chip>{statusLabel}</Chip>
        {!synced && <SyncLabel state="saved_on_phone" />}
      </div>
      <h2 className="p4d-next__code">{incidentCode}</h2>
      <p className="p4d-next__type">{incidentType ? incidentType.replace(/_/g, ' ') : 'Incident'}</p>
      <p className="p4d-next__loc">
        <IonIcon icon={locationOutline} aria-hidden="true" />
        <span>
          {locationLine}
          <span className="p4d-next__tele">{telemetry}</span>
        </span>
      </p>
      <p className="p4d-next__age">
        <IonIcon icon={timeOutline} aria-hidden="true" />
        <span>Dispatched {age}</span>
      </p>

      {action ? (
        <>
          <p className="p4d-next__hint">{action.hint}</p>
          <Button size="lg" fullWidth icon={checkmarkCircleOutline} loading={updating} disabled={blocked !== null} onClick={onAdvance}>
            {action.label}
          </Button>
          {blocked && !updating && (
            <p className="p4d-next__why" role="status">{blocked}</p>
          )}
        </>
      ) : (
        <p className="p4d-next__done">
          <IonIcon icon={checkmarkCircleOutline} aria-hidden="true" />
          <span>No further step. This dispatch is {statusLabel.toLowerCase()}.</span>
        </p>
      )}
    </section>
  );
};

export default DispatchNextCard;
