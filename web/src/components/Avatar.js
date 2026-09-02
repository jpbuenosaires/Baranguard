/**
 * Avatar — initials-circle pattern (§8 "Adopted UI reference":
 * "avatar-initials-circle pattern for user rows"). A small deterministic
 * hash picks the accent color from the existing status/accent token set
 * so the same name always gets the same color, without needing a stored
 * per-user color column.
 *
 * @param {string} fullName
 * @param {number} [size=32]
 * @returns {string} HTML string for a single <span> — safe to inline via
 *   innerHTML since fullName is escaped internally.
 */
const PALETTE = ['#1D4ED8', '#16A34A', '#D97706', '#0891B2', '#DC2626', '#1E3A6E'];

export function avatarInitials(fullName, size = 32) {
  const trimmed = (fullName || '').trim();
  const parts = trimmed.split(/\s+/).filter(Boolean);
  const initials = parts.length === 0
    ? '?'
    : parts.length === 1
      ? parts[0][0].toUpperCase()
      : (parts[0][0] + parts[parts.length - 1][0]).toUpperCase();

  let hash = 0;
  for (let i = 0; i < trimmed.length; i++) hash = (hash * 31 + trimmed.charCodeAt(i)) >>> 0;
  const color = PALETTE[hash % PALETTE.length];

  const div = document.createElement('div');
  div.textContent = initials;
  const escapedInitials = div.innerHTML;

  return `<span class="avatar" style="width:${size}px;height:${size}px;background:${color};font-size:${Math.round(size * 0.4)}px;" aria-hidden="true">${escapedInitials}</span>`;
}
