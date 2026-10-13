import { describe, it, expect } from 'vitest';
import { decideBack, homePathForRole, isTabRoot, type BackContext } from './backNavigation';

const base: BackContext = {
  overlayOpen: false,
  blockingOverlayOpen: false,
  canGoBack: false,
  pathname: '/tabs/home',
  homePath: '/tabs/home',
};

describe('decideBack', () => {
  it('dismisses an open overlay before anything else', () => {
    expect(decideBack({ ...base, overlayOpen: true, canGoBack: true, pathname: '/tabs/reports' }, false)).toBe('dismiss-overlay');
  });
  it('ignores back while a blocking overlay is open', () => {
    expect(decideBack({ ...base, overlayOpen: true, blockingOverlayOpen: true }, true)).toBe('ignore');
  });
  it('goes back on a sub-screen', () => {
    expect(decideBack({ ...base, canGoBack: true, pathname: '/tabs/reports' }, false)).toBe('router-back');
  });
  it('goes to the home tab from another tab root even if history exists', () => {
    expect(decideBack({ ...base, canGoBack: true, pathname: '/tabs/map' }, true)).toBe('go-home');
  });
  it('goes home from a sub-screen with no history', () => {
    expect(decideBack({ ...base, pathname: '/tabs/shifts' }, false)).toBe('go-home');
  });
  it('asks before exiting on the home root', () => {
    expect(decideBack({ ...base, canGoBack: true }, true)).toBe('confirm-exit');
  });
  it('uses the SOS tab as the admin home', () => {
    const admin = { ...base, homePath: '/tabs/sos' };
    expect(decideBack({ ...admin, pathname: '/tabs/sos' }, true)).toBe('confirm-exit');
    expect(decideBack({ ...admin, pathname: '/tabs/dispatch' }, true)).toBe('go-home');
  });
  it('asks before exiting when signed out', () => {
    expect(decideBack({ ...base, homePath: null, pathname: '/login' }, false)).toBe('confirm-exit');
  });
});

describe('helpers', () => {
  it('maps roles to home tabs', () => {
    expect(homePathForRole('tanod')).toBe('/tabs/home');
    expect(homePathForRole('admin')).toBe('/tabs/sos');
    expect(homePathForRole(null)).toBeNull();
  });
  it('recognises tab roots per role', () => {
    expect(isTabRoot('/tabs/map', 'tanod')).toBe(true);
    expect(isTabRoot('/tabs/map', 'admin')).toBe(false);
    expect(isTabRoot('/tabs/dispatch/', 'admin')).toBe(true);
    expect(isTabRoot('/tabs/reports', 'tanod')).toBe(false);
  });
});
