/**
 * AsyncState — shared Loading/Error builders for the `.state-block`/`.skeleton`
 * pattern in base.css (every data-driven screen needs Loading / Empty /
 * Error-with-retry / Populated). New or touched pages call this instead of
 * re-writing the DOM shape; existing pages adopt it incrementally.
 *
 * Deliberately does NOT cover the Empty state: it varies too much per page
 * (icon choice, next-action button, copy) to generalize without losing the
 * specific "what to do next" guidance — write that one per page.
 */

/**
 * @param {{container: HTMLElement, count?: number, ariaLabel: string}} opts
 *   `count` is how many skeleton blocks to show (defaults to 3 — matches
 *   incident-detail.js's original).
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
