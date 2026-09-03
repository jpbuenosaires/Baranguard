/**
 * NotBuiltYetPage.tsx — shared honest placeholder for a bottom-nav tab
 * whose real screen doesn't exist yet (Assignments/M5, Map/M7, Profile/
 * M10 — all Sprint 3+).
 *
 * Same precedent as the web dashboard's `renderUnavailable()` (Sprint 1)
 * and this app's own original `home.tsx` before M2 was built: a nav
 * destination that resolves to nothing looks like a bug, but a fake
 * screen with invented data is worse (§8's demo-tell rule) — so the tab
 * is real and reachable, and says plainly that the screen behind it
 * isn't built, rather than either hiding the tab or faking content.
 */

import { IonContent, IonHeader, IonNote, IonPage, IonTitle, IonToolbar } from '@ionic/react';

interface NotBuiltYetPageProps {
  title: string;
  detail: string;
  /** Additive — a real, working sub-section on an otherwise-unbuilt page (e.g. M12's notification diagnostics on the unbuilt Profile/M10 screen), never a second placeholder. */
  children?: React.ReactNode;
}

const NotBuiltYetPage: React.FC<NotBuiltYetPageProps> = ({ title, detail, children }) => (
  <IonPage>
    <IonHeader>
      <IonToolbar>
        <IonTitle>{title}</IonTitle>
      </IonToolbar>
    </IonHeader>
    <IonContent className="ion-padding">
      <div className="app-column">
        <h2 className="app-title">{title} isn't built yet</h2>
        <IonNote className="app-note">{detail}</IonNote>
        {children}
      </div>
    </IonContent>
  </IonPage>
);

export default NotBuiltYetPage;
