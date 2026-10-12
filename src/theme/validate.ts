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
const FADED: [Role, number][] = [['cost', 0.8]];
const CUSHION = 0.05;
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

  for (const r of contrastChecks(input as unknown as Theme)) {
    if (!r.pass) out.push({ code: 'contrast', fg: r.fg, bg: r.bg, ratio: r.ratio, min: r.min, message: `${r.fg} on ${r.bg} is ${r.ratio.toFixed(2)}:1, needs ${r.min}:1` });
  }
  return out;
}

export interface Check { fg: Role; bg: string; bgHex: string; ratio: number; min: number; pass: boolean }

/**
 * Every required pair with its ratio (the palette editor's readout). Composited
 * pairs (tints, translucent text) must clear the target by CUSHION so a 1-unit
 * browser rounding of the blended color cannot push them under it.
 */
export function contrastChecks(theme: Theme): Check[] {
  const { colors: c, contrast: level } = theme;
  const out: Check[] = [];
  const check = (fg: Role, bg: string, fgHex: string, bgHex: string, kind: 'text' | 'ui', cushion = 0) => {
    const min = MIN[level][kind] + cushion;
    const ratio = contrastRatio(fgHex, bgHex);
    out.push({ fg, bg, bgHex, ratio, min, pass: ratio >= min });
  };
  for (const [fgs, bgs, kind] of PAIRS) for (const fg of fgs) for (const bg of bgs) check(fg, bg, c[fg], c[bg], kind);
  for (const accent of ACCENTS) {
    const pct = Math.round(TINT[accent] * 100);
    for (const s of SURFACES) check(accent, `${accent}/${pct}@${s}`, c[accent], composite(c[accent], TINT[accent], c[s]), 'text', CUSHION);
    // Secondary text inside tinted callouts (`bg-cost/5 text-sub`; none deeper than /10).
    for (const fg of ['sub', 'dim'] as const) for (const s of MAIN) check(fg, `${accent}/10@${s}`, c[fg], composite(c[accent], 0.1, c[s]), 'text', CUSHION);
  }
  // Translucent text (`text-cost/80`, LiveAccrualBoard) over the cards it sits on.
  for (const [fg, alpha] of FADED) for (const s of ['slab', 'raised'] as const) {
    check(fg, `text/${alpha * 100}@${s}`, composite(c[fg], alpha, c[s]), c[s], 'text', CUSHION);
  }
  return out;
}
