/**
 * admin-sos.tsx — Chief Tanod console, SOS tab (decision 15C, stage 1).
 *
 * Lists the barangay's SOS alerts and lets the Chief Tanod ACKNOWLEDGE one
 * and, since 2026-10-12 (workflow gap #6), MARK RESOLVED an active or
 * acknowledged one after an in-app confirmation, so an SOS raised at night
 * with nobody at the desk does not stay open. Online-only: both actions are
 * disabled offline, nothing is queued, and a success
 * is shown only after the server's 200. An SOS record carries no narrative;
 * cards show who, when, and how trustworthy the location is.
 */

import { useCallback, useEffect, useRef, useState } from 'react';
import { IonAlert, IonContent, IonPage, IonRefresher, IonRefresherContent, IonSpinner } from '@ionic/react';
import { LoadingBlock } from '../../components/LoadingBlock';
import { EmptyState, ErrorState } from '../../components/ui';
import MobileHeader from '../../components/MobileHeader';
import { Banner } from '../../components/WorkflowBits';
import { useOnline } from '../../components/useOnline';
import { formatServerTime, humanize, NEEDS_CONNECTION } from '../../components/adminFormat';
import {
  acknowledgeSos,
  adminErrorMessage,
  ApiError,
  getSosAlerts,
  getSosFallbackContact,
  getTanodDirectory,
  resolveSos,
  type AdminSosAlert,
} from '../../services/apiService';
import { uuid } from '../../services/uuid';
import { publishActiveSosCount } from '../../services/adminSosCount';
import { activeSosCount, splitSosAlerts } from '../../utils/sosBadge';
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
  const [resolveTarget, setResolveTarget] = useState<AdminSosAlert | null>(null);
  const [resolvingId, setResolvingId] = useState<number | null>(null);
  const resolveKeys = useRef<Map<number, string>>(new Map());
  const [showEarlier, setShowEarlier] = useState(false);
  const busy = ackingId !== null || resolvingId !== null;

  const load = useCallback(async () => {
    setError(null);
    try {
      const fresh = await getSosAlerts();
      setAlerts(fresh);
      publishActiveSosCount(activeSosCount(fresh));
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

  async function resolve(sosId: number) {
    setRowError(null);
    setNotice(null);
    if (!online) {
      setRowError({ id: sosId, message: `${NEEDS_CONNECTION}. This SOS was NOT resolved; try again when you are back online.` });
      return;
    }
    if (!resolveKeys.current.has(sosId)) resolveKeys.current.set(sosId, uuid());
    setResolvingId(sosId);
    try {
      await resolveSos(sosId, resolveKeys.current.get(sosId)!);
      resolveKeys.current.delete(sosId);
      tacticalFeedback.onTap();
      setNotice('SOS marked resolved.');
      await load();
    } catch (err) {
      if (err instanceof ApiError && err.status === 409) {
        // Already resolved (the desk got there first, or our earlier reply was lost).
        resolveKeys.current.delete(sosId);
        setNotice('This SOS was already resolved.');
        await load();
      } else {
        const message = adminErrorMessage(err, 'Could not resolve this SOS.');
        setRowError({
          id: sosId,
          message: err instanceof ApiError && err.isOffline ? `${message} This SOS was NOT resolved.` : message,
        });
      }
    } finally {
      setResolvingId(null);
    }
  }

  function renderAlert(a: AdminSosAlert) {
    return (
            <div key={a.sosId} className="wf-card">
              <div className="wf-card__head">
                <strong className="wf-card__title">{names.get(a.userId) ?? `Tanod #${a.userId}`}</strong>
                <span className={`status-pill ${STATUS_PILL[a.status] ?? 'status-pill--neutral'}`}>{humanize(a.status)}</span>
              </div>
              <div className="wf-card__sub">Raised: {formatServerTime(a.triggeredAt)}</div>
              <div className="wf-card__sub">Received: {formatServerTime(a.receivedAt)}</div>
              <div className="wf-card__sub">
                Location: {LOCATION_LABEL[a.locationSource ?? 'no_fix'] ?? 'Unknown'}
                {a.locationSource === 'last_known' && a.locationRecordedAt ? ` (fix from ${formatServerTime(a.locationRecordedAt)})` : ''}
              </div>
              {a.acknowledgedAt && <div className="wf-card__sub">Acknowledged: {formatServerTime(a.acknowledgedAt)}</div>}
              {a.resolvedAt && <div className="wf-card__sub">Resolved: {formatServerTime(a.resolvedAt)}</div>}
              {rowError?.id === a.sosId && <Banner tone="critical">{rowError.message}</Banner>}
              {a.status === 'active' && (
                <button
                  type="button"
                  className="dispatch-primary-cta dispatch-primary-cta--blue"
                  disabled={!online || busy}
                  onClick={() => void acknowledge(a.sosId)}
                >
                  {ackingId === a.sosId ? <IonSpinner name="dots" /> : <span>Acknowledge</span>}
                </button>
              )}
              {a.status === 'acknowledged' && (
                <button type="button" className="sos-resolve-btn" disabled={!online || busy} onClick={() => setResolveTarget(a)}>
                  {resolvingId === a.sosId ? <IonSpinner name="dots" /> : <span>Mark resolved</span>}
                </button>
              )}
            </div>
    );
  }

  return (
    <IonPage>
      <MobileHeader title="SOS" subtitle="Chief Tanod Console" hideStatusIndicator />
      <IonContent>
        <IonRefresher slot="fixed" onIonRefresh={(e) => void load().finally(() => e.detail.complete())}>
          <IonRefresherContent />
        </IonRefresher>
        <div className="wf-page">
          {!online && <Banner tone="warning">{NEEDS_CONNECTION}. Showing the last loaded list; acknowledging and resolving are disabled.</Banner>}
          {notice && <Banner tone="success">{notice}</Banner>}
          {loading && <LoadingBlock compact />}
          {error && <ErrorState message={error} onRetry={() => void load()} />}
          {!loading && !error && alerts && alerts.length === 0 && (
            <EmptyState title="No SOS alerts" body="No SOS alerts on record for your barangay." />
          )}

          {(() => {
            const { current, earlier } = splitSosAlerts(alerts ?? []);
            return (
              <>
                {current.map(renderAlert)}
                {earlier.length > 0 && (
                  <>
                    <button
                      type="button"
                      className="sos-earlier-toggle"
                      aria-expanded={showEarlier}
                      onClick={() => setShowEarlier((v) => !v)}
                    >
                      <span>Earlier alerts ({earlier.length})</span>
                      <span aria-hidden="true">{showEarlier ? 'Hide' : 'Show'}</span>
                    </button>
                    {showEarlier && earlier.map(renderAlert)}
                  </>
                )}
              </>
            );
          })()}
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
        </div>

        <IonAlert
          isOpen={resolveTarget !== null}
          onDidDismiss={() => setResolveTarget(null)}
          header="Mark this SOS resolved?"
          message={
            resolveTarget
              ? `${names.get(resolveTarget.userId) ?? `Tanod #${resolveTarget.userId}`}'s SOS will be closed for everyone, including the web dashboard. Only do this once the Tanod is confirmed safe.`
              : ''
          }
          buttons={[
            { text: 'Cancel', role: 'cancel' },
            {
              text: 'Mark resolved',
              role: 'confirm',
              handler: () => {
                if (resolveTarget) void resolve(resolveTarget.sosId);
              },
            },
          ]}
        />
      </IonContent>
    </IonPage>
  );
};

export default AdminSosPage;
