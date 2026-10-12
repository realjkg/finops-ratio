// Must list exactly ROLES from src/theme/themes.ts (checked by src/theme/tokens.test.ts).
const THEMED = [
  'void', 'deep', 'slab', 'raised', 'edge', 'txt', 'sub', 'dim',
  'value', 'cost', 'shape', 'gate', 'unit', 'purple',
  'exec-bg', 'exec-surface', 'exec-border', 'exec-hover', 'exec-text', 'exec-muted', 'focus',
];

/** @type {import('tailwindcss').Config} */
module.exports = {
  // Server-only ingestion code (src/ingest) has no UI and must never contribute classes to the client CSS.
  content: ['./pages/**/*.{ts,tsx}', './src/**/*.{ts,tsx}', '!./src/ingest/**'],
  theme: {
    extend: {
      colors: {
        // Theme roles (src/theme/themes.ts) resolve through `--c-<role>` channel
        // triplets set in src/index.css, so opacity modifiers (bg-void/50) keep working.
        ...Object.fromEntries(THEMED.map((role) => [role, `rgb(var(--c-${role}) / <alpha-value>)`])),
        // Cloud provider brand colors stay fixed in every theme.
        aws: '#ff9900',
        azure: '#0078d4',
        gcp: '#4285f4',
      },
      fontFamily: {
        mono: ['"JetBrains Mono"', 'ui-monospace', 'monospace'],
        body: ['"Instrument Sans"', 'ui-sans-serif', 'system-ui', 'sans-serif'],
      },
      borderRadius: {
        card: '6px',
      },
    },
  },
  plugins: [],
};

