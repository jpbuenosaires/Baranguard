import { IonIcon } from '@ionic/react';
import { callOutline, medkitOutline, shieldOutline } from 'ionicons/icons';
import tacticalFeedback from '../../utils/tacticalFeedback';

/** Home section 3: emergency voice lines, one compact row. */
const EmergencyDials: React.FC<{ deskContact: string | null }> = ({ deskContact }) => {
  const backupDigits = deskContact ? deskContact.replace(/[^0-9+]/g, '') : '';
  return (
    <nav className="h4-dials" aria-label="Emergency phone lines">
      {backupDigits !== '' && (
        <a href={`tel:${backupDigits}`} className="h4-dial" onClick={() => tacticalFeedback.onTap()}>
          <IonIcon icon={callOutline} aria-hidden="true" />
          <span>Backup contact</span>
        </a>
      )}
      <a href="tel:911" className="h4-dial" onClick={() => tacticalFeedback.onTap()}>
        <IonIcon icon={shieldOutline} aria-hidden="true" />
        <span>Police 911</span>
      </a>
      <a href="tel:160" className="h4-dial" onClick={() => tacticalFeedback.onTap()}>
        <IonIcon icon={medkitOutline} aria-hidden="true" />
        <span>MDRRMO 160</span>
      </a>
    </nav>
  );
};

export default EmergencyDials;
