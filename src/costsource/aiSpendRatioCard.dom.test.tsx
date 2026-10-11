// @vitest-environment happy-dom
// AiSpendRatioCard mounted with effects running: a slow load for the old path
// never overwrites the new path, and the window is the shared billing period.
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { AiSpendRatioReport } from './aiSpendRatio';
import type { CostWindow } from './CostSourceClient';
import { AiSpendRatioCard } from './AiSpendRatioCard';

declare global {
  var IS_REACT_ACT_ENVIRONMENT: boolean;
}
globalThis.IS_REACT_ACT_ENVIRONMENT = true;

// fetchAiSpendRatio is deferred per client mode so the test decides the order.
const calls = vi.hoisted(() => [] as { mode: string; window: CostWindow; resolve: (r: AiSpendRatioReport) => void }[]);
vi.mock('./aiSpendRatio', () => ({
  fetchAiSpendRatio: (client: { mode: string }, window: CostWindow) =>
    new Promise((resolve) => calls.push({ mode: client.mode, window, resolve })),
}));

function report(mode: 'mock' | 'live', total: number): AiSpendRatioReport {
  const result = { byCurrency: [{ currency: 'USD', totalCost: total, aiCost: total, ratio: 1, rowCount: 1, byService: [] }], rowCount: 1, excludedRows: 0, notes: [] };
  return { mode, window: calls[0].window, perSource: [{ sourceId: 's', name: 'S', inHeadline: true, result }], overall: result, errors: [] };
}

let root: Root | undefined;
const container = document.createElement('div');
afterEach(() => {
  act(() => root?.unmount());
  calls.length = 0;
  vi.useRealTimers();
  vi.unstubAllGlobals();
});
const mount = () => act(() => {
  root = createRoot(container);
  root.render(<AiSpendRatioCard />);
});

describe('AiSpendRatioCard (mounted)', () => {
  it('a slow Static-seed load cannot overwrite Ingested after rapid switching', async () => {
    const ingestedSource = { id: 'ext', name: 'Ext', configured: true, capabilities: ['costRows'] };
    vi.stubGlobal('fetch', async () => new Response(JSON.stringify([ingestedSource]), { status: 200 }));
    mount();
    const button = [...container.querySelectorAll('button')].find((b) => b.textContent === 'Ingested')!;
    act(() => button.click());
    await vi.waitFor(() => expect(calls.map((c) => c.mode)).toEqual(['mock', 'live']));
    await act(async () => calls[1].resolve(report('live', 222)));
    await act(async () => calls[0].resolve(report('mock', 111)));
    expect(container.textContent).toContain('$222');
    expect(container.textContent).not.toContain('$111');
    expect(container.textContent).toContain('Path: Ingested');
  });

  it('after switching, the old path\'s data renders as loading under the new label', async () => {
    vi.stubGlobal('fetch', async () => new Response(JSON.stringify([{ id: 'ext', name: 'Ext', configured: true, capabilities: ['costRows'] }]), { status: 200 }));
    mount();
    await act(async () => calls[0].resolve(report('mock', 111)));
    expect(container.textContent).toContain('$111');
    const button = [...container.querySelectorAll('button')].find((b) => b.textContent === 'Ingested')!;
    act(() => button.click());
    expect(container.textContent).toContain('Path: Ingested');
    expect(container.textContent).toContain('Loading');
    expect(container.textContent).not.toContain('$111');
  });

  it.each([
    ['2026-12-31T23:59:59.999Z', '2026-12-01T00:00:00.000Z', '2027-01-01T00:00:00.000Z'],
    ['2027-01-01T00:00:00.000Z', '2027-01-01T00:00:00.000Z', '2027-02-01T00:00:00.000Z'],
    ['2027-01-31T23:59:59.999Z', '2027-01-01T00:00:00.000Z', '2027-02-01T00:00:00.000Z'],
    ['2027-02-01T00:00:00.000Z', '2027-02-01T00:00:00.000Z', '2027-03-01T00:00:00.000Z'],
  ])('at %s the window is the billing month [%s, %s)', (now, start, end) => {
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(new Date(now));
    mount();
    expect(calls[0].window).toEqual({ start, end });
  });
});
