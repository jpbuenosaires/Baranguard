/**
 * AsyncState — shared Loading/Error builders for the pattern already used
 * by ~20 pages via base.css's `.state-block`/`.skeleton` classes (§6:
 * "every data-driven screen needs Loading/Empty/Error-with-retry/
 * Populated"). Every page hand-rolled its own copy of this exact DOM shape
 * (see blotter-detail.js and service-health.js, the two cleanest examples
 * this was extracted from) — this just gives new/touched pages one place
 * to call instead of re-writing it. Existing pages are NOT being mass-
 * migrated; adopt incrementally as pages are touched.
 *
 * Deliberately does NOT cover the Empty state: that one varies too much
 * per page (icon choice, next-action button, copy) to generalize without
 * losing the specific "what to do next" guidance §16 asks for — keep
 * writing that one per page, same as today.
 */

/**
 * @param {{container: HTMLElement, count?: number, ariaLabel: string}} opts
 *   `count` is how many skeleton blocks to show (defaults to 3 — matches
 *   blotter-detail.js's original).
 */
export function renderLoadingSkeleton({ container, count = 3, ariaLabel }) {
  container.innerHTML = '';
  const wrap = document.createElement('div');
  wrap.className = 'stack';
  wrap.setAttribute('role', 'status');
  wrap.setAttribute('aria-label', ariaLabel);
  for (let i = 0; i < count; i++) {
    const skeleton = document.createElement('div');
    skeleton.className = 'skeleton skeleton--block';
    wrap.appendChild(skeleton);
  }
  container.appendChild(wrap);
}

/**
 * @param {{container: HTMLElement, message: string, onRetry: () => void, retryLabel?: string}} opts
 */
export function renderErrorState({ container, message, onRetry, retryLabel = 'Try again' }) {
  container.innerHTML = '';
  const block = document.createElement('div');
  block.className = 'card state-block state-block--error';
  block.setAttribute('role', 'alert');
  const text = document.createElement('p');
  text.textContent = message;
  const retryButton = document.createElement('button');
  retryButton.className = 'primary';
  retryButton.textContent = retryLabel;
  retryButton.addEventListener('click', onRetry);
  block.append(text, retryButton);
  container.appendChild(block);
}
