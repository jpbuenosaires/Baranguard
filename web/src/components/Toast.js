/**
 * Toast.js — lightweight notification component (§3.1 of the UI/UX
 * review). Replaces scattered inline success/error feedback and
 * `alert()` calls with a consistent, non-blocking pattern.
 *
 * Deliberately appended to `document.body`, NOT `#app` — main.js's
 * `boot()` does `root.innerHTML = ''` on every navigation, which would
 * wipe an in-flight toast if it lived inside `#app`. The container is
 * created once (module-scope singleton) and survives page swaps.
 *
 * Message text is set via `textContent`, never interpolated into
 * `innerHTML` — a server error message ends up here unmodified, and this
 * app doesn't trust it as markup.
 *
 * PascalCase filename per §4 (component convention), plain function
 * exports rather than a DOM-returning component — a toast has no single
 * owning parent element the way KpiCard/DataTable do.
 */
import { icons } from './icons.js';

const VARIANT_ICON = {
  success: icons.checkCircle,
  error: icons.alertCircle,
  warning: icons.alertTriangle,
  info: icons.alertCircle,
};

let container = null;
function ensureContainer() {
  if (container) return container;
  container = document.createElement('div');
  container.className = 'toast-container';
  // "polite" — a toast is a confirmation/status, not an emergency (SOS
  // alerts have their own dedicated, always-visible banner in Dispatch
  // Center; this component doesn't replace that).
  container.setAttribute('aria-live', 'polite');
  document.body.appendChild(container);
  return container;
}

/**
 * @param {string} message
 * @param {{variant?: 'success'|'error'|'warning'|'info', duration?: number}} [options]
 * @returns {() => void} dismiss function, in case the caller wants to close it early
 */
export function showToast(message, { variant = 'info', duration = 4000 } = {}) {
  const host = ensureContainer();

  const toast = document.createElement('div');
  toast.className = `toast toast--${variant}`;
  toast.setAttribute('role', variant === 'error' ? 'alert' : 'status');

  const iconEl = document.createElement('span');
  iconEl.className = 'toast__icon';
  iconEl.setAttribute('aria-hidden', 'true');
  iconEl.innerHTML = (VARIANT_ICON[variant] || icons.alertCircle)(18);

  const messageEl = document.createElement('span');
  messageEl.className = 'toast__message';
  messageEl.textContent = message;

  const closeButton = document.createElement('button');
  closeButton.type = 'button';
  closeButton.className = 'toast__close';
  closeButton.setAttribute('aria-label', 'Dismiss notification');
  closeButton.innerHTML = icons.x(14);

  // Progress bar — shrinks from 100% to 0% over the dismiss duration,
  // giving a visual countdown. Uses a CSS custom property so the animation
  // timing matches the actual timeout. Purely decorative (aria-hidden).
  const progressBar = document.createElement('div');
  progressBar.className = 'toast__progress';
  progressBar.setAttribute('aria-hidden', 'true');
  toast.style.setProperty('--toast-duration', `${duration}ms`);

  toast.append(iconEl, messageEl, closeButton, progressBar);
  host.appendChild(toast);

  let timeoutHandle;
  let dismissed = false;
  const dismiss = () => {
    if (dismissed) return;
    dismissed = true;
    clearTimeout(timeoutHandle);
    toast.classList.add('toast--leaving');
    toast.addEventListener('animationend', () => toast.remove(), { once: true });
    // Belt-and-suspenders removal in case prefers-reduced-motion zeroed
    // the leave animation's duration to something animationend still
    // fires for — but if it somehow doesn't, don't leave a dead toast.
    setTimeout(() => toast.remove(), 400);
  };

  closeButton.addEventListener('click', (event) => {
    event.stopPropagation();
    dismiss();
  });
  // "Dismiss on click" (§3.1) — clicking the toast body itself also closes it.
  toast.addEventListener('click', dismiss);

  timeoutHandle = setTimeout(dismiss, duration);
  return dismiss;
}
