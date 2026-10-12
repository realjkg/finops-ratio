// @vitest-environment happy-dom
// Typography settings: validated storage, CSS variables, scaled px sizes, constant pre-paint script.
import { createHash } from 'node:crypto';
import { readFileSync, readdirSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { beforeEach, describe, expect, it } from 'vitest';
import { PREPAINT_SCRIPT } from './user';
import { DEFAULT_TYPOGRAPHY, FAMILIES, SCALES, STORAGE_KEY, applyTypography, loadTypography, saveTypography } from './typography';

const root = resolve(__dirname, '../..');
const read = (p: string) => readFileSync(join(root, p), 'utf8');
const css = read('src/index.css');
const html = document.documentElement;
beforeEach(() => (localStorage.clear(), html.removeAttribute('style')));

describe('model', () => {
  it('offers four scale steps and the system stacks plus both bundled families, all local', () => {
    expect(SCALES).toEqual([90, 100, 115, 130]);
    expect(Object.keys(FAMILIES)).toEqual(['default', 'jetbrains-mono', 'instrument-sans', 'system-sans', 'system-serif', 'system-mono']);
    for (const f of Object.values(FAMILIES)) expect(f.stack).not.toMatch(/https?:|url\(|@import/);
  });

  it('round-trips a choice, falls back to the default for anything invalid, and survives blocked storage', () => {
    expect(saveTypography({ scale: 130, family: 'system-serif' })).toBe(true);
    expect(loadTypography()).toEqual({ scale: 130, family: 'system-serif' });
    for (const bad of ['{', '[]', '{"scale":200,"family":"default"}', '{"scale":115,"family":"x;}"}', '{"scale":"130","family":"default"}']) {
      localStorage.setItem(STORAGE_KEY, bad);
      expect(loadTypography(), bad).toEqual(DEFAULT_TYPOGRAPHY);
    }
    const boom = () => { throw new Error('SecurityError'); };
    expect(loadTypography({ getItem: boom, setItem: boom })).toEqual(DEFAULT_TYPOGRAPHY);
    expect(saveTypography({ scale: 115, family: 'default' }, { getItem: boom, setItem: boom })).toBe(false);
  });

  it('applies the scale and both font variables, and the default removes them again', () => {
    applyTypography({ scale: 130, family: 'system-serif' });
    const vars = ['--ui-scale', '--font-body', '--font-mono'].map((v) => html.style.getPropertyValue(v));
    expect(vars).toEqual(['1.3', FAMILIES['system-serif'].stack, FAMILIES['system-serif'].stack]);
    applyTypography(DEFAULT_TYPOGRAPHY);
    expect(html.getAttribute('style') ?? '').toBe('');
  });
});

describe('stylesheet and document', () => {
  it('scales the root size, routes both Tailwind font families through variables, and scales every px text size', () => {
    expect(css).toMatch(/html\s*\{[^}]*font-size:\s*calc\(100% \* var\(--ui-scale, 1\)\)/);
    expect(css).toMatch(/--font-body:\s*'Instrument Sans'[\s\S]*--font-mono:\s*'JetBrains Mono'/);
    expect(read('tailwind.config.js')).toMatch(/mono: 'var\(--font-mono\)'[\s\S]*body: 'var\(--font-body\)'/);
    const sizes = new Set<string>();
    for (const dir of ['src', 'pages']) {
      for (const f of readdirSync(join(root, dir), { recursive: true, encoding: 'utf8' })) {
        if (/\.tsx$/.test(f) && !/\.test\./.test(f)) for (const m of read(join(dir, f)).matchAll(/text-\[(\d+)px\]/g)) sizes.add(m[1]);
      }
    }
    expect(sizes.size).toBeGreaterThan(0);
    for (const n of sizes) expect(css, `${n}px`).toContain(`.text-\\[${n}px\\] { font-size: calc(${n}px * var(--ui-scale, 1)); }`);
  });

  it('keeps the pre-paint script the constant, byte-stable string a CSP hash can cover', () => {
    expect(createHash('sha256').update(PREPAINT_SCRIPT).digest('hex')).toBe('8f6faa317ad7ffd6b60d037431dab9730308ac24fc0d9247b807db00d9be6150');
  });
});
