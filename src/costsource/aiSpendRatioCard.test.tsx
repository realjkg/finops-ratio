// AiSpendRatioCard: the Static seed / Ingested switch runs the same
// fetchAiSpendRatio code; the Ingested path degrades to an honest state.
import { afterEach, describe, expect, it, vi } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';
import { AiSpendRatioCard, AiSpendRatioView, loadAiSpendRatio } from './AiSpendRatioCard';
import type { AiSpendRatioReport } from './aiSpendRatio';
import { createCostSourceClient } from './index';
import { anonymousSourceView } from './sourceDisclosure';
import { isOfflineSandboxSource } from './sandboxSources';
import { CompositionCard } from './CostSourcePage';
import { WORKLOADS } from '@/data/workloads';

const now = new Date();
const WINDOW = {
  start: new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1)).toISOString(),
  end: new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() + 1, 1)).toISOString(),
};

/**
 * A configured non-sandbox source. SIMULATION: only an authenticated
 * server-side caller sees configured connectors; an anonymous browser gets
 * configured:false placeholders (anonymousSourceView).
 */
const INGESTED = { id: 'ingested-export', name: 'Ingested export', kind: 'cloud', configured: true, capabilities: ['costRows'] };

/**
 * Stub fetch for the /api/costsource routes, serving the offline seed. With
 * `ingested`, the source list also carries INGESTED, whose rows are the
 * aws-sandbox rows; `respond` may override a path.
 */
function stubRoutes(ingested: boolean, respond: (path: string) => Response | undefined = () => undefined) {
  const seed = createCostSourceClient('mock');
  vi.stubGlobal('fetch', async (input: string) => {
    const [pathname, query = ''] = input.split('?');
    const hit = respond(pathname);
    if (hit) return hit;
    const id = new URLSearchParams(query).get('sourceId');
    const body = pathname === '/api/costsource/sources'
      ? [...(await seed.listSources()), ...(ingested ? [INGESTED] : [])]
      : await seed.fetchCostRows(id === INGESTED.id ? 'aws-sandbox' : id!, WINDOW);
    return new Response(JSON.stringify(body), { status: 200 });
  });
}
const json = (body: unknown, status: number) => new Response(JSON.stringify(body), { status });
const AUTH_REASON =
  'Ingested data needs an authenticated connection; this browser session is anonymous and the live routes expose only offline sandbox sources here.';
afterEach(() => vi.unstubAllGlobals());

describe('loadAiSpendRatio (path switch)', () => {
  it('Ingested never shows seed: sandbox-only live sources give the empty state', async () => {
    stubRoutes(false);
    expect(await loadAiSpendRatio('ingested', WINDOW)).toEqual({ status: 'unavailable', reason: AUTH_REASON });
  });

  it('anonymous browser view (connectors as configured:false placeholders) gives the auth-required copy', async () => {
    const all = (await createCostSourceClient('mock').listSources()).map((s) =>
      isOfflineSandboxSource(s.id) ? s : { ...s, configured: true },
    );
    stubRoutes(false, (p) => (p === '/api/costsource/sources' ? json(anonymousSourceView(all), 200) : undefined));
    expect(await loadAiSpendRatio('ingested', WINDOW)).toEqual({ status: 'unavailable', reason: AUTH_REASON });
  });

  it('SIMULATED authenticated server-side caller (not an anonymous browser): only non-sandbox sources count; identical rows give identical results', async () => {
    const seed = await loadAiSpendRatio('seed', WINDOW);
    stubRoutes(true);
    const ingested = await loadAiSpendRatio('ingested', WINDOW);
    if (seed.status !== 'ready' || ingested.status !== 'ready') throw new Error('expected ready');
    expect(seed.report.mode).toBe('mock');
    expect(ingested.report.mode).toBe('live');
    expect(ingested.report.perSource.map((s) => s.sourceId)).toEqual([INGESTED.id]);
    const aws = seed.report.perSource.find((s) => s.sourceId === 'aws-sandbox')!.result;
    expect(ingested.report.perSource[0].result).toEqual(aws);
    expect(ingested.report.overall).toEqual(aws);
  });

  it.each([
    ['auth error (401)', () => json({ error: 'nope' }, 401), /authenticated API access/],
    ['route error (500)', () => json({ error: 'Internal error' }, 500), /Internal error/],
    ['no sources', () => json([], 200), /authenticated connection/],
  ])('Ingested unavailable: %s', async (_name, sources, reason) => {
    stubRoutes(true, (p) => (p === '/api/costsource/sources' ? sources() : undefined));
    const state = await loadAiSpendRatio('ingested', WINDOW);
    expect(state.status).toBe('unavailable');
    if (state.status === 'unavailable') expect(state.reason).toMatch(reason);
  });

  it('Ingested unavailable: every source refused (unconfigured 409)', async () => {
    stubRoutes(true, (p) => (p === '/api/costsource/rows' ? json({ error: 'Cost source is not configured — live credentials required' }, 409) : undefined));
    const state = await loadAiSpendRatio('ingested', WINDOW);
    expect(state).toMatchObject({ status: 'unavailable', reason: 'No source returned cost rows' });
    if (state.status === 'unavailable') expect(state.errors?.[0].message).toMatch(/not configured/);
  });

  it('Ingested unavailable: sources answer with zero rows', async () => {
    stubRoutes(true, (p) => (p === '/api/costsource/rows' ? json({ rows: [] }, 200) : undefined));
    expect(await loadAiSpendRatio('ingested', WINDOW)).toMatchObject({
      status: 'unavailable',
      reason: 'No source returned cost rows',
      errors: [{ sourceId: INGESTED.id, message: 'Source returned no cost rows' }],
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
    perSource: [
      { sourceId: 'aws-sandbox', name: 'AWS (synthetic sandbox)', inHeadline: true, result },
      { sourceId: 'focus-file-sandbox', name: 'FOCUS file', inHeadline: false, result },
    ],
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
    expect(html).toContain('same workloads, not summed into the headline');
    expect(html.match(/not summed into the headline/g)).toHaveLength(1);
  });

  it('shows N/A with a reason when no headline-eligible source has rows', () => {
    const r = report('mock');
    r.overall = { ...r.overall, byCurrency: [] };
    const html = render(<AiSpendRatioView path="seed" state={{ status: 'ready', report: r }} onSwitch={noop} />);
    expect(html).toContain('N/A (no headline-eligible source returned rows)');
  });

  it('names the seed path as simulated and shows each excluded source its reason', () => {
    const r = report('mock');
    r.perSource[1] = { ...r.perSource[1], exclusionReason: 'Source role unconfirmed; excluded from headline totals' };
    const html = render(<AiSpendRatioView path="seed" state={{ status: 'ready', report: r }} onSwitch={noop} />);
    expect(html).toContain('simulated demo data');
    expect(html).toContain('(Source role unconfirmed; excluded from headline totals)');
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

describe('Forecast (EOM) in the composition card', () => {
  it('shows N/A, not 0%, for an invalid monthly budget', async () => {
    const rows = (await createCostSourceClient('mock').fetchCostRows('pointfive-sandbox', WINDOW)).rows;
    const html = (b: number) => {
      const seed = WORKLOADS.find((x) => x.id === rows[0].ResourceId?.split('/').pop())!;
      const saved = seed.costs.monthly_budget;
      seed.costs.monthly_budget = b;
      try { return render(<CompositionCard rows={rows} />); } finally { seed.costs.monthly_budget = saved; }
    };
    expect(html(0)).toContain('(N/A of budget)');
    expect(html(0)).not.toMatch(/\(0% of budget\)/);
    expect(html(15000)).toMatch(/\(\d+% of budget\)/);
  });
});
