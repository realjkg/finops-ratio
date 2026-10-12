// Theme switcher and palette editor in the top bar. Every user theme (pasted,
// file, sample or edited) goes through checkTheme before it can be applied, and
// the readout shows each required contrast pair as the validator computes it.
import { useEffect, useRef, useState, type ChangeEvent, type MouseEvent } from 'react';
import { applyTheme } from '@/theme/apply';
import { BUILT_IN_THEMES, DEFAULT_THEME, ROLES, type BuiltInThemeName, type Role, type Theme } from '@/theme/themes';
import { contrastChecks, type Violation } from '@/theme/validate';
import {
  MAX_CUSTOM, MAX_IMPORT_BYTES, checkTheme, exportTheme, fixContrast, isBuiltIn, loadActiveTheme, loadCustomThemes, normalizeHex, parseTheme, saveThemes, type Fix,
} from '@/theme/user';
import samples from '@/theme/sample-palettes.json';

const LABELS: Record<string, string> = { light: 'Light', 'high-contrast': 'High contrast', dark: 'Dark' };
const swatch = (v: unknown, fallback: string) => {
  const hex = normalizeHex(v);
  return typeof hex === 'string' && /^#[0-9a-f]{6}$/.test(hex) ? hex : fallback;
};
const btn = 'rounded border border-edge bg-raised px-2 py-1 font-mono text-xs text-txt hover:bg-slab';

/** The built-in the CSS shows when there is no choice (same order as src/index.css). */
function systemTheme(): BuiltInThemeName {
  const matches = (q: string) => typeof window.matchMedia === 'function' && window.matchMedia(q).matches;
  return matches('(prefers-contrast: more)') ? 'high-contrast' : matches('(prefers-color-scheme: dark)') ? 'dark' : DEFAULT_THEME;
}

/** Drops the user's choice: the CSS default (and the OS preference) applies again. */
function clearDocumentTheme() {
  const root = document.documentElement;
  root.removeAttribute('data-theme');
  for (const role of ROLES) root.style.removeProperty(`--c-${role}`);
  root.style.removeProperty('color-scheme');
}

export function ThemeMenu() {
  const [active, setActive] = useState<string | null>(null);
  const [custom, setCustom] = useState<Theme[]>([]);
  const [open, setOpen] = useState(false);
  const menu = useRef<HTMLDivElement>(null);
  const opener = useRef<HTMLButtonElement | null>(null);
  const close = () => { setOpen(false); opener.current?.focus(); };
  useEffect(() => {
    if (!open) return;
    const escape = (event: KeyboardEvent) => {
      if (event.key === 'Escape') { event.preventDefault(); setOpen(false); opener.current?.focus(); }
    };
    const outside = (event: PointerEvent) => {
      if (event.target instanceof Node && !menu.current?.contains(event.target)) setOpen(false);
    };
    document.addEventListener('keydown', escape);
    document.addEventListener('pointerdown', outside);
    return () => { document.removeEventListener('keydown', escape); document.removeEventListener('pointerdown', outside); };
  }, [open]);
  const [draft, setDraft] = useState<Record<string, unknown>>({ ...BUILT_IN_THEMES[DEFAULT_THEME], name: 'my-theme' });
  const [paste, setPaste] = useState('');
  const [problems, setProblems] = useState<Violation[]>([]);
  const [fix, setFix] = useState<Fix | null>(null);
  const [note, setNote] = useState('');
  const [system, setSystem] = useState<BuiltInThemeName>(DEFAULT_THEME);
  const [dirty, setDirty] = useState(false); // the draft has user edits (colors, name, import)

  useEffect(() => {
    const stored = loadActiveTheme();
    setCustom(loadCustomThemes());
    setSystem(systemTheme());
    setActive(stored === null ? null : typeof stored === 'string' ? stored : stored.name);
  }, []);
  // Default (system) follows live OS changes, the same queries the CSS uses.
  useEffect(() => {
    if (typeof window.matchMedia !== 'function') return;
    const lists = ['(prefers-contrast: more)', '(prefers-color-scheme: dark)'].map((q) => window.matchMedia(q));
    const update = () => setSystem(systemTheme());
    lists.forEach((l) => l.addEventListener?.('change', update));
    return () => lists.forEach((l) => l.removeEventListener?.('change', update));
  }, []);

  const current: Theme = custom.find((t) => t.name === active) ?? BUILT_IN_THEMES[isBuiltIn(active) ? active : system];
  const choose = (name: string, list = custom, success = '') => {
    const theme = isBuiltIn(name) ? name : list.find((t) => t.name === name);
    if (theme) applyTheme(theme);
    else clearDocumentTheme();
    setActive(theme ? name : null);
    setNote(saveThemes(theme ? name : null, list) ? success : 'Storage is unavailable: this choice lasts until you leave the page.');
  };

  const checked = checkTheme(draft);
  const colors = draft.colors as Record<Role, string>;
  /** Every deliberate draft replacement also drops the transient editor state. */
  const replaceDraft = (next: Record<string, unknown>, fixed: Fix | null = null) => {
    setDraft(next);
    setDirty(false);
    setProblems([]);
    setFix(fixed);
  };
  const draftOf = (t: Theme) => ({ ...t, name: isBuiltIn(t.name) ? 'my-theme' : t.name });
  const pick = (name: string) => {
    choose(name);
    replaceDraft(draftOf(custom.find((t) => t.name === name) ?? BUILT_IN_THEMES[isBuiltIn(name) ? name : system]));
  };
  // Default (system) follows the OS: refresh the draft too, unless the user has edited it.
  useEffect(() => {
    if (active === null && !dirty) replaceDraft(draftOf(BUILT_IN_THEMES[system]));
    // eslint-disable-next-line react-hooks/exhaustive-deps -- only an OS change should trigger this
  }, [system]);
  const setColor = (role: Role) => (e: ChangeEvent<HTMLInputElement>) => {
    setDirty(true);
    setProblems([]);
    setDraft({ ...draft, colors: { ...colors, [role]: e.target.value } });
  };
  const load = (result: { theme: Theme | null; violations: Violation[] }) => {
    setFix(null);
    // Only imports that cannot fill the editor keep a snapshot; contrast problems come live from `checked`.
    setProblems(result.theme ? [] : result.violations);
    setDirty(true); // any import attempt is an edit, a failed one included (its problems must survive OS changes)
    if (result.theme) {
      setDraft({ ...result.theme });
    }
    if (result.theme && !result.violations.length) save(result.theme);
  };
  const save = (imported?: Theme) => {
    const theme = imported ?? (checked.violations.length ? null : checked.theme);
    if (!theme) return;
    const list = [...custom.filter((t) => t.name !== theme.name), theme];
    if (list.length > MAX_CUSTOM) return setNote(`You can keep ${MAX_CUSTOM} custom themes. Delete one first.`);
    setCustom(list);
    choose(theme.name, list, `Saved and applied ${theme.name}.`);
    replaceDraft({ ...theme });
  };
  const remove = () => {
    const list = custom.filter((t) => t.name !== active);
    setCustom(list);
    choose('', list);
  };
  const readFile = async (e: ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    // Never read more than the limit; parseTheme rejects anything over it.
    if (file) load(parseTheme(await file.slice(0, MAX_IMPORT_BYTES + 1).text()));
  };
  const exportable = isBuiltIn(current.name) ? { ...current, name: `my-${current.name}` } : current;
  // Dark keeps pinned exemptions that the user-theme gate (rightly) refuses: do not offer an export that cannot re-import.
  const canExport = checkTheme(exportable).violations.length === 0;
  const exported = exportTheme(exportable);
  const checks = checked.theme ? contrastChecks(checked.theme) : [];

  const toggle = (event: MouseEvent<HTMLButtonElement>) => {
    opener.current = event.currentTarget;
    if (!open) replaceDraft(draftOf(current));
    setOpen(!open);
  };
  const switcher = (id: string) => (
    <>
      <label htmlFor={id}>Theme</label>
      <select id={id} value={active ?? ''} onChange={(e) => pick(e.target.value)} className="min-w-0 max-w-[11rem] rounded border border-edge bg-raised px-1 py-0.5 text-txt">
        <option value="">Default (system)</option>
        {Object.keys(BUILT_IN_THEMES).map((n) => <option key={n} value={n}>{LABELS[n]}</option>)}
        {custom.map((t) => <option key={t.name} value={t.name}>Custom: {t.name}</option>)}
      </select>
    </>
  );

  return (
    <div ref={menu} className="md:relative">
      <div className="flex items-center gap-1.5 font-mono text-xs text-sub">
        {/* Phones get one "Theme" button; the switcher then sits at the top of the panel. */}
        <button type="button" className={`${btn} md:hidden`} aria-expanded={open} aria-controls="theme-editor" onClick={toggle}>Theme</button>
        <span className="hidden items-center gap-1.5 md:flex">
          {switcher('theme-select')}
          <button type="button" className={btn} aria-expanded={open} aria-controls="theme-editor" onClick={toggle}>Customize</button>
        </span>
      </div>
      <div className="absolute inset-x-2 top-full z-40 mt-1 space-y-1 text-xs text-txt md:inset-x-auto md:right-0 md:w-[30rem]">
        {/* One status region, mounted while empty, so the storage note is announced. */}
        <p role="status" className={note ? 'rounded border border-edge bg-slab p-2' : ''}>{note}</p>
        {open && (
        <section id="theme-editor" aria-label="Theme editor" className="max-h-[80vh] space-y-3 overflow-auto rounded border border-edge bg-slab p-3 shadow-lg">
          <div className="flex items-center gap-1.5 md:hidden">{switcher('theme-select-panel')}</div>
          <div className="flex justify-end"><button type="button" className={btn} aria-label="Close theme editor" onClick={close}>Close</button></div>
          <label className="block">Name <input value={String(draft.name)} onChange={(e) => {
            setDirty(true);
            setProblems([]);
            setDraft({ ...draft, name: e.target.value });
          }} className="ml-1 rounded border border-edge bg-raised px-1 font-mono" /></label>
          <div className="grid grid-cols-1 gap-1 sm:grid-cols-2">
            {ROLES.map((role) => {
              // Foreground roles, and surfaces as the base of a pair (`txt/void`, `value/value/10@raised`).
              const worst = checks.filter((c) => c.fg === role || c.bg.split('@').pop() === role).sort((a, b) => a.ratio / a.min - b.ratio / b.min)[0];
              return (
                <div key={role} className="flex items-center gap-1">
                  <input type="color" aria-label={`${role} color`} value={swatch(colors[role], current.colors[role])} onChange={setColor(role)} className="h-5 w-6" />
                  <input aria-label={`${role} hex`} value={colors[role]} onChange={setColor(role)} className="w-20 rounded border border-edge bg-raised px-1 font-mono" />
                  <span className="min-w-0 break-words leading-tight">{role}{worst && ` ${worst.ratio.toFixed(2)} ${worst.pass ? 'Pass' : 'Fail'}`}</span>
                </div>
              );
            })}
          </div>
          <details>
            <summary>Contrast: {checks.filter((c) => c.pass).length} of {checks.length} required pairs pass</summary>
            <table className="mt-1 w-full font-mono" aria-label="Contrast readout">
              <thead>
                <tr><th scope="col">Pair</th><th scope="col">Ratio</th><th scope="col">Threshold</th><th scope="col">Result</th></tr>
              </thead>
              <tbody>
                {checks.map((c) => (
                  <tr key={`${c.fg}/${c.bg}`} className={c.pass ? 'text-sub' : 'text-cost'}>
                    <td>{c.fg} on {c.bg}</td><td>{c.ratio.toFixed(2)}:1</td><td>needs {c.min}</td><td>{c.pass ? 'Pass' : 'Fail'}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </details>
          <div className="flex flex-wrap gap-1">
            <button type="button" className={btn} onClick={() => save()}>Save and apply</button>
            <button type="button" className={btn} disabled={!checked.theme} onClick={() => {
              const f = fixContrast(checked.theme as Theme);
              replaceDraft({ ...f.theme }, f);
              setDirty(dirty || f.changes.length > 0); // changed colors are edits; "Nothing to change" is not
            }}>Fix contrast</button>
            <button type="button" className={btn} onClick={() => {
              replaceDraft({ ...BUILT_IN_THEMES[isBuiltIn(active) ? active : system], name: draft.name });
              setDirty(draft.name !== 'my-theme'); // a kept custom name is still an edit
            }}>Reset to built-in</button>
            {canExport ? (
              <a className={btn} download={`${exportable.name}.json`} href={`data:application/json;charset=utf-8,${encodeURIComponent(exported)}`}>Export current theme</a>
            ) : (
              <button type="button" className={btn} disabled aria-describedby="theme-export-note">Export current theme</button>
            )}
            {!canExport && <p id="theme-export-note" className="w-full">Dark cannot be exported (it has pinned contrast exceptions). Choose Light or High contrast, or save a custom theme, to export.</p>}
            {!isBuiltIn(active) && active && <button type="button" className={btn} onClick={remove}>Delete {active}</button>}
          </div>
          <div role="status">
            {fix && (fix.changes.length ? fix.changes.map((c) => <p key={c.role}>Changed {c.role}: {c.from} to {c.to}</p>) : <p>Nothing to change.</p>)}
            {fix && fix.unreachable.length > 0 && <p className="text-cost">Could not reach the target for: {fix.unreachable.join(', ')}</p>}
          </div>
          {/* Always mounted (empty when clean) so the first problem is announced. */}
          <ul aria-live="polite" aria-label="Theme problems" className="list-disc pl-4 text-cost">
            {(problems.length ? problems : checked.violations).slice(0, 12).map((v, i) => <li key={i}>{v.message}</li>)}
          </ul>
          <label className="block">Import JSON
            <textarea aria-label="Theme JSON" value={paste} onChange={(e) => setPaste(e.target.value)} rows={3} className="mt-1 block w-full rounded border border-edge bg-raised p-1 font-mono" />
          </label>
          <div className="flex flex-wrap items-center gap-1">
            <button type="button" className={btn} onClick={() => load(parseTheme(paste))}>Import</button>
            {samples.map((s) => <button key={s.name} type="button" className={btn} onClick={() => setPaste(JSON.stringify(s, null, 2))}>Sample: {s.name}</button>)}
            <label className={`${btn} focus-within:outline focus-within:outline-2 focus-within:outline-offset-2 focus-within:outline-focus`}>From file <input type="file" accept="application/json,.json" onChange={readFile} className="sr-only" /></label>
          </div>
        </section>
        )}
      </div>
    </div>
  );
}
