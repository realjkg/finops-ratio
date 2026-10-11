// Token layer: Tailwind classes resolve through CSS variables, index.css carries
// exactly the values in themes.ts, the dark theme is the pre-existing look byte
// for byte, and hard-coded colors outside the tokens cannot grow (T4 migrates them).
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { createRequire } from 'node:module';
import postcss from 'postcss';
import tailwind from 'tailwindcss';
import { describe, expect, it } from 'vitest';
import { applyTheme } from './apply';
import { hexToRgb } from './contrast';
import { BUILT_IN_THEMES, DEFAULT_THEME, ROLES, type Theme } from './themes';

const root = resolve(__dirname, '../..');
const config = createRequire(import.meta.url)(join(root, 'tailwind.config.js'));
const css = readFileSync(join(root, 'src/index.css'), 'utf8');

// The colors as they were on main before the token layer (tailwind.config.js @ a90dda5).
const ORIGINAL_DARK: Record<string, string> = {
  void: '#05070b', deep: '#090c12', slab: '#0d1119', raised: '#141a26', edge: '#1a2235',
  txt: '#d0d8ea', sub: '#8895ad', dim: '#4d5a72',
  value: '#00e09e', cost: '#ff5c72', shape: '#ffc44d', gate: '#7c8dff', unit: '#00ccee', purple: '#b490ff',
  'exec-bg': '#f5f8fb', 'exec-surface': '#ffffff', 'exec-border': '#d8e1ec', 'exec-hover': '#edf2f7',
  'exec-text': '#0f172a', 'exec-muted': '#64748b',
};

type Block = { scheme?: string; colors: Record<string, string> };
function parseBlock(body: string): Block {
  const colors: Record<string, string> = {};
  for (const m of body.matchAll(/--c-([a-z-]+):\s*(\d+) (\d+) (\d+);/g)) {
    colors[m[1]] = '#' + [m[2], m[3], m[4]].map((n) => Number(n).toString(16).padStart(2, '0')).join('');
  }
  return { scheme: /color-scheme:\s*(\w+)/.exec(body)?.[1], colors };
}
const media: Record<string, Block> = {};
const rest = css.replace(/@media \(([^)]+)\)\s*\{\s*:root:not\(\[data-theme\]\)\s*\{([^}]*)\}\s*\}/g, (_, q, body) => {
  media[q] = parseBlock(body);
  return '';
});
const blocks: Record<string, Block> = {};
for (const m of rest.matchAll(/([^{}]+)\{([^{}]*--c-[^{}]*)\}/g)) {
  for (const sel of m[1].split(',')) blocks[sel.trim()] = parseBlock(m[2]);
}
const expectBlock = (b: Block | undefined, t: Theme) => {
  expect(b?.colors).toEqual(t.colors);
  expect(b?.scheme).toBe(t.colorScheme);
};

describe('Tailwind token mapping', () => {
  const colors = config.theme.extend.colors as Record<string, string>;

  it('every theme role is an alpha-aware CSS-variable color; brands stay fixed hex', () => {
    for (const role of ROLES) expect(colors[role], role).toBe(`rgb(var(--c-${role}) / <alpha-value>)`);
    expect(Object.keys(colors).sort()).toEqual([...ROLES, 'aws', 'azure', 'gcp'].sort());
    expect([colors.aws, colors.azure, colors.gcp]).toEqual(['#ff9900', '#0078d4', '#4285f4']);
  });

  it('existing class names and opacity modifiers still compile', async () => {
    const out = await postcss([tailwind({ ...config, content: [{ raw: 'bg-void bg-void/50 text-txt border-edge/40 text-exec-muted' }], corePlugins: { preflight: false } })])
      .process('@tailwind utilities', { from: undefined });
    expect(out.css).toContain('background-color: rgb(var(--c-void) / var(--tw-bg-opacity, 1))');
    expect(out.css).toContain('background-color: rgb(var(--c-void) / 0.5)');
    expect(out.css).toContain('color: rgb(var(--c-txt) / var(--tw-text-opacity, 1))');
    expect(out.css).toContain('border-color: rgb(var(--c-edge) / 0.4)');
    expect(out.css).toContain('color: rgb(var(--c-exec-muted) / var(--tw-text-opacity, 1))');
  });
});

describe('index.css parity with themes.ts', () => {
  it('defines each built-in under :root[data-theme] and the default under :root', () => {
    for (const [name, theme] of Object.entries(BUILT_IN_THEMES)) expectBlock(blocks[`:root[data-theme='${name}']`], theme);
    expectBlock(blocks[':root'], BUILT_IN_THEMES[DEFAULT_THEME]);
  });

  it('honors prefers-color-scheme and prefers-contrast only when no theme is chosen', () => {
    expectBlock(media['prefers-color-scheme: dark'], BUILT_IN_THEMES.dark);
    expectBlock(media['prefers-contrast: more'], BUILT_IN_THEMES['high-contrast']);
    expect(css.indexOf('prefers-contrast: more')).toBeGreaterThan(css.indexOf('prefers-color-scheme: dark'));
  });

  it('keeps the legacy --<token> aliases used by inline styles', () => {
    for (const name of ['void', 'edge', 'txt', 'sub', 'dim', 'value', 'cost', 'shape', 'gate', 'unit', 'purple']) {
      expect(css).toContain(`--${name}: rgb(var(--c-${name}));`);
    }
  });

  it('draws a focus ring from the focus token', () => {
    expect(css).toMatch(/:focus-visible\s*\{[^}]*outline:\s*2px solid rgb\(var\(--c-focus\)\)/);
  });

  it('no hex drift: theme hex lives only in themes.ts', () => {
    expect(rest.match(/#[0-9a-f]{3,6}\b/gi) ?? []).toEqual(['#243049']); // pre-existing scrollbar hover
    expect(readFileSync(join(root, 'tailwind.config.js'), 'utf8').match(/#[0-9a-f]{6}\b/gi)).toHaveLength(3);
  });
});

describe('dark theme is the pre-existing look', () => {
  it('resolves every original token to the original hex (themes.ts and both CSS blocks)', () => {
    for (const [role, hex] of Object.entries(ORIGINAL_DARK)) {
      expect(BUILT_IN_THEMES.dark.colors[role as keyof Theme['colors']], role).toBe(hex);
      expect(blocks[":root[data-theme='dark']"].colors[role], role).toBe(hex);
      expect(media['prefers-color-scheme: dark'].colors[role], role).toBe(hex);
    }
  });
});

describe('applyTheme', () => {
  const fakeDoc = () => {
    const props: Record<string, string> = {};
    const attrs: Record<string, string> = {};
    const documentElement = { style: { setProperty: (k: string, v: string) => { props[k] = v; } }, setAttribute: (k: string, v: string) => { attrs[k] = v; } };
    return { doc: { documentElement } as unknown as Document, props, attrs };
  };

  it('sets data-theme and every --c-* channel triplet', () => {
    const { doc, props, attrs } = fakeDoc();
    expect(applyTheme('dark', doc)).toEqual([]);
    expect(attrs['data-theme']).toBe('dark');
    expect(props['--c-void']).toBe('5 7 11');
    expect(props['color-scheme']).toBe('dark');
    for (const role of ROLES) expect(props[`--c-${role}`]).toBe(hexToRgb(BUILT_IN_THEMES.dark.colors[role]).join(' '));
  });

  it('refuses invalid or unknown themes without touching the document', () => {
    const { doc, props, attrs } = fakeDoc();
    const bad = { ...BUILT_IN_THEMES.light, name: 'mine', colors: { ...BUILT_IN_THEMES.light.colors, txt: '#eeeeee' } };
    expect(applyTheme(bad, doc).length).toBeGreaterThan(0);
    expect(applyTheme('__proto__' as never, doc).map((v) => v.code)).toEqual(['unknown-theme']);
    expect(props).toEqual({});
    expect(attrs).toEqual({});
  });

  it('is a no-op without a document (SSR)', () => {
    expect(applyTheme('light', undefined)).toEqual([]);
  });
});

describe('hard-coded color baseline (T4 migrates these; they may only shrink)', () => {
  const files: string[] = [];
  const walk = (dir: string) => {
    for (const name of readdirSync(dir)) {
      const p = join(dir, name);
      if (statSync(p).isDirectory()) walk(p);
      else if (p.endsWith('.tsx')) files.push(p);
    }
  };
  walk(join(root, 'src'));
  walk(join(root, 'pages'));
  const count = (re: RegExp) => {
    let hits = 0;
    let hitFiles = 0;
    for (const f of files) {
      const n = (readFileSync(f, 'utf8').match(re) ?? []).length;
      hits += n;
      hitFiles += n > 0 ? 1 : 0;
    }
    return { hits, hitFiles };
  };

  it('inline color/background style lines do not grow past 94 in 39 files', () => {
    const { hits, hitFiles } = count(/^.*style=\{\{[^}\n]*\b(color|background).*$/gm);
    expect(hits).toBeLessThanOrEqual(94);
    expect(hitFiles).toBeLessThanOrEqual(39);
  });

  it('raw hex colors in TSX do not grow past 19 in 7 files', () => {
    const { hits, hitFiles } = count(/#[0-9a-fA-F]{6}\b|#[0-9a-fA-F]{3}\b/g);
    expect(hits).toBeLessThanOrEqual(19);
    expect(hitFiles).toBeLessThanOrEqual(7);
  });
});
