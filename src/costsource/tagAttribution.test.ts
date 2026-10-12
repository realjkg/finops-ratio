// Workload attribution from cost-row tags (documented key: ratio:workload).
import { describe, it, expect } from 'vitest';
import { FocusFileAdapter } from './FocusFileAdapter';
import { resourceIdFor } from './seed';
import { WORKLOAD_TAG_KEY as KEY, workloadIdFromTags } from './normalize';
import { WORKLOADS } from '@/data/workloads';
import type { RawSourceRow } from './focusRows';

const W = { start: '2026-06-01T00:00:00.000Z', end: '2026-07-01T00:00:00.000Z' };
const KNOWN = WORKLOADS[0].id;

function row(resourceId: string, tags?: unknown): RawSourceRow {
  return {
    BilledCost: 0.1, EffectiveCost: 0.1, BillingCurrency: 'USD',
    BillingPeriodStart: W.start, BillingPeriodEnd: W.end, ChargePeriodStart: W.start, ChargePeriodEnd: W.end,
    BillingAccountId: 'a', SubAccountId: 's', ServiceName: 'Svc', ServiceCategory: 'Compute', ProviderName: 'p',
    ChargeCategory: 'Usage', ChargeDescription: 'd', ResourceId: resourceId,
    PricingQuantity: 1, PricingUnit: 'u', UsageQuantity: 1, UsageUnit: 'u',
    ...(tags === undefined ? {} : { Tags: tags }),
  } as RawSourceRow;
}
const resolve = (r: RawSourceRow) => FocusFileAdapter.ingest([r], '1.4', 'focus-file-sandbox', W).rows[0];

describe('workload tag attribution', () => {
  it('uses the documented key', () => expect(KEY).toBe('ratio:workload'));

  it('resolves JSON-string and object Tags to the workload, money untouched', () => {
    for (const tags of [JSON.stringify({ [KEY]: KNOWN }), { [KEY]: KNOWN }]) {
      const out = resolve(row('i-0abc', tags));
      expect(out.x_RatioWorkloadId).toBe(KNOWN);
      expect(out.x_RatioTeam).not.toBe('');
      expect(out.BilledCost).toBe(0.1);
    }
  });

  it('keeps simulated rows unresolved even when tagged', () => {
    const out = resolve(row('synthetic:aws-sandbox/line-1', { [KEY]: KNOWN }));
    expect([out.x_RatioWorkloadId, out.x_RatioTeam]).toEqual(['', '']);
  });

  it('never invents workloads and never throws on malformed values', () => {
    const bad: unknown[] = ['{not json', '', null, 42, [], '[]', '"s"', { [KEY]: 'wl-nope' }, { [KEY]: 7 },
      { [KEY]: null }, { [KEY]: { a: 1 } }, { [KEY]: '' }, { [KEY]: 'constructor' }, { 'Ratio:Workload': KNOWN }, { other: KNOWN }];
    for (const t of bad) {
      expect(() => resolve(row('i-0abc', t))).not.toThrow();
      expect(resolve(row('i-0abc', t)).x_RatioWorkloadId).toBe('');
    }
    expect(workloadIdFromTags('{"__proto__":{"ratio:workload":"' + KNOWN + '"}}')).toBeNull();
  });

  it('prefers the ResourceId identity over a conflicting tag', () => {
    const out = resolve(row(resourceIdFor(KNOWN), { [KEY]: WORKLOADS[1].id }));
    expect(out.x_RatioWorkloadId).toBe(KNOWN);
  });
});
