/**
 * incident-submitted.tsx — M4 Incident Submitted Confirmation (§9 Mobile).
 *
 * §9 M4, in full: "Displays 'Saved locally,' 'Queued,' 'Synced,'
 * 'Duplicate reconciled,' or 'Needs attention.' It never claims server
 * submission when only local persistence has occurred."
 *
 * That last sentence is the whole point of this screen, so the state is
 * DERIVED from the stored row (`deriveSyncState`), never passed in as a
 * hopeful assumption from the previous screen. In Sprint 2 the only
 * reachable state is "Saved locally" — there is no sync worker yet — and
 * the copy says exactly that rather than implying delivery.
 *
 * kebab-case filename per §4.
 */

import { useEffect, useState } from 'react';
import { useNavigate, useParams } from 'react-router-dom';
import {
  IonButton,
  IonContent,
  IonHeader,
  IonNote,
  IonPage,
  IonSpinner,
  IonTitle,
  IonToolbar,
} from '@ionic/react';
import { deriveSyncState, getLocalIncident, type SyncState } from '../services/db/incidentRepository';
import type { IncidentLocalRow } from '../services/db/localSchema';

const STATE_LABELS: Record<SyncState, string> = {
  saved_locally: 'Saved locally',
  queued: 'Queued',
  synced: 'Synced',
  duplicate_reconciled: 'Duplicate reconciled',
  needs_attention: 'Needs attention',
};

const STATE_DETAIL: Record<SyncState, string> = {
  saved_locally:
    'This report is stored on your device. It has NOT been sent to the barangay workstation yet.',
  queued: 'Waiting to send to the barangay workstation.',
  synced: 'The barangay workstation has confirmed this report.',
  duplicate_reconciled:
    'The workstation already had this report; your copy was matched to it.',
  needs_attention: 'This report could not be sent. It is still safe on your device.',
};

const IncidentSubmittedPage: React.FC = () => {
  const navigate = useNavigate();
  const { localId } = useParams<{ localId: string }>();
  const [row, setRow] = useState<IncidentLocalRow | null>(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    let active = true;
    getLocalIncident(localId ?? '')
      .then((found) => {
        if (active) {
          setRow(found);
          setLoading(false);
        }
      })
      .catch(() => {
        if (active) setLoading(false);
      });
    return () => {
      active = false;
    };
  }, [localId]);

  const state: SyncState | null = row ? deriveSyncState(row) : null;

  return (
    <IonPage>
      <IonHeader>
        <IonToolbar>
          <IonTitle>Incident Saved</IonTitle>
        </IonToolbar>
      </IonHeader>
      <IonContent className="ion-padding">
        {loading && <IonSpinner name="dots" />}

        {!loading && !row && (
          <IonNote color="danger" role="alert">
            That report could not be found on this device.
          </IonNote>
        )}

        {!loading && row && state && (
          <>
            <h2 style={{ marginTop: 0 }}>{STATE_LABELS[state]}</h2>
            <p style={{ lineHeight: 1.5 }}>{STATE_DETAIL[state]}</p>

            <IonNote style={{ display: 'block', marginTop: 16, lineHeight: 1.6 }}>
              {/* The client_event_id is the identity the workstation will use to
                  recognise this exact report and avoid creating a duplicate,
                  whichever transport eventually carries it (§5 sync invariants).
                  Shown so a Tanod can quote it if they need to follow up. */}
              Reference: <code>{row.client_event_id}</code>
              <br />
              Captured: {new Date(row.created_offline_at).toLocaleString()}
            </IonNote>

            <IonButton expand="block" style={{ marginTop: 32 }} onClick={() => navigate('/home', { replace: true })}>
              Done
            </IonButton>
            <IonButton
              expand="block"
              fill="outline"
              onClick={() => navigate('/incidents/new', { replace: true })}
            >
              Log another incident
            </IonButton>
          </>
        )}
      </IonContent>
    </IonPage>
  );
};

export default IncidentSubmittedPage;
