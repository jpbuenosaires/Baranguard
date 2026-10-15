import { useEffect, useState } from 'react';
import { postSos } from '../../services/apiService';
import { getCurrentPosition } from '../../services/geolocation';
import { countFailedSosItems, enqueueSosItem } from '../../services/db/offlineQueueRepository';
import { forceSyncNow, subscribeSyncSummary } from '../../services/syncScheduler';
import { retryNeedsAttention } from '../../services/syncService';
import type { SmsFallbackInput } from '../../services/smsFallbackState';
import tacticalFeedback from '../../utils/tacticalFeedback';
import { runSosSmsFallback } from '../../utils/sosFallbackSms';
import { uuid } from '../../services/uuid';
import type { SosResult } from '../../utils/sosSheet';

/** SOS raise / offline-fallback / failed-alert state for the Home page. */
export function useSosFlow() {
  const [confirmingSos, setConfirmingSos] = useState(false);
  const [raisingSos, setRaisingSos] = useState(false);
  const [sosError, setSosError] = useState<string | null>(null);
  const [sosToast, setSosToast] = useState<string | null>(null);
  const [sosResult, setSosResult] = useState<SosResult | null>(null);
  const [sosFallbackOutcome, setSosFallbackOutcome] = useState<SmsFallbackInput | null>(null);
  // SOS alerts the sync worker gave up on after repeated server rejections —
  // persistent (not a toast) because an undelivered emergency must not
  // quietly disappear from view.
  const [failedSosCount, setFailedSosCount] = useState(0);
  const [retryingSos, setRetryingSos] = useState(false);

  async function refreshFailedSosCount() {
    try {
      setFailedSosCount(await countFailedSosItems());
    } catch {
      // Local DB unavailable (e.g. web preview) — no banner rather than a false one.
    }
  }

  useEffect(() => {
    void refreshFailedSosCount();
    return subscribeSyncSummary(() => void refreshFailedSosCount());
  }, []);

  async function handleRetryFailedSos() {
    setRetryingSos(true);
    try {
      await retryNeedsAttention();
      await forceSyncNow();
    } finally {
      await refreshFailedSosCount();
      setRetryingSos(false);
    }
  }

  function handleOpenSosModal() {
    tacticalFeedback.onWarning();
    setSosResult(null);
    setSosError(null);
    setConfirmingSos(true);
  }

  async function attemptSosSmsFallback(payload: { latitude?: number; longitude?: number }, clientEventId: string) {
    const result = await runSosSmsFallback(payload, clientEventId);
    setSosFallbackOutcome(result.outcome);
    setSosToast(result.toast);
    setSosResult({ kind: 'saved', detail: result.toast });
  }

  async function handleRaiseSos() {
    setSosError(null);
    setRaisingSos(true);
    tacticalFeedback.onSosFired();
    const clientEventId = uuid();
    try {
      let payload: { latitude?: number; longitude?: number } = {};
      try {
        const position = await getCurrentPosition();
        payload = { latitude: position.latitude, longitude: position.longitude };
      } catch {
        // Fallback without coordinates per §2 Rule 27
      }

      try {
        await postSos({ ...payload, clientEventId });
        setSosFallbackOutcome(null);
        setSosToast('EMERGENCY SOS BROADCAST SENT TO BARANGAY HQ.');
        setSosResult({ kind: 'sent', detail: null });
      } catch {
        await enqueueSosItem(clientEventId, payload);
        await attemptSosSmsFallback(payload, clientEventId);
        // Kick a sync right away: a 5s SOS timeout can be a blip, and the
        // queued row (same client_event_id) is idempotent if the first
        // attempt actually landed.
        void forceSyncNow();
      }
    } catch (error) {
      setSosError(error instanceof Error ? error.message : 'Could not raise SOS.');
    } finally {
      setRaisingSos(false);
    }
  }

  return {
    confirmingSos,
    setConfirmingSos,
    raisingSos,
    sosError,
    sosResult,
    sosToast,
    setSosToast,
    sosFallbackOutcome,
    failedSosCount,
    retryingSos,
    handleRetryFailedSos,
    handleOpenSosModal,
    handleRaiseSos,
  };
}
