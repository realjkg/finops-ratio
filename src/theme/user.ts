// User themes: the import gate (size and role limits, hex normalization, then
// validateTheme), export, one-click contrast repair, and localStorage persistence.
// Storage may be missing or throw (private windows, blocked site data): every
// access is guarded and every stored value is validated again on read.
import { ensureContrast } from './contrast';
import { BUILT_IN_THEMES, type BuiltInThemeName, type Role, type Theme } from './themes';
import { contrastChecks, validateTheme, type Violation } from './validate';

export const MAX_IMPORT_BYTES = 8 * 1024;
export const MAX_ROLES = 40;
export const MAX_CUSTOM = 5;
export const ACTIVE_KEY = 'ratio.theme';
const CUSTOM_KEY = 'ratio.theme.custom';

export const isBuiltIn = (name: unknown): name is BuiltInThemeName =>
  typeof name === 'string' && Object.hasOwn(BUILT_IN_THEMES, name);

/** '#ABC ' becomes '#aabbcc'; anything but #rgb / #rrggbb is returned as is, for validateTheme to reject. */
export function normalizeHex(value: unknown): unknown {
  if (typeof value !== 'string') return value;
  const v = value.trim().toLowerCase();
  if (/^#[0-9a-f]{3}$/.test(v)) return '#' + [...v.slice(1)].map((d) => d + d).join('');
  return /^#[0-9a-f]{6}$/.test(v) ? v : value;
}

const isObject = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);
const fail = (message: string) => ({ theme: null, violations: [{ code: 'structure', message } as Violation] });

export interface Checked {
  /** Structurally sound (normalized) theme, also when only contrast fails; null otherwise. */
  theme: Theme | null;
  violations: Violation[];
}

/** The single gate for every user theme: pasted or file JSON, editor drafts and stored themes. */
export function checkTheme(raw: unknown): Checked {
  let input = raw;
  if (isObject(raw) && isObject(raw.colors)) {
    if (Object.keys(raw.colors).length > MAX_ROLES) return fail(`A theme may define at most ${MAX_ROLES} roles`);
    // Object.fromEntries defines own keys, so a "__proto__" key survives for the validator to reject.
    input = { ...raw, colors: Object.fromEntries(Object.entries(raw.colors).map(([k, v]) => [k, normalizeHex(v)])) };
  }
  if (isObject(input) && isBuiltIn(input.name)) return fail(`"${input.name}" is a built-in theme name`);
  const violations = validateTheme(input);
  return { theme: violations.every((v) => v.code === 'contrast') ? (input as unknown as Theme) : null, violations };
}

export function parseTheme(text: string): Checked {
  if (new TextEncoder().encode(text).length > MAX_IMPORT_BYTES) return fail('Theme files are limited to 8 KB');
  try {
    return checkTheme(JSON.parse(text));
  } catch {
    return fail('Not valid JSON');
  }
}

export const exportTheme = (theme: Theme) => JSON.stringify(theme, null, 2);

export interface Fix {
  theme: Theme;
  changes: { role: Role; from: string; to: string }[];
  /** Roles whose targets could not be reached by changing lightness alone. */
  unreachable: Role[];
}

/** Moves each failing foreground role (never a surface) to the nearest lightness that passes. */
export function fixContrast(theme: Theme): Fix {
  const colors = { ...theme.colors };
  for (let round = 0; round < 30; round++) {
    const failing = contrastChecks({ ...theme, colors }).filter((c) => !c.pass);
    if (!failing.length) break;
    const seen = new Set<Role>();
    for (const f of failing) {
      if (seen.has(f.fg)) continue;
      seen.add(f.fg);
      // Composited pairs (tints, translucent text) move with the color: aim a little higher each round.
      colors[f.fg] = ensureContrast(colors[f.fg], f.bgHex, f.min * (1 + round * 0.04)).color;
    }
  }
  const fixed = { ...theme, colors };
  const changes = (Object.keys(colors) as Role[]).filter((r) => colors[r] !== theme.colors[r]).map((role) => ({ role, from: theme.colors[role], to: colors[role] }));
  return { theme: fixed, changes, unreachable: [...new Set(contrastChecks(fixed).filter((c) => !c.pass).map((c) => c.fg))] };
}

type Store = Pick<Storage, 'getItem' | 'setItem' | 'removeItem'>;
const local = (): Store | null => {
  try {
    return window.localStorage;
  } catch {
    return null;
  }
};

export function loadCustomThemes(store = local()): Theme[] {
  try {
    const list: unknown = JSON.parse(store?.getItem(CUSTOM_KEY) ?? '[]');
    if (!Array.isArray(list)) return [];
    return list.flatMap((t) => (checkTheme(t).violations.length ? [] : [t as Theme])).slice(0, MAX_CUSTOM);
  } catch {
    return [];
  }
}

/** The stored choice, if it is still a valid theme; null means "no choice" (the CSS default applies). */
export function loadActiveTheme(store = local()): BuiltInThemeName | Theme | null {
  try {
    const name = store?.getItem(ACTIVE_KEY);
    if (isBuiltIn(name)) return name;
    return loadCustomThemes(store).find((t) => t.name === name) ?? null;
  } catch {
    return null;
  }
}

/** Returns false when storage is unavailable; the theme still applies for this page view. */
export function saveThemes(active: string | null, custom: Theme[], store = local()): boolean {
  try {
    if (!store) return false;
    if (active === null) store.removeItem(ACTIVE_KEY);
    else store.setItem(ACTIVE_KEY, active);
    store.setItem(CUSTOM_KEY, JSON.stringify(custom.slice(0, MAX_CUSTOM)));
    return true;
  } catch {
    return false;
  }
}

/** Runs before first paint (pages/_document.tsx): built-in choices only, so no flash for them. */
export const PREPAINT_SCRIPT = `try{var t=localStorage.getItem(${JSON.stringify(ACTIVE_KEY)});if(${JSON.stringify(Object.keys(BUILT_IN_THEMES))}.indexOf(t)>=0)document.documentElement.setAttribute('data-theme',t)}catch(e){}`;
