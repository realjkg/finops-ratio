// Typography settings: a text size scale and a font family, applied as CSS variables on <html>
// (--ui-scale multiplies the root font size; --font-body and --font-mono feed the Tailwind
// font families). Local stacks only: no web fonts, no network. Storage may be missing or throw,
// so every access is guarded and every stored value is validated again on read. Applied after
// hydration; the constant pre-paint script (user.ts) is deliberately not involved.

export const SCALES = [90, 100, 115, 130] as const;
export const STORAGE_KEY = 'ratio.typography';

const SANS = 'ui-sans-serif, system-ui, -apple-system, "Segoe UI", Roboto, sans-serif';
const MONO = 'ui-monospace, SFMono-Regular, Menlo, Consolas, monospace';
export const FAMILIES = {
  default: { label: 'Default (Ratio)', stack: '' },
  'jetbrains-mono': { label: 'JetBrains Mono', stack: `'JetBrains Mono', ${MONO}` },
  'instrument-sans': { label: 'Instrument Sans', stack: `'Instrument Sans', ${SANS}` },
  'system-sans': { label: 'System sans-serif', stack: SANS },
  'system-serif': { label: 'System serif', stack: 'ui-serif, Georgia, Cambria, "Times New Roman", serif' },
  'system-mono': { label: 'System monospace', stack: MONO },
} as const;

export type FamilyId = keyof typeof FAMILIES;
export interface Typography {
  scale: (typeof SCALES)[number];
  family: FamilyId;
}
export const DEFAULT_TYPOGRAPHY: Typography = { scale: 100, family: 'default' };

type Store = Pick<Storage, 'getItem' | 'setItem'>;
const local = (): Store | null => {
  try {
    return window.localStorage;
  } catch {
    return null;
  }
};

export function loadTypography(store = local()): Typography {
  try {
    const v: unknown = JSON.parse(store?.getItem(STORAGE_KEY) ?? 'null');
    if (typeof v !== 'object' || v === null) return DEFAULT_TYPOGRAPHY;
    const { scale, family } = v as Record<string, unknown>;
    const ok = SCALES.find((s) => s === scale);
    return ok && typeof family === 'string' && Object.hasOwn(FAMILIES, family) ? { scale: ok, family: family as FamilyId } : DEFAULT_TYPOGRAPHY;
  } catch {
    return DEFAULT_TYPOGRAPHY;
  }
}

/** Returns false when storage is unavailable; the choice still applies for this page view. */
export function saveTypography(t: Typography, store = local()): boolean {
  try {
    if (!store) return false;
    store.setItem(STORAGE_KEY, JSON.stringify(t));
    return true;
  } catch {
    return false;
  }
}

export function applyTypography(t: Typography, doc: Document = document) {
  const style = doc.documentElement.style;
  const set = (name: string, value: string) => (value ? style.setProperty(name, value) : style.removeProperty(name));
  set('--ui-scale', t.scale === 100 ? '' : String(t.scale / 100));
  set('--font-body', FAMILIES[t.family].stack);
  set('--font-mono', FAMILIES[t.family].stack);
}
