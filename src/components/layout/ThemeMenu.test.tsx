// @vitest-environment happy-dom
// The theme switcher in the shared nav and its palette editor, mounted for real:
// choosing applies data-theme and the --c-* variables, persistence survives
// blocked storage, every import goes through the gate, and the readout is the
// contrast engine's numbers.
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { createRequire } from 'node:module';
import { join, resolve } from 'node:path';
import postcss from 'postcss';
import tailwind from 'tailwindcss';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import Document from '../../../pages/_document';
import { contrastRatio, hexToRgb } from '@/theme/contrast';
import { BUILT_IN_THEMES, type Theme } from '@/theme/themes';
import { applyTheme } from '@/theme/apply';
import { ACTIVE_KEY, PREPAINT_SCRIPT, loadActiveTheme, parseTheme } from '@/theme/user';
import { contrastChecks } from '@/theme/validate';
import { NavBar } from './NavBar';

declare global {
  var IS_REACT_ACT_ENVIRONMENT: boolean;
}
globalThis.IS_REACT_ACT_ENVIRONMENT = true;

const html = document.documentElement;
const storage = window.localStorage;
const mine: Theme = { ...BUILT_IN_THEMES.light, name: 'mine' };
let root: Root | undefined;
let container: HTMLDivElement;

const mount = () => {
  container = document.createElement('div');
  document.body.appendChild(container);
  act(() => {
    root = createRoot(container);
    root.render(<NavBar />);
  });
};
const $ = <T extends Element>(sel: string) => container.querySelector(sel) as T;
const byLabel = <T extends Element>(label: string) => $<T>(`[aria-label="${label}"]`);
const button = (text: string) => [...container.querySelectorAll('button, a')].find((b) => b.textContent?.startsWith(text)) as HTMLElement;
const click = (el: HTMLElement) => act(() => el.click());
function setValue(el: HTMLInputElement | HTMLTextAreaElement | HTMLSelectElement, value: string) {
  act(() => {
    Object.getOwnPropertyDescriptor(Object.getPrototypeOf(el), 'value')?.set?.call(el, value);
    el.dispatchEvent(new Event(el.tagName === 'SELECT' ? 'change' : 'input', { bubbles: true }));
  });
}
const select = () => $<HTMLSelectElement>('#theme-select');
const openEditor = () => click(button('Customize'));
const importText = (text: string) => {
  setValue(byLabel<HTMLTextAreaElement>('Theme JSON'), text);
  click(button('Import'));
};
const alertText = () => container.querySelector('[aria-label="Theme problems"]')?.textContent ?? '';
const channel = (role: string) => html.style.getPropertyValue(`--c-${role}`);

beforeEach(() => {
  localStorage.clear();
  html.removeAttribute('data-theme');
  html.removeAttribute('style');
});
afterEach(() => {
  act(() => root?.unmount());
  container.remove();
  Object.defineProperty(window, 'localStorage', { configurable: true, value: storage }); // undo a blocking getter
});

describe('switcher', () => {
  it('is in the shared nav, labeled in words, and applies + persists the chosen built-in', () => {
    mount();
    expect(container.querySelector('label[for="theme-select"]')?.textContent).toBe('Theme');
    expect([...select().options].map((o) => o.textContent)).toEqual(['Default (system)', 'Light', 'High contrast', 'Dark']);
    setValue(select(), 'high-contrast');
    expect(html.getAttribute('data-theme')).toBe('high-contrast');
    expect(channel('txt')).toBe('0 0 0');
    expect(localStorage.getItem(ACTIVE_KEY)).toBe('high-contrast');
    setValue(select(), '');
    expect(html.hasAttribute('data-theme')).toBe(false);
    expect(channel('txt')).toBe('');
    expect(localStorage.getItem(ACTIVE_KEY)).toBeNull();
  });

  it('still applies the theme when storage is blocked, and says the choice will not persist', () => {
    Object.defineProperty(window, 'localStorage', { configurable: true, get: () => { throw new Error('SecurityError'); } });
    mount();
    const status = $('[role="status"]'); // mounted while empty (Copilot 4244556908), so the note is announced
    expect(status?.textContent).toBe('');
    setValue(select(), 'dark');
    expect(html.getAttribute('data-theme')).toBe('dark');
    expect($('[role="status"]')).toBe(status);
    expect(status.textContent).toMatch(/Storage is unavailable/);
    openEditor();
    expect(container.querySelectorAll('[role="status"]')[0]).toBe(status);
  });

  it('replacing the draft (selector, reset, save) drops stale edits and import problems (Copilot 4244556890/948)', () => {
    mount();
    openEditor();
    setValue(byLabel<HTMLInputElement>('txt hex'), '#123456');
    importText('{oops');
    setValue(select(), 'high-contrast');
    expect(byLabel<HTMLInputElement>('txt hex').value).toBe(BUILT_IN_THEMES['high-contrast'].colors.txt);
    expect(alertText()).toBe('');
    importText('{oops');
    click(button('Reset to built-in'));
    expect(alertText()).toBe('');
    importText('{oops');
    click(button('Save and apply'));
    expect(html.getAttribute('data-theme')).toBe('my-theme');
    expect(alertText()).toBe('');
  });

  it('lists stored custom themes after re-validating them; garbage falls back to the default', () => {
    localStorage.setItem(ACTIVE_KEY, 'mine');
    localStorage.setItem('ratio.theme.custom', JSON.stringify([mine, { ...mine, name: 'evil', colors: { ...mine.colors, txt: 'red;}' } }]));
    mount();
    expect(select().value).toBe('mine');
    expect([...select().options].map((o) => o.textContent)).toContain('Custom: mine');
    expect([...select().options].map((o) => o.textContent)).not.toContain('Custom: evil');
    act(() => root?.unmount());
    localStorage.setItem(ACTIVE_KEY, '<garbage>');
    mount();
    expect(select().value).toBe('');
  });
});

describe('reload of a stored theme with short or padded hex (Copilot 4244404619)', () => {
  it('applies the normalized colors and the selector names the theme actually applied', () => {
    localStorage.setItem(ACTIVE_KEY, 'mine');
    localStorage.setItem('ratio.theme.custom', JSON.stringify([{ ...mine, colors: { ...mine.colors, void: '#FFF', focus: ' #2563EB ' } }]));
    const stored = loadActiveTheme(); // what pages/_app.tsx applies after hydration
    expect(stored && applyTheme(stored)).toEqual([]);
    expect(html.getAttribute('data-theme')).toBe('mine');
    expect(channel('void')).toBe('255 255 255');
    expect(channel('focus')).toBe('37 99 235');
    mount();
    expect(select().value).toBe(html.getAttribute('data-theme'));
  });
});

describe('import', () => {
  it('applies and saves a valid pasted theme, normalizing short hex', () => {
    mount();
    openEditor();
    importText(JSON.stringify({ ...mine, colors: { ...mine.colors, void: '#FFF', slab: ' #ffffff ' } }));
    expect(html.getAttribute('data-theme')).toBe('mine');
    expect(channel('void')).toBe('255 255 255');
    expect(JSON.parse(localStorage.getItem('ratio.theme.custom') ?? '[]')[0].colors.void).toBe('#ffffff');
  });

  it.each([
    ['CSS injection', JSON.stringify({ ...mine, colors: { ...mine.colors, txt: 'red;} body{display:none' } }), /#rrggbb/],
    ['prototype key', JSON.stringify(mine).replace('"colors":{', '"colors":{"__proto__":"#000000",'), /Forbidden key/],
    ['extra role', JSON.stringify({ ...mine, colors: { ...mine.colors, glow: '#ffffff' } }), /Unknown key "glow"/],
    ['non-string', JSON.stringify({ ...mine, colors: { ...mine.colors, txt: 0 } }), /txt must be/],
    ['oversized', JSON.stringify({ ...mine, pad: 'x'.repeat(9000) }), /8 KB/],
    ['not JSON', '{oops', /Not valid JSON/],
  ])('refuses %s and lists why', (_, text, message) => {
    mount();
    openEditor();
    importText(text);
    expect(alertText()).toMatch(message);
    expect(html.hasAttribute('data-theme')).toBe(false);
    expect(localStorage.getItem(ACTIVE_KEY)).toBeNull();
  });

  it('refuses an oversized file without reading past the limit', async () => {
    mount();
    openEditor();
    const input = $<HTMLInputElement>('input[type="file"]');
    Object.defineProperty(input, 'files', { value: [new File([JSON.stringify({ ...mine, pad: 'x'.repeat(20000) })], 't.json')] });
    await act(async () => {
      input.dispatchEvent(new Event('change', { bubbles: true }));
      await new Promise((r) => setTimeout(r, 20));
    });
    expect(alertText()).toMatch(/8 KB/);
  });

  it('refuses a sixth custom theme', () => {
    localStorage.setItem('ratio.theme.custom', JSON.stringify(['a', 'b', 'c', 'd', 'e'].map((name) => ({ ...mine, name }))));
    mount();
    openEditor();
    importText(JSON.stringify(mine));
    expect(container.textContent).toMatch(/keep 5 custom themes/);
    expect(html.hasAttribute('data-theme')).toBe(false);
  });
});

describe('contrast problems are live (Copilot 4244404600)', () => {
  it('an imported failure disappears once the color is edited to pass, and Save then applies', () => {
    mount();
    openEditor();
    importText(JSON.stringify({ ...mine, colors: { ...mine.colors, txt: '#aaaaaa' } }));
    expect(alertText()).toMatch(/txt on void/);
    setValue(byLabel<HTMLInputElement>('txt hex'), '#111827');
    expect(alertText()).toBe('');
    click(button('Save and apply'));
    expect(html.getAttribute('data-theme')).toBe('mine');
    expect(alertText()).toBe('');
  });
});

describe('fix contrast', () => {
  it('a failing sample is not applied; one click fixes it, shows the changes, then it saves', () => {
    mount();
    openEditor();
    click(button('Sample: lagoon'));
    click(button('Import'));
    expect(alertText()).toMatch(/purple on purple\/30@raised/);
    expect(html.hasAttribute('data-theme')).toBe(false);
    click(button('Fix contrast'));
    expect(container.textContent).toMatch(/Changed purple: #d8b4fe to #[0-9a-f]{6}/);
    expect(alertText()).toBe('');
    click(button('Save and apply'));
    expect(html.getAttribute('data-theme')).toBe('lagoon');
  });

  it('says when the target cannot be reached', () => {
    mount();
    openEditor();
    const gray = { ...BUILT_IN_THEMES['high-contrast'], name: 'gray', colors: { ...BUILT_IN_THEMES['high-contrast'].colors, slab: '#808080' } };
    importText(JSON.stringify(gray));
    click(button('Fix contrast'));
    expect(container.textContent).toMatch(/Could not reach the target for: .*txt/);
    click(button('Save and apply'));
    expect(html.hasAttribute('data-theme')).toBe(false);
  });
});

describe('palette editor', () => {
  it('reads out every required pair with the contrast engine numbers, live as colors change', () => {
    mount();
    openEditor();
    const rows = () => [...container.querySelectorAll('[aria-label="Contrast readout"] tbody tr')].map((r) => [...r.children].map((c) => c.textContent));
    const draft = BUILT_IN_THEMES.dark;
    expect(rows()).toEqual(contrastChecks({ ...draft, name: 'my-theme' }).map((c) => [`${c.fg} on ${c.bg}`, `${c.ratio.toFixed(2)}:1`, `needs ${c.min}`, c.pass ? 'Pass' : 'Fail']));
    setValue(byLabel<HTMLInputElement>('txt hex'), '#777');
    const row = rows().find((r) => r[0] === 'txt on void');
    expect(row).toEqual(['txt on void', `${contrastRatio('#777777', draft.colors.void).toFixed(2)}:1`, 'needs 4.5', 'Pass']);
    setValue(byLabel<HTMLInputElement>('txt color'), '#0a0a0a');
    expect(rows().find((r) => r[0] === 'txt on void')?.[3]).toBe('Fail');
    expect(byLabel<HTMLInputElement>('txt hex').value).toBe('#0a0a0a');
  });

  it('saves an edited palette, resets to the built-in, and exports what re-imports', () => {
    mount();
    setValue(select(), 'light');
    openEditor();
    setValue(byLabel<HTMLInputElement>('focus hex'), '#1d4ed8');
    click(button('Save and apply'));
    expect(html.getAttribute('data-theme')).toBe('my-theme');
    expect(channel('focus')).toBe(hexToRgb('#1d4ed8').join(' '));
    const link = button('Export current theme') as HTMLAnchorElement;
    const exported = parseTheme(decodeURIComponent(link.href.split(',')[1]));
    expect(exported.violations).toEqual([]);
    expect(exported.theme).toEqual({ ...BUILT_IN_THEMES.light, name: 'my-theme', colors: { ...BUILT_IN_THEMES.light.colors, focus: '#1d4ed8' } });
    expect(link.getAttribute('download')).toBe('my-theme.json');
    click(button('Reset to built-in'));
    expect(byLabel<HTMLInputElement>('focus hex').value).toBe(BUILT_IN_THEMES.dark.colors.focus);
  });

  it('every control is a native, named, keyboard-focusable element', () => {
    mount();
    openEditor();
    for (const el of container.querySelectorAll<HTMLElement>('input, select, textarea, button, a')) {
      const named = el.getAttribute('aria-label') || el.textContent?.trim() || el.id && container.querySelector(`label[for="${el.id}"]`) || el.closest('label');
      expect(named, el.outerHTML.slice(0, 80)).toBeTruthy();
      expect(el.tabIndex).toBeGreaterThanOrEqual(0);
    }
    const toggle = button('Customize');
    toggle.focus();
    expect(document.activeElement).toBe(toggle);
    expect(toggle.getAttribute('aria-expanded')).toBe('true');
  });
});

it('the document carries the pre-paint script (its behavior: user.test.ts)', () => {
  const find = (node: unknown): string[] => {
    if (Array.isArray(node)) return node.flatMap(find);
    if (!node || typeof node !== 'object' || !('props' in node)) return [];
    const { props, type } = node as { type: unknown; props: { children?: unknown; dangerouslySetInnerHTML?: { __html: string } } };
    return [...(type === 'script' && props.dangerouslySetInnerHTML ? [props.dangerouslySetInnerHTML.__html] : []), ...find(props.children)];
  };
  expect(find(Document())).toEqual([PREPAINT_SCRIPT]);
});

describe('challenger review of #116', () => {
  it('M1: the sr-only file input shows a token focus ring on its visible label', async () => {
    mount();
    openEditor();
    const label = $<HTMLInputElement>('input[type="file"]').closest('label') as HTMLLabelElement;
    const config = createRequire(import.meta.url)(join(resolve(__dirname, '../../..'), 'tailwind.config.js'));
    const out = await postcss([tailwind({ ...config, content: [{ raw: label.className }], corePlugins: { preflight: false } })]).process('@tailwind utilities', { from: undefined });
    const rules = out.css.split('}').filter((r) => r.includes(':focus-within'));
    for (const re of [/outline-color: rgb\(var\(--c-focus\)/, /outline-width: 2px/, /outline-style: solid/]) expect(rules.some((r) => re.test(r)), String(re)).toBe(true);
  });

  it('L1: under Default (system) the editor and export start from the theme the CSS shows', () => {
    const matchMedia = window.matchMedia;
    Object.defineProperty(window, 'matchMedia', { configurable: true, value: (q: string) => ({ matches: q === '(prefers-contrast: more)', media: q }) });
    try {
      mount();
      openEditor();
      const hc = BUILT_IN_THEMES['high-contrast'];
      expect(byLabel<HTMLInputElement>('txt hex').value).toBe(hc.colors.txt);
      const link = button('Export current theme') as HTMLAnchorElement;
      expect(link.getAttribute('download')).toBe('my-high-contrast.json');
      expect(parseTheme(decodeURIComponent(link.href.split(',')[1]))).toEqual({ theme: { ...hc, name: 'my-high-contrast' }, violations: [] });
    } finally {
      Object.defineProperty(window, 'matchMedia', { configurable: true, value: matchMedia });
    }
  });

  it('L4: problems are announced politely, not as an alert on every keystroke', () => {
    mount();
    setValue(select(), 'light');
    openEditor();
    const list = byLabel<HTMLElement>('Theme problems'); // mounted while empty, so the first problem is announced
    expect([list.textContent, list.getAttribute('aria-live')]).toEqual(['', 'polite']);
    setValue(byLabel<HTMLInputElement>('txt hex'), '#zzz');
    expect(byLabel<HTMLElement>('Theme problems')).toBe(list);
    expect(list.textContent).toMatch(/txt must be/);
    expect(container.querySelector('[role="alert"]')).toBeNull();
  });
});


describe('theme editor Medium fixes (Copilot 4244601651, 4244601697, 4244556921, ThemeMenu.tsx:92, :148)', () => {
  it('Default (system) follows live OS changes and removes its listeners on unmount', () => {
    const original = window.matchMedia;
    const os = { more: false, listeners: new Set<() => void>() };
    const mq = (q: string) => ({ get matches() { return q === '(prefers-contrast: more)' && os.more; }, addEventListener: (_: string, f: () => void) => os.listeners.add(f), removeEventListener: (_: string, f: () => void) => os.listeners.delete(f) });
    Object.defineProperty(window, 'matchMedia', { configurable: true, value: mq });
    try {
      const flip = (more: boolean) => act(() => { os.more = more; os.listeners.forEach((f) => f()); });
      const txt = () => byLabel<HTMLInputElement>('txt hex').value;
      const [hc, dark] = [BUILT_IN_THEMES['high-contrast'].colors, BUILT_IN_THEMES.dark.colors];
      mount();
      openEditor();
      flip(true); expect([txt(), button('Export current theme').getAttribute('download')]).toEqual([hc.txt, 'my-high-contrast.json']); // case 1: untouched draft follows
      setValue(byLabel<HTMLInputElement>('txt hex'), '#123456');
      flip(false); expect(txt()).toBe('#123456'); // case 2: an edited draft is kept
      click(button('Customize')); // case 4: closing is the cancel path; an OS change happens while closed
      flip(true); openEditor();
      expect(txt()).toBe(hc.txt); // edits discarded, effective theme
      click(button('Fix contrast')); // "Nothing to change" is not an edit (re-review)
      flip(false); expect(txt()).toBe(dark.txt); // dirty was reset on reopen and the no-op fix left it clear: it follows
      const name = () => $<HTMLInputElement>('#theme-editor label input');
      click(button('Fix contrast')); // a Fix that changes colors (untouched Dark) is an edit
      const fixed = txt();
      flip(true); expect([txt(), byLabel<HTMLInputElement>('void hex').value]).toEqual([fixed, dark.void]);
      click(button('Reset to built-in')); // Reset with the default name: unedited again, so it follows
      importText('{oops'); // a failed import attempt counts as an edit (re-review)
      flip(false); expect([txt(), alertText()]).toEqual([hc.txt, expect.stringMatching(/Not valid JSON/)]);
      setValue(name(), 'acme'); click(button('Reset to built-in')); // Reset keeps a custom name, so the draft stays edited
      flip(true); expect([name().value, txt()]).toEqual(['acme', dark.txt]);
      setValue(name(), 'my-theme'); click(button('Reset to built-in'));
      flip(false); expect(txt()).toBe(dark.txt);
      for (const name of ['light', 'dark'] as const) { // case 3: an explicit choice is not overridden (theme nor draft)
        setValue(select(), name);
        flip(!os.more);
        expect([html.getAttribute('data-theme'), txt()], name).toEqual([name, BUILT_IN_THEMES[name].colors.txt]);
      }
      act(() => root?.unmount()); expect(os.listeners.size).toBe(0);
    } finally {
      Object.defineProperty(window, 'matchMedia', { configurable: true, value: original });
    }
  });
  it('editing the name clears a stale import-problems snapshot', () => {
    mount();
    openEditor();
    importText('{oops');
    setValue($<HTMLInputElement>('#theme-editor label input'), 'renamed');
    expect(alertText()).not.toMatch(/Not valid JSON/);
  });
  it('background-only roles show their worst pair (pairs whose base surface is that role), export and headers', () => {
    mount();
    setValue(select(), 'dark');
    openEditor();
    expect([(button('Export current theme') as HTMLButtonElement).disabled, container.textContent]).toEqual([true, expect.stringMatching(/Dark cannot be exported \(it has pinned contrast exceptions\)\. Choose Light or High contrast, or save a custom theme, to export\./)]);
    expect([...container.querySelectorAll('[aria-label="Contrast readout"] thead th')].map((h) => `${h.textContent}/${h.getAttribute('scope')}`)).toEqual(['Pair/col', 'Ratio/col', 'Threshold/col', 'Result/col']);
    setValue(select(), 'light');
    expect(button('Export current theme').tagName).toBe('A');
    for (const role of ['void', 'deep', 'slab', 'raised', 'exec-bg', 'exec-surface', 'exec-hover']) {
      const worst = contrastChecks({ ...BUILT_IN_THEMES.light, name: 'my-theme' }).filter((c) => c.bg.split('@').pop() === role).sort((a, b) => a.ratio / a.min - b.ratio / b.min)[0];
      expect(byLabel<HTMLInputElement>(`${role} hex`).nextElementSibling?.textContent, role).toBe(`${role} ${worst.ratio.toFixed(2)} Pass`);
    }
  });
});


describe('editor dismissal and save feedback', () => {
  it('closes explicitly and with Escape, returning focus to its opener', () => {
    mount(); openEditor();
    click(byLabel<HTMLButtonElement>('Close theme editor'));
    expect(container.querySelector('#theme-editor')).toBeNull();
    expect(document.activeElement).toBe(button('Customize'));
    openEditor();
    act(() => document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true })));
    expect(container.querySelector('#theme-editor')).toBeNull();
    expect(document.activeElement).toBe(button('Customize'));
  });
  it('dismisses on an outside pointer without applying unsaved edits or stealing focus', () => {
    mount(); setValue(select(), 'light'); openEditor();
    setValue(byLabel<HTMLInputElement>('txt hex'), '#123456');
    const outside = document.createElement('button'); document.body.appendChild(outside); outside.focus();
    act(() => outside.dispatchEvent(new Event('pointerdown', { bubbles: true })));
    expect(container.querySelector('#theme-editor')).toBeNull();
    expect(document.activeElement).toBe(outside);
    expect(html.getAttribute('data-theme')).toBe('light');
    expect(localStorage.getItem(ACTIVE_KEY)).toBe('light');
    outside.remove(); openEditor();
    expect(byLabel<HTMLInputElement>('txt hex').value).toBe(BUILT_IN_THEMES.light.colors.txt);
  });
  it('keeps inside interactions open and confirms a saved theme', () => {
    mount(); setValue(select(), 'light'); openEditor();
    act(() => byLabel<HTMLInputElement>('txt hex').dispatchEvent(new Event('pointerdown', { bubbles: true })));
    expect(container.querySelector('#theme-editor')).not.toBeNull();
    setValue($<HTMLInputElement>('#theme-editor label input'), 'brownstone'); click(button('Save and apply'));
    expect(html.getAttribute('data-theme')).toBe('brownstone');
    expect(localStorage.getItem(ACTIVE_KEY)).toBe('brownstone');
    expect(container.textContent).toContain('Saved and applied brownstone.');
  });
});
