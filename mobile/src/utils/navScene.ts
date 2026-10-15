/** Text for the navigation sheet's destination line. Uses only data the dispatch row already has. */
import { formatDistance } from './geo';

/** "Bearing S · 29.5 km straight-line", or null when neither part is known. */
export function sceneSubline(bearing: string | null, distanceM: number | null): string | null {
  const parts: string[] = [];
  if (bearing) parts.push(`Bearing ${bearing}`);
  if (distanceM !== null) parts.push(`${formatDistance(distanceM)} straight-line`);
  return parts.length ? parts.join(' · ') : null;
}

/** Priority chip wording: sentence case, strong tone for high and critical. */
export function priorityChip(priority: string): { label: string; tone: 'critical' | 'high' | 'normal' } {
  const label = priority ? priority.charAt(0).toUpperCase() + priority.slice(1).toLowerCase() : 'Normal';
  if (priority === 'critical') return { label, tone: 'critical' };
  if (priority === 'high') return { label, tone: 'high' };
  return { label, tone: 'normal' };
}
