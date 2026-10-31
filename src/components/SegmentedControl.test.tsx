// @vitest-environment happy-dom
// Selection controls expose their state to assistive technology and work from the
// keyboard: one tab stop, arrows move and select (wrapping), Home/End jump, and the
// selected item is marked by more than color.
import { act, useState } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { KeyboardEvent } from 'react';
import { CLIENT_MODES, SegmentedControl, rovingKeyDown, type SegmentOption } from './SegmentedControl';
import { DetailPanel } from './detail/DetailPanel';
import { Filters } from './workload/Filters';
import { WorkloadList } from './workload/WorkloadList';
import { useStore } from '@/store/useStore';

declare global {
  var IS_REACT_ACT_ENVIRONMENT: boolean;
}
globalThis.IS_REACT_ACT_ENVIRONMENT = true;

let root: Root;
let host: HTMLDivElement;
beforeEach(() => {
  host = document.createElement('div');
  document.body.appendChild(host);
  root = createRoot(host);
});
afterEach(() => {
  act(() => root.unmount());
  host.remove();
});

const OPTIONS: SegmentOption<'a' | 'b' | 'c'>[] = [
  { value: 'a', label: 'Alpha' },
  { value: 'b', label: 'Beta' },
  { value: 'c', label: 'Gamma', tone: 'cost' },
];
function Harness() {
  const [value, setValue] = useState<'a' | 'b' | 'c'>('a');
  return <SegmentedControl label="Letters" options={OPTIONS} value={value} onChange={setValue} />;
}
const radios = (scope: ParentNode = host) => [...scope.querySelectorAll<HTMLElement>('[role="radio"]')];
const checked = (scope?: ParentNode) => radios(scope).map((r) => r.getAttribute('aria-checked'));
const key = (el: Element, k: string) => act(() => { el.dispatchEvent(new KeyboardEvent('keydown', { key: k, bubbles: true })); });

describe('SegmentedControl', () => {
  it('is a named radio group with exactly one checked, tabbable radio', () => {
    act(() => root.render(<Harness />));
    const group = host.querySelector('[role="radiogroup"]');
    expect(group?.getAttribute('aria-label')).toBe('Letters');
    expect(checked()).toEqual(['true', 'false', 'false']);
    expect(radios().map((r) => r.tabIndex)).toEqual([0, -1, -1]);
    expect(radios().every((r) => r.getAttribute('type') === 'button')).toBe(true);
  });

  it('selects on click and marks the choice with a filled dot and bold label, not color alone', () => {
    act(() => root.render(<Harness />));
    act(() => radios()[2].click());
    expect(checked()).toEqual(['false', 'false', 'true']);
    expect(radios()[2].className).toContain('font-semibold');
    expect(radios()[2].querySelector('[aria-hidden="true"]')?.className).toContain('bg-current');
    expect(radios()[0].querySelector('[aria-hidden="true"]')?.className).not.toContain('bg-current');
  });

  it('moves and selects with arrow keys (wrapping), Home and End, and moves focus along', () => {
    act(() => root.render(<Harness />));
    radios()[0].focus();
    key(radios()[0], 'ArrowRight');
    expect(checked()).toEqual(['false', 'true', 'false']);
    expect(document.activeElement).toBe(radios()[1]);
    key(radios()[1], 'ArrowDown');
    key(radios()[2], 'ArrowRight');
    expect(checked()).toEqual(['true', 'false', 'false']);
    key(radios()[0], 'ArrowLeft');
    expect(checked()).toEqual(['false', 'false', 'true']);
    key(radios()[2], 'Home');
    expect(checked()).toEqual(['true', 'false', 'false']);
    key(radios()[0], 'End');
    expect(checked()).toEqual(['false', 'false', 'true']);
    expect(radios().map((r) => r.tabIndex)).toEqual([-1, -1, 0]);
    key(radios()[2], 'a');
    expect(checked()).toEqual(['false', 'false', 'true']);
  });

  it('labels the client modes in words, not raw ids', () => {
    expect(CLIENT_MODES.map((m) => m.label)).toEqual(['Mock (offline)', 'Live API']);
  });
});

describe('Workload detail tabs', () => {
  it('are a tab list with aria-selected, a labelled panel and arrow-key navigation', () => {
    act(() => useStore.setState({ activeTab: 'budget' }));
    act(() => root.render(<DetailPanel />));
    const list = host.querySelector('[role="tablist"]');
    expect(list?.getAttribute('aria-label')).toBe('Workload detail sections');
    const tabs = () => [...host.querySelectorAll<HTMLElement>('[role="tab"]')];
    expect(tabs().map((t) => t.getAttribute('aria-selected'))).toEqual(['true', 'false', 'false', 'false', 'false', 'false', 'false']);
    const panel = host.querySelector('[role="tabpanel"]');
    expect(panel?.getAttribute('aria-labelledby')).toBe(tabs()[0].id);
    expect(tabs()[0].getAttribute('aria-controls')).toBe(panel?.id);
    tabs()[0].focus();
    key(tabs()[0], 'ArrowRight');
    expect(useStore.getState().activeTab).toBe('models');
    expect(tabs()[1].getAttribute('aria-selected')).toBe('true');
    expect(document.activeElement).toBe(tabs()[1]);
    expect(host.querySelector('[role="tabpanel"]')?.getAttribute('aria-labelledby')).toBe(tabs()[1].id);
    key(tabs()[1], 'End');
    expect(useStore.getState().activeTab).toBe('outcomes');
    act(() => tabs()[2].click());
    expect(useStore.getState().activeTab).toBe('governance');
    expect(tabs().filter((t) => t.tabIndex === 0)).toEqual([tabs()[2]]);
  });
});

describe('Workload card metric switch', () => {
  it('is a radio group bound to the store', () => {
    act(() => useStore.setState({ secondaryMode: 'value' }));
    act(() => root.render(<Filters />));
    expect(host.querySelector('[role="radiogroup"]')?.getAttribute('aria-label')).toBe('Card metric');
    expect(checked()).toEqual(['true', 'false', 'false']);
    radios()[0].focus();
    key(radios()[0], 'ArrowRight');
    expect(useStore.getState().secondaryMode).toBe('cost');
    expect(checked()).toEqual(['false', 'true', 'false']);
    expect(document.activeElement).toBe(radios()[1]);
  });
});

// Review fix: browser and OS shortcuts (Alt+Arrow is Back/Forward, Ctrl/Meta+Arrow,
// Shift+Arrow) pass through every selection control untouched.
describe('modifier keys', () => {
  const MODS = ['altKey', 'ctrlKey', 'metaKey', 'shiftKey'] as const;
  const KEYS = ['ArrowLeft', 'ArrowRight', 'ArrowUp', 'ArrowDown', 'Home', 'End'];
  const press = (el: Element, k: string, mod?: (typeof MODS)[number]) => {
    const ev = new KeyboardEvent('keydown', { key: k, bubbles: true, cancelable: true, ...(mod ? { [mod]: true } : {}) });
    act(() => { el.dispatchEvent(ev); });
    return ev.defaultPrevented;
  };
  /** Every modified key leaves the state and default alone; the plain key still works. */
  function expectIgnoresModifiers(item: () => Element, state: () => unknown) {
    for (const k of KEYS) for (const m of MODS) {
      const before = state();
      expect(press(item(), k, m), `${m}+${k} default`).toBe(false);
      expect(state(), `${m}+${k} selection`).toEqual(before);
    }
    const before = state();
    expect(press(item(), 'ArrowRight')).toBe(true);
    expect(state()).not.toEqual(before);
  }

  it('client mode and other SegmentedControl groups', () => {
    function Modes() {
      const [m, setM] = useState<'mock' | 'live'>('mock');
      return <SegmentedControl label="Client mode" options={CLIENT_MODES} value={m} onChange={setM} />;
    }
    act(() => root.render(<><Modes /><Harness /></>));
    const groups = [...host.querySelectorAll('[role="radiogroup"]')];
    for (const g of groups) expectIgnoresModifiers(() => g.querySelector('[aria-checked="true"]')!, () => checked(g));
  });

  it('workload detail tabs', () => {
    act(() => useStore.setState({ activeTab: 'budget' }));
    act(() => root.render(<DetailPanel />));
    expectIgnoresModifiers(() => host.querySelector('[role="tab"][aria-selected="true"]')!, () => useStore.getState().activeTab);
  });

  it('workload card metric switch', () => {
    act(() => useStore.setState({ secondaryMode: 'value' }));
    act(() => root.render(<Filters />));
    expectIgnoresModifiers(() => host.querySelector('[aria-checked="true"]')!, () => useStore.getState().secondaryMode);
  });

  it('rovingKeyDown itself (cost source picker and any other caller)', () => {
    const calls: string[] = [];
    const mk = (k: string, mod: Partial<Record<(typeof MODS)[number], boolean>> = {}) => {
      let prevented = false;
      const parent = document.createElement('div');
      const item = document.createElement('button');
      parent.append(item, document.createElement('button'));
      rovingKeyDown({ key: k, ...mod, preventDefault: () => { prevented = true; }, currentTarget: item } as unknown as KeyboardEvent<HTMLElement>, ['x', 'y'], 'x', (v) => calls.push(v));
      return prevented;
    };
    for (const k of KEYS) for (const m of MODS) expect(mk(k, { [m]: true })).toBe(false);
    expect(calls).toEqual([]);
    expect(mk('End')).toBe(true);
    expect(calls).toEqual(['y']);
  });
});

describe('selected workload card scrolling', () => {
  // A tall scrolling list where only the first ~400px are visible.
  function layout(list: HTMLElement) {
    Object.defineProperty(list, 'scrollHeight', { configurable: true, value: 2000 });
    Object.defineProperty(list, 'clientHeight', { configurable: true, value: 400 });
    list.getBoundingClientRect = () => ({ top: 0, bottom: 400 }) as DOMRect;
    list.querySelectorAll('button[aria-pressed]').forEach((b, i) => {
      (b as HTMLElement).getBoundingClientRect = () => ({ top: 120 * i - list.scrollTop, bottom: 120 * i + 110 - list.scrollTop }) as DOMRect;
    });
  }
  const cards = () => [...host.querySelectorAll<HTMLButtonElement>('button[aria-pressed]')];

  it('brings a selection made elsewhere into view, but never scrolls under a pointer click', () => {
    const ws = useStore.getState().workloads;
    act(() => useStore.setState({ selectedId: ws[0].id, filters: { team: 'all', provider: 'all', environment: 'all' } }));
    act(() => root.render(<WorkloadList />));
    const list = cards()[0].closest('div.overflow-x-auto') as HTMLElement;
    layout(list);
    const last = cards().at(-1)!;
    const lastId = useStore.getState().workloads.find((w) => last.textContent?.includes(w.name))!.id;
    // Pointer: press and click a partly clipped card; the list must not move under the pointer.
    act(() => {
      last.dispatchEvent(new Event('pointerdown', { bubbles: true }));
      last.click();
    });
    expect(useStore.getState().selectedId).toBe(lastId);
    expect(list.scrollTop).toBe(0);
    // Selection from the keyboard or another page (no pointer): scrolled into view.
    act(() => useStore.setState({ selectedId: ws[0].id }));
    layout(list);
    act(() => useStore.setState({ selectedId: lastId }));
    expect(list.scrollTop).toBeGreaterThan(0);
  });
});
