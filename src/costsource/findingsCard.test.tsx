// @vitest-environment happy-dom
// The anomaly row must show the sign of observedSpendDelta without a stray '+'.
// A8: the findings title names the source that produced the findings.

import { createRoot } from 'react-dom/client';
import { describe, expect, it, vi } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';
import { CostSourcePage, FindingsCard } from './CostSourcePage';
import type { CostFinding } from './index';

const gate = vi.hoisted(() => ({ open: (): void => {} }));
vi.mock('./index', async (importOriginal) => {
  const mod = await importOriginal<typeof import('./index')>();
  return {
    ...mod,
    createCostSourceClient: (mode: 'mock' | 'live') => {
      const real = mod.createCostSourceClient(mode);
      return {
        ...real,
        listSources: () => real.listSources(),
        healthCheck: (id: string) => real.healthCheck(id),
        fetchCostRows: (id: string, w: { start: string; end: string }) => real.fetchCostRows(id, w),
        fetchFindings: (id: string) =>
          new Promise<void>((resolve) => { gate.open = resolve; }).then(() => real.fetchFindings(id)),
      };
    },
  };
});
vi.mock('./AiSpendRatioCard', () => ({ AiSpendRatioCard: () => null }));


function anomaly(id: string, observedSpendDelta: number): CostFinding {
  return {
    id,
    sourceId: 'fixture',
    type: 'anomaly',
    category: 'spend_spike',
    title: `Anomaly ${id}`,
    resourceId: 'r-1',
    workloadId: null,
    estimatedMonthlySavings: 0,
    observedSpendDelta,
    severity: 'warning',
    status: 'open',
    detectedAt: '2026-01-01T00:00:00Z',
  };
}

const tick = () => new Promise((r) => setTimeout(r, 20));
async function waitFor<T>(get: () => T | undefined): Promise<T> {
  for (let i = 0; i < 100; i++) {
    const v = get();
    if (v) return v;
    await tick();
  }
  throw new Error('timed out');
}
const button = (root: HTMLElement, text: string) => () =>
  [...root.querySelectorAll('button')].find((b) => b.textContent?.includes(text) && !b.disabled);
const title = (root: HTMLElement) => () =>
  [...root.querySelectorAll('*')].filter((e) => e.children.length === 0).map((e) => e.textContent ?? '').find((t) => t.startsWith('Findings — '));

describe('FindingsCard anomaly delta', () => {
  it('renders +$ for a positive delta and -$ for a negative delta', () => {
    const html = renderToStaticMarkup(
      <FindingsCard findings={[anomaly('up', 5), anomaly('down', -5)]} />,
    );
    expect(html).toContain('+$5.00/mo');
    expect(html).toContain('-$5.00/mo');
    expect(html).not.toMatch(/\+-|\+\$-/);
  });
});

describe('FindingsCard title', () => {
  it('names_the_source_that_ran_the_ingest_even_after_the_picker_changes', async () => {
    const host = document.createElement('div');
    document.body.appendChild(host);
    const root = createRoot(host);
    root.render(<CostSourcePage />);
    (await waitFor(button(host, 'ServiceNow'))).click();
    (await waitFor(button(host, 'Ingest + Normalize'))).click();
    await waitFor(() => host.textContent?.includes('Loading findings'));
    (await waitFor(button(host, 'PointFive'))).click();
    gate.open();
    expect(await waitFor(title(host))).toMatch(/^Findings — \d+ \(ServiceNow, synthetic demo data\)$/);
    root.unmount();
  });
});
