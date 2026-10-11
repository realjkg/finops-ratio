// Theme gate for built-in and user-imported themes. Structure is checked first
// (input is untrusted JSON); contrast is only checked once the shape is sound.
import { composite, contrastRatio } from './contrast';
import { ROLES, type Role, type Theme } from './themes';

export interface Violation {
  code: 'structure' | 'unknown-key' | 'forbidden-key' | 'unknown-role' | 'missing-role' | 'bad-color' | 'contrast' | 'unknown-theme';
  message: string;
  fg?: Role;
  /** A surface role, or `<accent>/<percent>@<surface>` for an accent tint over it. */
  bg?: string;
  ratio?: number;
  min?: number;
}

const MAIN: Role[] = ['void', 'deep', 'slab', 'raised'];
const EXEC: Role[] = ['exec-bg', 'exec-surface', 'exec-hover'];
const SURFACES = [...MAIN, ...EXEC];
// Accent text sits on every surface (exec cards included) and on its own tint
// (`text-value bg-value/10` badges). Alpha = the largest bg-<accent>/<n> in use.
const TINT = { value: 0.1, cost: 0.1, shape: 0.1, gate: 0.2, unit: 0.2, purple: 0.3 } as const;
const ACCENTS = Object.keys(TINT) as (keyof typeof TINT)[];
// [foreground roles, surfaces they sit on, kind]
const PAIRS: [Role[], Role[], 'text' | 'ui'][] = [
  [['txt', 'sub', 'dim', ...ACCENTS], SURFACES, 'text'],
  [['exec-text', 'exec-muted'], EXEC, 'text'],
  [['edge'], MAIN, 'ui'],
  [['exec-border'], EXEC, 'ui'],
  [['focus'], SURFACES, 'ui'],
];
const MIN = { standard: { text: 4.5, ui: 3 }, high: { text: 7, ui: 4.5 } } as const;

const TOP_KEYS = new Set(['name', 'colorScheme', 'contrast', 'colors']);
const FORBIDDEN = new Set(['__proto__', 'constructor', 'prototype']);
const ROLE_SET = new Set<string>(ROLES);

const isPlainObject = (v: unknown): v is Record<string, unknown> =>
  typeof v === 'object' && v !== null && !Array.isArray(v) && [Object.prototype, null].includes(Object.getPrototypeOf(v));

function checkKeys(obj: Record<string, unknown>, allowed: Set<string>, unknown: Violation['code'], out: Violation[]) {
  for (const key of Object.keys(obj)) {
    if (FORBIDDEN.has(key)) out.push({ code: 'forbidden-key', message: `Forbidden key ${JSON.stringify(key)}` });
    else if (!allowed.has(key)) out.push({ code: unknown, message: `Unknown key ${JSON.stringify(key)}` });
  }
}

export function validateTheme(input: unknown): Violation[] {
  const out: Violation[] = [];
  if (!isPlainObject(input)) return [{ code: 'structure', message: 'Theme must be a JSON object' }];
  checkKeys(input, TOP_KEYS, 'unknown-key', out);
  const { name, colorScheme, contrast, colors } = input;
  if (typeof name !== 'string' || !/^[a-z0-9][a-z0-9-]{0,39}$/.test(name)) {
    out.push({ code: 'structure', message: 'name must be 1-40 lowercase letters, digits or hyphens' });
  }
  if (colorScheme !== 'light' && colorScheme !== 'dark') out.push({ code: 'structure', message: 'colorScheme must be "light" or "dark"' });
  if (contrast !== 'standard' && contrast !== 'high') out.push({ code: 'structure', message: 'contrast must be "standard" or "high"' });
  if (!isPlainObject(colors)) return [...out, { code: 'structure', message: 'colors must be an object' }];
  checkKeys(colors, ROLE_SET, 'unknown-role', out);
  for (const role of ROLES) {
    const hex = Object.hasOwn(colors, role) ? colors[role] : undefined;
    if (hex === undefined) out.push({ code: 'missing-role', message: `Missing color for ${role}` });
    else if (typeof hex !== 'string' || !/^#[0-9a-f]{6}$/i.test(hex)) {
      out.push({ code: 'bad-color', message: `${role} must be a #rrggbb color` });
    }
  }
  if (out.length) return out;

  const { colors: c, contrast: level } = input as unknown as Theme;
  const check = (fg: Role, bg: string, bgHex: string, kind: 'text' | 'ui') => {
    const min = MIN[level][kind];
    const ratio = contrastRatio(c[fg], bgHex);
    if (ratio < min) out.push({ code: 'contrast', fg, bg, ratio, min, message: `${fg} on ${bg} is ${ratio.toFixed(2)}:1, needs ${min}:1` });
  };
  for (const [fgs, bgs, kind] of PAIRS) for (const fg of fgs) for (const bg of bgs) check(fg, bg, c[bg], kind);
  for (const accent of ACCENTS) {
    for (const s of SURFACES) check(accent, `${accent}/${Math.round(TINT[accent] * 100)}@${s}`, composite(c[accent], TINT[accent], c[s]), 'text');
  }
  return out;
}
