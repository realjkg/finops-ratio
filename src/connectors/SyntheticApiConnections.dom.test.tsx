// @vitest-environment happy-dom
// The three simulated API connections on the Connectors page: labeled Synthetic, no credential fields,
// "Import sample" reconciles client-side with no network call.
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { useSampleImports } from '@/demo/apiDatasets/store';
import { SyntheticApiConnections } from './SyntheticApiConnections';

declare global { var IS_REACT_ACT_ENVIRONMENT: boolean }
globalThis.IS_REACT_ACT_ENVIRONMENT = true;

let root: Root; let box: HTMLDivElement;
const mount = () => { box = document.createElement('div'); document.body.appendChild(box); act(() => { root = createRoot(box); root.render(<SyntheticApiConnections />); }); };
const button = (text: string, within: ParentNode = box) => [...within.querySelectorAll('button')].find((b) => b.textContent === text) as HTMLButtonElement;
const card = (name: string) => box.querySelector(`article[aria-label="${name}"]`) as HTMLElement;
const settle = async () => { for (let i = 0; i < 100 && Object.values(useSampleImports.getState().busy).some(Boolean); i++) await new Promise((r) => setTimeout(r, 20)); };
const click = async (el: HTMLElement) => { await act(async () => { el.click(); await new Promise((r) => setTimeout(r, 0)); await settle(); }); };

beforeEach(() => { useSampleImports.setState({ imported: {}, busy: {}, error: null }); localStorage.clear(); sessionStorage.clear(); });
afterEach(() => { act(() => root.unmount()); box.remove(); vi.unstubAllGlobals(); });

describe('SyntheticApiConnections', () => {
  it('shows the three connections as Synthetic, before import, with no credential or endpoint fields', () => {
    mount();
    expect([...box.querySelectorAll('article')].map((a) => a.getAttribute('aria-label'))).toEqual(['Example Cloud billing API', 'Example Private Cloud usage API', 'Example Datacenter cost allocation API']);
    expect([...box.querySelectorAll('article')].every((a) => a.textContent?.includes('Synthetic'))).toBe(true);
    expect(box.textContent).toMatch(/Public cloud API/);
    expect(box.textContent).toMatch(/Private cloud API/);
    expect(box.textContent).toMatch(/On-premise API/);
    expect(box.textContent).toMatch(/2026-10-30 06:00 UTC \(simulated\)/);
    expect(box.querySelectorAll('input, textarea, select')).toHaveLength(0);
    expect(box.querySelector('table')).toBeNull();
  });
  it('imports a sample client-side and reconciles it, with no network call and nothing stored', async () => {
    const fetchSpy = vi.fn(() => { throw new Error('no network'); });
    vi.stubGlobal('fetch', fetchSpy);
    mount();
    await click(button('Import sample', card('Example Private Cloud usage API')));
    const priv = card('Example Private Cloud usage API');
    expect(priv.querySelector('[role="status"]')?.textContent).toMatch(/^Reconciled/);
    const row = priv.querySelector('table[aria-label^="Reconciliation"] tbody tr')!;
    expect([...row.children].map((c) => c.textContent)).toEqual(['109', 'EUR 2,339.00', 'EUR 1,739.00', 'EUR 600.00']);
    expect(priv.textContent).toMatch(/ListCost: N\/A on 109 of 109 rows\. Internal chargeback has no public list price/);
    expect(card('Example Cloud billing API').querySelector('table')).toBeNull(); // others untouched
    expect(fetchSpy).not.toHaveBeenCalled();
    expect([localStorage.length, sessionStorage.length]).toEqual([0, 0]);
  });
  it('totals each currency on its own line and removes an import', async () => {
    mount();
    for (const n of ['Example Cloud billing API', 'Example Private Cloud usage API', 'Example Datacenter cost allocation API']) await click(button('Import sample', card(n)));
    const totals = [...box.querySelectorAll('table[aria-label="Imported totals by currency"] tbody tr')].map((tr) => [...tr.children].map((c) => c.textContent));
    expect(totals).toEqual([['EUR', '1', '109', 'EUR 2,339.00', 'EUR 1,739.00'], ['USD', '2', '214', 'USD 4,617.88', 'USD 5,188.73']]);
    await click(button('Remove', card('Example Datacenter cost allocation API')));
    expect([...box.querySelectorAll('table[aria-label="Imported totals by currency"] tbody tr')].map((tr) => tr.children[0].textContent)).toEqual(['EUR', 'USD']);
    expect(box.querySelector('table[aria-label="Imported totals by currency"] tbody tr:last-child')?.children[2].textContent).toBe('108');
  });
});
