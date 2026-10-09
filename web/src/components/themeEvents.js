/**
 * themeEvents.js — one signal for "the colour theme just changed" (audit
 * 2026-10-09 D-10).
 *
 * The theme is applied in three places: the topbar toggle (AppShell.js),
 * the Settings > Appearance cards (settings.js `applyTheme`), and the
 * index.html bootstrap that keeps following the OS until a preference is
 * stored. Charts and maps that resolve colours in JS (MapLibre paint
 * properties) cannot follow a CSS custom-property change by themselves.
 *
 * Rather than asking each of those three writers to remember to announce
 * the change, this watches the one thing they all write — `data-theme` on
 * <html> — and dispatches a `baranguard:themechange` event on `window`
 * (detail: `{ theme: 'light'|'dark' }`) whenever it actually changes.
 * Anything may also dispatch the event itself; listeners must be idempotent.
 */

export const THEME_CHANGE_EVENT = 'baranguard:themechange';

let observer = null;
let lastTheme = null;

function currentTheme() {
  return document.documentElement.getAttribute('data-theme');
}

/** Starts the <html data-theme> watcher. Safe to call any number of times. */
export function startThemeWatcher() {
  if (observer || typeof MutationObserver === 'undefined' || typeof document === 'undefined') return;
  lastTheme = currentTheme();
  observer = new MutationObserver(() => {
    const theme = currentTheme();
    if (theme === lastTheme) return;
    lastTheme = theme;
    window.dispatchEvent(new CustomEvent(THEME_CHANGE_EVENT, { detail: { theme } }));
  });
  observer.observe(document.documentElement, { attributes: true, attributeFilter: ['data-theme'] });
}

/**
 * Runs `callback` on every theme change for as long as `ownerEl` stays in
 * the document; the listener removes itself the first time it fires after
 * `ownerEl` has been detached (pages are rebuilt wholesale on navigation,
 * so there is no unmount hook to rely on). Returns an explicit unsubscribe.
 *
 * @param {Element|null} ownerEl
 * @param {(theme: string|null) => void} callback
 */
export function onThemeChange(ownerEl, callback) {
  startThemeWatcher();
  const handler = (event) => {
    if (ownerEl && !ownerEl.isConnected) {
      window.removeEventListener(THEME_CHANGE_EVENT, handler);
      return;
    }
    callback(event?.detail?.theme ?? currentTheme());
  };
  window.addEventListener(THEME_CHANGE_EVENT, handler);
  return () => window.removeEventListener(THEME_CHANGE_EVENT, handler);
}

/** Reads a CSS custom property off <html>, for libraries that need a resolved colour. */
export function readThemeToken(name, fallback = '') {
  const value = getComputedStyle(document.documentElement).getPropertyValue(name).trim();
  return value || fallback;
}
