// The verified Value / cost semantics. The number on a finding card is
//   value_ratio = (counted value − harm from misses) ÷ monthly cost
// i.e. business value ÷ cost (break-even 1×), where value is net of harm. It is NOT
// (value − cost) ÷ cost, so −0.2× means value is −0.2 times cost, not a −20% return.
import { describe, expect, it } from 'vitest';
import { WORKLOADS } from '@/data/workloads';
import { buildFindings, targetStatusFor, VALUE_MINIMUM } from './findingsModel';
import { deriveWorkloadValue } from '@/lib/valueMath';

describe('Value / cost formula', () => {
  it('every seeded stored ratio equals net value ÷ monthly cost (rounded to 2 places)', () => {
    for (const w of WORKLOADS) {
      const d = deriveWorkloadValue(w);
      expect(w.value.value_ratio, w.id).toBeCloseTo(Math.round(d.total_value) / w.costs.monthly_spend, 2);
      expect(d.total_value, w.id).toBeCloseTo(d.counted_value - d.harm_from_misses, 6);
    }
  });

  it('is not the net-return formula: (value − cost) ÷ cost differs from the shown number', () => {
    const fraud = WORKLOADS.find((w) => w.id === 'wl-fraud')!;
    const netReturn = (fraud.value.total_value - fraud.costs.monthly_spend) / fraud.costs.monthly_spend;
    expect(fraud.value.value_ratio).toBeCloseTo(-0.17, 2);
    expect(netReturn).toBeCloseTo(-1.17, 2);
  });

  it('can be negative, and the model keeps it negative instead of flooring it', () => {
    const fraud = buildFindings().find((f) => f.workloadId === 'wl-fraud')!;
    expect(fraud.valueRatio).toBeLessThan(0);
    expect(fraud.targetStatus).toBe('below_break_even');
  });
});

describe('finding card model', () => {
  const fraud = () => buildFindings().find((f) => f.workloadId === 'wl-fraud')!;

  it('sorts lowest Value / cost first', () => {
    const ratios = buildFindings().map((f) => f.valueRatio);
    expect(ratios).toEqual([...ratios].sort((a, b) => a - b));
  });

  it('classifies against break-even and the configured target', () => {
    expect(targetStatusFor(-0.2)).toBe('below_break_even');
    expect(targetStatusFor(0.99)).toBe('below_break_even');
    expect(targetStatusFor(1)).toBe('below_target');
    expect(targetStatusFor(VALUE_MINIMUM - 0.01)).toBe('below_target');
    expect(targetStatusFor(VALUE_MINIMUM)).toBe('on_target');
  });

  it('names the actual reason for a negative value: harm exceeds counted value', () => {
    expect(fraud().why).toMatch(/Harm from misses .* larger than counted value/);
  });

  it('keeps the exact gap in the calculation, not in the headline copy', () => {
    const f = fraud();
    expect(f.calculation.gapToTarget).toBeCloseTo(VALUE_MINIMUM - f.valueRatio, 6);
    expect(f.problem).not.toMatch(/3\.2/);
    expect(f.why).not.toMatch(/3\.2/);
  });

  it('calculation breakdown agrees with the headline ratio and states cost basis honestly', () => {
    const f = fraud();
    const c = f.calculation;
    expect(c.netValue).toBeCloseTo(c.countedValue - c.harmFromMisses, 6);
    expect(c.netValue / c.monthlyCost).toBeCloseTo(f.valueRatio, 2);
    expect(c.formula).toBe('Value / cost = (counted value − harm from misses) ÷ monthly cost');
    expect(c.costBasis).toMatch(/Cost basis not stated/);
    expect(c.costBasis).not.toMatch(/^Billed|^Effective/);
  });

  it('a workload at or above target has no gap', () => {
    const best = buildFindings().at(-1)!;
    expect(best.targetStatus).toBe('on_target');
    expect(best.calculation.gapToTarget).toBeNull();
  });
});
