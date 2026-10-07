/**
 * admin-sos.tsx — Chief Tanod console, SOS tab (decision 15C, stage 1).
 *
 * Lists the barangay's SOS alerts and lets the Chief Tanod ACKNOWLEDGE one.
 * There is deliberately NO resolve button: resolution stays on the web
 * dashboard in this stage. Online-only — Acknowledge is disabled offline
 * ("Needs a connection") and a success is shown only after the server's
 * 200. An SOS record carries no narrative; cards show who, when, and how
 * trustworthy the location is.
 */

import { useCallback, useEffect, useRef, useState } from 'react';
import { IonContent, IonPage, IonRefresher, IonRefresherContent, IonSpinner } from '@ionic/react';
import MobileHeader from '../../components/MobileHeader';
import { Banner } from '../../components/WorkflowBits';
import { useOnline } from '../../components/useOnline';
import { formatServerTime, NEEDS_CONNECTION } from '../../components/adminFormat';
import {
  acknowledgeSos,
  adminErrorMessage,
  getSosAlerts,
  getSosFallbackContact,
  getTanodDirectory,
  type AdminSosAlert,
} from '../../services/apiService';
import { uuid } from '../../services/uuid';
import tacticalFeedback from '../../utils/tacticalFeedback';

const LOCATION_LABEL: Record<string, string> = {
  live: 'Live GPS fix',
  last_known: 'Last known position (not live)',
  no_fix: 'No location available',
};

const STATUS_PILL: Record<string, string> = {
  active: 'status-pill--critical is-urgent',
  acknowledged: 'status-pill--pending',
  resolved: 'status-pill--success',
};

const AdminSosPage: React.FC = () => {
  const online = useOnline();
  const [alerts, setAlerts] = useState<AdminSosAlert[] | null>(null);
  const [names, setNames] = useState<Map<number, string>>(new Map());
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [fallbackNumber, setFallbackNumber] = useState<string | null | undefined>(undefined);
  const [ackingId, setAckingId] = useState<number | null>(null);
  const [rowError, setRowError] = useState<{ id: number; message: string } | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  // One key per SOS per user intent: a retry after a dropped reply reuses it.
  const ackKeys = useRef<Map<number, string>>(new Map());

  const load = useCallback(async () => {
    setError(null);
    try {
      setAlerts(await getSosAlerts());
    } catch (err) {
      setError(adminErrorMessage(err, 'Could not load SOS alerts.'));
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void load();
    // Names: best-effort (the directory is a separate, possibly scope-denied call).
    getTanodDirectory()
      .then((list) => setNames(new Map(list.map((u) => [u.userId, u.fullName]))))
      .catch(() => undefined);
    getSosFallbackContact()
      .then((n) => setFallbackNumber(n))
      .catch(() => setFallbackNumber(undefined));
    const timer = setInterval(() => void load(), 20000);
    return () => clearInterval(timer);
  }, [load]);

  async function acknowledge(sosId: number) {
    if (!ackKeys.current.has(sosId)) ackKeys.current.set(sosId, uuid());
    setAckingId(sosId);
    setRowError(null);
    setNotice(null);
    try {
      await acknowledgeSos(sosId, ackKeys.current.get(sosId)!);
      ackKeys.current.delete(sosId);
      tacticalFeedback.onTap();
      setNotice('SOS acknowledged.');
      await load();
    } catch (err) {
      setRowError({ id: sosId, message: adminErrorMessage(err, 'Could not acknowledge this SOS.') });
    } finally {
      setAckingId(null);
    }
  }

  return (
    <IonPage>
      <MobileHeader title="SOS Alerts" subtitle="Chief Tanod Console" hideStatusIndicator />
      <IonContent>
        <IonRefresher slot="fixed" onIonRefresh={(e) => void load().finally(() => e.detail.complete())}>
          <IonRefresherContent />
        </IonRefresher>
        <div className="wf-page">
          {!online && <Banner tone="warning">{NEEDS_CONNECTION}. Showing the last loaded list; acknowledging is disabled.</Banner>}
          {notice && <Banner tone="success">{notice}</Banner>}
          {fallbackNumber !== undefined && (
            <div className="wf-card">
              <strong className="wf-card__title">SMS fallback number</strong>
              {fallbackNumber ? (
                <a className="admin-fallback-number" href={`tel:${fallbackNumber}`}>
                  {fallbackNumber}
                </a>
              ) : (
                <span className="wf-muted">No backup contact number has been configured.</span>
              )}
              <span className="wf-hint">Where a Tanod's phone sends the SOS text if it cannot reach the workstation.</span>
            </div>
          )}

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
          {!loading && !error && alerts && alerts.length === 0 && <div className="wf-card wf-muted">No SOS alerts on record.</div>}

          {alerts?.map((a) => (
            <div key={a.sosId} className="wf-card">
              <div className="wf-card__head">
                <strong className="wf-card__title">{names.get(a.userId) ?? `Tanod #${a.userId}`}</strong>
                <span className={`status-pill ${STATUS_PILL[a.status] ?? 'status-pill--neutral'}`}>{a.status}</span>
              </div>
              <div className="wf-card__sub">Raised: {formatServerTime(a.triggeredAt)}</div>
              <div className="wf-card__sub">Received: {formatServerTime(a.receivedAt)}</div>
              <div className="wf-card__sub">
                Location: {LOCATION_LABEL[a.locationSource ?? 'no_fix'] ?? 'Unknown'}
                {a.locationSource === 'last_known' && a.locationRecordedAt ? ` (fix from ${formatServerTime(a.locationRecordedAt)})` : ''}
              </div>
              {a.acknowledgedAt && <div className="wf-card__sub">Acknowledged: {formatServerTime(a.acknowledgedAt)}</div>}
              {rowError?.id === a.sosId && <Banner tone="critical">{rowError.message}</Banner>}
              {a.status === 'active' && (
                <button
                  type="button"
                  className="dispatch-primary-cta dispatch-primary-cta--blue"
                  disabled={!online || ackingId !== null}
                  onClick={() => void acknowledge(a.sosId)}
                >
                  {ackingId === a.sosId ? <IonSpinner name="dots" /> : <span>{online ? 'Acknowledge' : NEEDS_CONNECTION}</span>}
                </button>
              )}
            </div>
          ))}
        </div>
      </IonContent>
    </IonPage>
  );
};

export default AdminSosPage;
