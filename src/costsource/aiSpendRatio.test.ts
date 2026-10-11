// AI spend vs total spend: pure math (computeAiSpendRatio) and the
// interface-only fetch (fetchAiSpendRatio) on the mock and live paths.
import { afterEach, describe, expect, it, vi } from 'vitest';
import { computeAiSpendRatio, fetchAiSpendRatio } from './aiSpendRatio';
import type { CanonicalFocusRow } from './focusRows';
import type { CostSourceClient, CostSourceDescriptor, CostWindow } from './CostSourceClient';
import { createCostSourceClient } from './index';
import { LiveCostSourceClient, LiveDataAuthError } from './LiveCostSourceClient';
import { rawRowsForServiceNow, rawRowsForVersion } from './seed';

const AI = 'AI and Machine Learning';
const now = new Date();
const WINDOW: CostWindow = {
  start: new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1)).toISOString(),
  end: new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() + 1, 1)).toISOString(),
};

function row(cost: number, category = AI, currency = 'USD', service = 'Svc'): CanonicalFocusRow {
  return {
    EffectiveCost: cost,
    BilledCost: cost,
    BillingCurrency: currency,
    ServiceCategory: category,
    ServiceName: service,
  } as CanonicalFocusRow;
}

describe('computeAiSpendRatio', () => {
  const usd = (rows: CanonicalFocusRow[]) => computeAiSpendRatio(rows).byCurrency[0];
  it.each([
    ['all AI', [row(10), row(30)], 40, 40, 1],
    ['no AI', [row(10, 'Compute'), row(5, 'Storage')], 15, 0, 0],
    ['credits net in', [row(100), row(-20), row(80, 'Compute')], 160, 80, 0.5],
    ['zero total -> null', [row(50), row(-50, 'Compute')], 0, 50, null],
    ['negative total -> null', [row(10), row(-40, 'Compute')], -30, 10, null],
    ['0.1 + 0.2 is exactly 0.3', [row(0.1), row(0.2)], 0.3, 0.3, 1],
    ['huge values sum exactly', [row(100_000_000_000.01), row(100_000_000_000.02, 'Compute')], 200_000_000_000.03, 100_000_000_000.01, 100_000_000_000.01 / 200_000_000_000.03],
  ])('%s', (_name, rows, total, ai, ratio) => {
    const r = usd(rows);
    expect(r.totalCost).toBe(total);
    expect(r.aiCost).toBe(ai);
    expect(r.ratio).toBe(ratio);
    expect(r.rowCount).toBe(rows.length);
  });

  it('is empty for no rows', () => {
    expect(computeAiSpendRatio([])).toEqual({ byCurrency: [], rowCount: 0, excludedRows: 0, notes: [] });
  });

  it('sums ten 0.1 rows to exactly 1', () => {
    expect(usd(Array.from({ length: 10 }, () => row(0.1))).totalCost).toBe(1);
  });

  it('matches the category exactly and uses EffectiveCost, not BilledCost', () => {
    const r = usd([
      { ...row(70), BilledCost: 100 },
      row(30, 'ai and machine learning'),
      row(10, 'AI and Machine Learning '),
    ]);
    expect(r).toMatchObject({ totalCost: 110, aiCost: 70 });
  });

  it('never sums mixed currencies; one ratio per BillingCurrency', () => {
    const r = computeAiSpendRatio([row(40), row(60, 'Compute'), row(50, AI, 'EUR')]);
    expect(r.byCurrency.map((c) => [c.currency, c.totalCost, c.aiCost, c.ratio])).toEqual([
      ['EUR', 50, 50, 1],
      ['USD', 100, 40, 0.4],
    ]);
    expect(r.notes.join(' ')).toMatch(/never summed/);
  });

  it('breaks AI spend down by service, largest first, non-AI excluded', () => {
    const r = usd([row(5, AI, 'USD', 'A'), row(20, AI, 'USD', 'B'), row(1, AI, 'USD', 'A'), row(99, 'Compute', 'USD', 'C')]);
    expect(r.byService).toEqual([
      { serviceName: 'B', aiCost: 20 },
      { serviceName: 'A', aiCost: 6 },
    ]);
  });

  it('counts invalid rows as excluded, never throws', () => {
    const bad = [
      row(NaN),
      row(Infinity),
      row(-Infinity),
      row(1e13),
      row(Number.MAX_VALUE),
      row('12' as unknown as number),
      row(5, AI, 'usd'),
      row(5, AI, ''),
    ];
    const r = computeAiSpendRatio([row(10), ...bad]);
    expect(r.excludedRows).toBe(bad.length);
    expect(r.rowCount).toBe(1);
    expect(r.byCurrency).toHaveLength(1);
    expect(r.byCurrency[0].totalCost).toBe(10);
    expect(r.notes.join(' ')).toMatch(/8 rows? excluded/);
  });
});

// Independent oracle: the synthetic sandbox literals (syntheticCloudSeed.ts)
// and the workload seed rows summed in integer cents.
const SYNTHETIC = {
  'aws-sandbox': { total: 9542, ai: 5400 },
  'azure-sandbox': { total: 8287, ai: 4800 },
  'gcp-sandbox': { total: 6770, ai: 3900 },
};
const cents = (rows: { EffectiveCost: number }[]) => rows.reduce((s, r) => s + Math.round(r.EffectiveCost * 100), 0);
const WORKLOAD_CENTS = cents(rawRowsForVersion('1.0'));
const SERVICENOW_CENTS = cents(rawRowsForServiceNow());

describe('fetchAiSpendRatio on the mock path (sandbox + synthetic)', () => {
  it('matches the independent oracle per source and overall', async () => {
    const report = await fetchAiSpendRatio(createCostSourceClient('mock'), WINDOW);
    expect(report.mode).toBe('mock');
    expect(report.errors).toEqual([]);
    const usd = (id: string) => report.perSource.find((s) => s.sourceId === id)!.result.byCurrency[0];
    expect(report.perSource.map((s) => s.sourceId).sort()).toEqual(
      ['aws-sandbox', 'azure-sandbox', 'focus-file-sandbox', 'gcp-sandbox', 'pointfive-sandbox', 'servicenow-sandbox'],
    );
    for (const [id, o] of Object.entries(SYNTHETIC)) {
      expect(usd(id)).toMatchObject({ totalCost: o.total, aiCost: o.ai, ratio: o.ai / o.total });
    }
    expect(usd('pointfive-sandbox').totalCost * 100).toBeCloseTo(WORKLOAD_CENTS, 6);
    expect(usd('servicenow-sandbox').ratio).toBe(1);
    const overallCents = 2 * WORKLOAD_CENTS + SERVICENOW_CENTS + (9542 + 8287 + 6770) * 100;
    const aiCents = 2 * WORKLOAD_CENTS + SERVICENOW_CENTS + (5400 + 4800 + 3900) * 100;
    const overall = report.overall.byCurrency[0];
    expect(report.overall.byCurrency).toHaveLength(1);
    expect(Math.round(overall.totalCost * 100)).toBe(overallCents);
    expect(Math.round(overall.aiCost * 100)).toBe(aiCents);
  });
});

/** Stub fetch that serves the /api/costsource routes from the offline seed. */
function stubRoutes(override?: (path: string) => Response | undefined) {
  const seed = createCostSourceClient('mock');
  vi.stubGlobal('fetch', async (input: string) => {
    const url = new URL(input, 'http://localhost');
    const hit = override?.(url.pathname);
    if (hit) return hit;
    const body = url.pathname === '/api/costsource/sources'
      ? await seed.listSources()
      : await seed.fetchCostRows(url.searchParams.get('sourceId')!, WINDOW);
    return new Response(JSON.stringify(body), { status: 200 });
  });
}
afterEach(() => vi.unstubAllGlobals());

describe('fetchAiSpendRatio on the live path', () => {
  it('gives identical results to the mock path for identical rows', async () => {
    const mock = await fetchAiSpendRatio(createCostSourceClient('mock'), WINDOW);
    stubRoutes();
    const live = await fetchAiSpendRatio(new LiveCostSourceClient(), WINDOW);
    expect(live.mode).toBe('live');
    expect({ ...live, mode: 'mock' }).toEqual(mock);
  });
});

function fakeClient(sources: Partial<CostSourceDescriptor>[], failures: Record<string, Error> = {}) {
  const fetchCostRows = vi.fn(async (sourceId: string, window: CostWindow) => {
    if (failures[sourceId]) throw failures[sourceId];
    return { sourceId, window, rows: [row(25), row(75, 'Compute')] } as never;
  });
  const client = {
    mode: 'live',
    listSources: async () =>
      sources.map((s) => ({ capabilities: ['costRows'], configured: true, name: s.id, ...s })) as CostSourceDescriptor[],
    fetchCostRows,
  } as unknown as CostSourceClient;
  return { client, fetchCostRows };
}

describe('fetchAiSpendRatio failure isolation', () => {
  it('reports per-source failures without failing the others', async () => {
    const { client } = fakeClient([{ id: 'a' }, { id: 'b' }, { id: 'c' }], {
      b: new LiveDataAuthError(),
      c: new Error('route exploded'),
    });
    const report = await fetchAiSpendRatio(client, WINDOW);
    expect(report.perSource.map((s) => s.sourceId)).toEqual(['a']);
    expect(report.overall.byCurrency[0]).toMatchObject({ totalCost: 100, aiCost: 25, ratio: 0.25 });
    expect(report.errors).toEqual([
      { sourceId: 'b', message: 'Live connector data requires authenticated API access' },
      { sourceId: 'c', message: 'route exploded' },
    ]);
  });

  it('skips unconfigured or row-less sources by default; reports them when named', async () => {
    const { client, fetchCostRows } = fakeClient([
      { id: 'a' },
      { id: 'dark', configured: false },
      { id: 'findings-only', capabilities: ['findings'] },
    ]);
    const byDefault = await fetchAiSpendRatio(client, WINDOW);
    expect(byDefault.perSource.map((s) => s.sourceId)).toEqual(['a']);
    expect(byDefault.errors).toEqual([]);

    const named = await fetchAiSpendRatio(client, WINDOW, ['a', 'dark', 'missing']);
    expect(named.perSource.map((s) => s.sourceId)).toEqual(['a']);
    expect(named.errors).toEqual([
      { sourceId: 'dark', message: 'Source is not configured' },
      { sourceId: 'missing', message: 'Unknown cost source' },
    ]);
    expect(fetchCostRows.mock.calls.map((c) => c[0])).toEqual(['a', 'a']);
  });
});
