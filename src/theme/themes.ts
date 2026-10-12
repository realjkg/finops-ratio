// Built-in themes: named sets of semantic color roles. Every role is a Tailwind
// color (tailwind.config.js) backed by a `--c-<role>` CSS variable (src/index.css,
// kept equal to these values by src/theme/tokens.test.ts).

export const ROLES = [
  // Surfaces
  'void', 'deep', 'slab', 'raised', 'edge',
  // Text
  'txt', 'sub', 'dim',
  // Semantic accents (also used as text)
  'value', 'cost', 'shape', 'gate', 'unit', 'purple',
  // Executive surface
  'exec-bg', 'exec-surface', 'exec-border', 'exec-hover', 'exec-text', 'exec-muted',
  // Keyboard focus ring
  'focus',
] as const;

export type Role = (typeof ROLES)[number];

export interface Theme {
  name: string;
  colorScheme: 'light' | 'dark';
  /** 'high' raises the targets to 7:1 for text and 4.5:1 for UI (see validate.ts). */
  contrast: 'standard' | 'high';
  colors: Record<Role, string>;
}

export type BuiltInThemeName = 'light' | 'high-contrast' | 'dark';

export const BUILT_IN_THEMES: Readonly<Record<BuiltInThemeName, Theme>> = {
  light: {
    name: 'light',
    colorScheme: 'light',
    contrast: 'standard',
    colors: {
      void: '#ffffff', deep: '#f6f7f9', slab: '#ffffff', raised: '#eef0f3', edge: '#848b97',
      txt: '#111827', sub: '#4b5563', dim: '#585f6c',
      value: '#04704f', cost: '#b21239', shape: '#875800', gate: '#4338ca', unit: '#0e607c', purple: '#631aa7',
      'exec-bg': '#f5f8fb', 'exec-surface': '#ffffff', 'exec-border': '#848b97', 'exec-hover': '#edf2f7',
      'exec-text': '#0f172a', 'exec-muted': '#475569',
      focus: '#2563eb',
    },
  },
  'high-contrast': {
    name: 'high-contrast',
    colorScheme: 'light',
    contrast: 'high',
    colors: {
      void: '#ffffff', deep: '#ffffff', slab: '#ffffff', raised: '#f0f0f0', edge: '#4d4d4d',
      txt: '#000000', sub: '#1a1a1a', dim: '#333333',
      value: '#004e34', cost: '#6e0016', shape: '#5c3d00', gate: '#252596', unit: '#003f4b', purple: '#361454',
      'exec-bg': '#ffffff', 'exec-surface': '#ffffff', 'exec-border': '#4d4d4d', 'exec-hover': '#f0f0f0',
      'exec-text': '#000000', 'exec-muted': '#333333',
      focus: '#0033cc',
    },
  },
  // The pre-existing look, value for value. Its known shortfalls (dim text, faint
  // borders, exec-muted) are pinned in validate.test.ts; changing them is an owner call.
  dark: {
    name: 'dark',
    colorScheme: 'dark',
    contrast: 'standard',
    colors: {
      void: '#05070b', deep: '#090c12', slab: '#0d1119', raised: '#141a26', edge: '#1a2235',
      txt: '#d0d8ea', sub: '#8895ad', dim: '#4d5a72',
      value: '#00e09e', cost: '#ff5c72', shape: '#ffc44d', gate: '#7c8dff', unit: '#00ccee', purple: '#b490ff',
      'exec-bg': '#f5f8fb', 'exec-surface': '#ffffff', 'exec-border': '#d8e1ec', 'exec-hover': '#edf2f7',
      'exec-text': '#0f172a', 'exec-muted': '#64748b',
      focus: '#6b7cf5',
    },
  },
};

/**
 * The theme used when the user has made no choice and the OS asks for no extra
 * contrast; must match the `:root` block in src/index.css (tokens.test.ts).
 * Light is the intended default. The rendered audit (tests/simulation/contrast-audit.spec.ts)
 * now shows zero failing text nodes for Light and High contrast, so the flip is only
 * waiting on ThemeMenu.test.tsx, which assumes a dark default (owned by the open theme
 * menu PR); flip it there, never as a way to hide failures.
 */
export const DEFAULT_THEME: BuiltInThemeName = 'dark';
