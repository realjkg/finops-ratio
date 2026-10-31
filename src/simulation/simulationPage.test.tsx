// @vitest-environment happy-dom
// /simulation: when server simulation is off the page is a finished read-only sample (no server call,
// no storage); when it is on, the sign-in experience is unchanged.
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

declare global { var IS_REACT_ACT_ENVIRONMENT: boolean }
globalThis.IS_REACT_ACT_ENVIRONMENT = true;

const access = vi.hoisted(() => ({ current: null as unknown }));
vi.mock('@/simulation/SimulationProvider', () => ({ useSimulationAccess: () => access.current }));
vi.mock('next/link', () => ({ default: ({ href, children, ...rest }: { href: string; children: React.ReactNode }) => <a href={href} {...rest}>{children}</a> }));

import { useSampleImports } from '@/demo/apiDatasets/store';
import SimulationSignIn from '../../pages/simulation';

const base = { loading: false, error: null, identities: {}, signIn: vi.fn(async () => {}), signOut: async () => {}, refresh: async () => {} };
let root: Root; let box: HTMLDivElement;
const mount = () => { box = document.createElement('div'); document.body.appendChild(box); act(() => { root = createRoot(box); root.render(<SimulationSignIn />); }); };
const click = (el: Element) => act(() => (el as HTMLElement).click());
const buttons = () => [...box.querySelectorAll('button')];

beforeEach(() => { localStorage.clear(); sessionStorage.clear(); });
afterEach(() => { act(() => root.unmount()); box.remove(); vi.unstubAllGlobals(); });

describe('/simulation with server simulation disabled', () => {
  it('shows the labeled sample workspace instead of the dead end, with three persona cards', () => {
    access.current = { ...base, enabled: false };
    mount();
    expect(box.textContent).not.toMatch(/does not enable customer simulation/);
    expect(box.querySelector('[role="note"]')?.textContent).toBe('Synthetic sample data · nothing is saved');
    expect(box.textContent).not.toMatch(/Continue as/);
    expect(buttons().map((b) => b.textContent)).toEqual(['Open Executive sample', 'Open Technical sample', 'Open Procurement sample']);
  });
  it('opens each persona read-only, with no network call and nothing stored', () => {
    const fetchSpy = vi.fn(() => { throw new Error('no network in the sample'); });
    vi.stubGlobal('fetch', fetchSpy);
    access.current = { ...base, enabled: false };
    mount();
    for (const [i, title] of ['Executive', 'Technical', 'Procurement'].entries()) {
      click(buttons()[i]);
      const region = box.querySelector(`[aria-label="Sample workspace: ${title}"]`);
      expect(region?.textContent, title).toMatch(/\$|%/);
      expect(buttons()[i].getAttribute('aria-pressed')).toBe('true');
    }
    expect(fetchSpy).not.toHaveBeenCalled();
    expect([localStorage.length, sessionStorage.length]).toEqual([0, 0]);
    expect(box.querySelectorAll('input, textarea, select')).toHaveLength(0);
  });
  it('uses the imported synthetic connections in each persona view, still with no network call', async () => {
    const fetchSpy = vi.fn(() => { throw new Error('no network in the sample'); });
    vi.stubGlobal('fetch', fetchSpy);
    useSampleImports.setState({ imported: {}, busy: {}, error: null });
    access.current = { ...base, enabled: false };
    mount();
    click(buttons()[0]);
    expect(box.querySelector('[aria-label="Imported synthetic connections"]')?.textContent).toMatch(/Import the three synthetic connections/);
    await act(async () => {
      click(buttons().find((b) => b.textContent === 'Import the three synthetic connections')!);
      for (let i = 0; i < 100 && Object.keys(useSampleImports.getState().imported).length < 3; i++) await new Promise((r) => setTimeout(r, 20));
    });
    const region = () => box.querySelector('[aria-label="Imported synthetic connections"]')!;
    expect([...region().querySelectorAll('tbody tr')].map((tr) => tr.children[0].textContent)).toEqual(['EUR', 'USD']);
    click(buttons()[1]);
    expect(region().textContent).toMatch(/Example Cloud billing API/);
    click(buttons()[2]);
    expect(region().textContent).toMatch(/Example Compute Savings Plan.*prepaid.*unused/);
    expect(region().textContent).toMatch(/No commitment on this connection/);
    expect(fetchSpy).not.toHaveBeenCalled();
  });
  it('waits while loading instead of flashing the sample', () => {
    access.current = { ...base, enabled: false, loading: true };
    mount();
    expect(box.querySelector('[role="note"]')).toBeNull();
    expect(box.textContent).toContain('Loading simulation');
  });
});

describe('/simulation with server simulation enabled', () => {
  it('is unchanged: server-backed identities, no sample', () => {
    access.current = { ...base, enabled: true, identities: { a: { tenant: 'Example Tenant', user: 'Ada Example', persona: 'executive' } } };
    mount();
    expect(box.querySelector('[role="note"]')).toBeNull();
    expect(box.textContent).toContain('Follow the cost from import to decision.');
    expect(buttons().map((b) => b.textContent)).toEqual(['Continue as Ada']);
    click(buttons()[0]);
    expect(base.signIn).toHaveBeenCalledWith('a');
  });
});
