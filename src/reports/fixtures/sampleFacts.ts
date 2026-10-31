// Test fixture (SYNTHETIC aggregates shaped like the public FOCUS 1.0 sample's AWS 2024-09
// published facts; values from fixtures/focus-1.0-sample/control-totals.json). Test-only.
import type { FactsAggregateGroup, ReportFactsInput } from '../reportFacts';

export const SRC = '0a0a0a0a-0000-4000-8000-00000000000a';
export const SRC_B = '0b0b0b0b-0000-4000-8000-00000000000b';
export const BATCH = 'aaaaaaaa-0000-4000-8000-000000000001';
export const STAGED = '8'.repeat(64);
export const g = (o: Partial<FactsAggregateGroup>): FactsAggregateGroup => ({
  sourceId: SRC, currency: 'USD', chargeCategory: null, isTotal: true, rowCount: '942', billedCost: '18.00663861840', effectiveCost: '13.00000000000', effectiveMissingRows: '0', ...o,
});
export const ENGAGEMENT = { id: 'example-engagement', displayName: 'Example engagement' };

/** The sample's AWS 2024-09 published facts (values from fixtures/focus-1.0-sample/control-totals.json). */
export function sampleInput(o: Partial<ReportFactsInput> = {}): ReportFactsInput {
  return {
    period: '2024-09-01',
    asOf: '2026-10-31T12:00:00.000Z',
    groups: [
      g({}),
      g({ isTotal: false, chargeCategory: 'Credit', rowCount: '1', billedCost: '-2.61370000000', effectiveCost: '-3.00000000000' }),
      g({ isTotal: false, chargeCategory: 'Usage', rowCount: '941', billedCost: '20.62033861840', effectiveCost: '16.00000000000' }),
    ],
    batches: [{ sourceId: SRC, batchId: BATCH, rowCount: '942', publishedAt: '2026-10-31T03:00:00.000000Z', chargePeriodStart: '2024-09-01T00:00:00.000000Z', chargePeriodEnd: '2024-10-01T00:00:00.000000Z', providers: ['AWS'], focusVersions: ['1.0'] }],
    artifacts: [{ sourceId: SRC, batchId: BATCH, artifactSha256: STAGED, rowCount: '942' }],
    engagement: { currency: 'USD', declaredSources: [{ id: 'aws-focus-sample', provider: 'AWS', costBasis: 'focus-native', creditsCoverage: 'included', completeness: 'explicit-subset', controlTotalSource: 'export-query' }] },
    ...o,
  };
}
