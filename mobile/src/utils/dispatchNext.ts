/**
 * dispatchNext.ts - wording for the single "what do I do next" card on the
 * assignment detail. Pure: the status order itself is server-defined and comes
 * from nextStatusFor(); nothing here decides a transition.
 */

export type NextStatus = 'en_route' | 'arrived' | 'completed';

export interface NextAction {
  label: string;
}

const ACTIONS: Record<NextStatus, NextAction> = {
  en_route: { label: 'Start navigation, go en route' },
  arrived: { label: 'Mark arrived' },
  completed: { label: 'Mark completed' },
};

export function nextActionFor(next: string | null): NextAction | null {
  return next && next in ACTIONS ? ACTIONS[next as NextStatus] : null;
}

/** Why the action cannot be used right now, or null when it can. */
export function nextActionBlockedReason(opts: {
  serverDispatchId: number | null;
  updating: boolean;
}): string | null {
  if (opts.updating) return 'Saving your change.';
  if (opts.serverDispatchId === null) {
    return 'This call has no desk number yet. Connect to the workstation so it can sync, then try again.';
  }
  return null;
}
