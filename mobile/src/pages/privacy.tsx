/**
 * privacy.tsx — in-app privacy notice summary (DRAFT). Static text so it reads
 * offline; the full notice is web/privacy.html. Keep both in step. Values the
 * barangay has not decided are bracketed placeholders, never invented.
 */

import { useEffect, useState } from 'react';
import { IonContent, IonPage } from '@ionic/react';
import { openOutline } from 'ionicons/icons';
import MobileHeader from '../components/MobileHeader';
import { Banner, Button } from '../components/ui';

export const PRIVACY_NOTICE_URL = 'https://baranguardph.win/privacy.html';

const PrivacyPage: React.FC = () => {
  const [online, setOnline] = useState(() => navigator.onLine);
  useEffect(() => {
    const up = () => setOnline(true);
    const down = () => setOnline(false);
    window.addEventListener('online', up);
    window.addEventListener('offline', down);
    return () => {
      window.removeEventListener('online', up);
      window.removeEventListener('offline', down);
    };
  }, []);

  return (
    <IonPage>
      <MobileHeader title="Privacy notice" showBack defaultBackHref="/tabs/profile" hideStatusIndicator />
      <IonContent className="ion-padding content-bg">
        <div className="app-column privacy-notice">
          <Banner tone="warning">
            <strong>Draft.</strong> The Sangguniang Barangay has not adopted this notice yet, and no Data Protection
            Officer has reviewed it.
          </Banner>

          <h1 className="privacy-notice__title">Privacy notice for Tanods and staff</h1>
          <p>
            This app holds personal information about you. This is what it keeps, why, and who can see it.
          </p>

          <h2>What the app records about you</h2>
          <ul>
            <li>Your location, only while you are on duty, so you can be dispatched and kept safe.</li>
            <li>Your duty status changes and hours, and the shifts you are given.</li>
            <li>The availability you submit.</li>
            <li>Your monthly accomplishment reports.</li>
            <li>School check-ins and check-outs (time and school only, no location).</li>
            <li>Incidents you report and matters you refer to other agencies.</li>
            <li>Your device ID and push notification token, so the barangay can confirm requests come from your phone.</li>
          </ul>

          <h2>What stays on this phone</h2>
          <p>
            Reports, location points and updates are saved in an encrypted database on this phone first. They are sent
            to the barangay workstation when you are connected. Signing out does not erase them.
          </p>

          <h2>Who can see what</h2>
          <ul>
            <li>You see your own incidents, dispatches, shifts and reports.</li>
            <li>The Chief Tanod and Secretary see Tanod positions, duty records and incidents for this barangay only.</li>
            <li>The written incident narrative is read only by the Secretary, and by the Chief Tanod on the web dashboard.</li>
            <li>The Punong Barangay sees dashboards and reports.</li>
            <li>The app has no advertising or analytics.</li>
          </ul>

          <h2>How long it is kept</h2>
          <p>Written incident narratives are deleted after 90 days, unless a record is under legal hold.</p>
          <p>
            Other records, including accomplishment reports, availability, school check-ins and referrals: [To be set
            by the barangay council].
          </p>

          <h2>Your rights and who to ask</h2>
          <p>
            Under the Data Privacy Act (RA 10173) you may ask what is held about you, ask for a copy, ask for
            corrections, object, and complain to the National Privacy Commission.
          </p>
          <p>Data Protection Officer: [To be filled by the barangay: name and contact].</p>
          <p>Effective date: [To be filled by the barangay].</p>

          <Button
            fullWidth
            variant="secondary"
            icon={openOutline}
            disabled={!online}
            onClick={() => window.open(PRIVACY_NOTICE_URL, '_system')}
          >
            Read the full notice
          </Button>
          {!online && <p className="wf-muted">Connect to the internet to open the full notice.</p>}
        </div>
      </IonContent>
    </IonPage>
  );
};

export default PrivacyPage;
