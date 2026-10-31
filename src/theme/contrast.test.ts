// WCAG 2.x contrast math, checked against published reference values, plus the
// lightness-adjustment helper the theme validator and T2's importer rely on.
import { describe, expect, it } from 'vitest';
import { composite, contrastRatio, ensureContrast, hexToRgb, onColor, relativeLuminance } from './contrast';

describe('relativeLuminance / contrastRatio (WCAG 2.x)', () => {
  it('matches published reference ratios', () => {
    expect(contrastRatio('#000000', '#ffffff')).toBe(21);
    expect(contrastRatio('#777777', '#ffffff')).toBeCloseTo(4.48, 2);
    expect(contrastRatio('#767676', '#ffffff')).toBeCloseTo(4.54, 2);
    expect(contrastRatio('#ffffff', '#ffffff')).toBe(1);
  });

  it('is symmetric and luminance spans 0..1', () => {
    expect(contrastRatio('#ffffff', '#4338ca')).toBe(contrastRatio('#4338ca', '#ffffff'));
    expect(relativeLuminance('#000000')).toBe(0);
    expect(relativeLuminance('#ffffff')).toBe(1);
  });

  it('rejects malformed colors', () => {
    for (const bad of ['#fff', 'red', '#12345g', '', '#1234567', 'ffffff']) {
      expect(() => hexToRgb(bad), bad).toThrow();
    }
  });
});

describe('onColor', () => {
  it.each([
    ['#ffffff', '#000000'],
    ['#000000', '#ffffff'],
    ['#00e09e', '#000000'],
    ['#4338ca', '#ffffff'],
  ])('onColor(%s) = %s', (bg, fg) => expect(onColor(bg)).toBe(fg));
});

describe('ensureContrast', () => {
  it('returns a passing color unchanged (normalized)', () => {
    expect(ensureContrast('#111827', '#FFFFFF', 4.5)).toEqual({ color: '#111827', ok: true });
  });

  it('nudges #777 on white just past 4.5:1 with a minimal lightness change', () => {
    const out = ensureContrast('#777777', '#ffffff', 4.5).color;
    expect(contrastRatio(out, '#ffffff')).toBeGreaterThanOrEqual(4.5);
    expect(parseInt(out.slice(1, 3), 16)).toBeGreaterThanOrEqual(0x70);
  });

  it('keeps the hue family when adjusting an accent', () => {
    const out = ensureContrast('#00e09e', '#ffffff', 4.5).color;
    const [r, g, b] = hexToRgb(out);
    expect(contrastRatio(out, '#ffffff')).toBeGreaterThanOrEqual(4.5);
    expect(g).toBeGreaterThan(r);
    expect(g).toBeGreaterThan(b);
  });

  const palette = ['#ffffff', '#000000', '#777777', '#05070b', '#f5f8fb', '#00e09e', '#ff7083', '#ffc44d', '#8494ff', '#c7acff', '#0078d4'];
  it('property: every pair reaches the target, or falls back to black/white when impossible', () => {
    for (const fg of palette) {
      for (const bg of palette) {
        for (const min of [3, 4.5, 7]) {
          const { color, ok } = ensureContrast(fg, bg, min);
          expect(color).toMatch(/^#[0-9a-f]{6}$/);
          expect(ok, `${fg} on ${bg} @${min} -> ${color}`).toBe(contrastRatio(color, bg) >= min);
          if (!ok) expect(color).toBe(onColor(bg));
        }
      }
    }
  });

  it('reports ok: false (with onColor(bg)) when the target is unreachable', () => {
    expect(ensureContrast('#777777', '#777777', 22)).toEqual({ color: onColor('#777777'), ok: false });
    expect(ensureContrast('#777777', '#777777', 7)).toEqual({ color: onColor('#777777'), ok: false }); // best is 4.69
  });
});

describe('composite', () => {
  it('blends like Tailwind bg-<color>/<n> over an opaque surface', () => {
    expect(composite('#000000', 0.5, '#ffffff')).toBe('#808080');
    expect(composite('#00e09e', 0.1, '#ffffff')).toBe('#e6fcf5'); // value/10 badge as rendered
    expect(composite('#123456', 1, '#ffffff')).toBe('#123456');
    expect(composite('#123456', 0, '#abcdef')).toBe('#abcdef');
  });
});
