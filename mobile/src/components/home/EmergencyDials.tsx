import { IonIcon, useIonAlert } from '@ionic/react';
import { callOutline, medkitOutline, shieldOutline } from 'ionicons/icons';
import tacticalFeedback from '../../utils/tacticalFeedback';
import { formatPhMobile } from '../../utils/homeDuty';

interface Dial {
  href: string;
  label: string;
  number: string;
  icon: string;
}

/** Home section 3: emergency voice lines, one row of three buttons with the number visible. */
const EmergencyDials: React.FC<{ deskContact: string | null }> = ({ deskContact }) => {
  const backupDigits = deskContact ? deskContact.replace(/[^0-9+]/g, '') : '';
  const [presentAlert] = useIonAlert();
  const dials: Dial[] = [];
  if (backupDigits !== '') dials.push({ href: `tel:${backupDigits}`, label: 'Backup contact', number: formatPhMobile(deskContact ?? backupDigits), icon: callOutline });
  dials.push({ href: 'tel:911', label: 'Police', number: '911', icon: shieldOutline });
  dials.push({ href: 'tel:160', label: 'MDRRMO', number: '160', icon: medkitOutline });
  return (
    <nav className="h4-dials" aria-label="Emergency phone lines">
      {dials.map((d) => (
        <button
          key={d.href}
          type="button"
          className="h4-dial"
          aria-label={`Call ${d.label}, ${d.number}`}
          onClick={() => {
            tacticalFeedback.onTap();
            // A confirm step: these rows sit beside Report and SOS, and a stray tap must not place a call.
            void presentAlert({
              header: `Call ${d.label}?`,
              message: d.number,
              buttons: [
                { text: 'Cancel', role: 'cancel' },
                { text: 'Call', handler: () => { window.location.href = d.href; } },
              ],
            });
          }}
        >
          <IonIcon icon={d.icon} aria-hidden="true" />
          <span className="h4-dial__label">{d.label}</span>
          <span className="h4-dial__number">{d.number}</span>
        </button>
      ))}
    </nav>
  );
};

export default EmergencyDials;
