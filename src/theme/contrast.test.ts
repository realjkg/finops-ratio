// WCAG 2.x contrast math, checked against published reference values, plus the
// lightness-adjustment helper the theme validator and T2's importer rely on.
import { describe, expect, it } from 'vitest';
import { contrastRatio, ensureContrast, hexToRgb, onColor, relativeLuminance } from './contrast';

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
    expect(ensureContrast('#111827', '#FFFFFF', 4.5)).toBe('#111827');
  });

  it('nudges #777 on white just past 4.5:1 with a minimal lightness change', () => {
    const out = ensureContrast('#777777', '#ffffff', 4.5);
    expect(contrastRatio(out, '#ffffff')).toBeGreaterThanOrEqual(4.5);
    expect(parseInt(out.slice(1, 3), 16)).toBeGreaterThanOrEqual(0x70);
  });

  it('keeps the hue family when adjusting an accent', () => {
    const out = ensureContrast('#00e09e', '#ffffff', 4.5);
    const [r, g, b] = hexToRgb(out);
    expect(contrastRatio(out, '#ffffff')).toBeGreaterThanOrEqual(4.5);
    expect(g).toBeGreaterThan(r);
    expect(g).toBeGreaterThan(b);
  });

  const palette = ['#ffffff', '#000000', '#777777', '#05070b', '#f5f8fb', '#00e09e', '#ff5c72', '#ffc44d', '#7c8dff', '#b490ff', '#0078d4'];
  it('property: every pair reaches the target, or falls back to black/white when impossible', () => {
    for (const fg of palette) {
      for (const bg of palette) {
        for (const min of [3, 4.5, 7]) {
          const out = ensureContrast(fg, bg, min);
          expect(out).toMatch(/^#[0-9a-f]{6}$/);
          const ok = contrastRatio(out, bg) >= min;
          const fallback = out === onColor(bg) && contrastRatio(onColor(bg), bg) < min;
          expect(ok || fallback, `${fg} on ${bg} @${min} -> ${out}`).toBe(true);
        }
      }
    }
  });

  it('falls back to onColor(bg) when the target is unreachable', () => {
    expect(ensureContrast('#777777', '#777777', 22)).toBe(onColor('#777777'));
  });
});
