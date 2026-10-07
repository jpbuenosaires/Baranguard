/**
 * dispatchOfferStore.ts — in-memory view of the Tanod's open night-dispatch
 * offers (`GET /dispatch-offers`), shared by the Home card, the Dispatches tab
 * and the tab-bar badge.
 *
 * ONLINE-ONLY BY DESIGN (Wave 2 decision): an offer is a broadcast the server
 * arbitrates ("first accept wins"), so it is never cached in SQLite, never put
 * in `offline_queue_local`, and never claimed as taken locally. Everything in
 * this file lives in module memory and disappears with the process; the next
 * poll is the source of truth. If the workstation is unreachable the last
 * list is kept on screen (flagged `offline`) so a card the Tanod was already
 * looking at doesn't vanish mid-decision, and its Accept button is disabled.
 *
 * Refresh triggers (reusing what the app already listens to):
 *   - a foreground poll every OFFER_POLL_MS while ANY subscriber is mounted and
 *     the app is active. The existing 60 s on-duty sync tick is too slow for a
 *     180 s accept window, so this runs at the web dashboard's 15 s cadence;
 *   - app resume and network reconnect (the same two Capacitor events
 *     `syncScheduler.ts` uses);
 *   - a push whose data carries `dispatch_offer` — `criticalAlertStore.ts`
 *     calls `requestDispatchOfferRefresh()` from its two push listeners;
 *   - the earliest `expires_at` passing (the store drops expired offers itself
 *     and refetches, so the server's `escalated`/re-broadcast state is picked up).
 *
 * The countdown uses the DEVICE clock against the server's `expires_at`; the
 * server stays authoritative (a late accept is a 409 `OFFER_CLOSED`).
 *
 * Nothing here logs offer contents.
 */

import { App as CapacitorApp } from '@capacitor/app';
import { Network } from '@capacitor/network';
import { ApiError, getOpenDispatchOffers, type DispatchOfferEntry } from './apiService';
import { loadSession } from './session';

/** Foreground poll cadence for open offers (the accept window is 180 s server-side). */
export const OFFER_POLL_MS = 15000;

export interface DispatchOfferSnapshot {
  /** Unexpired open offers, soonest-expiring first. */
  offers: DispatchOfferEntry[];
  /** Device reports no network, or the last fetch could not reach the workstation. */
  offline: boolean;
  /** True once at least one fetch has completed (success or failure). */
  loaded: boolean;
}

type Listener = (snapshot: DispatchOfferSnapshot) => void;

const listeners = new Set<Listener>();

let allOffers: DispatchOfferEntry[] = [];
let networkConnected = true;
let lastFetchUnreachable = false;
let loaded = false;
let snapshot: DispatchOfferSnapshot = { offers: [], offline: false, loaded: false };

let pollTimer: ReturnType<typeof setInterval> | null = null;
let expiryTimer: ReturnType<typeof setTimeout> | null = null;
let inFlight: Promise<void> | null = null;
let appActive = true;
let nativeListenersStarted = false;

/**
 * Parses a server timestamp as UTC. The API emits ISO-8601 with a `Z`, but a
 * naive `YYYY-MM-DD HH:MM:SS` (UTC by the project's Rule 11) is accepted too.
 */
export function parseServerTime(value: string): number {
  const hasZone = /(Z|[+-]\d{2}:?\d{2})$/.test(value);
  const iso = hasZone ? value : `${value.replace(' ', 'T')}Z`;
  return new Date(iso).getTime();
}

function unexpired(offers: DispatchOfferEntry[], now: number): DispatchOfferEntry[] {
  return offers
    .filter((offer) => offer.status === 'offered' || offer.status === 'open')
    .filter((offer) => parseServerTime(offer.expiresAt) > now)
    .sort((a, b) => parseServerTime(a.expiresAt) - parseServerTime(b.expiresAt));
}

function publish(): void {
  const now = Date.now();
  const visible = unexpired(allOffers, now);
  snapshot = { offers: visible, offline: !networkConnected || lastFetchUnreachable, loaded };
  for (const listener of listeners) listener(snapshot);

  if (expiryTimer) clearTimeout(expiryTimer);
  expiryTimer = null;
  if (visible.length > 0 && listeners.size > 0) {
    const wait = Math.max(250, parseServerTime(visible[0].expiresAt) - now + 250);
    expiryTimer = setTimeout(() => {
      // The offer timed out locally: drop it from view and ask the server what happened next.
      publish();
      void refreshDispatchOffers();
    }, wait);
  }
}

/** Current snapshot (for hooks' initial state). */
export function getDispatchOfferSnapshot(): DispatchOfferSnapshot {
  return snapshot;
}

/**
 * Fetches `GET /dispatch-offers` now. De-duplicated (a call during an in-flight
 * fetch shares it), never throws, and does nothing while signed out.
 */
export function refreshDispatchOffers(): Promise<void> {
  if (inFlight) return inFlight;
  inFlight = (async () => {
    try {
      if (!(await loadSession())) {
        allOffers = [];
        lastFetchUnreachable = false;
        return;
      }
      allOffers = await getOpenDispatchOffers();
      lastFetchUnreachable = false;
    } catch (error) {
      // Keep whatever is on screen; only record whether the workstation was unreachable.
      lastFetchUnreachable = error instanceof ApiError && error.isOffline;
    } finally {
      loaded = true;
      inFlight = null;
      publish();
    }
  })();
  return inFlight;
}

/**
 * Called by the push listeners when a `dispatch_offer` push arrives. A no-op with
 * no subscriber mounted (the next screen to subscribe fetches on mount anyway).
 */
export function requestDispatchOfferRefresh(): void {
  if (listeners.size > 0) void refreshDispatchOffers();
}

/** True when a push `data` payload announces a dispatch offer. */
export function isDispatchOfferPush(data: Record<string, unknown> | undefined): boolean {
  return data?.type === 'dispatch_offer' || data?.notification_type === 'dispatch_offer';
}

function startPolling(): void {
  if (pollTimer || !appActive) return;
  pollTimer = setInterval(() => void refreshDispatchOffers(), OFFER_POLL_MS);
}

function stopPolling(): void {
  if (pollTimer) clearInterval(pollTimer);
  pollTimer = null;
}

function startNativeListeners(): void {
  if (nativeListenersStarted) return;
  nativeListenersStarted = true;
  Network.getStatus()
    .then((status) => {
      networkConnected = status.connected;
      publish();
    })
    .catch(() => {
      // Plugin unavailable (web preview) — assume connected; a failed fetch still flips `offline`.
    });
  Network.addListener('networkStatusChange', (status) => {
    networkConnected = status.connected;
    publish();
    if (status.connected && listeners.size > 0) void refreshDispatchOffers();
  });
  CapacitorApp.addListener('appStateChange', ({ isActive }) => {
    appActive = isActive;
    if (isActive) {
      if (listeners.size > 0) {
        startPolling();
        void refreshDispatchOffers();
      }
    } else {
      stopPolling();
    }
  });
}

/**
 * Subscribes to offer changes. The first subscriber starts the foreground poll
 * and the last one to leave stops it. The listener is called immediately with
 * the current snapshot.
 */
export function subscribeDispatchOffers(listener: Listener): () => void {
  startNativeListeners();
  listeners.add(listener);
  listener(snapshot);
  if (listeners.size === 1) {
    startPolling();
    void refreshDispatchOffers();
  }
  return () => {
    listeners.delete(listener);
    if (listeners.size === 0) {
      stopPolling();
      if (expiryTimer) clearTimeout(expiryTimer);
      expiryTimer = null;
    }
  };
}
