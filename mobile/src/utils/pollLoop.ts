/**
 * pollLoop.ts — a self-scheduling poller: one request at a time, backs off
 * after failures, resets after success, and stops cleanly. No React.
 */

export const POLL_BACKOFF_CAP_MS = 5 * 60_000;

/** Delay before the next run: base after success, doubling per consecutive failure up to the cap. */
export function backoffDelay(baseMs: number, failures: number, capMs: number = POLL_BACKOFF_CAP_MS): number {
  if (failures <= 0) return baseMs;
  return Math.min(capMs, baseMs * 2 ** Math.min(failures, 10));
}

export interface Poller {
  /** Run now and keep the schedule going. */
  start: () => void;
  /** Stop the schedule. An in-flight run finishes but nothing is scheduled after it. */
  stop: () => void;
  /** Ask for an early run. If one is in flight, one more runs right after it; ignored when stopped. */
  trigger: () => void;
}

/** `run` resolves true on success, false on failure (a throw also counts as failure). */
export function createPoller(run: () => Promise<boolean>, baseMs: number, capMs: number = POLL_BACKOFF_CAP_MS): Poller {
  let timer: ReturnType<typeof setTimeout> | null = null;
  let active = false;
  let inFlight = false;
  let rerun = false;
  let failures = 0;

  const clear = () => {
    if (timer !== null) {
      clearTimeout(timer);
      timer = null;
    }
  };

  const schedule = () => {
    clear();
    if (!active) return;
    timer = setTimeout(() => void tick(), backoffDelay(baseMs, failures, capMs));
  };

  async function tick() {
    timer = null;
    if (!active || inFlight) return;
    inFlight = true;
    let ok = false;
    try {
      ok = await run();
    } catch {
      ok = false;
    }
    inFlight = false;
    failures = ok ? 0 : failures + 1;
    if (rerun && active) {
      rerun = false;
      void tick();
      return;
    }
    schedule();
  }

  return {
    start() {
      if (active) return;
      active = true;
      failures = 0;
      void tick();
    },
    stop() {
      active = false;
      clear();
    },
    trigger() {
      if (!active) return;
      if (inFlight) {
        rerun = true;
        return;
      }
      clear();
      void tick();
    },
  };
}
