/**
 * Theme resolution — port of ../mobile/src/utils/theme.ts's model
 * ('light' | 'dark' | 'system', persisted, OS-change-aware), reworked as a
 * React context since RN has no `document.documentElement[data-theme]` to
 * toggle. `useTheme()` replaces reading CSS variables directly.
 */
import { createContext, useContext, useEffect, useMemo, useState, type ReactNode } from 'react';
import { useColorScheme } from 'react-native';
import { palettes, tokens, type ColorPalette, type ThemeMode } from './tokens';
import { prefs } from '../services/storage';

export type ThemePreference = ThemeMode | 'system';

const THEME_KEY = 'baranguard.theme';

interface ThemeContextValue {
  preference: ThemePreference;
  mode: ThemeMode;
  colors: ColorPalette;
  tokens: typeof tokens;
  setPreference: (preference: ThemePreference) => void;
  toggle: () => void;
}

const ThemeContext = createContext<ThemeContextValue | null>(null);

export function ThemeProvider({ children }: { children: ReactNode }) {
  const systemScheme = useColorScheme();
  const [preference, setPreferenceState] = useState<ThemePreference>('system');

  useEffect(() => {
    prefs.get(THEME_KEY).then((stored) => {
      if (stored === 'light' || stored === 'dark' || stored === 'system') setPreferenceState(stored);
    });
  }, []);

  const setPreference = (next: ThemePreference) => {
    setPreferenceState(next);
    if (next === 'system') {
      void prefs.remove(THEME_KEY);
    } else {
      void prefs.set(THEME_KEY, next);
    }
  };

  const mode: ThemeMode = preference === 'system' ? (systemScheme === 'dark' ? 'dark' : 'light') : preference;

  const value = useMemo<ThemeContextValue>(
    () => ({
      preference,
      mode,
      colors: palettes[mode],
      tokens,
      setPreference,
      toggle: () => setPreference(mode === 'dark' ? 'light' : 'dark'),
    }),
    [preference, mode],
  );

  return <ThemeContext.Provider value={value}>{children}</ThemeContext.Provider>;
}

export function useTheme(): ThemeContextValue {
  const ctx = useContext(ThemeContext);
  if (!ctx) throw new Error('useTheme() must be used inside <ThemeProvider>.');
  return ctx;
}
