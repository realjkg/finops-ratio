// @vitest-environment happy-dom
// Typography settings: validated storage, CSS-variable application, a scale that
// reaches every font size, and the constant pre-paint script left untouched.
import { createHash } from 'node:crypto';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { beforeEach, describe, expect, it } from 'vitest';
import { PREPAINT_SCRIPT } from './user';
import { DEFAULT_TYPOGRAPHY, FAMILIES, SCALES, STORAGE_KEY, applyTypography, loadTypography, saveTypography } from './typography';

const root = resolve(__dirname, '../..');
const css = readFileSync(join(root, 'src/index.css'), 'utf8');
const html = document.documentElement;
beforeEach(() => {
  localStorage.clear();
  html.removeAttribute('style');
});

describe('model', () => {
  it('offers four scale steps and the system stacks plus both bundled families, all local', () => {
    expect(SCALES).toEqual([90, 100, 115, 130]);
    expect(Object.keys(FAMILIES)).toEqual(['default', 'jetbrains-mono', 'instrument-sans', 'system-sans', 'system-serif', 'system-mono']);
    for (const f of Object.values(FAMILIES)) expect(f.stack).not.toMatch(/https?:|url\(|@import/);
  });

  it('round-trips a choice and falls back to the default for anything invalid', () => {
    expect(saveTypography({ scale: 130, family: 'system-serif' })).toBe(true);
    expect(loadTypography()).toEqual({ scale: 130, family: 'system-serif' });
    for (const bad of ['{', '[]', '{"scale":200,"family":"default"}', '{"scale":115,"family":"x;}"}', '{"scale":"130","family":"default"}']) {
      localStorage.setItem(STORAGE_KEY, bad);
      expect(loadTypography(), bad).toEqual(DEFAULT_TYPOGRAPHY);
    }
  });

  it('survives blocked storage: load gives the default, save reports false', () => {
    const blocked = { getItem: () => { throw new Error('SecurityError'); }, setItem: () => { throw new Error('SecurityError'); }, removeItem: () => {} };
    expect(loadTypography(blocked)).toEqual(DEFAULT_TYPOGRAPHY);
    expect(saveTypography({ scale: 115, family: 'default' }, blocked)).toBe(false);
  });
});

describe('applyTypography', () => {
  it('sets the scale and both font variables, and the default removes them again', () => {
    applyTypography({ scale: 130, family: 'system-serif' });
    expect(html.style.getPropertyValue('--ui-scale')).toBe('1.3');
    expect(html.style.getPropertyValue('--font-body')).toBe(FAMILIES['system-serif'].stack);
    expect(html.style.getPropertyValue('--font-mono')).toBe(FAMILIES['system-serif'].stack);
    applyTypography(DEFAULT_TYPOGRAPHY);
    expect(html.getAttribute('style') ?? '').toBe('');
  });
});

describe('stylesheet', () => {
  it('scales the root font size and routes both Tailwind font families through variables', () => {
    expect(css).toMatch(/html\s*\{[^}]*font-size:\s*calc\(100% \* var\(--ui-scale, 1\)\)/);
    expect(css).toMatch(/--font-body:\s*'Instrument Sans'/);
    expect(css).toMatch(/--font-mono:\s*'JetBrains Mono'/);
    const tw = readFileSync(join(root, 'tailwind.config.js'), 'utf8');
    expect(tw).toMatch(/mono: 'var\(--font-mono\)'/);
    expect(tw).toMatch(/body: 'var\(--font-body\)'/);
  });

  it('gives every fixed-pixel text-[Npx] size in the source a scaled override', () => {
    const sizes = new Set<string>();
    const walk = (dir: string) => {
      for (const name of readdirSync(dir)) {
        const p = join(dir, name);
        if (statSync(p).isDirectory()) walk(p);
        else if (/\.tsx$/.test(name) && !/\.test\./.test(name)) for (const m of readFileSync(p, 'utf8').matchAll(/text-\[(\d+)px\]/g)) sizes.add(m[1]);
      }
    };
    walk(join(root, 'src'));
    walk(join(root, 'pages'));
    expect(sizes.size).toBeGreaterThan(0);
    for (const n of sizes) expect(css, `${n}px`).toContain(`.text-\\[${n}px\\] { font-size: calc(${n}px * var(--ui-scale, 1)); }`);
  });
});

describe('pre-paint script', () => {
  it('stays the constant, byte-stable string a CSP hash can cover', () => {
    expect(createHash('sha256').update(PREPAINT_SCRIPT).digest('hex')).toBe('8f6faa317ad7ffd6b60d037431dab9730308ac24fc0d9247b807db00d9be6150');
  });
});
