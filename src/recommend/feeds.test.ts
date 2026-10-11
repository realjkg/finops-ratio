import { describe, expect, it } from 'vitest';
import { normalizeAwsComputeOptimizer } from './awsComputeOptimizer';
import { normalizeAzureAdvisor } from './azureAdvisor';
import { normalizeGcpRecommender } from './gcpRecommender';
import { REFUSAL_MESSAGES, MAX_FEED_ITEMS } from './types';
import { toJsonSafe } from './money';

const B = (n: number) => BigInt(n);

// ---- AWS ----
const awsInstance = (over: Record<string, unknown> = {}, opt: Record<string, unknown> = {}) => ({
  instanceArn: 'arn:aws:ec2:us-east-1:123456789012:instance/i-0abc',
  finding: 'OVERPROVISIONED',
  lookBackPeriodInDays: 30,
  currentInstanceType: 'm5.2xlarge',
  recommendationOptions: [{
    instanceType: 'm5.xlarge', rank: 1, performanceRisk: 1, migrationEffort: 'Low',
    savingsOpportunity: { savingsOpportunityPercentage: 50, estimatedMonthlySavings: { currency: 'USD', value: 70.08 } },
    ...opt,
  }],
  ...over,
});

describe('normalizeAwsComputeOptimizer', () => {
  it('maps an overprovisioned instance', () => {
    const r = normalizeAwsComputeOptimizer({ instanceRecommendations: [awsInstance()] });
    expect(r.refused).toBeNull();
    expect(r.rejected).toBe(0);
    expect(r.items).toHaveLength(1);
    expect(r.items[0]).toMatchObject({
      source: 'aws_compute_optimizer', category: 'rightsize', currency: 'USD',
      estimatedSavingsMinor: B(7008), currentSpendMinor: B(14016), confidence: 'high', risk: 'low', effort: 'low',
      period: 'monthly', valueContext: 'none_available',
    });
    expect(r.items[0].evidence).toContain('aws-co:currentSpend=derived-from-savings-pct:50');
  });
  it('picks the lowest-rank option', () => {
    const r = normalizeAwsComputeOptimizer({ instanceRecommendations: [awsInstance({
      recommendationOptions: [
        { rank: 2, savingsOpportunity: { estimatedMonthlySavings: { currency: 'USD', value: 999 } } },
        { rank: 1, savingsOpportunity: { estimatedMonthlySavings: { currency: 'USD', value: 5 } } },
      ],
    })] });
    expect(r.items[0].estimatedSavingsMinor).toBe(B(500));
    expect(r.items[0].currentSpendMinor).toBeNull();
  });
  it('confidence and risk tiers', () => {
    const c = (lb: number, perf: number) => normalizeAwsComputeOptimizer({ instanceRecommendations: [awsInstance({ lookBackPeriodInDays: lb }, { performanceRisk: perf })] }).items[0];
    expect(c(30, 1)).toMatchObject({ confidence: 'high', risk: 'low' });
    expect(c(14, 2)).toMatchObject({ confidence: 'medium', risk: 'medium' });
    expect(c(13, 2)).toMatchObject({ confidence: 'low' });
    expect(c(30, 3)).toMatchObject({ confidence: 'low', risk: 'high' });
  });
  it('maps volume and idle items', () => {
    const r = normalizeAwsComputeOptimizer({
      volumeRecommendations: [{ volumeArn: 'arn:aws:ec2:us-east-1:1:volume/vol-1', finding: 'NotOptimized', lookBackPeriodInDays: 14, currentVolumeType: 'gp2',
        volumeRecommendationOptions: [{ volumeType: 'gp3', savingsOpportunity: { estimatedMonthlySavings: { currency: 'USD', value: 3.2 } } }] }],
      idleRecommendations: [{ resourceArn: 'arn:aws:ec2:us-east-1:1:instance/i-idle', finding: 'Idle', lookBackPeriodInDays: 14, resourceType: 'EC2Instance',
        savingsOpportunity: { savingsOpportunityPercentage: 100, estimatedMonthlySavings: { currency: 'USD', value: 40 } } }],
    });
    expect(r.items.map((i) => [i.category, i.estimatedSavingsMinor])).toEqual([['rightsize', B(320)], ['idle', B(4000)]]);
    expect(r.items[1].currentSpendMinor).toBe(B(4000));
  });
  it('skips optimized, underprovisioned and zero savings without counting them as rejected', () => {
    const r = normalizeAwsComputeOptimizer({ instanceRecommendations: [
      awsInstance({ finding: 'OPTIMIZED' }), awsInstance({ finding: 'UNDER_PROVISIONED' }),
      awsInstance({}, { savingsOpportunity: { estimatedMonthlySavings: { currency: 'USD', value: 0 } } }),
    ] });
    expect(r.skipped).toBe(3);
    expect(r.rejected).toBe(0);
    expect(r.skippedByReason).toEqual({ no_savings_opportunity: 2, zero_savings: 1 });
  });
  const bad: Array<[string, unknown, string]> = [
    ['not an object', 5, 'not_an_object'],
    ['missing arn', awsInstance({ instanceArn: undefined }), 'invalid_id'],
    ['unknown finding', awsInstance({ finding: 'WEIRD' }), 'unknown_finding'],
    ['no options', awsInstance({ recommendationOptions: [] }), 'missing_savings'],
    ['negative savings', awsInstance({}, { savingsOpportunity: { estimatedMonthlySavings: { currency: 'USD', value: -5 } } }), 'negative_savings'],
    ['NaN savings', awsInstance({}, { savingsOpportunity: { estimatedMonthlySavings: { currency: 'USD', value: NaN } } }), 'invalid_amount'],
    ['string savings', awsInstance({}, { savingsOpportunity: { estimatedMonthlySavings: { currency: 'USD', value: '5' } } }), 'invalid_amount'],
    ['bad currency', awsInstance({}, { savingsOpportunity: { estimatedMonthlySavings: { currency: 'usd', value: 5 } } }), 'invalid_currency'],
    ['pct over 100', awsInstance({}, { savingsOpportunity: { savingsOpportunityPercentage: 150, estimatedMonthlySavings: { currency: 'USD', value: 5 } } }), 'implausible_percentage'],
    ['pct zero', awsInstance({}, { savingsOpportunity: { savingsOpportunityPercentage: 0, estimatedMonthlySavings: { currency: 'USD', value: 5 } } }), 'implausible_percentage'],
    ['pct negative', awsInstance({}, { savingsOpportunity: { savingsOpportunityPercentage: -3, estimatedMonthlySavings: { currency: 'USD', value: 5 } } }), 'implausible_percentage'],
    ['savings above derived spend are impossible only via pct, so check tiny pct', awsInstance({}, { savingsOpportunity: { savingsOpportunityPercentage: 0.001, estimatedMonthlySavings: { currency: 'USD', value: 5 } } }), 'implausible_percentage'],
    ['control chars in arn', awsInstance({ instanceArn: 'arn\nx' }), 'invalid_id'],
  ];
  for (const [name, item, code] of bad) {
    it(`rejects ${name}; batch survives; count reported`, () => {
      const r = normalizeAwsComputeOptimizer({ instanceRecommendations: [awsInstance(), item, awsInstance({ instanceArn: 'arn:aws:ec2:us-east-1:1:instance/i-2' })] });
      expect(r.items).toHaveLength(2);
      expect(r.rejected).toBe(1);
      expect(r.rejectedByReason).toEqual({ [code]: 1 });
    });
  }
  it('refuses unrecognized payloads with fixed text', () => {
    for (const p of [null, undefined, 5, 'x', [], {}, { instanceRecommendations: 'nope' }, { other: [] }]) {
      const r = normalizeAwsComputeOptimizer(p);
      expect(r.refused).toBe('UNRECOGNIZED_PAYLOAD');
      expect(r.refusalMessage).toBe(REFUSAL_MESSAGES.UNRECOGNIZED_PAYLOAD);
      expect(r.items).toEqual([]);
    }
  });
  it('caps: exactly the cap is processed, one past is refused with the count', () => {
    const items = new Array(MAX_FEED_ITEMS).fill(null).map(() => awsInstance({ finding: 'OPTIMIZED' }));
    const ok = normalizeAwsComputeOptimizer({ instanceRecommendations: items });
    expect(ok.refused).toBeNull();
    expect(ok.skipped).toBe(MAX_FEED_ITEMS);
    const over = normalizeAwsComputeOptimizer({ instanceRecommendations: [...items, awsInstance()] });
    expect(over.refused).toBe('TOO_MANY_ITEMS');
    expect(over.rejected).toBe(MAX_FEED_ITEMS + 1);
    expect(over.items).toEqual([]);
  });
  it('hostile item (throwing getter) is rejected, not thrown, and not echoed', () => {
    const hostile = { get instanceArn(): string { throw new Error('SECRET-MARKER-123'); } };
    const r = normalizeAwsComputeOptimizer({ instanceRecommendations: [hostile, awsInstance()] });
    expect(r.items).toHaveLength(1);
    expect(r.rejectedByReason).toEqual({ unexpected_error: 1 });
    expect(JSON.stringify(toJsonSafe(r))).not.toContain('SECRET-MARKER-123');
  });
  it('does not put unsafe feed text into evidence', () => {
    const r = normalizeAwsComputeOptimizer({ instanceRecommendations: [awsInstance({ currentInstanceType: 'x y<script>' })] });
    expect(r.items[0].evidence.join('|')).not.toContain('script');
  });
  it('ignores inherited properties', () => {
    const item = Object.create(awsInstance());
    expect(normalizeAwsComputeOptimizer({ instanceRecommendations: [item] }).rejected).toBe(1);
  });
});

// ---- Azure ----
const VM = '/subscriptions/s1/resourceGroups/rg/providers/Microsoft.Compute/virtualMachines/vm1';
const azure = (props: Record<string, unknown> = {}, ext: Record<string, unknown> = {}, top: Record<string, unknown> = {}) => ({
  id: `${VM}/providers/Microsoft.Advisor/recommendations/abc-1`,
  properties: {
    category: 'Cost', impact: 'High', impactedField: 'Microsoft.Compute/virtualMachines',
    shortDescription: { problem: 'Right-size or shutdown underutilized virtual machines', solution: 'Right-size or shutdown' },
    resourceMetadata: { resourceId: VM },
    extendedProperties: { annualSavingsAmount: '1200.00', savingsCurrency: 'USD', targetSku: 'Standard_D2s_v3', MaxCpuP95: '20', ...ext },
    ...props,
  },
  ...top,
});

describe('normalizeAzureAdvisor', () => {
  it('maps annual savings to a monthly figure', () => {
    const r = normalizeAzureAdvisor({ value: [azure()] });
    expect(r.items[0]).toMatchObject({
      source: 'azure_advisor', sourceId: 'abc-1', resourceId: VM, category: 'rightsize', currency: 'USD',
      estimatedSavingsMinor: B(10000), currentSpendMinor: null, confidence: 'medium',
    });
  });
  it('rounds annual/12 half away from zero', () => {
    // 1000.00 / 12 = 83.333.. -> 8333 ; 1000.06/12 = 83.338 -> 8334
    expect(normalizeAzureAdvisor({ value: [azure({}, { annualSavingsAmount: '1000.00' })] }).items[0].estimatedSavingsMinor).toBe(B(8333));
    expect(normalizeAzureAdvisor({ value: [azure({}, { annualSavingsAmount: '1000.06' })] }).items[0].estimatedSavingsMinor).toBe(B(8334));
    expect(normalizeAzureAdvisor({ value: [azure({}, { annualSavingsAmount: 1200 })] }).items[0].estimatedSavingsMinor).toBe(B(10000));
  });
  it('derives the resource from the id when metadata is absent', () => {
    const r = normalizeAzureAdvisor({ value: [azure({ resourceMetadata: undefined })] });
    expect(r.items[0].resourceId).toBe(VM);
  });
  it('classifies categories', () => {
    const cat = (problem: string, ext: Record<string, unknown> = {}) =>
      normalizeAzureAdvisor({ value: [azure({ shortDescription: { problem } }, { targetSku: undefined, ...ext })] }).items[0].category;
    expect(cat('Consider virtual machine reserved instance to save over your on-demand costs')).toBe('commitment');
    expect(cat('Delete unattached disk')).toBe('unattached');
    expect(cat('Shut down unused resource')).toBe('idle');
    expect(cat('Something else')).toBe('other');
    expect(cat('Whatever', { targetSku: 'Standard_B2s' })).toBe('rightsize');
  });
  it('low confidence without utilization metrics', () => {
    expect(normalizeAzureAdvisor({ value: [azure({}, { MaxCpuP95: undefined })] }).items[0].confidence).toBe('low');
  });
  it('skips non-cost, suppressed and unquantified items', () => {
    const r = normalizeAzureAdvisor({ value: [
      azure({ category: 'Security' }), azure({ suppressionIds: ['x'] }), azure({ extendedProperties: {} }), azure({ extendedProperties: undefined }),
      azure({}, { annualSavingsAmount: '0' }),
    ] });
    expect(r.items).toEqual([]);
    expect(r.rejected).toBe(0);
    expect(r.skippedByReason).toEqual({ not_cost_recommendation: 1, suppressed: 1, no_quantified_savings: 2, zero_savings: 1 });
  });
  const bad: Array<[string, unknown, string]> = [
    ['null item', null, 'not_an_object'],
    ['missing id', azure({}, {}, { id: undefined }), 'invalid_id'],
    ['missing properties', { id: 'x' }, 'invalid_shape'],
    ['only ambiguous savingsAmount', azure({}, { annualSavingsAmount: undefined, savingsAmount: '50' }), 'ambiguous_savings_period'],
    ['negative annual', azure({}, { annualSavingsAmount: '-5' }), 'negative_savings'],
    ['garbage amount', azure({}, { annualSavingsAmount: '1e3' }), 'invalid_amount'],
    ['NaN amount', azure({}, { annualSavingsAmount: NaN }), 'invalid_amount'],
    ['bad currency', azure({}, { savingsCurrency: 'dollars' }), 'invalid_currency'],
    ['no resource', azure({ resourceMetadata: undefined }, {}, { id: 'plain-id' }), 'invalid_resource'],
  ];
  for (const [name, item, code] of bad) {
    it(`rejects ${name}; batch survives`, () => {
      const r = normalizeAzureAdvisor({ value: [azure(), item, azure()] });
      expect(r.items).toHaveLength(2);
      expect(r.rejectedByReason).toEqual({ [code]: 1 });
    });
  }
  it('refuses unrecognized payloads and enforces the cap', () => {
    for (const p of [null, [], {}, { value: {} }, 'x']) expect(normalizeAzureAdvisor(p).refused).toBe('UNRECOGNIZED_PAYLOAD');
    const items = new Array(MAX_FEED_ITEMS).fill(azure({ category: 'Security' }));
    expect(normalizeAzureAdvisor({ value: items }).skipped).toBe(MAX_FEED_ITEMS);
    const over = normalizeAzureAdvisor({ value: [...items, azure()] });
    expect(over.refused).toBe('TOO_MANY_ITEMS');
  });
});

// ---- GCP ----
const GNAME = 'projects/p1/locations/us-central1-a/recommenders/google.compute.instance.IdleResourceRecommender/recommendations/r1';
const gcp = (over: Record<string, unknown> = {}, cost: Record<string, unknown> = {}, duration = '2592000s') => ({
  name: GNAME,
  stateInfo: { state: 'ACTIVE' },
  primaryImpact: { category: 'COST', costProjection: { cost: { currencyCode: 'USD', units: '-30', nanos: -500000000, ...cost }, duration } },
  content: { operationGroups: [{ operations: [{ resource: '//compute.googleapis.com/projects/p1/zones/z/instances/i1' }] }] },
  ...over,
});

describe('normalizeGcpRecommender', () => {
  it('maps a 30-day saving', () => {
    const r = normalizeGcpRecommender({ recommendations: [gcp()] });
    expect(r.items[0]).toMatchObject({
      source: 'gcp_recommender', sourceId: GNAME, category: 'idle', currency: 'USD',
      estimatedSavingsMinor: B(3050), currentSpendMinor: null, confidence: 'medium',
      resourceId: '//compute.googleapis.com/projects/p1/zones/z/instances/i1',
    });
  });
  it('scales other durations to 30 days', () => {
    expect(normalizeGcpRecommender({ recommendations: [gcp({}, {}, '1296000s')] }).items[0].estimatedSavingsMinor).toBe(B(6100));
    expect(normalizeGcpRecommender({ recommendations: [gcp({}, {}, '5184000s')] }).items[0].estimatedSavingsMinor).toBe(B(1525));
  });
  it('disk and address recommenders are unattached; unknown recommender is other with low confidence', () => {
    const nm = (id: string) => `projects/p/locations/l/recommenders/${id}/recommendations/x`;
    expect(normalizeGcpRecommender({ recommendations: [gcp({ name: nm('google.compute.disk.IdleResourceRecommender') })] }).items[0].category).toBe('unattached');
    const o = normalizeGcpRecommender({ recommendations: [gcp({ name: nm('google.new.Recommender') })] }).items[0];
    expect(o).toMatchObject({ category: 'other', confidence: 'low' });
  });
  it('commitment recommenders fall back to the recommendation name as the resource', () => {
    const name = 'projects/p/locations/l/recommenders/google.compute.commitment.UsageCommitmentRecommender/recommendations/x';
    const r = normalizeGcpRecommender({ recommendations: [gcp({ name, content: {} })] });
    expect(r.items[0]).toMatchObject({ category: 'commitment', resourceId: name });
  });
  it('handles JPY exponent', () => {
    const r = normalizeGcpRecommender({ recommendations: [gcp({}, { currencyCode: 'JPY', units: '-3000', nanos: 0 })] });
    expect(r.items[0].estimatedSavingsMinor).toBe(B(3000));
  });
  it('skips non-active, dismissed, non-cost, cost increases and zero', () => {
    const r = normalizeGcpRecommender({ recommendations: [
      gcp({ stateInfo: { state: 'CLAIMED' } }), gcp({ stateInfo: { state: 'DISMISSED' } }),
      gcp({ primaryImpact: { category: 'SECURITY' } }),
      gcp({}, { units: '5', nanos: 0 }), gcp({}, { units: '0', nanos: 0 }), gcp({}, { units: '0', nanos: -1 }),
    ] });
    expect(r.items).toEqual([]);
    expect(r.rejected).toBe(0);
    expect(r.skippedByReason).toEqual({ not_active: 1, suppressed: 1, not_cost_recommendation: 1, cost_increase: 1, zero_savings: 2 });
  });
  const bad: Array<[string, unknown, string]> = [
    ['null', null, 'not_an_object'],
    ['bad name', gcp({ name: 'nope' }), 'invalid_id'],
    ['missing state', gcp({ stateInfo: {} }), 'missing_state'],
    ['missing impact', gcp({ primaryImpact: undefined }), 'invalid_shape'],
    ['missing projection', gcp({ primaryImpact: { category: 'COST' } }), 'missing_savings'],
    ['bad currency', gcp({}, { currencyCode: 'usd' }), 'invalid_amount'],
    ['bad units', gcp({}, { units: 'abc' }), 'invalid_amount'],
    ['float units', gcp({}, { units: 1.5 }), 'invalid_amount'],
    ['mixed sign money', gcp({}, { units: '-3', nanos: 5 }), 'invalid_amount'],
    ['nanos out of range', gcp({}, { nanos: -2000000000 }), 'invalid_amount'],
    ['zero duration', gcp({}, {}, '0s'), 'invalid_duration'],
    ['bad duration', gcp({}, {}, '30 days'), 'invalid_duration'],
    ['no resource', gcp({ content: {} }), 'invalid_resource'],
  ];
  for (const [name, item, code] of bad) {
    it(`rejects ${name}; batch survives`, () => {
      const r = normalizeGcpRecommender({ recommendations: [gcp(), item, gcp()] });
      expect(r.items).toHaveLength(2);
      expect(r.rejectedByReason).toEqual({ [code]: 1 });
    });
  }
  it('refuses unrecognized payloads and enforces the cap', () => {
    for (const p of [null, [], {}, { recommendations: 'x' }]) expect(normalizeGcpRecommender(p).refused).toBe('UNRECOGNIZED_PAYLOAD');
    const items = new Array(MAX_FEED_ITEMS).fill(gcp({ stateInfo: { state: 'CLAIMED' } }));
    expect(normalizeGcpRecommender({ recommendations: items }).skipped).toBe(MAX_FEED_ITEMS);
    expect(normalizeGcpRecommender({ recommendations: [...items, gcp()] }).refused).toBe('TOO_MANY_ITEMS');
  });
});
