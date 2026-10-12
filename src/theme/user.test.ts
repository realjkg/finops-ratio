// The user-theme gate: every import is normalized, size- and role-limited, then
// validated; contrast repair; export round trip; storage that may throw or lie.
import { describe, expect, it } from 'vitest';
import samples from './sample-palettes.json';
import { BUILT_IN_THEMES, type Theme } from './themes';
import {
  ACTIVE_KEY, MAX_CUSTOM, PREPAINT_SCRIPT, checkTheme, fixContrast, loadActiveTheme, loadCustomThemes, normalizeHex, parseTheme, saveThemes,
} from './user';
import { contrastChecks, validateTheme } from './validate';

const mine: Theme = { ...BUILT_IN_THEMES.light, name: 'mine' };
const json = (t: unknown) => JSON.stringify(t);
const codes = (text: string) => parseTheme(text).violations.map((v) => v.code);
const withColor = (role: string, value: unknown) => ({ ...mine, colors: { ...mine.colors, [role]: value } });

function memoryStore(init: Record<string, string> = {}) {
  const data = new Map(Object.entries(init));
  return { data, getItem: (k: string) => data.get(k) ?? null, setItem: (k: string, v: string) => void data.set(k, v), removeItem: (k: string) => void data.delete(k) };
}
const fail = () => { throw new Error('SecurityError'); };
const throwing = { getItem: fail, setItem: fail, removeItem: fail };

describe('normalization', () => {
  it.each([['#ABC', '#aabbcc'], ['  #0f0 ', '#00ff00'], ['#A1B2C3', '#a1b2c3'], ['\t#ffffff\n', '#ffffff']])('accepts %j as %j', (raw, hex) => {
    expect(normalizeHex(raw)).toBe(hex);
    const { theme, violations } = parseTheme(json(withColor('focus', raw)));
    expect(violations).toEqual(validateTheme({ ...mine, colors: { ...mine.colors, focus: hex } }));
    expect(theme?.colors.focus).toBe(hex);
  });

  it.each(['#abcd', '#12345', 'red', 'rgb(0,0,0)', '#ggg', '# fff', 'red;} body{display:none', '#fff;}*{color:red', 'url(x)', '#ffffff !important'])(
    'rejects %j as a bad color', (raw) => {
      const r = parseTheme(json(withColor('txt', raw)));
      expect(r.theme).toBeNull();
      expect(r.violations.map((v) => v.code)).toContain('bad-color');
    },
  );
});

describe('hostile and oversized imports', () => {
  it('rejects non-string colors, extra roles, unknown keys and prototype keys', () => {
    for (const value of [0, null, true, ['#ffffff'], { hex: '#ffffff' }]) expect(codes(json(withColor('txt', value)))).toContain('bad-color');
    expect(codes(json(withColor('chartreuse', '#00ff00')))).toContain('unknown-role');
    expect(codes(json({ ...mine, script: 'alert(1)' }))).toContain('unknown-key');
    expect(codes(json(mine).replace('"colors":{', '"colors":{"__proto__":"#000000",'))).toContain('forbidden-key');
    expect(codes(`{"__proto__":{"polluted":1},${json(mine).slice(1)}`)).toContain('forbidden-key');
    expect(codes(json(withColor('constructor', '#000000')))).toContain('forbidden-key');
    expect(({} as Record<string, unknown>).polluted).toBeUndefined();
  });

  it('rejects files over 8 KB, more than 40 roles, invalid JSON and built-in names', () => {
    expect(codes(json({ ...mine, pad: 'x'.repeat(8 * 1024) }))).toEqual(['structure']);
    const many = { ...mine, colors: { ...mine.colors, ...Object.fromEntries(Array.from({ length: 20 }, (_, i) => [`r${i}`, '#000000'])) } };
    expect(parseTheme(json(many)).violations[0].message).toMatch(/at most 40 roles/);
    expect(codes('{"name": "mine",')).toEqual(['structure']);
    expect(codes(json(BUILT_IN_THEMES.light))).toEqual(['structure']);
  });

  it('keeps a theme that only fails contrast (so it can be fixed) but reports why', () => {
    const r = parseTheme(json(withColor('txt', '#aaaaaa')));
    expect(r.theme?.colors.txt).toBe('#aaaaaa');
    expect(r.violations.length).toBeGreaterThan(0);
    expect(r.violations.every((v) => v.code === 'contrast')).toBe(true);
  });
});

describe('fix contrast', () => {
  it('repairs failing foreground roles, never surfaces, and lists what changed', () => {
    const broken = withColor('txt', '#aaaaaa') as Theme;
    const fix = fixContrast({ ...broken, colors: { ...broken.colors, cost: '#ff5c72' } });
    expect(validateTheme(fix.theme)).toEqual([]);
    expect(fix.unreachable).toEqual([]);
    expect(fix.changes.map((c) => c.role).sort()).toEqual(['cost', 'txt']);
    expect(fix.changes.find((c) => c.role === 'txt')).toMatchObject({ from: '#aaaaaa' });
    for (const s of ['void', 'deep', 'slab', 'raised'] as const) expect(fix.theme.colors[s]).toBe(broken.colors[s]);
  });

  it('reports unreachable targets instead of claiming success', () => {
    // Mid-gray surfaces: no text color reaches 7:1 on #808080.
    const gray = { ...BUILT_IN_THEMES['high-contrast'], name: 'gray', colors: { ...BUILT_IN_THEMES['high-contrast'].colors, slab: '#808080' } };
    const fix = fixContrast(gray);
    expect(fix.unreachable).toContain('txt');
    expect(validateTheme(fix.theme).length).toBeGreaterThan(0);
  });

  it('leaves a passing theme unchanged', () => {
    expect(fixContrast(mine)).toEqual({ theme: mine, changes: [], unreachable: [] });
  });
});

describe('sample palettes (importable examples, not built-ins)', () => {
  it.each(samples.map((s) => [s.name, s]))('%s passes the gate as authored or after fix contrast', (_, sample) => {
    const { theme } = parseTheme(json(sample));
    expect(theme).not.toBeNull();
    const final = validateTheme(theme).length ? fixContrast(theme as Theme) : { theme, unreachable: [] };
    expect(final.unreachable).toEqual([]);
    expect(validateTheme(final.theme)).toEqual([]);
  });
});

describe('persistence', () => {
  it('round-trips the active choice and custom themes', () => {
    const store = memoryStore();
    expect(saveThemes('mine', [mine], store)).toBe(true);
    expect(loadActiveTheme(store)).toEqual(mine);
    expect(saveThemes('high-contrast', [mine], store)).toBe(true);
    expect(loadActiveTheme(store)).toBe('high-contrast');
    expect(loadCustomThemes(store)).toEqual([mine]);
    expect(saveThemes(null, [], store)).toBe(true);
    expect(store.data.has(ACTIVE_KEY)).toBe(false);
    expect(loadActiveTheme(store)).toBeNull();
  });

  it('survives storage that throws or is missing', () => {
    expect(saveThemes('dark', [mine], throwing)).toBe(false);
    expect(loadActiveTheme(throwing)).toBeNull();
    expect(loadCustomThemes(throwing)).toEqual([]);
    expect(saveThemes('dark', [], null)).toBe(false);
    expect(loadActiveTheme(null)).toBeNull();
    // Node has no window: the default accessor must not throw either.
    expect(loadActiveTheme()).toBeNull();
  });

  it('falls back to the default for stored garbage and re-validates stored custom themes', () => {
    for (const raw of ['__proto__', 'constructor', 'neon', '']) expect(loadActiveTheme(memoryStore({ [ACTIVE_KEY]: raw }))).toBeNull();
    const tampered = [withColor('txt', 'red;} body{display:none'), withColor('txt', '#ffffff'), { ...BUILT_IN_THEMES.dark }, 'x', null, mine];
    const store = memoryStore({ [ACTIVE_KEY]: 'mine', 'ratio.theme.custom': json(tampered) });
    expect(loadCustomThemes(store)).toEqual([mine]);
    expect(loadActiveTheme(memoryStore({ [ACTIVE_KEY]: 'mine', 'ratio.theme.custom': '{not json' }))).toBeNull();
    expect(loadActiveTheme(memoryStore({ [ACTIVE_KEY]: 'mine', 'ratio.theme.custom': '{"name":"mine"}' }))).toBeNull();
  });

  it('returns stored themes normalized, so they apply as they validated', () => {
    const padded = { ...mine, colors: { ...mine.colors, void: '#FFF', txt: ' #111827 ' } };
    const store = memoryStore({ [ACTIVE_KEY]: 'mine', 'ratio.theme.custom': json([padded]) });
    expect(loadCustomThemes(store)).toEqual([mine]);
    expect(loadActiveTheme(store)).toEqual(mine);
  });

  it('drops a stored duplicate name (the first one wins)', () => {
    const twin = { ...mine, colors: { ...mine.colors, focus: '#1d4ed8' } };
    expect(loadCustomThemes(memoryStore({ 'ratio.theme.custom': json([mine, twin]) }))).toEqual([mine]);
  });

  it(`keeps at most ${MAX_CUSTOM} custom themes`, () => {
    const many = Array.from({ length: 7 }, (_, i) => ({ ...mine, name: `t${i}` }));
    const store = memoryStore();
    saveThemes('t0', many, store);
    expect(loadCustomThemes(store).map((t) => t.name)).toEqual(['t0', 't1', 't2', 't3', 't4']);
    expect(loadCustomThemes(memoryStore({ 'ratio.theme.custom': json(many) }))).toHaveLength(MAX_CUSTOM);
  });
});

describe('pre-paint script', () => {
  const run = (stored: string | null, storage: unknown = memoryStore(stored === null ? {} : { [ACTIVE_KEY]: stored })) => {
    const attrs: Record<string, string> = {};
    const document = { documentElement: { setAttribute: (k: string, v: string) => void (attrs[k] = v) } };
    new Function('localStorage', 'document', PREPAINT_SCRIPT)(storage, document);
    return attrs['data-theme'];
  };

  it('sets a stored built-in before paint and ignores anything else', () => {
    expect(run('high-contrast')).toBe('high-contrast');
    expect(run('light')).toBe('light');
    for (const v of [null, 'mine', '"><script>', '__proto__']) expect(run(v)).toBeUndefined();
    expect(run('dark', throwing)).toBeUndefined();
  });
});

describe('readout source', () => {
  it('contrastChecks reports exactly the contrast violations validateTheme returns', () => {
    for (const t of [...Object.values(BUILT_IN_THEMES), checkTheme(withColor('txt', '#aaaaaa')).theme as Theme]) {
      const failing = contrastChecks(t).filter((c) => !c.pass).map((c) => `${c.fg}/${c.bg}`);
      expect(failing).toEqual(validateTheme(t).map((v) => `${v.fg}/${v.bg}`));
    }
  });
});
