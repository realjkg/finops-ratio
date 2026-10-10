// Tests for FocusFileAdapter — the second source adapter (PR F).
//
// Coverage:
//   1. ingest() normalizes v1.0–v1.5 rows (1.5 a working draft) to canonical v1.4 (backfill correctness)
//   2. ingest() with a v1.4 source is a pass-through (no backfill)
//   3. Value attachment is source-independent — same workload → same value ratio
//   4. healthCheck() is always reachable (no credentials)
//   5. Source-agnosticism proof: FocusFileAdapter and MockCostSourceClient
//      produce identical engine outputs for the same data (only adapter differs)

import { describe, it, expect } from 'vitest';
import { FocusFileAdapter } from './FocusFileAdapter';
import { rawRowsForVersion, resourceIdFor } from './seed';
import type { FocusCoreV10, RawSourceRow } from './focusRows';
import { FOCUS_VERSIONS, columnsAddedAfter } from './focusVersions';
import type { FocusVersion } from './focusVersions';
import { createCostSourceClient } from './index';

const WINDOW = {
  start: '2026-06-01T00:00:00.000Z',
  end: '2026-07-01T00:00:00.000Z',
};

const SOURCE_ID = 'focus-file-sandbox';

/** Build a minimal FOCUS v1.0 row (private-cloud shape, no post-1.0 columns). */
function minimalV10Row(workloadId: string): RawSourceRow {
  const core: FocusCoreV10 = {
    BilledCost: 1500,
    EffectiveCost: 1400,
    BillingCurrency: 'USD',
    BillingPeriodStart: '2026-06-01T00:00:00.000Z',
    BillingPeriodEnd: '2026-07-01T00:00:00.000Z',
    ChargePeriodStart: '2026-06-01T00:00:00.000Z',
    ChargePeriodEnd: '2026-07-01T00:00:00.000Z',
    BillingAccountId: 'onprem-tenant-001',
    SubAccountId: 'private-cloud-cx',
    ServiceName: 'On-Prem LLM Gateway',
    ServiceCategory: 'AI and Machine Learning',
    ProviderName: 'private-cloud',
    ChargeCategory: 'Usage',
    ChargeDescription: `Private cloud workload ${workloadId}`,
    ResourceId: resourceIdFor(workloadId),
    PricingQuantity: 5_000_000,
    PricingUnit: '1M Tokens',
    UsageQuantity: 5_000_000,
    UsageUnit: 'Tokens',
  };
  return core;
}

// ---------------------------------------------------------------------------
// Version normalization
// ---------------------------------------------------------------------------

describe('FocusFileAdapter.ingest — version normalization', () => {
  it('normalizes a minimal v1.0 row to canonical v1.4, backfilling all post-1.0 columns', () => {
    const result = FocusFileAdapter.ingest([minimalV10Row('wl-support')], '1.0', SOURCE_ID, WINDOW);

    expect(result.sourceVersion).toBe('1.0');
    expect(result.canonicalVersion).toBe('1.4');
    expect(result.backfilledColumns).toEqual(columnsAddedAfter('1.0'));
    expect(result.backfilledColumns.length).toBeGreaterThan(0);

    const [row] = result.rows;
    // v1.1 backfilled: derived from source columns present
    expect(row.ListCost).toBe(1500);           // defaults to BilledCost
    expect(row.ContractedCost).toBe(1400);     // defaults to EffectiveCost
    expect(row.ConsumedQuantity).toBe(5_000_000);
    expect(row.CommitmentDiscountStatus).toBeNull();
    // v1.2 backfilled
    expect(row.ServiceSubcategory).toBe('Generative AI');
    expect(row.InvoiceIssuerName).toBe('private-cloud');
    // v1.3 backfilled
    expect(row.SkuMeter).toBeNull();
    expect(row.PricingCurrency).toBe('USD');   // inherits BillingCurrency
    // v1.4 backfilled
    expect(row.CapacityReservationId).toBeNull();
    expect(row.CapacityReservationStatus).toBeNull();
  });

  // Parametric: each sub-canonical version backfills exactly the columns
  // introduced by later versions — additive only, nothing removed.
  it.each(FOCUS_VERSIONS.slice(0, -1) as FocusVersion[])(
    'backfills additive columns for v%s source; every row reaches canonical shape',
    (version) => {
      const rows = rawRowsForVersion(version);
      const result = FocusFileAdapter.ingest(rows, version, SOURCE_ID, WINDOW);
      expect(result.backfilledColumns).toEqual(columnsAddedAfter(version));
      for (const row of result.rows) {
        // Every post-v1.0 column is present (possibly null, never missing).
        expect(typeof row.CapacityReservationId !== 'undefined').toBe(true);
        expect(typeof row.ListCost).toBe('number');
        expect(typeof row.ServiceSubcategory).toBe('string');
        expect(typeof row.PricingCurrency).toBe('string');
      }
    },
  );

  it('is a pass-through for a v1.4 source — no backfill needed', () => {
    const rows = rawRowsForVersion('1.4');
    const result = FocusFileAdapter.ingest(rows, '1.4', SOURCE_ID, WINDOW);
    expect(result.backfilledColumns).toEqual([]);
    expect(result.sourceVersion).toBe('1.4');
    expect(result.canonicalVersion).toBe('1.4');
    // Source-supplied columns are preserved unchanged.
    for (let i = 0; i < rows.length; i++) {
      expect(result.rows[i].BilledCost).toBe(rows[i].BilledCost);
      expect(result.rows[i].ServiceSubcategory).toBe(rows[i].ServiceSubcategory);
    }
  });
});

// ---------------------------------------------------------------------------
// Value attachment (R4: cost always paired with value context)
// ---------------------------------------------------------------------------

describe('FocusFileAdapter.ingest — value attachment (R4)', () => {
  it('attaches value ratio from the Ratio engine for a resolvable workload', () => {
    const result = FocusFileAdapter.ingest([minimalV10Row('wl-support')], '1.0', SOURCE_ID, WINDOW);
    const [row] = result.rows;
    expect(row.x_RatioWorkloadId).toBe('wl-support');
    expect(row.x_RatioValueRatio).toBeGreaterThan(0);
    expect(row.x_RatioSourceId).toBe(SOURCE_ID);
    expect(row.x_RatioSourceVersion).toBe('1.0');
    expect(row.x_RatioGovernanceGates).toBeGreaterThanOrEqual(0);
  });

  it('normalizes unresolvable rows with zero value — cost never hidden (R4)', () => {
    const unknownRow: RawSourceRow = {
      ...minimalV10Row('wl-support'),
      ResourceId: 'arn:unknown:private-cloud-resource',
    };
    const result = FocusFileAdapter.ingest([unknownRow], '1.0', SOURCE_ID, WINDOW);
    const [row] = result.rows;
    // Cost is always surfaced; value is 0 to signal resolution failed, not hidden.
    expect(row.BilledCost).toBe(1500);
    expect(row.x_RatioValueRatio).toBe(0);
    expect(row.x_RatioWorkloadId).toBe('');
  });
});

// ---------------------------------------------------------------------------
// Health check
// ---------------------------------------------------------------------------

describe('FocusFileAdapter.healthCheck', () => {
  it('is always reachable and authed with no credentials', () => {
    const health = FocusFileAdapter.healthCheck(SOURCE_ID);
    expect(health.reachable).toBe(true);
    expect(health.authed).toBe(true);
    expect(health.canonicalVersion).toBe('1.4');
    expect(health.detail).toMatch(/no credentials required/);
    expect(health.sourceVersion).toBe('1.2'); // matches focus-file-sandbox descriptor
  });

  it('handles an unknown sourceId gracefully — still reachable (stateless adapter)', () => {
    const health = FocusFileAdapter.healthCheck('nonexistent-source');
    // The adapter itself is always reachable; unknown ID is a config error, not
    // a network failure.
    expect(health.reachable).toBe(true);
    expect(health.detail).toMatch(/Unknown/);
  });
});

// ---------------------------------------------------------------------------
// Source-agnosticism proof
// ---------------------------------------------------------------------------

describe('Source-agnosticism proof', () => {
  it('FocusFileAdapter and MockCostSourceClient produce identical engine outputs for the same data', async () => {
    // The engine — value ratio, governance gates, demand shape — is unchanged.
    // Two adapters (FocusFileAdapter direct, MockCostSourceClient via seam) given
    // the same v1.2 seed rows must produce identical x_Ratio* extensions.
    const seedRows = rawRowsForVersion('1.2');
    const adapterResult = FocusFileAdapter.ingest(seedRows, '1.2', SOURCE_ID, WINDOW);

    const client = createCostSourceClient('mock');
    const mockResult = await client.fetchCostRows(SOURCE_ID, WINDOW);

    expect(adapterResult.rows.length).toBe(mockResult.rows.length);
    for (let i = 0; i < adapterResult.rows.length; i++) {
      const a = adapterResult.rows[i];
      const m = mockResult.rows[i];
      // Engine output is deterministic and source-independent.
      expect(a.x_RatioValueRatio).toBe(m.x_RatioValueRatio);
      expect(a.x_RatioGovernanceGates).toBe(m.x_RatioGovernanceGates);
      expect(a.x_RatioDemandShape).toBe(m.x_RatioDemandShape);
      expect(a.x_RatioWorkloadId).toBe(m.x_RatioWorkloadId);
    }
  });
});

