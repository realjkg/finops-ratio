// FOCUS 1.5 carries model identity and token labels as properties INSIDE the
// SkuPriceDetails column, not as columns ("The model and token properties in 1.5
// live here, which is why none of them needed new columns": Tokenomics
// Foundation, What FOCUS 1.5 does for AI cost, Nov 2026). These tests pin that
// Ratio reads them there, keeps the column through the CSV transport, accepts a
// provider-issued PricingCurrency, and totals prepaid AI spend once.
import { describe, expect, it } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';
import type { CanonicalFocusRow, FocusCoreV10, RawSourceRow } from './focusRows';
import { parseSkuPriceDetails, skuPriceDetailsAi, upgradeToCanonicalCost } from './focusRows';
import { normalizeRows } from './normalize';
import { validateFocusRecords } from './transports/focusExport';
import { computeAiSpendRatio } from './aiSpendRatio';
import { resourceIdFor } from './seed';
import { MultiModelTab, TOKENIZER_CAVEAT } from '@/components/detail/MultiModelTab';
import { MODEL_REGISTRY } from '@/data/models';
import { WORKLOADS } from '@/data/workloads';

const AI = 'AI and Machine Learning';

function core(patch: Partial<RawSourceRow> = {}): RawSourceRow {
  const base: FocusCoreV10 = {
    BilledCost: 10,
    EffectiveCost: 10,
    BillingCurrency: 'USD',
    BillingPeriodStart: '2026-06-01T00:00:00.000Z',
    BillingPeriodEnd: '2026-07-01T00:00:00.000Z',
    ChargePeriodStart: '2026-06-01T00:00:00.000Z',
    ChargePeriodEnd: '2026-06-02T00:00:00.000Z',
    BillingAccountId: 'acct-1',
    SubAccountId: 'team-1',
    ServiceName: 'Model API',
    ServiceCategory: AI,
    ProviderName: 'Provider',
    ChargeCategory: 'Usage',
    ChargeDescription: 'input tokens',
    ResourceId: resourceIdFor('wl-support'),
    PricingQuantity: 1,
    PricingUnit: '1M Tokens',
    UsageQuantity: 1_000_000,
    UsageUnit: 'Tokens',
  };
  return { ...base, ...patch } as RawSourceRow;
}

const DETAILS = {
  ModelDeveloper: 'Anthropic',
  ModelFamily: 'Claude',
  ModelId: 'claude-sonnet-4-20250514',
  ModelVersion: '20250514',
  TokenCacheAction: 'Read',
  TokenDirection: 'Input',
  InstanceType: 'not-an-ai-property',
};

describe('model identity and token labels come from SkuPriceDetails', () => {
  it('reads all six properties from SkuPriceDetails text (as a CSV export carries it)', () => {
    const row = upgradeToCanonicalCost(core({ SkuPriceDetails: JSON.stringify(DETAILS) }));
    expect([row.ModelDeveloper, row.ModelFamily, row.ModelId, row.ModelVersion, row.TokenCacheAction, row.TokenDirection]).toEqual([
      'Anthropic', 'Claude', 'claude-sonnet-4-20250514', '20250514', 'Read', 'Input',
    ]);
  });

  it('reads them from a SkuPriceDetails object too (JSON transports)', () => {
    const row = upgradeToCanonicalCost(core({ SkuPriceDetails: DETAILS }));
    expect(row.ModelId).toBe('claude-sonnet-4-20250514');
    expect(row.TokenCacheAction).toBe('Read');
  });

  it('SkuPriceDetails wins over a same-named top-level column', () => {
    const row = upgradeToCanonicalCost(core({ SkuPriceDetails: JSON.stringify(DETAILS), ModelId: 'other-model', TokenDirection: 'Output' }));
    expect(row.ModelId).toBe('claude-sonnet-4-20250514');
    expect(row.TokenDirection).toBe('Input');
  });

  it('a property present in SkuPriceDetails is authoritative even when invalid or null: no top-level fallback', () => {
    const raw = core({ SkuPriceDetails: JSON.stringify({ TokenDirection: 'input', ModelId: null }), TokenDirection: 'Output', ModelId: 'stale' });
    const row = upgradeToCanonicalCost(raw);
    expect(row.TokenDirection).toBeNull();
    expect(row.ModelId).toBeNull();
    expect(skuPriceDetailsAi(raw as unknown as Record<string, unknown>).fromTopLevelColumns).toEqual([]);
  });

  it('inherited keys never count as present in SkuPriceDetails', () => {
    const row = upgradeToCanonicalCost(core({ SkuPriceDetails: '{"__proto__": {"ModelId": "polluted"}}', ModelId: 'top' }));
    expect(row.ModelId).toBe('top');
    expect(({} as Record<string, unknown>).ModelId).toBeUndefined();
  });

  it('falls back to a top-level column only when SkuPriceDetails lacks the property, and says so', () => {
    const raws = [core({ SkuPriceDetails: JSON.stringify({ ModelId: 'm-1' }), ModelDeveloper: 'Dev', TokenDirection: 'Output' })];
    const row = upgradeToCanonicalCost(raws[0]);
    expect([row.ModelId, row.ModelDeveloper, row.TokenDirection]).toEqual(['m-1', 'Dev', 'Output']);
    expect(skuPriceDetailsAi(raws[0] as unknown as Record<string, unknown>).fromTopLevelColumns).toEqual(['ModelDeveloper', 'TokenDirection']);
    expect(normalizeRows(raws, 'focus-file-sandbox', '1.4').aiPropertiesFromTopLevelColumns).toEqual(['ModelDeveloper', 'TokenDirection']);
  });

  it('reports no top-level fallback for a standard 1.5 export', () => {
    const raws = [core({ SkuPriceDetails: JSON.stringify(DETAILS) })];
    expect(normalizeRows(raws, 'focus-file-sandbox', '1.4').aiPropertiesFromTopLevelColumns).toEqual([]);
  });

  it('omits token labels outside FOCUS allowed values rather than misdescribing them', () => {
    const row = upgradeToCanonicalCost(core({ SkuPriceDetails: JSON.stringify({ TokenCacheAction: 'Cached', TokenDirection: 'input' }) }));
    expect(row.TokenCacheAction).toBeNull();
    expect(row.TokenDirection).toBeNull();
    for (const action of ['Uncached', 'Read', 'Write', 'Other']) {
      expect(upgradeToCanonicalCost(core({ SkuPriceDetails: JSON.stringify({ TokenCacheAction: action }) })).TokenCacheAction).toBe(action);
    }
  });

  it('a separately metered reasoning-token row is Output; a context-cache standing charge carries no token labels', () => {
    const reasoning = upgradeToCanonicalCost(core({ SkuPriceDetails: JSON.stringify({ ModelId: 'm', TokenDirection: 'Output' }) }));
    expect(reasoning.TokenDirection).toBe('Output');
    const storage = upgradeToCanonicalCost(core({ ChargeDescription: 'cache storage', SkuPriceDetails: JSON.stringify({ ModelId: 'm' }) }));
    expect(storage.ModelId).toBe('m');
    expect([storage.TokenCacheAction, storage.TokenDirection]).toEqual([null, null]);
  });

  it('malformed, empty or non-object SkuPriceDetails yields nulls and never throws', () => {
    for (const bad of ['{not json', '', '   ', '[1,2]', 'null', '"text"', 42]) {
      expect(parseSkuPriceDetails(bad)).toBeNull();
      const row = upgradeToCanonicalCost(core({ SkuPriceDetails: bad as string }));
      expect(row.ModelId).toBeNull();
    }
  });
});

describe('the CSV transport keeps SkuPriceDetails', () => {
  const rec = (patch: Record<string, unknown>) => ({ BilledCost: '1', BillingCurrency: 'USD', ChargePeriodStart: '2026-06-02T00:00:00Z', ...patch });

  it('passes the column through so normalization can parse it; an empty cell is null', () => {
    const [kept] = validateFocusRecords([rec({ SkuPriceDetails: JSON.stringify(DETAILS) })], 'feed');
    expect(upgradeToCanonicalCost(kept).ModelId).toBe('claude-sonnet-4-20250514');
    const [empty] = validateFocusRecords([rec({ SkuPriceDetails: '' })], 'feed');
    expect(empty.SkuPriceDetails).toBeNull();
  });

  it('keeps an object-valued SkuPriceDetails (JSON sources) readable, never "[object Object]"', () => {
    const [kept] = validateFocusRecords([rec({ SkuPriceDetails: DETAILS })], 'feed');
    expect(kept.SkuPriceDetails).toBe(JSON.stringify(DETAILS));
    const row = upgradeToCanonicalCost(kept);
    expect([row.ModelId, row.TokenCacheAction, row.TokenDirection]).toEqual(['claude-sonnet-4-20250514', 'Read', 'Input']);
  });

  it('an array-valued SkuPriceDetails is rejected, never unwrapped into object-shaped text', () => {
    for (const arr of [['{"ModelId":"m-1","TokenDirection":"Output"}'], [DETAILS], []]) {
      const [kept] = validateFocusRecords([rec({ SkuPriceDetails: arr })], 'feed');
      const row = upgradeToCanonicalCost(kept);
      expect([row.ModelId, row.TokenDirection]).toEqual([null, null]);
    }
  });

  it('accepts a provider-issued unit in PricingCurrency, but never in BillingCurrency', () => {
    expect(validateFocusRecords([rec({ PricingCurrency: 'Credits' })], 'feed')[0].PricingCurrency).toBe('Credits');
    expect(validateFocusRecords([rec({ PricingCurrency: 'PLATFORM_UNITS' })], 'feed')[0].PricingCurrency).toBe('PLATFORM_UNITS');
    expect(() => validateFocusRecords([rec({ BillingCurrency: 'Credits' })], 'feed')).toThrow(/BillingCurrency/);
  });

  it('still refuses anything that looks like a currency code but is not a real one', () => {
    expect(() => validateFocusRecords([rec({ PricingCurrency: 'eur' })], 'feed')).toThrow(/PricingCurrency/);
    expect(() => validateFocusRecords([rec({ PricingCurrency: 'XQZ' })], 'feed')).toThrow(/PricingCurrency/);
    expect(validateFocusRecords([rec({ PricingCurrency: 'EUR' })], 'feed')[0].PricingCurrency).toBe('EUR');
  });

  it('refuses currency symbols and disguised codes as provider units', () => {
    for (const bad of ['US$', '€', 'U.S.D', 'usd1', 'X', 'EUR-1', '$$$$']) {
      expect(() => validateFocusRecords([rec({ PricingCurrency: bad })], 'feed'), bad).toThrow(/PricingCurrency/);
    }
    for (const ok of ['Credits', 'PLATFORM_UNITS', 'Compute Units', 'tokens-v2']) {
      expect(validateFocusRecords([rec({ PricingCurrency: ok })], 'feed')[0].PricingCurrency).toBe(ok);
    }
  });
});

describe('prepaid AI spend is counted once', () => {
  it('a token prepayment and the usage that draws it down total EffectiveCost, not purchase plus usage', () => {
    // FOCUS records the purchase and the drawdown on different rows: the purchase
    // is billed but carries no effective cost; the usage carries the amortized cost.
    const purchase = { BilledCost: 1000, EffectiveCost: 0, BillingCurrency: 'USD', ServiceCategory: AI, ServiceName: 'Model API', ChargeCategory: 'Purchase' };
    const drawdown = (cost: number) => ({ BilledCost: 0, EffectiveCost: cost, BillingCurrency: 'USD', ServiceCategory: AI, ServiceName: 'Model API', ChargeCategory: 'Usage' });
    const rows = [purchase, drawdown(300), drawdown(200)] as unknown as CanonicalFocusRow[];
    const usd = computeAiSpendRatio(rows).byCurrency[0];
    expect(usd.aiCost).toBe(500);
    expect(usd.totalCost).toBe(500);
  });
});

describe('model comparison is labeled an estimate across tokenizers', () => {
  it('says token counts differ between models', () => {
    const html = renderToStaticMarkup(<MultiModelTab workload={WORKLOADS[0]} models={MODEL_REGISTRY} />);
    expect(html).toContain('data-testid="tokenizer-caveat"');
    expect(html).toContain(TOKENIZER_CAVEAT.replace(/'/g, '&#x27;'));
    expect(TOKENIZER_CAVEAT).toMatch(/^Estimates:/);
  });
});
