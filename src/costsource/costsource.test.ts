// Tests for the cost-ingest seam: the FOCUS v1.0-v1.5 version shim (1.5 a
// working draft), value attachment (numerator/denominator), and the mock
// client over offline seed.
import { describe, it, expect } from 'vitest';
import { CANONICAL_FOCUS_VERSION, columnsAddedAfter } from './focusVersions';
import type { FocusCoreV10, RawSourceRow } from './focusRows';
import { upgradeToCanonicalCost } from './focusRows';
import { resourceIdFor, resolveWorkloadId, rawRowsForVersion } from './seed';
import { attachRatioValue, normalizeRows, composeRatioView } from './normalize';
import { createCostSourceClient } from './index';

// A minimal v1.0 row — only the mandatory core columns a v1.0 source emits.
function v10Row(workloadId: string): RawSourceRow {
  const core: FocusCoreV10 = {
    BilledCost: 1000,
    EffectiveCost: 950,
    BillingCurrency: 'USD',
    BillingPeriodStart: '2026-06-01T00:00:00.000Z',
    BillingPeriodEnd: '2026-07-01T00:00:00.000Z',
    ChargePeriodStart: '2026-06-01T00:00:00.000Z',
    ChargePeriodEnd: '2026-07-01T00:00:00.000Z',
    BillingAccountId: 'acct-1',
    SubAccountId: 'team-1',
    ServiceName: 'Claude Sonnet 4',
    ServiceCategory: 'AI and Machine Learning',
    ProviderName: 'anthropic',
    ChargeCategory: 'Usage',
    ChargeDescription: 'test charge',
    ResourceId: resourceIdFor(workloadId),
    PricingQuantity: 1_000_000,
    PricingUnit: '1M Tokens',
    UsageQuantity: 1_000_000,
    UsageUnit: 'Tokens',
  };
  return core;
}

describe('upgradeToCanonicalCost (version shim)', () => {
  it('backfills every post-1.0 column on a v1.0 source row', () => {
    const canonical = upgradeToCanonicalCost(v10Row('wl-support'));
    // v1.1 additive, derived from columns the source provides
    expect(canonical.ListCost).toBe(1000); // defaults to BilledCost
    expect(canonical.ContractedCost).toBe(950); // defaults to EffectiveCost
    expect(canonical.ConsumedQuantity).toBe(1_000_000);
    expect(canonical.CommitmentDiscountStatus).toBeNull();
    // v1.2 additive
    expect(canonical.ServiceSubcategory).toBe('Generative AI');
    expect(canonical.InvoiceIssuerName).toBe('anthropic');
    // v1.3 / v1.4 additive
    expect(canonical.PricingCurrency).toBe('USD');
    expect(canonical.CapacityReservationId).toBeNull();
  });

  it('preserves columns a higher-version source already provides', () => {
    const raw: RawSourceRow = { ...v10Row('wl-support'), ListCost: 1234, ServiceSubcategory: 'LLM' };
    const canonical = upgradeToCanonicalCost(raw);
    expect(canonical.ListCost).toBe(1234);
    expect(canonical.ServiceSubcategory).toBe('LLM');
  });
});

describe('columnsAddedAfter', () => {
  it('reports all later columns for a v1.0 source and none for v1.4', () => {
    expect(columnsAddedAfter('1.0')).toContain('ServiceSubcategory');
    expect(columnsAddedAfter('1.0').length).toBeGreaterThan(0);
    expect(columnsAddedAfter('1.4')).toEqual([]);
  });
});

describe('resourceId round-trip', () => {
  it('resolves a workload id from its FOCUS ResourceId', () => {
    expect(resolveWorkloadId(resourceIdFor('wl-support'))).toBe('wl-support');
    expect(resolveWorkloadId('arn:other:thing')).toBeNull();
  });
});

describe('attachRatioValue (numerator + denominator)', () => {
  it('attaches the resolved workload value ratio', () => {
    const cost = upgradeToCanonicalCost(v10Row('wl-support'));
    const row = attachRatioValue(cost, 'pointfive-sandbox', '1.0');
    expect(row.x_RatioWorkloadId).toBe('wl-support');
    expect(row.x_RatioValueRatio).toBeGreaterThan(0);
    expect(row.x_RatioSourceVersion).toBe('1.0');
  });

  it('never hides cost: unresolved rows normalize with zero value', () => {
    const cost = upgradeToCanonicalCost({ ...v10Row('wl-support'), ResourceId: 'arn:unknown' });
    const row = attachRatioValue(cost, 'pointfive-sandbox', '1.0');
    expect(row.x_RatioWorkloadId).toBe('');
    expect(row.x_RatioValueRatio).toBe(0);
  });
});

describe('normalizeRows', () => {
  it('normalizes seed rows to canonical v1.4 with an upgrade audit', () => {
    const { rows, backfilledColumns } = normalizeRows(rawRowsForVersion('1.0'), 'pointfive-sandbox', '1.0');
    expect(rows.length).toBeGreaterThan(0);
    expect(backfilledColumns).toContain('ServiceSubcategory');
    expect(rows.every((r) => typeof r.CapacityReservationId !== 'undefined')).toBe(true);
  });
});

describe('composeRatioView (forecast + gates)', () => {
  it('produces value, gates, and a forecast for an ingested row', () => {
    const { rows } = normalizeRows(rawRowsForVersion('1.0'), 'pointfive-sandbox', '1.0');
    const view = composeRatioView(rows[0]);
    expect(view).not.toBeNull();
    expect(view?.valueRatio).toBeGreaterThan(0);
    expect(view?.gatesPassed).toBeGreaterThanOrEqual(0);
    expect(view?.budget?.monthly.projectedEom).toBeGreaterThan(0);
  });
});

describe('MockCostSourceClient', () => {
  it('lists sources and serves canonical rows offline', async () => {
    const client = createCostSourceClient('mock');
    const sources = await client.listSources();
    expect(sources.length).toBeGreaterThanOrEqual(2);

    const result = await client.fetchCostRows('pointfive-sandbox', {
      start: '2026-06-01T00:00:00.000Z',
      end: '2026-07-01T00:00:00.000Z',
    });
    expect(result.canonicalVersion).toBe(CANONICAL_FOCUS_VERSION);
    expect(result.sourceVersion).toBe('1.0');
    expect(result.rows.length).toBeGreaterThan(0);
  });

  it('exposes findings for a findings-capable source', async () => {
    const client = createCostSourceClient('mock');
    const findings = await client.fetchFindings('pointfive-sandbox');
    expect(findings.length).toBeGreaterThan(0);
    expect(findings.every((f) => f.type === 'opportunity' || f.type === 'anomaly')).toBe(true);
  });

  it('refuses cost rows from an unconfigured (dark) source', async () => {
    const client = createCostSourceClient('mock');
    await expect(
      client.fetchCostRows('pointfive-live', {
        start: '2026-06-01T00:00:00.000Z',
        end: '2026-07-01T00:00:00.000Z',
      }),
    ).rejects.toThrow(/not configured/);
  });
});

