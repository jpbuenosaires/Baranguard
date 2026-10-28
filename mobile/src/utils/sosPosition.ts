/** Longest the SOS flow waits for a GPS fix before sending without one (Rule 27 / C-01: the server falls back to last-known or no-fix). */
export const SOS_FIX_WAIT_MS = 2000;

/** Resolves with the fix if it arrives within `ms`, else null. Never rejects. */
export function positionWithin<T>(get: () => Promise<T>, ms: number = SOS_FIX_WAIT_MS): Promise<T | null> {
  return new Promise((resolve) => {
    const timer = setTimeout(() => resolve(null), ms);
    get().then(
      (value) => {
        clearTimeout(timer);
        resolve(value);
      },
      () => {
        clearTimeout(timer);
        resolve(null);
      }
    );
  });
}
