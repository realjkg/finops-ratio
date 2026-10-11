// AiSpendRatioCard: the Static seed / Ingested switch runs the same
// fetchAiSpendRatio code; the Ingested path degrades to an honest state.
import { afterEach, describe, expect, it, vi } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';
import { AiSpendRatioCard, AiSpendRatioView, loadAiSpendRatio } from './AiSpendRatioCard';
import type { AiSpendRatioReport } from './aiSpendRatio';
import { createCostSourceClient } from './index';

const now = new Date();
const WINDOW = {
  start: new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1)).toISOString(),
  end: new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() + 1, 1)).toISOString(),
};

/** Stub fetch for the /api/costsource routes; `respond` may override a path. */
function stubRoutes(respond: (path: string) => Response | undefined = () => undefined) {
  const seed = createCostSourceClient('mock');
  vi.stubGlobal('fetch', async (input: string) => {
    const [pathname, query = ''] = input.split('?');
    const hit = respond(pathname);
    if (hit) return hit;
    const body = pathname === '/api/costsource/sources'
      ? await seed.listSources()
      : await seed.fetchCostRows(new URLSearchParams(query).get('sourceId')!, WINDOW);
    return new Response(JSON.stringify(body), { status: 200 });
  });
}
const json = (body: unknown, status: number) => new Response(JSON.stringify(body), { status });
afterEach(() => vi.unstubAllGlobals());

describe('loadAiSpendRatio (path switch)', () => {
  it('switching paths changes only the client: identical rows give identical results', async () => {
    const seed = await loadAiSpendRatio('seed', WINDOW);
    stubRoutes();
    const ingested = await loadAiSpendRatio('ingested', WINDOW);
    if (seed.status !== 'ready' || ingested.status !== 'ready') throw new Error('expected ready');
    expect(seed.report.mode).toBe('mock');
    expect(ingested.report.mode).toBe('live');
    expect({ ...ingested.report, mode: 'mock' }).toEqual(seed.report);
  });

  it.each([
    ['auth error (401)', () => json({ error: 'nope' }, 401), /authenticated API access/],
    ['route error (500)', () => json({ error: 'Internal error' }, 500), /Internal error/],
    ['no sources', () => json([], 200), /No configured cost sources/],
  ])('Ingested unavailable: %s', async (_name, sources, reason) => {
    stubRoutes((p) => (p === '/api/costsource/sources' ? sources() : undefined));
    const state = await loadAiSpendRatio('ingested', WINDOW);
    expect(state.status).toBe('unavailable');
    if (state.status === 'unavailable') expect(state.reason).toMatch(reason);
  });

  it('Ingested unavailable: every source refused (unconfigured 409)', async () => {
    stubRoutes((p) => (p === '/api/costsource/rows' ? json({ error: 'Cost source is not configured — live credentials required' }, 409) : undefined));
    const state = await loadAiSpendRatio('ingested', WINDOW);
    expect(state).toMatchObject({ status: 'unavailable', reason: 'No source returned cost rows' });
    if (state.status === 'unavailable') expect(state.errors?.[0].message).toMatch(/not configured/);
  });

  it('Ingested unavailable: sources answer with zero rows', async () => {
    stubRoutes((p) => (p === '/api/costsource/rows' ? json({ rows: [] }, 200) : undefined));
    expect(await loadAiSpendRatio('ingested', WINDOW)).toMatchObject({
      status: 'unavailable',
      reason: 'Sources returned no cost rows for this window',
    });
  });
});

function report(mode: 'mock' | 'live'): AiSpendRatioReport {
  const usd = { currency: 'USD', totalCost: 1000, aiCost: 250, ratio: 0.25, rowCount: 3, byService: [{ serviceName: 'Bedrock', aiCost: 250 }] };
  const eur = { currency: 'EUR', totalCost: -40, aiCost: -40, ratio: null, rowCount: 1, byService: [] };
  const result = { byCurrency: [eur, usd], rowCount: 4, excludedRows: 0, notes: [] };
  return {
    mode,
    window: WINDOW,
    perSource: [{ sourceId: 'aws-sandbox', name: 'AWS (synthetic sandbox)', result }],
    overall: result,
    errors: [{ sourceId: 'dark', message: 'Source is not configured' }],
  };
}
const render = (el: React.ReactElement) => renderToStaticMarkup(el);
const noop = () => {};

describe('AiSpendRatioView', () => {
  it('shows headline, ratio, per-source and per-currency figures on the seed path', () => {
    const html = render(<AiSpendRatioView path="seed" state={{ status: 'ready', report: report('mock') }} onSwitch={noop} />);
    expect(html).toContain('Static seed');
    expect(html).toContain('mock client');
    expect(html).toContain('25.0%');
    expect(html).toContain('$250');
    expect(html).toContain('$1,000');
    expect(html).toContain('AWS (synthetic sandbox)');
    expect(html).toContain('-40.00 EUR');
    expect(html).not.toContain('€');
    expect(html).toContain('n/a');
    expect(html).toContain('dark: Source is not configured');
    expect(html).toMatch(/not deduplicated/);
  });

  it('labels the ingested path', () => {
    const html = render(<AiSpendRatioView path="ingested" state={{ status: 'ready', report: report('live') }} onSwitch={noop} />);
    expect(html).toContain('Ingested');
    expect(html).toContain('live client');
  });

  it('renders an honest unavailable state with a way back to the seed', () => {
    const html = render(
      <AiSpendRatioView path="ingested" state={{ status: 'unavailable', reason: 'Authentication required: x' }} onSwitch={noop} />,
    );
    expect(html).toContain('Ingested data unavailable');
    expect(html).toContain('Authentication required: x');
    expect(html).toContain('Switch to Static seed');
  });

  it('formats negative USD with the sign first', () => {
    const r = report('mock');
    r.overall = { ...r.overall, byCurrency: [{ ...r.overall.byCurrency[1], totalCost: -702, ratio: null }] };
    const html = render(<AiSpendRatioView path="seed" state={{ status: 'ready', report: r }} onSwitch={noop} />);
    expect(html).toContain('-$702');
  });

  it('the card starts on the Static seed path', () => {
    const html = render(<AiSpendRatioCard />);
    expect(html).toContain('Static seed');
    expect(html).toContain('Loading');
  });
});
