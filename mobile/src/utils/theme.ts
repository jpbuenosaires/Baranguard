/**
 * theme.ts — Theme management utility for Baranguard Mobile.
 *
 * Persists user preference ('light' | 'dark' | 'system') in localStorage
 * and synchronizes the root `[data-theme]` attribute. Matches the web
 * command center's theme resolution model.
 */

import { Capacitor } from '@capacitor/core';
import { StatusBar, Style } from '@capacitor/status-bar';

export type ThemePreference = 'light' | 'dark' | 'system';

export const THEME_KEY = 'baranguard.theme';
export const THEME_CHANGED_EVENT = 'baranguard:theme-changed';

export async function syncStatusBar(resolved: 'light' | 'dark'): Promise<void> {
  const isDark = resolved === 'dark';

  // 1. Web & PWA Meta Tags
  if (typeof document !== 'undefined') {
    const metaColorScheme = document.querySelector('meta[name="color-scheme"]');
    if (metaColorScheme) {
      metaColorScheme.setAttribute('content', isDark ? 'dark' : 'light');
    }

    const metaThemeColor = document.querySelector('meta[name="theme-color"]');
    if (metaThemeColor) {
      metaThemeColor.setAttribute('content', isDark ? '#1e293b' : '#ffffff');
    }
  }

  // 2. Native Capacitor StatusBar
  if (Capacitor.isPluginAvailable('StatusBar')) {
    try {
      await StatusBar.setStyle({ style: isDark ? Style.Dark : Style.Light });
      await StatusBar.setBackgroundColor({ color: isDark ? '#1e293b' : '#ffffff' });
    } catch {
      // Non-fatal if web or plugin not available
    }
  }
}

export function getStoredTheme(): ThemePreference {
  try {
    const val = localStorage.getItem(THEME_KEY);
    if (val === 'light' || val === 'dark' || val === 'system') return val;
  } catch {
    // Private mode / storage disabled
  }
  return 'system';
}

export function isCurrentlyDark(): boolean {
  if (typeof document === 'undefined') return false;
  const attr = document.documentElement.getAttribute('data-theme');
  if (attr === 'dark') return true;
  if (attr === 'light') return false;
  return typeof window !== 'undefined' && window.matchMedia
    ? window.matchMedia('(prefers-color-scheme: dark)').matches
    : false;
}

export function resolveTheme(preference: ThemePreference): 'light' | 'dark' {
  if (preference === 'dark') return 'dark';
  if (preference === 'light') return 'light';
  if (typeof window !== 'undefined' && window.matchMedia) {
    return window.matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light';
  }
  return 'light';
}

export function setTheme(preference: ThemePreference): void {
  try {
    if (preference === 'system') {
      localStorage.removeItem(THEME_KEY);
    } else {
      localStorage.setItem(THEME_KEY, preference);
    }
  } catch {
    // Private mode
  }

  const resolved = resolveTheme(preference);
  document.documentElement.setAttribute('data-theme', resolved);
  void syncStatusBar(resolved);
  window.dispatchEvent(new CustomEvent(THEME_CHANGED_EVENT, { detail: { preference, resolved } }));
}

export function toggleTheme(): void {
  const currentDark = isCurrentlyDark();
  setTheme(currentDark ? 'light' : 'dark');
}

/**
 * Watch OS color scheme changes when user preference is set to 'system'.
 */
export function initThemeListener(): () => void {
  const currentTheme = isCurrentlyDark() ? 'dark' : 'light';
  void syncStatusBar(currentTheme);

  if (typeof window === 'undefined' || !window.matchMedia) return () => {};

  const mq = window.matchMedia('(prefers-color-scheme: dark)');
  const handler = (e: MediaQueryListEvent) => {
    const stored = getStoredTheme();
    if (stored === 'system') {
      const resolved = e.matches ? 'dark' : 'light';
      document.documentElement.setAttribute('data-theme', resolved);
      void syncStatusBar(resolved);
      window.dispatchEvent(new CustomEvent(THEME_CHANGED_EVENT, { detail: { preference: 'system', resolved } }));
    }
  };

  mq.addEventListener('change', handler);
  return () => mq.removeEventListener('change', handler);
}

