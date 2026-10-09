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
  // No aria-live on the container (audit 2026-10-09 X-08): each toast is
  // its own live region, role=status (polite) for success/info/warning and
  // role=alert (assertive) for errors. A polite container around an alert
  // made some screen readers queue the error behind other speech.
  document.body.appendChild(container);
  return container;
}

/**
 * @param {string} message
 * @param {{variant?: 'success'|'error'|'warning'|'info', duration?: number}} [options]
 * @returns {() => void} dismiss function, in case the caller wants to close it early
 */
export function showToast(message, { variant = 'info', duration } = {}) {
  // X-08: an error stays until it is dismissed (a 4-second error was easy
  // to miss and could not be paused by keyboard); everything else
  // auto-dismisses after 4 s unless the caller sets a duration.
  // `duration: 0` (or Infinity) also means "until dismissed".
  if (duration === undefined) duration = variant === 'error' ? 0 : 4000;
  const persistent = !Number.isFinite(duration) || duration <= 0;
  const host = ensureContainer();

  const toast = document.createElement('div');
  toast.className = `toast toast--${variant}` + (persistent ? ' toast--persistent' : '');
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
  if (!persistent) toast.style.setProperty('--toast-duration', `${duration}ms`);

  if (persistent) toast.append(iconEl, messageEl, closeButton);
  else toast.append(iconEl, messageEl, closeButton, progressBar);
  host.appendChild(toast);

  let timeoutHandle;
  let dismissed = false;
  let startTime = Date.now();
  let remaining = duration;

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

  const pause = () => {
    if (dismissed || persistent) return;
    clearTimeout(timeoutHandle);
    remaining -= (Date.now() - startTime);
  };

  const resume = () => {
    if (dismissed || persistent) return;
    startTime = Date.now();
    timeoutHandle = setTimeout(dismiss, Math.max(remaining, 500));
  };

  toast.addEventListener('mouseenter', pause);
  toast.addEventListener('mouseleave', resume);
  // Keyboard users pause it the same way a mouse hover does.
  toast.addEventListener('focusin', pause);
  toast.addEventListener('focusout', resume);

  closeButton.addEventListener('click', (event) => {
    event.stopPropagation();
    dismiss();
  });
  // "Dismiss on click" (§3.1) — clicking the toast body itself also closes it.
  toast.addEventListener('click', dismiss);

  if (!persistent) timeoutHandle = setTimeout(dismiss, duration);
  return dismiss;
}
