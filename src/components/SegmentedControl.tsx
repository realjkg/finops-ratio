// Single-choice controls with real selection semantics: a radio group (or tab
// list) with one tab stop, arrow keys that move and select, and a selected state
// that never relies on color alone (a filled dot and bold label mark it).
import type { KeyboardEvent, ReactNode } from 'react';

const STEP: Record<string, (i: number, n: number) => number> = {
  ArrowRight: (i) => i + 1, ArrowDown: (i) => i + 1, ArrowLeft: (i) => i - 1, ArrowUp: (i) => i - 1,
  Home: () => 0, End: (_, n) => n - 1,
};

/**
 * Roving-focus keyboard handler for a row of sibling items (radios or tabs) in
 * the same order as `values`: moves to the next/previous item (wrapping), selects
 * it, and focuses it. Ignores keys pressed with Alt, Ctrl, Meta or Shift.
 */
export function rovingKeyDown<T extends string>(e: KeyboardEvent<HTMLElement>, values: readonly T[], current: T, onChange: (value: T) => void) {
  // Modified keys belong to the browser and OS (Alt+Arrow is Back/Forward): leave them alone.
  if (e.altKey || e.ctrlKey || e.metaKey || e.shiftKey) return;
  if (!Object.hasOwn(STEP, e.key) || values.length === 0) return;
  e.preventDefault();
  const n = values.length;
  const next = (STEP[e.key](values.indexOf(current), n) + n) % n;
  onChange(values[next]);
  (e.currentTarget.parentElement?.children[next] as HTMLElement | undefined)?.focus();
}

export type SegmentTone = 'gate' | 'unit' | 'shape' | 'value' | 'cost';
const SELECTED: Record<SegmentTone, string> = {
  gate: 'border-gate bg-gate/10 text-gate',
  unit: 'border-unit bg-unit/10 text-unit',
  shape: 'border-shape bg-shape/10 text-shape',
  value: 'border-value bg-value/10 text-value',
  cost: 'border-cost bg-cost/10 text-cost',
};

export interface SegmentOption<T extends string> {
  value: T;
  label: ReactNode;
  /** Accent used when this option is selected (default gate). */
  tone?: SegmentTone;
  title?: string;
}

export function SegmentedControl<T extends string>({ label, options, value, onChange, size = 'md', className = '' }: {
  /** Accessible name of the group. */
  label: string;
  options: readonly SegmentOption<T>[];
  value: T;
  onChange: (value: T) => void;
  size?: 'sm' | 'md';
  className?: string;
}) {
  const values = options.map((o) => o.value);
  return (
    <div role="radiogroup" aria-label={label} className={`flex flex-wrap gap-2 ${className}`}>
      {options.map((o) => {
        const on = o.value === value;
        return (
          <button
            key={o.value}
            type="button"
            role="radio"
            aria-checked={on}
            tabIndex={on ? 0 : -1}
            title={o.title}
            onClick={() => onChange(o.value)}
            onKeyDown={(e) => rovingKeyDown(e, values, value, onChange)}
            className={`inline-flex items-center gap-2 rounded-card border transition-colors ${size === 'sm' ? 'px-3 py-1 text-xs' : 'px-4 py-1.5 text-sm'} ${
              on ? `${SELECTED[o.tone ?? 'gate']} font-semibold` : 'border-edge bg-raised text-sub hover:border-sub hover:text-txt'
            }`}
          >
            <span aria-hidden="true" className={`h-2 w-2 shrink-0 rounded-full border border-current ${on ? 'bg-current' : ''}`} />
            {o.label}
          </button>
        );
      })}
    </div>
  );
}

/** The mock/live client switch shared by the sandbox pages. */
export const CLIENT_MODES: readonly SegmentOption<'mock' | 'live'>[] = [
  { value: 'mock', label: 'Mock (offline)', tone: 'shape' },
  { value: 'live', label: 'Live API', tone: 'value' },
];
