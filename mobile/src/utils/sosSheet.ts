/** Pure helpers for the SOS confirm sheet (swipe-to-dismiss and result wording). */

export const SOS_SWIPE_DISMISS_PX = 70;

export type SosResultKind = 'sent' | 'saved';

export interface SosResult {
  kind: SosResultKind;
  /** SMS fallback outcome or other detail from the existing flow, if any. */
  detail: string | null;
}

/** A downward drag dismisses only past the threshold and never while a send is in flight. */
export function shouldDismissOnDrag(deltaY: number, sending: boolean): boolean {
  return !sending && deltaY >= SOS_SWIPE_DISMISS_PX;
}

/** Only the server's confirmation may be worded as sent. */
export function sosResultHeadline(kind: SosResultKind): string {
  return kind === 'sent' ? 'SOS sent' : 'SOS saved on this phone, will send when online';
}
