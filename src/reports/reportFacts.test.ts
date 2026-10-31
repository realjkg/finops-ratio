// Report facts (1.0): the pure assembler over the reader's aggregates.
// SYNTHETIC inputs only (no provider data). Amounts are the exact decimal
// strings Postgres returns; the assembler never does arithmetic on money, never
// sums across currencies or sources, and never turns missing data into zero.
import { describe, expect, it } from 'vitest';
import {
  assembleReportFacts,
  NA_REASONS,
  SCOPE_LABEL,
  type FactsAggregateGroup,
  type FactsArtifactRow,
  type FactsBatchRow,
  type ReportFactsInput,
} from './reportFacts';

const SRC_A = '0a0a0a0a-0000-4000-8000-00000000000a';
const SRC_B = '0b0b0b0b-0000-4000-8000-00000000000b';
const BATCH_A = 'aaaaaaaa-0000-4000-8000-000000000001';
const BATCH_B = 'bbbbbbbb-0000-4000-8000-000000000002';
const SHA = 'f'.repeat(64);

const group = (o: Partial<FactsAggregateGroup>): FactsAggregateGroup => ({
  sourceId: SRC_A, currency: 'USD', chargeCategory: null, isTotal: true, rowCount: '1', billedCost: '1.00', effectiveCost: '1.00', effectiveMissingRows: '0', ...o,
});
const batch = (o: Partial<FactsBatchRow> = {}): FactsBatchRow => ({
  sourceId: SRC_A, batchId: BATCH_A, rowCount: '3', publishedAt: '2026-10-02T08:00:00.000000Z',
  chargePeriodStart: '2026-09-01T00:00:00.000000Z', chargePeriodEnd: '2026-10-01T00:00:00.000000Z', providers: ['AWS'], focusVersions: ['1.0'], ...o,
});
const artifact = (o: Partial<FactsArtifactRow> = {}): FactsArtifactRow => ({ sourceId: SRC_A, batchId: BATCH_A, artifactSha256: SHA, rowCount: '3', ...o });

/** One source, one currency: Usage + Credit rows (SYNTHETIC). */
function oneSource(o: Partial<ReportFactsInput> = {}): ReportFactsInput {
  return {
    period: '2026-09-01',
    asOf: '2026-10-15T00:00:00.000Z',
    groups: [
      group({ rowCount: '3', billedCost: '18.00663861840', effectiveCost: '13.00000000000' }),
      group({ isTotal: false, chargeCategory: 'Credit', rowCount: '1', billedCost: '-2.61370000000', effectiveCost: '-3.00000000000' }),
      group({ isTotal: false, chargeCategory: 'Usage', rowCount: '2', billedCost: '20.62033861840', effectiveCost: '16.00000000000' }),
    ],
    batches: [batch()],
    artifacts: [artifact()],
    engagement: {
      currency: 'USD',
      declaredSources: [{ id: 'aws-focus', provider: 'AWS', costBasis: 'focus-native', creditsCoverage: 'included', completeness: 'explicit-subset', controlTotalSource: 'export-query' }],
    },
    ...o,
  };
}

describe('assembleReportFacts: one published source', () => {
  const f = assembleReportFacts(oneSource());

  it('identifies the period, the scope label and the as-of time', () => {
    expect(f.schema).toBe('ratio.report-facts/1');
    expect(f.scope).toBe(SCOPE_LABEL);
    expect(f.period).toMatchObject({ month: '2026-09', start: '2026-09-01', endExclusive: '2026-10-01', state: 'closed' });
    expect(f.period.completeness).toEqual({ status: 'available', value: 'charge periods cover the whole month' });
    expect(f.freshness).toEqual({
      asOf: '2026-10-15T00:00:00.000Z',
      latestPublishedAt: { status: 'available', value: '2026-10-02T08:00:00.000000Z' },
      dataThrough: { status: 'available', value: '2026-10-01T00:00:00.000000Z' },
    });
  });

  it('carries billed and effective exactly, credits separately (included once in both totals)', () => {
    const usd = f.sources[0].currencies[0];
    expect(usd).toMatchObject({ currency: 'USD', rowCount: '3', billedCost: '18.00663861840', effectiveCost: { status: 'available', value: '13.00000000000' } });
    expect(usd.credits).toEqual({ status: 'available', value: { rowCount: '1', billedCost: '-2.61370000000', effectiveCost: { status: 'available', value: '-3.00000000000' } } });
    expect(usd.adjustments).toEqual({ status: 'not_available', reason: NA_REASONS.noAdjustmentRows });
    expect(usd.byChargeCategory.map((c) => c.chargeCategory)).toEqual(['Credit', 'Usage']);
    expect(f.creditsPolicy.treatment).toMatch(/included once in both/);
    expect(f.creditsPolicy.declared).toEqual([{ sourceId: 'aws-focus', creditsCoverage: 'included' }]);
  });

  it('combines per currency only because exactly one source published', () => {
    expect(f.totals).toEqual({ status: 'available', value: [expect.objectContaining({ currency: 'USD', billedCost: '18.00663861840' })] });
  });

  it('identifies the import (batch, artifacts) and states every trust field the reader cannot see as N/A with a reason', () => {
    const s = f.sources[0];
    expect(s).toMatchObject({ sourceId: SRC_A, providers: ['AWS'], focusVersions: ['1.0'] });
    expect(s.sourceKey).toEqual({ status: 'not_available', reason: NA_REASONS.sourceKey });
    expect(s.batches).toEqual([
      {
        batchId: BATCH_A,
        status: 'published',
        publishedAt: '2026-10-02T08:00:00.000000Z',
        rowCount: '3',
        artifacts: [{ sha256: SHA, rowCount: '3' }],
        reconciliation: { status: 'not_available', reason: NA_REASONS.batchStatus },
        controlTotals: { status: 'not_available', reason: NA_REASONS.batchStatus },
        importMetadataSha256: { status: 'not_available', reason: NA_REASONS.sourceKey },
      },
    ]);
    expect(f.coverageGaps.map((g) => g.code)).toEqual(['BATCH_STATUS_NOT_VISIBLE', 'DECLARED_SOURCES_NOT_LINKED']);
  });

  it('shows the cost basis (both measures) and the currency rule', () => {
    expect(f.costBasis.shown).toEqual(['billed', 'effective']);
    expect(f.costBasis.declared).toEqual([{ sourceId: 'aws-focus', costBasis: 'focus-native' }]);
    expect(f.currency).toEqual({ reporting: { status: 'available', value: 'USD' }, inData: ['USD'], rule: expect.stringMatching(/never summed or converted/) });
  });

  it('is deterministic: the same input gives byte-identical output', () => {
    expect(JSON.stringify(assembleReportFacts(oneSource()))).toBe(JSON.stringify(f));
    const shuffled = oneSource();
    shuffled.groups.reverse();
    expect(JSON.stringify(assembleReportFacts(shuffled))).toBe(JSON.stringify(f));
  });
});

describe('assembleReportFacts: missing and incomplete data stay explicit (never zero)', () => {
  it('no published batch: every amount is N/A with the reason, and no "0" amount appears anywhere', () => {
    const f = assembleReportFacts(oneSource({ groups: [], batches: [], artifacts: [] }));
    expect(f.sources).toEqual([]);
    expect(f.totals).toEqual({ status: 'not_available', reason: NA_REASONS.noPublished });
    expect(f.freshness.latestPublishedAt).toEqual({ status: 'not_available', reason: NA_REASONS.noPublished });
    expect(f.freshness.dataThrough).toEqual({ status: 'not_available', reason: NA_REASONS.noPublished });
    expect(f.period.completeness).toEqual({ status: 'not_available', reason: NA_REASONS.noPublished });
    expect(f.coverageGaps.map((g) => g.code)).toContain('NO_PUBLISHED_BATCH');
    expect(JSON.stringify(f)).not.toMatch(/"(billedCost|effectiveCost|value|rowCount)":"0(\.0+)?"/);
  });

  it('rows without EffectiveCost: effective is labeled partial (never filled with billed), all-missing is N/A', () => {
    const f = assembleReportFacts(
      oneSource({
        groups: [
          group({ rowCount: '3', billedCost: '3.00', effectiveCost: '2.00', effectiveMissingRows: '1' }),
          group({ isTotal: false, chargeCategory: 'Usage', rowCount: '2', billedCost: '2.00', effectiveCost: '2.00' }),
          group({ isTotal: false, chargeCategory: 'Tax', rowCount: '1', billedCost: '1.00', effectiveCost: null, effectiveMissingRows: '1' }),
        ],
      }),
    );
    const usd = f.sources[0].currencies[0];
    expect(usd.effectiveCost).toEqual({ status: 'partial', value: '2.00', rowsWithoutEffectiveCost: '1', reason: NA_REASONS.effectivePartial });
    expect(usd.byChargeCategory.find((c) => c.chargeCategory === 'Tax')?.effectiveCost).toEqual({ status: 'not_available', reason: NA_REASONS.effectiveMissing });
    expect(usd.credits).toEqual({ status: 'not_available', reason: NA_REASONS.noCreditRows });
    expect(f.coverageGaps.map((g) => g.code)).toContain('EFFECTIVE_PARTIAL');
  });

  it('a partial month and an open period are flagged', () => {
    const f = assembleReportFacts(oneSource({ asOf: '2026-09-20T00:00:00.000Z', batches: [batch({ chargePeriodEnd: '2026-09-19T00:00:00.000000Z' })] }));
    expect(f.period.state).toBe('open');
    expect(f.period.completeness).toEqual({ status: 'available', value: 'partial: charge periods do not cover the whole month' });
    expect(f.coverageGaps.map((g) => g.code)).toEqual(expect.arrayContaining(['PERIOD_OPEN', 'PERIOD_PARTIAL']));
  });

  it('multiple currencies are never summed together; a currency other than the reporting one is a gap', () => {
    const f = assembleReportFacts(
      oneSource({
        groups: [
          group({ currency: 'USD', billedCost: '10.00', effectiveCost: '9.00' }),
          group({ currency: 'EUR', billedCost: '7.00', effectiveCost: '7.00' }),
          group({ currency: 'EUR', isTotal: false, chargeCategory: 'Usage', billedCost: '7.00', effectiveCost: '7.00' }),
          group({ currency: 'USD', isTotal: false, chargeCategory: 'Usage', billedCost: '10.00', effectiveCost: '9.00' }),
        ],
      }),
    );
    expect(f.sources[0].currencies.map((c) => [c.currency, c.billedCost])).toEqual([['EUR', '7.00'], ['USD', '10.00']]);
    expect(f.currency.inData).toEqual(['EUR', 'USD']);
    expect(f.coverageGaps.find((g) => g.code === 'CURRENCY_NOT_REPORTING')?.detail).toContain('EUR');
    expect(JSON.stringify(f)).not.toContain('17');
  });

  it('two published sources are never added together (overlap policy needs source keys)', () => {
    const f = assembleReportFacts(
      oneSource({
        groups: [group({}), group({ isTotal: false, chargeCategory: 'Usage' }), group({ sourceId: SRC_B, billedCost: '2.00' }), group({ sourceId: SRC_B, isTotal: false, chargeCategory: 'Usage', billedCost: '2.00' })],
        batches: [batch(), batch({ sourceId: SRC_B, batchId: BATCH_B })],
        artifacts: [artifact(), artifact({ sourceId: SRC_B, batchId: BATCH_B })],
      }),
    );
    expect(f.sources.map((s) => s.sourceId)).toEqual([SRC_A, SRC_B]);
    expect(f.totals).toEqual({ status: 'not_available', reason: NA_REASONS.multiSource });
    expect(f.coverageGaps.map((g) => g.code)).toContain('MULTI_SOURCE_NOT_COMBINED');
    expect(JSON.stringify(f)).not.toContain('"3.00"');
  });

  it('without an engagement config, the reporting currency and declared policies are N/A', () => {
    const f = assembleReportFacts(oneSource({ engagement: null }));
    expect(f.currency.reporting).toEqual({ status: 'not_available', reason: NA_REASONS.noEngagement });
    expect(f.costBasis.declared).toEqual({ status: 'not_available', reason: NA_REASONS.noEngagement });
    expect(f.creditsPolicy.declared).toEqual({ status: 'not_available', reason: NA_REASONS.noEngagement });
    expect(f.coverageGaps.map((g) => g.code)).toContain('NO_ENGAGEMENT_CONFIG');
  });

  it('refuses a malformed input instead of guessing (period, asOf, amount)', () => {
    expect(() => assembleReportFacts(oneSource({ period: '2026-09-02' }))).toThrow(/period/);
    expect(() => assembleReportFacts(oneSource({ asOf: 'yesterday' }))).toThrow(/asOf/);
    expect(() => assembleReportFacts(oneSource({ groups: [group({ billedCost: '1e3' })] }))).toThrow(/decimal/);
  });
});
