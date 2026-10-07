/**
 * admin-dispatch.tsx — Chief Tanod console, Dispatch tab (decision 15C,
 * stage 1): active dispatches (open the incident read-only, assign more
 * responders, cancel with a required reason) and night-dispatch offers
 * (status/round/recipient counts, cancel an offer). "Take over" lives on
 * the incident sheet. All writes are online-only and never queued.
 */

import { useCallback, useEffect, useRef, useState } from 'react';
import { IonContent, IonPage, IonRefresher, IonRefresherContent, IonSpinner } from '@ionic/react';
import MobileHeader from '../../components/MobileHeader';
import { Banner } from '../../components/WorkflowBits';
import { useOnline } from '../../components/useOnline';
import { AdminIncidentSheet, ReasonSheet } from '../../components/AdminBits';
import { formatServerTime, humanize, isActiveDispatchStatus, NEEDS_CONNECTION } from '../../components/adminFormat';
import {
  adminErrorMessage,
  cancelDispatch,
  cancelDispatchOffer,
  getAdminDispatches,
  getAdminOffers,
  type AdminDispatchEntry,
  type AdminOfferEntry,
} from '../../services/apiService';
import { uuid } from '../../services/uuid';

const LIVE_OFFER_STATUSES = ['open', 'escalated'];

const AdminDispatchPage: React.FC = () => {
  const online = useOnline();
  const [dispatches, setDispatches] = useState<AdminDispatchEntry[] | null>(null);
  const [offers, setOffers] = useState<AdminOfferEntry[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [offersError, setOffersError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [openIncidentId, setOpenIncidentId] = useState<number | null>(null);
  const [notice, setNotice] = useState<string | null>(null);

  const [cancelTarget, setCancelTarget] = useState<AdminDispatchEntry | null>(null);
  const [busy, setBusy] = useState(false);
  const [actionError, setActionError] = useState<string | null>(null);
  const cancelKey = useRef<string | null>(null);
  const [offerBusyId, setOfferBusyId] = useState<number | null>(null);
  const [offerError, setOfferError] = useState<{ id: number; message: string } | null>(null);
  const offerKeys = useRef<Map<number, string>>(new Map());

  const load = useCallback(async () => {
    setError(null);
    setOffersError(null);
    const [d, o] = await Promise.allSettled([getAdminDispatches(), getAdminOffers()]);
    if (d.status === 'fulfilled') setDispatches(d.value.filter((x) => isActiveDispatchStatus(x.status)));
    else setError(adminErrorMessage(d.reason, 'Could not load dispatches.'));
    if (o.status === 'fulfilled') setOffers(o.value);
    else setOffersError(adminErrorMessage(o.reason, 'Could not load offers.'));
    setLoading(false);
  }, []);

  useEffect(() => {
    void load();
    const timer = setInterval(() => void load(), 20000);
    return () => clearInterval(timer);
  }, [load]);

  async function submitCancel(reason: string) {
    if (!cancelTarget) return;
    if (!cancelKey.current) cancelKey.current = uuid();
    setBusy(true);
    setActionError(null);
    try {
      await cancelDispatch(cancelTarget.dispatchId, reason, cancelKey.current);
      cancelKey.current = null;
      setCancelTarget(null);
      setNotice('Dispatch cancelled.');
      await load();
    } catch (err) {
      setActionError(adminErrorMessage(err, 'Could not cancel this dispatch.'));
    } finally {
      setBusy(false);
    }
  }

  async function cancelOffer(offerId: number) {
    if (!offerKeys.current.has(offerId)) offerKeys.current.set(offerId, uuid());
    setOfferBusyId(offerId);
    setOfferError(null);
    try {
      await cancelDispatchOffer(offerId, offerKeys.current.get(offerId)!);
      offerKeys.current.delete(offerId);
      setNotice('Offer cancelled.');
      await load();
    } catch (err) {
      setOfferError({ id: offerId, message: adminErrorMessage(err, 'Could not cancel this offer.') });
    } finally {
      setOfferBusyId(null);
    }
  }

  return (
    <IonPage>
      <MobileHeader title="Dispatch" subtitle="Chief Tanod Console" hideStatusIndicator />
      <IonContent>
        <IonRefresher slot="fixed" onIonRefresh={(e) => void load().finally(() => e.detail.complete())}>
          <IonRefresherContent />
        </IonRefresher>
        <div className="wf-page">
          {!online && <Banner tone="warning">{NEEDS_CONNECTION}. Dispatch actions are disabled and never queued.</Banner>}
          {notice && <Banner tone="success">{notice}</Banner>}

          <h2 className="admin-section-title">Active dispatches</h2>
          {loading && (
            <div style={{ display: 'flex', justifyContent: 'center', padding: '24px 0' }}>
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
          {!loading && !error && dispatches && dispatches.length === 0 && <div className="wf-card wf-muted">No active dispatches.</div>}
          {dispatches?.map((d) => (
            <div key={d.dispatchId} className="wf-card">
              <div className="wf-card__head">
                <strong className="wf-card__title">{d.tanodName ?? `Tanod #${d.tanodId}`}</strong>
                <span className="status-pill status-pill--info">{humanize(d.status)}</span>
              </div>
              <div className="wf-card__sub">
                Incident #{d.incidentId} · {humanize(d.incidentType)} · {humanize(d.priority)}
              </div>
              <div className="wf-card__sub">Dispatched: {formatServerTime(d.dispatchedAt)}</div>
              <div className="wf-row">
                <button type="button" className="wf-btn wf-btn--small" onClick={() => setOpenIncidentId(d.incidentId)}>
                  Open incident
                </button>
                <button
                  type="button"
                  className="wf-btn wf-btn--small"
                  disabled={!online}
                  onClick={() => {
                    cancelKey.current = null;
                    setActionError(null);
                    setCancelTarget(d);
                  }}
                >
                  {online ? 'Cancel dispatch' : NEEDS_CONNECTION}
                </button>
              </div>
            </div>
          ))}

          <h2 className="admin-section-title">Dispatch offers</h2>
          {offersError && <Banner tone="critical">{offersError}</Banner>}
          {!loading && !offersError && offers && offers.length === 0 && <div className="wf-card wf-muted">No offers yet.</div>}
          {offers?.map((o) => (
            <div key={o.offerId} className="wf-card">
              <div className="wf-card__head">
                <strong className="wf-card__title">
                  Incident #{o.incidentId} · {humanize(o.incidentType)}
                </strong>
                <span className={`status-pill ${LIVE_OFFER_STATUSES.includes(o.status) ? 'status-pill--pending' : 'status-pill--neutral'}`}>
                  {o.status}
                </span>
              </div>
              <div className="wf-card__sub">
                Round {o.round} · {o.recipientCount} recipient{o.recipientCount === 1 ? '' : 's'} (waiting {o.offered}, accepted {o.accepted},
                released {o.released}, expired {o.expired})
              </div>
              <div className="wf-card__sub">
                Opened {formatServerTime(o.createdAt)}
                {LIVE_OFFER_STATUSES.includes(o.status) ? ` · round ends ${formatServerTime(o.expiresAt)}` : ''}
              </div>
              {o.acceptedByName && <div className="wf-card__sub">Accepted by {o.acceptedByName}</div>}
              {offerError?.id === o.offerId && <Banner tone="critical">{offerError.message}</Banner>}
              <div className="wf-row">
                <button type="button" className="wf-btn wf-btn--small" onClick={() => setOpenIncidentId(o.incidentId)}>
                  Open incident
                </button>
                {LIVE_OFFER_STATUSES.includes(o.status) && (
                  <button
                    type="button"
                    className="wf-btn wf-btn--small"
                    disabled={!online || offerBusyId !== null}
                    onClick={() => void cancelOffer(o.offerId)}
                  >
                    {offerBusyId === o.offerId ? <IonSpinner name="dots" /> : online ? 'Cancel offer' : NEEDS_CONNECTION}
                  </button>
                )}
              </div>
            </div>
          ))}
        </div>
      </IonContent>

      <AdminIncidentSheet incidentId={openIncidentId} onClose={() => setOpenIncidentId(null)} onChanged={() => void load()} />
      <ReasonSheet
        isOpen={cancelTarget !== null}
        title={`Cancel dispatch${cancelTarget?.tanodName ? ` for ${cancelTarget.tanodName}` : ''}`}
        hint="Required. Say why this responder is being pulled off."
        confirmLabel="Cancel dispatch"
        busy={busy}
        error={actionError}
        onConfirm={(reason) => void submitCancel(reason)}
        onClose={() => setCancelTarget(null)}
      />
    </IonPage>
  );
};

export default AdminDispatchPage;
