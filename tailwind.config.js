/** @type {import('tailwindcss').Config} */
module.exports = {
  // Server-only ingestion code (src/ingest) has no UI and must never contribute classes to the client CSS.
  content: ['./pages/**/*.{ts,tsx}', './src/**/*.{ts,tsx}', '!./src/ingest/**'],
  theme: {
    extend: {
      colors: {
        // Backgrounds (spec §10.1)
        void: '#05070b',
        deep: '#090c12',
        slab: '#0d1119',
        raised: '#141a26',
        edge: '#1a2235',
        // Text
        txt: '#d0d8ea',
        sub: '#8895ad',
        dim: '#4d5a72',
        // Semantic
        value: '#00e09e',
        cost: '#ff5c72',
        shape: '#ffc44d',
        gate: '#7c8dff',
        unit: '#00ccee',
        purple: '#b490ff',
        // Cloud providers
        aws: '#ff9900',
        azure: '#0078d4',
        gcp: '#4285f4',
        // Executive light surface (Ratio v2 Wave 2). Token accents (value/cost/
        // shape/gate/unit) are unchanged — they read on both backgrounds.
        'exec-bg': '#f5f8fb',
        'exec-surface': '#ffffff',
        'exec-border': '#d8e1ec',
        'exec-hover': '#edf2f7',
        'exec-text': '#0f172a',
        'exec-muted': '#64748b',
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

