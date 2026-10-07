/**
 * DispatchOfferCards.tsx — the night-dispatch "offer" cards (Wave 2).
 *
 * At night the server broadcasts a call to every on-duty tanod holding a
 * published shift; the first to accept (as recorded by the server) gets a
 * normal dispatch, everyone else is released. This renders the open offers
 * on Home and on the Dispatches tab.
 *
 * WHAT A CARD SHOWS — and nothing more: the incident-type label, the barangay
 * name, when the offer was raised and a live countdown to `expires_at`. No
 * narrative, names, contacts, coordinates or location text exist in the offer
 * payload and none are fetched here (the incident detail only becomes
 * available once the tanod's own dispatch exists).
 *
 * ACCEPT IS ONLINE-ONLY: the button is disabled with "Needs a connection to
 * accept" when the device or workstation is unreachable. It is never queued,
 * never written to SQLite / `offline_queue_local`, and success is only ever
 * claimed from the server's 200. A retry after a network failure re-sends the
 * SAME `request_id` for that offer (the server replays the original result), so
 * a dropped response can't turn a won call into a spurious "someone else got
 * it"; the id is discarded once the server gives a definitive answer.
 */

import { useCallback, useEffect, useRef, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { IonIcon, IonSpinner } from '@ionic/react';
import { flashOutline, locationOutline, timeOutline, cloudOfflineOutline } from 'ionicons/icons';
import { Banner } from './WorkflowBits';
import {
  acceptDispatchOffer,
  ApiError,
  getDispatches,
  type DispatchOfferEntry,
} from '../services/apiService';
import { parseServerTime, refreshDispatchOffers } from '../services/dispatchOfferStore';
import { cacheDispatchesFromServer, getCachedDispatch } from '../services/db/dispatchRepository';
import { useDispatchOffers } from '../services/useDispatchOffers';
import { uuid } from '../services/uuid';
import { formatCountdown, incidentTypeLabel } from '../utils/dispatchOfferFormat';
import { formatManilaTime } from '../utils/manilaTime';
import tacticalFeedback from '../utils/tacticalFeedback';

type Notice = { tone: 'warning' | 'critical' | 'info'; text: string };

const DispatchOfferCards: React.FC = () => {
  const navigate = useNavigate();
  const { offers, offline } = useDispatchOffers();
  const [now, setNow] = useState(() => Date.now());
  const [acceptingId, setAcceptingId] = useState<number | null>(null);
  const [notice, setNotice] = useState<Notice | null>(null);
  // offer id -> request_id kept across network-failure retries (see the file doc).
  const pendingRequestIds = useRef(new Map<number, string>());

  // 1 s tick for the countdown, only while there is something to count down.
  useEffect(() => {
    if (offers.length === 0) return;
    setNow(Date.now());
    const timer = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(timer);
  }, [offers.length]);

  // A notice about an offer that has since gone away shouldn't linger forever.
  useEffect(() => {
    if (!notice || notice.tone === 'critical') return;
    const timer = setTimeout(() => setNotice(null), 8000);
    return () => clearTimeout(timer);
  }, [notice]);

  const goToAssignment = useCallback(
    async (dispatchId: number) => {
      // Pull the new dispatch into the local cache, then open the same detail screen the
      // Dispatches list uses. If the follow-up fetch fails the accept has still succeeded
      // (the server said so), so fall back to the list rather than showing an error.
      const localId = `srv-${dispatchId}`;
      try {
        await cacheDispatchesFromServer(await getDispatches());
        if (await getCachedDispatch(localId)) {
          navigate(`/tabs/assignments/${encodeURIComponent(localId)}`);
          return;
        }
      } catch {
        // fall through
      }
      navigate('/tabs/assignments');
    },
    [navigate]
  );

  async function handleAccept(offer: DispatchOfferEntry) {
    if (acceptingId !== null || offline) return;
    tacticalFeedback.onTap();
    setNotice(null);
    setAcceptingId(offer.offerId);
    const requestId = pendingRequestIds.current.get(offer.offerId) ?? uuid();
    pendingRequestIds.current.set(offer.offerId, requestId);
    try {
      const result = await acceptDispatchOffer(offer.offerId, requestId);
      pendingRequestIds.current.delete(offer.offerId);
      tacticalFeedback.onSuccess();
      void refreshDispatchOffers();
      await goToAssignment(result.dispatchId);
    } catch (error) {
      if (error instanceof ApiError && error.isOffline) {
        // Ambiguous outcome: keep the request id so the retry replays rather than re-races.
        tacticalFeedback.onWarning();
        setNotice({
          tone: 'warning',
          text: 'Could not reach the barangay workstation. Check your connection and tap Accept again.',
        });
        return;
      }
      pendingRequestIds.current.delete(offer.offerId);
      tacticalFeedback.onWarning();
      if (error instanceof ApiError && error.status === 409 && error.code === 'OFFER_CLOSED') {
        setNotice({ tone: 'info', text: 'Another tanod already responded.' });
      } else if (error instanceof ApiError && error.status === 404) {
        setNotice({ tone: 'info', text: 'This call is no longer available.' });
      } else {
        setNotice({
          tone: 'critical',
          text: error instanceof Error && error.message ? error.message : 'Could not accept this call.',
        });
      }
      void refreshDispatchOffers();
    } finally {
      setAcceptingId(null);
    }
  }

  if (offers.length === 0 && !notice) return null;

  return (
    <section className="wf-stack" aria-label="Dispatch offers">
      {notice && <Banner tone={notice.tone}>{notice.text}</Banner>}

      {offers.map((offer) => {
        const remainingMs = parseServerTime(offer.expiresAt) - now;
        const expired = remainingMs <= 0;
        const raisedAt = parseServerTime(offer.createdAt);
        const accepting = acceptingId === offer.offerId;
        const disabled = offline || expired || acceptingId !== null;
        const typeLabel = incidentTypeLabel(offer.incidentType);

        return (
          <article
            key={offer.offerId}
            className="wf-card dispatch-offer-card"
            aria-label={`Dispatch offer: ${typeLabel}, Barangay ${offer.barangayName}`}
          >
            <div className="wf-card__head">
              <div className="wf-stack dispatch-offer-card__text">
                <span className="dispatch-offer-card__tag">
                  <IonIcon icon={flashOutline} aria-hidden="true" />
                  <span>Call available</span>
                </span>
                <h3 className="wf-card__title">{typeLabel}</h3>
                <span className="wf-card__sub dispatch-offer-card__meta">
                  <IonIcon icon={locationOutline} aria-hidden="true" />
                  <span>Barangay {offer.barangayName}</span>
                  {Number.isFinite(raisedAt) && (
                    <>
                      <span aria-hidden="true">&bull;</span>
                      <span>{formatManilaTime(new Date(raisedAt).toISOString())}</span>
                    </>
                  )}
                </span>
              </div>
              <div
                className={`dispatch-offer-card__timer ${
                  remainingMs <= 30000 ? 'dispatch-offer-card__timer--urgent' : ''
                }`}
                role="timer"
                aria-label={`${formatCountdown(remainingMs)} left to accept`}
              >
                <IonIcon icon={timeOutline} aria-hidden="true" />
                <span>{formatCountdown(remainingMs)}</span>
                <span className="dispatch-offer-card__timer-label">left</span>
              </div>
            </div>

            <button
              type="button"
              className="wf-btn wf-btn--primary wf-btn--block"
              disabled={disabled}
              onClick={() => void handleAccept(offer)}
            >
              {accepting ? (
                <>
                  <IonSpinner name="dots" style={{ width: '18px', height: '18px' }} />
                  <span>Accepting&hellip;</span>
                </>
              ) : offline ? (
                <>
                  <IonIcon icon={cloudOfflineOutline} aria-hidden="true" />
                  <span>Needs a connection to accept</span>
                </>
              ) : (
                <span>Accept call</span>
              )}
            </button>
          </article>
        );
      })}
    </section>
  );
};

export default DispatchOfferCards;
