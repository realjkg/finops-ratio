// @vitest-environment happy-dom
// The three simulated API connections on the Connectors page: no per-card data label (the top-bar Demo
// badge covers it), no credential fields, "Import" reconciles client-side with no data request.
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
  it('shows the three connections, unlabeled, before import, with no credential or endpoint fields', () => {
    mount();
    expect([...box.querySelectorAll('article')].map((a) => a.getAttribute('aria-label'))).toEqual(['Public cloud billing API', 'Private cloud usage API', 'On-premises cost allocation API']);
    expect(box.textContent).not.toMatch(/synthetic|sample|example|simulated|fictional|fixture/i);
    expect(box.textContent).toMatch(/Public cloud API/);
    expect(box.textContent).toMatch(/Private cloud API/);
    expect(box.textContent).toMatch(/On-premises API/);
    expect(box.textContent).toMatch(/Last import2026-10-30 06:00 UTC/);
    expect(box.querySelectorAll('input, textarea, select')).toHaveLength(0);
    expect(box.querySelector('table')).toBeNull();
  });
  it('imports a connection client-side and reconciles it, with no data request and nothing stored', async () => {
    const fetchSpy = vi.fn(() => { throw new Error('no network'); });
    vi.stubGlobal('fetch', fetchSpy);
    mount();
    await click(button('Import', card('Private cloud usage API')));
    const priv = card('Private cloud usage API');
    expect(priv.querySelector('[role="status"]')?.textContent).toMatch(/^Reconciled/);
    const table = priv.querySelector('table[aria-label^="Reconciliation"]')!;
    expect(table.querySelector('caption')?.textContent).toBe('Reconciliation in EUR for Private cloud usage API');
    expect(table.querySelector('tbody th[scope="row"]')?.textContent).toBe('Private cloud usage API');
    expect([...table.querySelectorAll('tbody tr')[0].children].map((c) => c.textContent)).toEqual(['Private cloud usage API', '109', 'EUR 2,339.00', 'EUR 1,739.00', 'EUR 600.00']);
    // The phone layout is a stacked list carrying the same numbers.
    expect([...priv.querySelectorAll('dl')].find((d) => /Billed/.test(d.textContent ?? ''))?.textContent).toMatch(/Billed − Effective.*EUR 600\.00/);
    // N/A columns: collapsed by default, grouped by reason, whole-column cases apart from partial ones.
    const na = priv.querySelector('details')!;
    expect(na.open).toBe(false);
    expect(na.textContent).toMatch(/Empty on every row.*Not applicable: the line is not a correction: ChargeClass/);
    expect(na.textContent).toMatch(/Empty on some rows/);
    expect(na.textContent).not.toMatch(/ListCost/);
    expect(na.textContent).not.toMatch(/of 109/);
    expect(card('Public cloud billing API').querySelector('table')).toBeNull(); // others untouched
    expect(fetchSpy).not.toHaveBeenCalled();
    expect([localStorage.length, sessionStorage.length]).toEqual([0, 0]);
  });
  it('explains a negative Billed minus Effective on the on-premises connection only', async () => {
    mount();
    await click(button('Import', card('On-premises cost allocation API')));
    await click(button('Import', card('Private cloud usage API')));
    expect(card('On-premises cost allocation API').textContent).toMatch(/Billed − Effective is negative: owned hardware has no purchase in this period/);
    expect(card('Private cloud usage API').textContent).not.toMatch(/is negative/);
  });
  it('totals each currency on its own line and removes an import', async () => {
    mount();
    for (const n of ['Public cloud billing API', 'Private cloud usage API', 'On-premises cost allocation API']) await click(button('Import', card(n)));
    const totals = [...box.querySelectorAll('table[aria-label="Imported totals by currency"] tbody tr')].map((tr) => [...tr.children].map((c) => c.textContent));
    expect(box.querySelector('table[aria-label="Imported totals by currency"] caption')?.textContent).toMatch(/one row per currency/);
    expect(totals).toEqual([['EUR', '1', '109', 'EUR 2,339.00', 'EUR 1,739.00'], ['USD', '2', '214', 'USD 4,617.88', 'USD 5,188.73']]);
    await click(button('Remove', card('On-premises cost allocation API')));
    expect([...box.querySelectorAll('table[aria-label="Imported totals by currency"] tbody tr')].map((tr) => tr.children[0].textContent)).toEqual(['EUR', 'USD']);
    expect(box.querySelector('table[aria-label="Imported totals by currency"] tbody tr:last-child')?.children[2].textContent).toBe('108');
  });
});
