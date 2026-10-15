import { IonIcon } from '@ionic/react';
import { callOutline, medkitOutline, shieldOutline } from 'ionicons/icons';
import tacticalFeedback from '../../utils/tacticalFeedback';

interface Dial {
  href: string;
  label: string;
  number: string;
  icon: string;
}

/** Home section 3: emergency voice lines, full-width rows with the number visible. */
const EmergencyDials: React.FC<{ deskContact: string | null }> = ({ deskContact }) => {
  const backupDigits = deskContact ? deskContact.replace(/[^0-9+]/g, '') : '';
  const dials: Dial[] = [];
  if (backupDigits !== '') dials.push({ href: `tel:${backupDigits}`, label: 'Backup contact', number: deskContact ?? backupDigits, icon: callOutline });
  dials.push({ href: 'tel:911', label: 'Police', number: '911', icon: shieldOutline });
  dials.push({ href: 'tel:160', label: 'MDRRMO', number: '160', icon: medkitOutline });
  return (
    <nav className="h4-dials" aria-label="Emergency phone lines">
      {dials.map((d) => (
        <a key={d.href} href={d.href} className="h4-dial" onClick={() => tacticalFeedback.onTap()}>
          <IonIcon icon={d.icon} aria-hidden="true" />
          <span className="h4-dial__label">{d.label}</span>
          <span className="h4-dial__number">{d.number}</span>
        </a>
      ))}
    </nav>
  );
};

export default EmergencyDials;
