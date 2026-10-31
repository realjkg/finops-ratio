// validateTheme is the gate for built-in and (from T2) user-imported themes:
// structure first, then WCAG contrast for the role pairs the UI actually uses.
import { describe, expect, it } from 'vitest';
import { BUILT_IN_THEMES, type Theme } from './themes';
import { composite, contrastRatio } from './contrast';
import { contrastChecks, validateTheme } from './validate';

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
    const tint = (a: string, pct: number, surfaces: string[]) => surfaces.map((x) => `${a}/${a}/${pct}@${x}`);
    const EXEC = ['exec-bg', 'exec-surface', 'exec-hover'];
    const MAIN = ['void', 'deep', 'slab', 'raised'];
    const onExec = (fgs: string[]) => fgs.flatMap((fg) => EXEC.map((bg) => `${fg}/${bg}`));
    expect(pairs(BUILT_IN_THEMES.dark).sort()).toEqual([
      // Executive surfaces now reuse deep/slab/raised and edge (owner decision 2026-10-31), so
      // the 41 white-panel pairs are gone; what remains on them are the same color pairs as the
      // main-surface entries below (no new color combination; the dashboard draws no dim text).
      ...onExec(['dim', 'exec-border']),
      'dim/void', 'dim/deep', 'dim/slab', 'dim/raised',
      'edge/void', 'edge/deep', 'edge/slab', 'edge/raised',
      ...tint('gate', 20, ['raised', 'exec-hover']), ...tint('purple', 30, ['slab', 'raised', 'exec-surface', 'exec-hover']),
      // Added in T2 with the newly checked pairs: dim text in accent callouts, and the
      // translucent text-cost/80 on cards.
      ...['value', 'cost', 'shape', 'gate', 'unit', 'purple'].flatMap((a) => MAIN.map((x) => `dim/${a}/10@${x}`)),
      'cost/text/80@slab', 'cost/text/80@raised',
    ].sort()); // 20 + 26 pairs (was 58 + 26)
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

  it('checks every foreground role: each one set to its surface color is flagged', () => {
    const fgs = ['txt', 'sub', 'dim', 'value', 'cost', 'shape', 'gate', 'unit', 'purple', 'exec-text', 'exec-muted', 'edge', 'exec-border', 'focus'];
    for (const fg of fgs) {
      const surface = fg.startsWith('exec') ? 'exec-surface' : 'slab';
      const flagged = validateTheme(withColor(light, fg, light.colors[surface])).filter((v) => v.fg === fg);
      expect(flagged.length, fg).toBeGreaterThan(0);
    }
  });

  it('covers raised and exec-hover surfaces and accents on executive cards', () => {
    expect(pairs(withColor(light, 'edge', '#878e99'))).toEqual(['edge/raised']); // 2.89:1
    expect(pairs(withColor(light, 'exec-muted', '#64748b'))).toContain('exec-muted/exec-hover');
    expect(pairs(withColor(light, 'gate', '#7c8dff'))).toContain('gate/exec-surface');
  });

  it('checks accent text over its own composited tint (bg-<accent>/<n> badges)', () => {
    // #047857 passes on every plain surface but not on value/10 over raised.
    expect(pairs(withColor(light, 'value', '#047857'))).toEqual(expect.arrayContaining(['value/value/10@raised']));
    expect(pairs(withColor(light, 'value', '#047857')).every((p) => p.includes('@'))).toBe(true);
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

describe('T2 follow-ups: composited pairs get a cushion, more real pairs are checked', () => {
  const hc = BUILT_IN_THEMES['high-contrast'];
  const check = (t: Theme, key: string) => contrastChecks(t).find((c) => `${c.fg}/${c.bg}` === key);

  it('composited pairs must clear the target by 0.05; plain pairs need only the target', () => {
    expect(check(light, 'txt/void')?.min).toBe(4.5);
    expect(check(light, 'value/value/10@raised')?.min).toBeCloseTo(4.55, 10);
    expect(check(light, 'cost/text/80@slab')?.min).toBeCloseTo(4.55, 10);
    expect(check(hc, 'gate/gate/20@raised')?.min).toBeCloseTo(7.05, 10);
    // T1's light value: 4.528 on its tint over raised passed 4.5 but sits inside the cushion.
    const old = withColor(light, 'value', '#047251') as unknown as Theme;
    expect(check(old, 'value/value/10@raised')?.ratio).toBeGreaterThan(4.5);
    expect(pairs(old)).toEqual(['value/value/10@raised']);
  });

  it('checks text-cost/80 over slab and raised as the browser blends it', () => {
    const c = check(light, 'cost/text/80@raised');
    expect(c?.ratio).toBeCloseTo(contrastRatio(composite(light.colors.cost, 0.8, light.colors.raised), light.colors.raised), 10);
    expect(pairs(withColor(light, 'cost', '#be123c'))).toEqual(['cost/text/80@raised']); // T1 value: 4.26 blended
  });

  it('checks sub and dim text on every accent callout tint over the main surfaces', () => {
    const keys = contrastChecks(light).map((c) => `${c.fg}/${c.bg}`);
    for (const fg of ['sub', 'dim']) for (const a of ['value', 'cost', 'shape', 'gate', 'unit', 'purple']) {
      for (const s of ['void', 'deep', 'slab', 'raised']) expect(keys).toContain(`${fg}/${a}/10@${s}`);
    }
    expect(pairs(withColor(light, 'dim', '#5d6573'))).toContain('dim/cost/10@raised'); // T1 value: 4.36
  });

  it('light and high contrast were re-tuned to zero violations under the new rules', () => {
    expect(contrastChecks(light).every((c) => c.pass)).toBe(true);
    expect(contrastChecks(hc).every((c) => c.pass)).toBe(true);
    expect(contrastChecks(light)).toHaveLength(125 + 50); // T1 pairs + 48 callout + 2 translucent
  });
});
