/**
 * Like setInterval, but does nothing while the app is in the background and runs once
 * immediately when it returns to the foreground. Returns a stop function.
 */
export function visibleInterval(fn: () => void, ms: number): () => void {
  const tick = () => {
    if (typeof document === 'undefined' || !document.hidden) fn();
  };
  const timer = setInterval(tick, ms);
  const onVisible = () => {
    if (!document.hidden) fn();
  };
  document.addEventListener('visibilitychange', onVisible);
  return () => {
    clearInterval(timer);
    document.removeEventListener('visibilitychange', onVisible);
  };
}
