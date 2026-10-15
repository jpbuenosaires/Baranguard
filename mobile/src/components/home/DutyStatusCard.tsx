import { IonIcon } from '@ionic/react';
import { documentTextOutline, radioOutline, shieldCheckmarkOutline, shieldOutline, timeOutline } from 'ionicons/icons';
import { Button, Chip } from '../ui';
import type { DutyStatus } from '../../services/apiService';

interface Props {
  fullName: string;
  barangayName: string;
  status: DutyStatus | null;
  loadingStatus: boolean;
  toggling: boolean;
  shiftElapsed: string;
  patrolTracking: boolean | null;
  todayIncidentCount: number;
  /** Something saved on this phone is still waiting to reach HQ. */
  waitingToSend?: boolean;
  onToggleDuty: () => void;
}

/** Home section 1: identity line, duty state, elapsed time, GPS, duty control. */
const DutyStatusCard: React.FC<Props> = ({
  fullName,
  barangayName,
  status,
  loadingStatus,
  toggling,
  shiftElapsed,
  patrolTracking,
  todayIncidentCount,
  waitingToSend = false,
  onToggleDuty,
}) => {
  const initials = fullName
    ? fullName
        .split(' ')
        .map((p) => p[0])
        .slice(0, 2)
        .join('')
        .toUpperCase()
    : 'TR';

  return (
    <section className="h4-status" aria-label="Duty status">
      <div className="h4-identity">
        <div className="profile-avatar-circle" aria-hidden="true">{initials}</div>
        <div className="h4-identity__text">
          <span className="h4-identity__name">{fullName || 'Field Officer'}</span>
          <span className="h4-identity__sub">Barangay Tanod &bull; Barangay {barangayName}</span>
        </div>
      </div>

      <div className="h4-telemetry">
        {status === null ? (
          <Chip tone="neutral">{loadingStatus ? 'Checking duty status…' : 'Duty status unknown'}</Chip>
        ) : status === 'on_duty' ? (
          <>
            <Chip tone="success">
              <IonIcon icon={shieldCheckmarkOutline} aria-hidden="true" /> On duty
            </Chip>
            <Chip tone="neutral">
              <IonIcon icon={timeOutline} aria-hidden="true" /> {shiftElapsed}
            </Chip>
            <Chip tone={patrolTracking === false ? 'critical' : 'info'}>
              <IonIcon icon={radioOutline} aria-hidden="true" />{' '}
              {patrolTracking === false
                ? 'GPS: no signal'
                : patrolTracking === null
                  ? 'GPS: starting'
                  : 'GPS: sharing live'}
            </Chip>
          </>
        ) : (
          <Chip tone="neutral">
            <IonIcon icon={shieldOutline} aria-hidden="true" /> {status === 'responding' ? 'Responding' : 'Off duty'}
          </Chip>
        )}
      </div>

      <Button
        variant={status === 'on_duty' ? 'secondary' : 'primary'}
        fullWidth
        loading={toggling}
        disabled={loadingStatus || status === null}
        onClick={onToggleDuty}
        title={status === 'on_duty' ? 'End active patrol shift' : 'Start patrol shift'}
      >
        {status === 'on_duty' ? 'End shift' : 'Go on duty'}
      </Button>

      {(todayIncidentCount > 0 || waitingToSend) && (
        <p className="h4-today">
          <IonIcon icon={documentTextOutline} aria-hidden="true" /> Reports saved today: {todayIncidentCount}
          {waitingToSend ? ' (some waiting to send)' : ''}
        </p>
      )}
    </section>
  );
};

export default DutyStatusCard;
