// validateTheme is the gate for built-in and (from T2) user-imported themes:
// structure first, then WCAG contrast for the role pairs the UI actually uses.
import { describe, expect, it } from 'vitest';
import { BUILT_IN_THEMES, type Theme } from './themes';
import { validateTheme } from './validate';

const light = BUILT_IN_THEMES.light;
const clone = (t: Theme): Theme => JSON.parse(JSON.stringify(t));
const withColor = (t: Theme, role: string, hex: string) => {
  const c = clone(t) as unknown as { colors: Record<string, string> };
  c.colors[role] = hex;
  return c;
};
const codes = (input: unknown) => validateTheme(input).map((v) => v.code);
const pairs = (input: unknown) => validateTheme(input).filter((v) => v.code === 'contrast').map((v) => `${v.fg}/${v.bg}`);

describe('built-in themes', () => {
  it('light and high-contrast pass with no violations', () => {
    expect(validateTheme(BUILT_IN_THEMES.light)).toEqual([]);
    expect(validateTheme(BUILT_IN_THEMES['high-contrast'])).toEqual([]);
  });

  // Dark is the pre-existing look kept pixel-identical, so its known shortfalls are
  // pinned here: the list may shrink (T4 / owner decision) but can never grow.
  it('dark fails only the pinned legacy pairs', () => {
    expect(pairs(BUILT_IN_THEMES.dark).sort()).toEqual([
      'dim/deep', 'dim/raised', 'dim/slab', 'dim/void',
      'edge/deep', 'edge/slab', 'edge/void',
      'exec-border/exec-bg', 'exec-border/exec-surface',
      'exec-muted/exec-bg',
    ]);
    expect(codes(BUILT_IN_THEMES.dark).every((c) => c === 'contrast')).toBe(true);
  });
});

describe('structure', () => {
  it.each([null, undefined, 'light', 42, [], [light]])('rejects non-object %#', (input) => {
    expect(codes(input)).toContain('structure');
  });

  it('rejects unknown top-level keys and bad name / colorScheme / contrast', () => {
    expect(codes({ ...light, extra: 1 })).toContain('unknown-key');
    expect(codes({ ...light, name: 'Bad Name!' })).toContain('structure');
    expect(codes({ ...light, name: 'x'.repeat(41) })).toContain('structure');
    expect(codes({ ...light, colorScheme: 'sepia' })).toContain('structure');
    expect(codes({ ...light, contrast: 'max' })).toContain('structure');
    expect(codes({ ...light, colors: 'red' })).toContain('structure');
  });

  it('rejects unknown and missing roles', () => {
    expect(codes(withColor(light, 'chartreuse', '#00ff00'))).toContain('unknown-role');
    const missing = clone(light) as unknown as { colors: Record<string, string> };
    delete missing.colors.txt;
    expect(codes(missing)).toContain('missing-role');
  });

  it.each(['#fff', 'red', '#12345g', '', 'rgb(0,0,0)', '#0000001'])('rejects malformed color %j', (hex) => {
    expect(codes(withColor(light, 'txt', hex))).toContain('bad-color');
  });

  it('rejects non-string colors', () => {
    expect(codes(withColor(light, 'txt', 0 as unknown as string))).toContain('bad-color');
  });

  it('rejects prototype keys at the top level and inside colors', () => {
    const top = JSON.parse(`{"__proto__":{"x":1},${JSON.stringify(light).slice(1)}`);
    expect(codes(top)).toContain('forbidden-key');
    const inner = JSON.parse(JSON.stringify(light).replace('"colors":{', '"colors":{"__proto__":"#000000",'));
    expect(codes(inner)).toContain('forbidden-key');
    expect(codes(withColor(light, 'constructor', '#000000'))).toContain('forbidden-key');
  });

  it('skips contrast checks when the structure is invalid', () => {
    expect(codes({ ...withColor(light, 'txt', 'red') })).not.toContain('contrast');
  });
});

describe('contrast', () => {
  it('rejects body text below 4.5:1 (#777 on white is 4.48)', () => {
    expect(pairs(withColor(light, 'txt', '#777777'))).toContain('txt/void');
    expect(pairs(withColor(light, 'txt', '#767676'))).not.toContain('txt/void');
  });

  it('rejects semantic accents used as text below 4.5:1', () => {
    expect(pairs(withColor(light, 'value', '#00e09e'))).toContain('value/slab');
  });

  it('rejects borders and focus rings below 3:1', () => {
    expect(pairs(withColor(light, 'edge', '#d8e1ec'))).toContain('edge/void');
    expect(pairs(withColor(light, 'focus', '#a0a0a0'))).toContain('focus/void');
    expect(pairs(withColor(light, 'focus', '#949494'))).not.toContain('focus/void');
  });

  it('high contrast requires 7:1 text and 4.5:1 UI', () => {
    const hc = BUILT_IN_THEMES['high-contrast'];
    expect(pairs(withColor(hc, 'txt', '#5a5a5a'))).toContain('txt/void'); // 6.9 on white, just under
    expect(pairs(withColor(hc, 'txt', '#595959'))).not.toContain('txt/void'); // 7.0
    expect(pairs(withColor(hc, 'focus', '#767676'))).toContain('focus/raised');
    expect(pairs(withColor(hc, 'edge', '#808080'))).toContain('edge/void'); // 3.9: fine for standard, not high
  });
});
