/**
 * admin-incidents.tsx — Chief Tanod console, Incidents tab (read-only).
 * A recent-incidents list; tapping one opens the same read-only sheet the
 * Dispatch tab uses (which carries the dispatch actions). No narrative is
 * requested or shown anywhere here.
 */

import { useCallback, useEffect, useState } from 'react';
import { IonContent, IonPage, IonRefresher, IonRefresherContent, IonSpinner } from '@ionic/react';
import MobileHeader from '../../components/MobileHeader';
import { Banner } from '../../components/WorkflowBits';
import { AdminIncidentSheet } from '../../components/AdminBits';
import { formatServerTime, humanize, NEEDS_CONNECTION } from '../../components/adminFormat';
import { useOnline } from '../../components/useOnline';
import { adminErrorMessage, getAdminIncidents, type AdminIncidentListItem } from '../../services/apiService';

const AdminIncidentsPage: React.FC = () => {
  const online = useOnline();
  const [items, setItems] = useState<AdminIncidentListItem[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [openId, setOpenId] = useState<number | null>(null);

  const load = useCallback(async () => {
    setError(null);
    try {
      setItems(await getAdminIncidents());
    } catch (err) {
      setError(adminErrorMessage(err, 'Could not load incidents.'));
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  return (
    <IonPage>
      <MobileHeader title="Incidents" subtitle="Chief Tanod Console · read-only" hideStatusIndicator />
      <IonContent>
        <IonRefresher slot="fixed" onIonRefresh={(e) => void load().finally(() => e.detail.complete())}>
          <IonRefresherContent />
        </IonRefresher>
        <div className="wf-page">
          {!online && <Banner tone="warning">{NEEDS_CONNECTION}. Showing the last loaded list.</Banner>}
          {loading && (
            <div style={{ display: 'flex', justifyContent: 'center', padding: '32px 0' }}>
              <IonSpinner name="dots" />
            </div>
          )}
          {error && (
            <>
              <Banner tone="critical">{error}</Banner>
              <button type="button" className="wf-btn" onClick={() => void load()}>
                Retry
              </button>
            </>
          )}
          {!loading && !error && items && items.length === 0 && <div className="wf-card wf-muted">No incidents on record.</div>}
          {items?.map((i) => (
            <button key={i.incidentId} type="button" className="wf-card wf-card--tap" onClick={() => setOpenId(i.incidentId)}>
              <div className="wf-card__head">
                <strong className="wf-card__title">{i.displayId ?? `Incident #${i.incidentId}`}</strong>
                <span className="status-pill status-pill--info">{humanize(i.status)}</span>
              </div>
              <div className="wf-card__sub">
                {humanize(i.incidentType)} · {humanize(i.priority)}
              </div>
              <div className="wf-card__sub">{i.locationDescription ?? 'No location description'}</div>
              <div className="wf-card__sub">{formatServerTime(i.createdAt)}</div>
            </button>
          ))}
        </div>
      </IonContent>
      <AdminIncidentSheet incidentId={openId} onClose={() => setOpenId(null)} onChanged={() => void load()} />
    </IonPage>
  );
};

export default AdminIncidentsPage;
