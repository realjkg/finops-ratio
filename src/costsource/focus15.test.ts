// Tests for the FOCUS 1.5 working-draft support in the ingest seam (ratifies
// 3 Dec 2026): draft-version metadata, the five AI-cost column families as
// OPTIONAL backfilled columns, registry-derived model identity, the currency
// classification, and the FinIO handshake's ratified-only negotiation gate.
//
// Draft columns ride the same additive-delta pattern as 1.1→1.4, so the tests
// mirror costsource.test.ts's shim suite at the 1.5 boundary.
import { describe, it, expect } from 'vitest';
import {
  CANONICAL_FOCUS_VERSION,
  FOCUS_VERSIONS,
  RATIFIED_FOCUS_VERSIONS,
  DRAFT_FOCUS_VERSIONS,
  FOCUS_15_RATIFICATION_DATE,
  columnsAddedAfter,
  draftColumnsAfter,
  isDraftVersion,
} from './focusVersions';
import type { RawSourceRow, FocusCoreV10 } from './focusRows';
import { upgradeToCanonicalCost, classifyCurrencyFormat } from './focusRows';
import { normalizeRows } from './normalize';
import { rawRowsForVersion, resourceIdFor } from './seed';
import { SUPPORTED_FOCUS_VERSIONS } from '@/finio/exchange';

// A minimal v1.0 row — only the mandatory core columns a v1.0 source emits
// (same fixture as costsource.test.ts).
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

// A v1.5 source row that supplies every draft family (model identity, token
// labels, requester attribution, SKU price join key).
function v15Row(workloadId: string): RawSourceRow {
  return {
    ...v10Row(workloadId),
    ModelDeveloper: 'Anthropic',
    ModelFamily: 'Claude',
    ModelId: 'claude-sonnet-4-20250514',
    ModelVersion: '20250514',
    TokenCacheAction: 'Read',
    TokenDirection: 'Input',
    PrincipalId: 'user-007',
    CredentialId: 'cred-42',
    RequesterDetails: '{"region":"us-east-1"}',
    SkuPriceId: 'price-001',
  };
}

describe('draft-version metadata', () => {
  it('carries 1.5 as a draft version alongside the ratified range', () => {
    expect(FOCUS_VERSIONS).toEqual(['1.0', '1.1', '1.2', '1.3', '1.4', '1.5']);
    expect(RATIFIED_FOCUS_VERSIONS).toEqual(['1.0', '1.1', '1.2', '1.3', '1.4']);
    expect(DRAFT_FOCUS_VERSIONS).toEqual(['1.5']);
    expect(FOCUS_15_RATIFICATION_DATE).toBe('2026-12-03');
  });

  it('classifies 1.5 as draft and every ratified version as non-draft', () => {
    expect(isDraftVersion('1.5')).toBe(true);
    for (const v of RATIFIED_FOCUS_VERSIONS) {
      expect(isDraftVersion(v)).toBe(false);
    }
  });
});

describe('draftColumnsAfter (additive draft deltas)', () => {
  it('reports all draft columns for a v1.0 source', () => {
    const cols = draftColumnsAfter('1.0');
    for (const c of [
      'ModelDeveloper',
      'ModelFamily',
      'ModelId',
      'ModelVersion',
      'TokenCacheAction',
      'TokenDirection',
      'PrincipalId',
      'CredentialId',
      'RequesterDetails',
      'SkuPriceId',
    ]) {
      expect(cols).toContain(c);
    }
  });

  it('reports the draft columns for a v1.4 source (ratified backfill is empty there)', () => {
    expect(columnsAddedAfter('1.4')).toEqual([]);
    expect(draftColumnsAfter('1.4').length).toBe(10);
  });

  it('reports nothing for a source already at 1.5', () => {
    expect(draftColumnsAfter('1.5')).toEqual([]);
    // The draft boundary must not leak into the ratified backfill audit.
    expect(columnsAddedAfter('1.5')).toEqual([]);
  });
});

describe('upgradeToCanonicalCost with 1.5 draft columns', () => {
  it('preserves draft families a 1.5 source already provides', () => {
    const canonical = upgradeToCanonicalCost(v15Row('wl-support'));
    expect(canonical.ModelDeveloper).toBe('Anthropic');
    expect(canonical.ModelFamily).toBe('Claude');
    expect(canonical.ModelId).toBe('claude-sonnet-4-20250514');
    expect(canonical.ModelVersion).toBe('20250514');
    expect(canonical.TokenCacheAction).toBe('Read');
    expect(canonical.TokenDirection).toBe('Input');
    expect(canonical.PrincipalId).toBe('user-007');
    expect(canonical.CredentialId).toBe('cred-42');
    expect(canonical.RequesterDetails).toBe('{"region":"us-east-1"}');
    expect(canonical.SkuPriceId).toBe('price-001');
    // Still the v1.4 canonical target — 1.5 adds columns, not a new canonical.
    expect(CANONICAL_FOCUS_VERSION).toBe('1.4');
  });

  it('backfills omitted draft properties as null on a v1.0 row (omitted, never guessed)', () => {
    const canonical = upgradeToCanonicalCost(v10Row('wl-support'));
    expect(canonical.ModelDeveloper).toBeNull();
    expect(canonical.ModelFamily).toBeNull();
    expect(canonical.ModelId).toBeNull();
    expect(canonical.ModelVersion).toBeNull();
    expect(canonical.TokenCacheAction).toBeNull();
    expect(canonical.TokenDirection).toBeNull();
    expect(canonical.PrincipalId).toBeNull();
    expect(canonical.CredentialId).toBeNull();
    expect(canonical.RequesterDetails).toBeNull();
    expect(canonical.SkuPriceId).toBeNull();
  });
});

describe('registry-derived model identity (normalizeRows)', () => {
  it('derives identity from ServiceName when the exporter omits it', () => {
    const raw: RawSourceRow = { ...v15Row('wl-support'), ModelDeveloper: undefined, ModelFamily: undefined, ModelId: undefined, ModelVersion: undefined };
    const { rows } = normalizeRows([raw], 'focus-file-sandbox', '1.5');
    expect(rows[0].ModelDeveloper).toBe('Anthropic');
    expect(rows[0].ModelFamily).toBe('Claude');
    expect(rows[0].ModelId).toBe('claude-sonnet-4-20250514');
    expect(rows[0].ModelVersion).toBe('20250514');
  });

  it('keeps source-supplied identity and fills only the gaps', () => {
    const raw: RawSourceRow = { ...v15Row('wl-support'), ModelId: 'custom-billing-id', ModelDeveloper: undefined };
    const { rows } = normalizeRows([raw], 'focus-file-sandbox', '1.5');
    expect(rows[0].ModelId).toBe('custom-billing-id');
    expect(rows[0].ModelDeveloper).toBe('Anthropic');
  });

  it('leaves identity null for a ServiceName the registry cannot say', () => {
    const raw: RawSourceRow = {
      ...v15Row('wl-support'),
      ServiceName: 'Totally Unknown Service',
      ModelDeveloper: undefined,
      ModelFamily: undefined,
      ModelId: undefined,
      ModelVersion: undefined,
    };
    const { rows } = normalizeRows([raw], 'focus-file-sandbox', '1.5');
    expect(rows[0].ModelDeveloper).toBeNull();
    expect(rows[0].ModelFamily).toBeNull();
    expect(rows[0].ModelId).toBeNull();
    expect(rows[0].ModelVersion).toBeNull();
  });

  it('derives registry identity on pre-1.5 rows too — identity rides ServiceName, not the draft boundary', () => {
    // The 1.5 columns exist on canonical rows at every source version (additive
    // backfill); what the registry can honestly derive from ServiceName is the
    // same enrichment a draft exporter would get. A v1.0 source just never
    // supplies the values itself.
    const { rows } = normalizeRows(rawRowsForVersion('1.0'), 'focus-file-sandbox', '1.0');
    expect(rows.length).toBeGreaterThan(0);
    expect(rows.every((r) => r.ModelId === null || typeof r.ModelId === 'string')).toBe(true);
    expect(rows.some((r) => r.ModelDeveloper === 'Anthropic')).toBe(true);
  });
});

describe('seed rows at 1.5', () => {
  it('emits every draft column (registry identity, null token labels) and reports no draft backfill', () => {
    const rows = rawRowsForVersion('1.5');
    expect(rows.length).toBeGreaterThan(0);
    for (const r of rows) {
      expect(typeof r.TokenCacheAction !== 'undefined').toBe(true);
      expect(typeof r.SkuPriceId !== 'undefined').toBe(true);
    }
    // At least the Claude-backed workloads resolve a developer.
    expect(rows.some((r) => r.ModelDeveloper === 'Anthropic')).toBe(true);
    // This exporter never emits token-level draft telemetry (FR 2099: omit).
    expect(rows.every((r) => r.TokenCacheAction === null && r.TokenDirection === null)).toBe(true);

    const { backfilledColumns, draftColumnsBackfilled } = normalizeRows(rows, 'focus-file-sandbox', '1.5');
    expect(backfilledColumns).toEqual([]);
    expect(draftColumnsBackfilled).toEqual([]);
  });
});

describe('classifyCurrencyFormat (1.5 currency rule)', () => {
  it('classifies ISO 4217 codes as national currencies', () => {
    expect(classifyCurrencyFormat('USD')).toBe('iso4217');
    expect(classifyCurrencyFormat('EUR')).toBe('iso4217');
  });

  it('classifies non-ISO-4217 values as provider-issued units', () => {
    expect(classifyCurrencyFormat('CREDITS')).toBe('provider-issued');
    expect(classifyCurrencyFormat('usd')).toBe('provider-issued'); // lowercase is not an ISO code
    expect(classifyCurrencyFormat('')).toBe('provider-issued');
  });
});

describe('FinIO negotiation stays ratified-only while 1.5 is a draft', () => {
  it('does not offer the unratified draft version to A2A peers', () => {
    expect(SUPPORTED_FOCUS_VERSIONS).toEqual(RATIFIED_FOCUS_VERSIONS);
    expect(SUPPORTED_FOCUS_VERSIONS).not.toContain('1.5');
  });
});
