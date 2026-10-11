// Applies a theme to the document root: `--c-<role>` channel triplets (what the
// Tailwind tokens read), color-scheme, and data-theme. Safe to call during SSR.
import { hexToRgb } from './contrast';
import { BUILT_IN_THEMES, ROLES, type BuiltInThemeName, type Theme } from './themes';
import { validateTheme, type Violation } from './validate';

/** Returns the violations that blocked the change; an empty list means applied (or no document). */
export function applyTheme(
  input: BuiltInThemeName | Theme,
  doc: Document | undefined = typeof document === 'undefined' ? undefined : document,
): Violation[] {
  let theme: Theme;
  if (typeof input === 'string') {
    if (!Object.hasOwn(BUILT_IN_THEMES, input)) return [{ code: 'unknown-theme', message: `Unknown theme ${JSON.stringify(input)}` }];
    theme = BUILT_IN_THEMES[input];
  } else {
    const violations = validateTheme(input);
    if (violations.length) return violations;
    theme = input;
  }
  if (!doc) return [];
  const root = doc.documentElement;
  for (const role of ROLES) root.style.setProperty(`--c-${role}`, hexToRgb(theme.colors[role]).join(' '));
  root.style.setProperty('color-scheme', theme.colorScheme);
  root.setAttribute('data-theme', theme.name);
  return [];
}
