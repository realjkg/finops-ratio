// Workload attribution from cost-row tags: a documented tag key resolves a
// row to a Ratio workload when ResourceId carries no workload identity.

import { describe, it, expect } from 'vitest';
import { FocusFileAdapter } from './FocusFileAdapter';
import { resourceIdFor } from './seed';
import { WORKLOAD_TAG_KEY, workloadIdFromTags } from './normalize';
import { WORKLOADS } from '@/data/workloads';
import type { FocusCoreV10, RawSourceRow } from './focusRows';

const WINDOW = { start: '2026-06-01T00:00:00.000Z', end: '2026-07-01T00:00:00.000Z' };
const KNOWN = WORKLOADS[0].id;

function row(resourceId: string, tags?: unknown, billed = 12.5): RawSourceRow {
  const core: FocusCoreV10 = {
    BilledCost: billed, EffectiveCost: billed, BillingCurrency: 'USD',
    BillingPeriodStart: WINDOW.start, BillingPeriodEnd: WINDOW.end,
    ChargePeriodStart: WINDOW.start, ChargePeriodEnd: WINDOW.end,
    BillingAccountId: 'acct', SubAccountId: 'sub', ServiceName: 'Svc',
    ServiceCategory: 'Compute', ProviderName: 'p', ChargeCategory: 'Usage',
    ChargeDescription: 'd', ResourceId: resourceId,
    PricingQuantity: 1, PricingUnit: 'u', UsageQuantity: 1, UsageUnit: 'u',
  };
  return tags === undefined ? core : ({ ...core, Tags: tags } as RawSourceRow);
}

function resolve(r: RawSourceRow) {
  return FocusFileAdapter.ingest([r], '1.4', 'focus-file-sandbox', WINDOW).rows[0];
}

describe('workload tag attribution', () => {
  it('documents one tag key', () => {
    expect(WORKLOAD_TAG_KEY).toBe('ratio:workload');
  });

  it('resolves a tagged row (JSON string Tags) to the workload', () => {
    const out = resolve(row('i-0abc', JSON.stringify({ [WORKLOAD_TAG_KEY]: KNOWN })));
    expect(out.x_RatioWorkloadId).toBe(KNOWN);
    expect(out.x_RatioTeam).not.toBe('');
  });

  it('resolves a tagged row (object Tags) to the workload', () => {
    expect(resolve(row('i-0abc', { [WORKLOAD_TAG_KEY]: KNOWN })).x_RatioWorkloadId).toBe(KNOWN);
  });

  it('keeps simulated rows unresolved even when tagged', () => {
    const out = resolve(row('synthetic:aws-sandbox/line-1', { [WORKLOAD_TAG_KEY]: KNOWN }));
    expect(out.x_RatioWorkloadId).toBe('');
    expect(out.x_RatioTeam).toBe('');
  });

  it('does not invent workloads that are not loaded', () => {
    const out = resolve(row('i-0abc', { [WORKLOAD_TAG_KEY]: 'wl-does-not-exist' }));
    expect(out.x_RatioWorkloadId).toBe('');
    expect(out.x_RatioValueRatio).toBe(0);
  });

  it('never throws on malformed tag values', () => {
    const bad: unknown[] = ['{not json', '', null, 42, [], ['x'], '[]', '"str"', { [WORKLOAD_TAG_KEY]: 7 },
      { [WORKLOAD_TAG_KEY]: null }, { [WORKLOAD_TAG_KEY]: { a: 1 } }, { [WORKLOAD_TAG_KEY]: '' }, { other: KNOWN }];
    for (const t of bad) {
      expect(() => resolve(row('i-0abc', t))).not.toThrow();
      expect(resolve(row('i-0abc', t)).x_RatioWorkloadId).toBe('');
    }
  });

  it('ignores prototype keys and different-case tag keys', () => {
    expect(workloadIdFromTags('{"__proto__":{"ratio:workload":"' + KNOWN + '"}}')).toBeNull();
    expect(workloadIdFromTags({ 'Ratio:Workload': KNOWN })).toBeNull();
    expect(workloadIdFromTags({ [WORKLOAD_TAG_KEY]: 'constructor' })).toBeNull();
  });

  it('prefers the ResourceId identity over a conflicting tag', () => {
    const other = WORKLOADS[1].id;
    expect(resolve(row(resourceIdFor(KNOWN), { [WORKLOAD_TAG_KEY]: other })).x_RatioWorkloadId).toBe(KNOWN);
  });

  it('leaves money untouched', () => {
    const tagged = resolve(row('i-0abc', { [WORKLOAD_TAG_KEY]: KNOWN }, 0.1));
    const plain = resolve(row('i-0abc', undefined, 0.1));
    expect(tagged.BilledCost).toBe(plain.BilledCost);
    expect(tagged.BillingCurrency).toBe(plain.BillingCurrency);
  });
});
