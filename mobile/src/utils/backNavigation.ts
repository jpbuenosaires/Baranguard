/**
 * backNavigation.ts - pure decision logic for the Android hardware back button
 * (Phase 1 UI overhaul, 2026-10-14). The listener itself lives in App.tsx; this
 * file only decides WHAT to do so the order can be unit-tested.
 *
 * Order: (a) an open overlay is dismissed first; (b) else go back if the
 * router can; (c) else, off the role's home tab, switch to the home tab;
 * (d) on the home root, ask before exiting. The app never exits silently.
 */

export type BackAction = 'ignore' | 'dismiss-overlay' | 'router-back' | 'go-home' | 'confirm-exit';

export interface BackContext {
  /** An Ionic modal/alert/action sheet/popover is open. */
  overlayOpen: boolean;
  /** A blocking overlay (loading spinner for a request in flight) is open. */
  blockingOverlayOpen: boolean;
  /** Router history has an entry to go back to. */
  canGoBack: boolean;
  pathname: string;
  /** The signed-in role's home tab path, or null when not signed in. */
  homePath: string | null;
}

export const TANOD_HOME = '/tabs/home';
export const ADMIN_HOME = '/tabs/sos';

const TANOD_TAB_ROOTS = ['/tabs/home', '/tabs/assignments', '/tabs/map', '/tabs/profile'];
const ADMIN_TAB_ROOTS = ['/tabs/sos', '/tabs/dispatch', '/tabs/incidents', '/tabs/profile'];

export function homePathForRole(role: string | null | undefined): string | null {
  if (role === 'admin') return ADMIN_HOME;
  if (role === 'tanod') return TANOD_HOME;
  return null;
}

export function isTabRoot(pathname: string, role: string | null | undefined): boolean {
  const roots = role === 'admin' ? ADMIN_TAB_ROOTS : TANOD_TAB_ROOTS;
  const clean = pathname.replace(/\/+$/, '');
  return roots.includes(clean);
}

/**
 * Tab roots are peers: back from one must not walk the tab-switch history, so
 * `canGoBack` is ignored there and the user is sent to the home tab instead.
 */
export function decideBack(ctx: BackContext, onTabRoot: boolean): BackAction {
  if (ctx.blockingOverlayOpen) return 'ignore';
  if (ctx.overlayOpen) return 'dismiss-overlay';
  if (ctx.homePath === null) return 'confirm-exit';
  const clean = ctx.pathname.replace(/\/+$/, '');
  if (clean === ctx.homePath) return 'confirm-exit';
  if (!onTabRoot && ctx.canGoBack) return 'router-back';
  return 'go-home';
}
