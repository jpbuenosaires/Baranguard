/** Text for the navigation sheet's destination line. Uses only data the dispatch row already has. */
import { compassWord, formatDistance } from './geo';

/** "29.5 km south, straight-line", or null when neither part is known. */
export function sceneSubline(bearing: string | null, distanceM: number | null): string | null {
  const direction = bearing ? compassWord(bearing) : null;
  if (distanceM === null) return direction ? `Heading ${direction}` : null;
  return `${formatDistance(distanceM)}${direction ? ` ${direction}` : ''}, straight-line`;
}

/** Priority chip wording: sentence case, strong tone for high and critical. */
export function priorityChip(priority: string): { label: string; tone: 'critical' | 'high' | 'normal' } {
  const label = priority ? priority.charAt(0).toUpperCase() + priority.slice(1).toLowerCase() : 'Normal';
  if (priority === 'critical') return { label, tone: 'critical' };
  if (priority === 'high') return { label, tone: 'high' };
  return { label, tone: 'normal' };
}
