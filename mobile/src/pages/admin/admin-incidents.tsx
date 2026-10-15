/**
 * admin-incidents.tsx — Chief Tanod console, Incidents tab (read-only).
 * A recent-incidents list; tapping one opens the same read-only sheet the
 * Dispatch tab uses (which carries the dispatch actions). No narrative is
 * requested or shown anywhere here.
 */

import { useCallback, useEffect, useId, useMemo, useState } from 'react';
import { IonContent, IonPage, IonRefresher, IonRefresherContent } from '@ionic/react';
import MobileHeader from '../../components/MobileHeader';
import { LoadingBlock } from '../../components/LoadingBlock';
import { Banner, Button, Chip, EmptyState, ErrorState } from '../../components/ui';
import { AdminIncidentSheet } from '../../components/AdminBits';
import { capList, filterIncidents, formatServerTime, humanize, INCIDENT_STATUS_FILTERS, NEEDS_CONNECTION } from '../../components/adminFormat';
import { useOnline } from '../../components/useOnline';
import { formatIncidentCode } from '../../utils/incidentCode';
import { adminErrorMessage, getAdminIncidents, type AdminIncidentListItem } from '../../services/apiService';

const AdminIncidentsPage: React.FC = () => {
  const online = useOnline();
  const [items, setItems] = useState<AdminIncidentListItem[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [openId, setOpenId] = useState<number | null>(null);
  const [query, setQuery] = useState('');
  const [status, setStatus] = useState('all');
  const [expanded, setExpanded] = useState(false);
  const searchId = useId();
  const filtered = useMemo(() => filterIncidents(items ?? [], query, status), [items, query, status]);
  const shown = capList(filtered, expanded);

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
          {loading && <LoadingBlock compact />}
          {error && <ErrorState message={error} onRetry={() => void load()} />}
          {!loading && !error && items && items.length === 0 && (
            <EmptyState title="No incidents" body="No incidents on record for your barangay." />
          )}
          {items && items.length > 0 && (
            <>
              <div className="wf-field">
                <label className="wf-label" htmlFor={searchId}>
                  Search incidents
                </label>
                <input
                  id={searchId}
                  type="search"
                  className="wf-input admin-search"
                  placeholder="Code, type or location"
                  value={query}
                  onChange={(e) => setQuery(e.target.value)}
                />
              </div>
              <div className="admin-filter-row" role="group" aria-label="Filter by status">
                {INCIDENT_STATUS_FILTERS.map((f) => (
                  <Chip key={f.value} selected={status === f.value} onClick={() => setStatus(f.value)}>
                    {f.label}
                  </Chip>
                ))}
              </div>
              <p className="admin-updated" role="status">
                {filtered.length} of {items.length} incident{items.length === 1 ? '' : 's'}
              </p>
              {filtered.length === 0 && (
                <EmptyState
                  title="No matching incidents"
                  body="Nothing matches that search and status."
                  action={
                    <Button
                      variant="secondary"
                      onClick={() => {
                        setQuery('');
                        setStatus('all');
                      }}
                    >
                      Clear search and filters
                    </Button>
                  }
                />
              )}
            </>
          )}
          {shown.map((i) => (
            <button key={i.incidentId} type="button" className="wf-card wf-card--tap" onClick={() => setOpenId(i.incidentId)}>
              <div className="wf-card__head">
                <strong className="wf-card__title">{formatIncidentCode({ displayId: i.displayId, serverIncidentId: i.incidentId })}</strong>
                <span className="status-pill status-pill--info">{humanize(i.status)}</span>
              </div>
              <div className="wf-card__sub">
                {humanize(i.incidentType)} · {humanize(i.priority)}
              </div>
              <div className="wf-card__sub">{i.locationDescription ?? 'No location description'}</div>
              <div className="wf-card__sub">{formatServerTime(i.createdAt)}</div>
            </button>
          ))}
          {filtered.length > shown.length && (
            <div className="admin-more">
              <Button variant="secondary" onClick={() => setExpanded(true)}>
                Show {filtered.length - shown.length} more
              </Button>
            </div>
          )}
        </div>
      </IonContent>
      <AdminIncidentSheet incidentId={openId} onClose={() => setOpenId(null)} onChanged={() => void load()} />
    </IonPage>
  );
};

export default AdminIncidentsPage;
