/**
 * The one HTML-escaping helper for the web app.
 *
 * Three page modules grew their own private copy of this
 * (admin-dashboard, dispatch-center, gis-live-tracking) and all three
 * diverged: two miss the single quote, which is live inside any
 * single-quoted attribute, and dispatch-center's `if (!str) return ''`
 * silently renders a real `0` as empty. New code imports this one.
 *
 * Escaping is still the second-best answer. Prefer `textContent` — a node
 * that never parses markup cannot be tricked into executing it. Reach for
 * this only where a template literal genuinely has to build markup.
 */
export function escapeHtml(value) {
  if (value === null || value === undefined) return '';
  return String(value)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}
