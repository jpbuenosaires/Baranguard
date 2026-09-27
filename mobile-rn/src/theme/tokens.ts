/**
 * §8 design tokens as plain JS objects — RN has no CSS custom properties,
 * so `../mobile/src/theme/variables.css`'s `:root` values become a `light`
 * object and its `:root[data-theme="dark"]` overrides become `dark`.
 * Values are copied verbatim; only the representation changed.
 */

const spacing = {
  xs: 4,
  sm: 8,
  md: 16,
  lg: 24,
  xl: 32,
  xxl: 48,
};

const radius = {
  sm: 8,
  md: 12,
  lg: 16,
  xl: 20,
};

const fontSize = {
  label: 12,
  sm: 14,
  md: 16,
  lg: 20,
  xl: 28,
  xxl: 36,
};

/** RN has no box-shadow string; shadows are applied per-platform (elevation vs shadow*). */
const elevation = {
  card: 2,
  cardHover: 4,
  elevated: 4,
  floating: 8,
  fab: 6,
};

export interface ColorPalette {
  navy: string;
  navyDark: string;
  navyDeep: string;
  primary: string;
  primaryHover: string;
  accent: string;
  surfaceBlue: string;
  surface: string;
  surfaceElevated: string;
  surfaceHover: string;
  bg: string;
  border: string;
  borderSubtle: string;
  borderBlue: string;
  textPrimary: string;
  textSecondary: string;
  textTertiary: string;
  textDisabled: string;
  rowActiveBg: string;
  critical: string;
  warning: string;
  success: string;
  info: string;
  pillSuccessText: string;
  pillCriticalText: string;
  pillInfoText: string;
  pillNeutralText: string;
  pillWarningText: string;
  tintSuccessBg: string;
  tintCriticalBg: string;
  tintWarningBg: string;
  tintInfoBg: string;
  tintNeutralBg: string;
  white: string;
  criticalBright: string;
  warningBright: string;
  successBright: string;
  accentSoft: string;
}

const light: ColorPalette = {
  navy: '#1e3a6e',
  navyDark: '#162d58',
  navyDeep: '#0b1329',
  primary: '#1d4ed8',
  primaryHover: '#1e40af',
  accent: '#3b82f6',
  surfaceBlue: '#e0f2fe',
  surface: '#ffffff',
  surfaceElevated: '#ffffff',
  surfaceHover: '#f1f5f9',
  bg: '#f8fafc',
  border: '#e2e8f0',
  borderSubtle: '#f1f5f9',
  borderBlue: '#bfdbfe',
  textPrimary: '#0f172a',
  textSecondary: '#475569',
  textTertiary: '#64748b',
  textDisabled: '#94a3b8',
  rowActiveBg: '#eff6ff',
  critical: '#dc2626',
  warning: '#d97706',
  success: '#16a34a',
  info: '#0891b2',
  pillSuccessText: '#15803d',
  pillCriticalText: '#991b1b',
  pillInfoText: '#1d4ed8',
  pillNeutralText: '#1e293b',
  pillWarningText: '#78350f',
  tintSuccessBg: '#f0fdf4',
  tintCriticalBg: '#fee2e2',
  tintWarningBg: '#fef3c7',
  tintInfoBg: '#dbeafe',
  tintNeutralBg: '#f3f4f6',
  white: '#ffffff',
  criticalBright: '#ef4444',
  warningBright: '#f59e0b',
  successBright: '#10b981',
  accentSoft: '#93c5fd',
};

const dark: ColorPalette = {
  ...light,
  surface: '#1e293b',
  surfaceElevated: '#1e293b',
  surfaceHover: '#334155',
  bg: '#0f172a',
  border: '#334155',
  borderSubtle: '#1e293b',
  borderBlue: '#1d4ed8',
  surfaceBlue: '#1e293b',
  textPrimary: '#f1f5f9',
  textSecondary: '#94a3b8',
  textTertiary: '#93a2b4',
  textDisabled: '#64748b',
  rowActiveBg: '#1e3a5f',
  critical: '#f87171',
  warning: '#fbbf24',
  success: '#4ade80',
  info: '#38bdf8',
  primary: '#2563eb',
  primaryHover: '#1d4ed8',
  accent: '#60a5fa',
  pillSuccessText: '#86efac',
  pillCriticalText: '#fca5a5',
  pillInfoText: '#bae6fd',
  pillNeutralText: '#cbd5e1',
  pillWarningText: '#fde68a',
  tintSuccessBg: '#16341f',
  tintCriticalBg: '#3a1c1c',
  tintWarningBg: '#3a2c10',
  tintInfoBg: '#1a2c3d',
  tintNeutralBg: '#26303f',
};

export const tokens = { spacing, radius, fontSize, elevation };
export const palettes = { light, dark };
export type ThemeMode = 'light' | 'dark';
