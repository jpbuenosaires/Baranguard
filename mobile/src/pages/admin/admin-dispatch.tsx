/**
 * admin-dispatch.tsx — Chief Tanod console, Dispatch tab (decision 15C,
 * stage 1): active dispatches (open the incident read-only, assign more
 * responders, cancel with a required reason) and night-dispatch offers
 * (status/round/recipient counts, cancel an offer). "Take over" lives on
 * the incident sheet. All writes are online-only and never queued.
 */

import { useCallback, useEffect, useRef, useState } from 'react';
import { IonContent, IonPage, IonRefresher, IonRefresherContent } from '@ionic/react';
import MobileHeader from '../../components/MobileHeader';
import { LoadingBlock } from '../../components/LoadingBlock';
import { Banner, Button, Card, Chip, EmptyState, ErrorState } from '../../components/ui';
import { useOnline } from '../../components/useOnline';
import { AdminIncidentSheet, ReasonSheet } from '../../components/AdminBits';
import { LIVE_OFFER_STATUSES, formatServerTime, humanize, isActiveDispatchStatus, NEEDS_CONNECTION, offerStateText, sortOffers, visibleOffers } from '../../components/adminFormat';
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
import { formatIncidentCode } from '../../utils/incidentCode';

const AdminDispatchPage: React.FC = () => {
  const online = useOnline();
  const [dispatches, setDispatches] = useState<AdminDispatchEntry[] | null>(null);
  const [offers, setOffers] = useState<AdminOfferEntry[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [offersError, setOffersError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [showEarlier, setShowEarlier] = useState(false);
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
    if (o.status === 'fulfilled') setOffers(sortOffers(o.value));
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
          {loading && <LoadingBlock compact />}
          {error && <ErrorState message={error} onRetry={() => void load()} />}
          {!loading && !error && dispatches && dispatches.length === 0 && (
            <EmptyState title="No active dispatches" body="No Tanod is on an active dispatch right now." />
          )}
          {dispatches?.map((d) => (
            <Card
              key={d.dispatchId}
              title={d.tanodName ?? `Tanod #${d.tanodId}`}
              action={<Chip tone="info">{humanize(d.status)}</Chip>}
            >
              <div className="wf-card__sub">
                {formatIncidentCode({ displayId: d.incidentDisplayId, serverIncidentId: d.incidentId })} · {humanize(d.incidentType)} · {humanize(d.priority)}
              </div>
              <div className="wf-card__sub">Dispatched: {formatServerTime(d.dispatchedAt)}</div>
              <div className="admin-actions">
                <Button variant="secondary" onClick={() => setOpenIncidentId(d.incidentId)}>
                  Open incident
                </Button>
                <Button
                  variant="danger"
                  disabled={!online}
                  onClick={() => {
                    cancelKey.current = null;
                    setActionError(null);
                    setCancelTarget(d);
                  }}
                >
                  {online ? 'Cancel dispatch' : NEEDS_CONNECTION}
                </Button>
              </div>
            </Card>
          ))}

          <h2 className="admin-section-title">Dispatch offers</h2>
          {offersError && <ErrorState message={offersError} onRetry={() => void load()} />}
          {!loading && !offersError && offers && offers.length === 0 && (
            <EmptyState title="No offers yet" body="Night dispatch offers will appear here once one is sent." />
          )}
          {offers && offers.length > 0 && visibleOffers(offers, showEarlier).length === 0 && (
            <EmptyState title="No live offers" body="Every offer so far has finished." />
          )}
          {offers &&
            visibleOffers(offers, showEarlier).map((o) => {
              const live = LIVE_OFFER_STATUSES.includes(o.status);
              return (
                <Card
                  key={o.offerId}
                  title={`${formatIncidentCode({ displayId: o.incidentDisplayId, serverIncidentId: o.incidentId })} · ${humanize(o.incidentType)}`}
                  action={<Chip tone={live ? 'warning' : 'neutral'}>{humanize(o.status)}</Chip>}
                >
                  <div className="wf-card__sub">{offerStateText(o)}</div>
                  <div className="wf-card__sub">
                    {o.recipientCount} recipient{o.recipientCount === 1 ? '' : 's'}: waiting {o.offered}, accepted {o.accepted}, released {o.released}, expired {o.expired}
                  </div>
                  <div className="wf-card__sub">Opened {formatServerTime(o.createdAt)}</div>
                  {o.acceptedByName && <div className="wf-card__sub">Accepted by {o.acceptedByName}</div>}
                  {offerError?.id === o.offerId && <Banner tone="error">{offerError.message}</Banner>}
                  <div className="admin-actions">
                    <Button variant="secondary" onClick={() => setOpenIncidentId(o.incidentId)}>
                      Open incident
                    </Button>
                    {live && (
                      <Button
                        variant="secondary"
                        loading={offerBusyId === o.offerId}
                        disabled={!online || offerBusyId !== null}
                        onClick={() => void cancelOffer(o.offerId)}
                      >
                        {online ? 'Cancel offer' : NEEDS_CONNECTION}
                      </Button>
                    )}
                  </div>
                </Card>
              );
            })}
          {offers && offers.some((o) => !LIVE_OFFER_STATUSES.includes(o.status)) && (
            <div className="admin-more">
              <Button variant="ghost" onClick={() => setShowEarlier((v) => !v)} aria-expanded={showEarlier}>
                {showEarlier ? 'Hide finished offers' : 'Show finished offers'}
              </Button>
            </div>
          )}
        </div>
      </IonContent>

      <AdminIncidentSheet incidentId={openIncidentId} onClose={() => setOpenIncidentId(null)} onChanged={() => void load()} />
      <ReasonSheet
        isOpen={cancelTarget !== null}
        title={`Cancel dispatch${cancelTarget?.tanodName ? ` for ${cancelTarget.tanodName}` : ''}`}
        hint="Required. Say why this responder is being pulled off."
        confirmLabel="Confirm cancellation"
        dismissLabel="Keep dispatch"
        tone="danger"
        busy={busy}
        error={actionError}
        onConfirm={(reason) => void submitCancel(reason)}
        onClose={() => setCancelTarget(null)}
      />
    </IonPage>
  );
};

export default AdminDispatchPage;
