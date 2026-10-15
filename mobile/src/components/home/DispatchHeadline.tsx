import { useNavigate } from 'react-router-dom';
import { IonIcon } from '@ionic/react';
import { alertCircleOutline, arrowForwardOutline, shieldCheckmarkOutline } from 'ionicons/icons';
import { Chip } from '../ui';
import tacticalFeedback from '../../utils/tacticalFeedback';
import type { DispatchLocalRow } from '../../services/db/localSchema';

interface Props {
  topDispatch: DispatchLocalRow | null;
  activeDispatchCount: number;
}

/** Home section 2: one status headline — active call, or all clear. */
const DispatchHeadline: React.FC<Props> = ({ topDispatch, activeDispatchCount }) => {
  const navigate = useNavigate();

  if (!topDispatch) {
    return (
      <div className="console-mission-card console-mission-card--clear h4-clear">
        <h2 className="console-mission-title h4-clear__title">
          <IonIcon icon={shieldCheckmarkOutline} aria-hidden="true" />
          All clear
        </h2>
        <p className="console-mission-desc">No active dispatches assigned to you.</p>
      </div>
    );
  }

  return (
    <div
      className={`console-mission-card ${
        topDispatch.priority === 'critical'
          ? 'console-mission-card--critical'
          : topDispatch.priority === 'high'
            ? 'console-mission-card--high'
            : 'console-mission-card--normal'
      }`}
    >
      <div className="console-mission-header">
        <span className="console-mission-tag">
          <IonIcon icon={alertCircleOutline} aria-hidden="true" />
          Active call #{topDispatch.server_dispatch_id ?? topDispatch.local_id.slice(0, 6)}
        </span>
        <Chip tone={topDispatch.priority === 'critical' ? 'critical' : topDispatch.priority === 'high' ? 'warning' : 'info'}>
          {topDispatch.priority.toUpperCase()} priority
        </Chip>
      </div>

      <h2 className="console-mission-title">
        {topDispatch.redacted_incident_type ? topDispatch.redacted_incident_type.replace(/_/g, ' ') : 'INCIDENT REPORT'}
      </h2>

      {activeDispatchCount > 1 && (
        <p className="console-mission-desc">1 of {activeDispatchCount} active calls assigned to you.</p>
      )}

      <button
        type="button"
        className={`console-mission-btn ${
          topDispatch.priority === 'critical' ? 'console-mission-btn--critical' : 'console-mission-btn--blue'
        }`}
        onClick={() => {
          tacticalFeedback.onTap();
          navigate(`/tabs/assignments/${encodeURIComponent(topDispatch.local_id)}`);
        }}
      >
        <span>Respond to Call</span>
        <IonIcon icon={arrowForwardOutline} />
      </button>
    </div>
  );
};

export default DispatchHeadline;
