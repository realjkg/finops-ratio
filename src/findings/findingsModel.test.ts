// The verified Value / cost semantics. The number on a finding card is
//   value_ratio = (counted value − harm from misses) ÷ monthly cost
// i.e. business value ÷ cost (break-even 1×), where value is net of harm. It is NOT
// (value − cost) ÷ cost, so −0.2× means value is −0.2 times cost, not a −20% return.
import { describe, expect, it } from 'vitest';
import { WORKLOADS } from '@/data/workloads';
import { buildFindings, targetStatusFor, VALUE_MINIMUM } from './findingsModel';
import { formatRatio } from '@/lib/format';
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
    const ratios = buildFindings().map((f) => f.valueRatio ?? -Infinity);
    expect(ratios).toEqual([...ratios].sort((a, b) => a - b));
  });

  it('classifies against break-even and the configured target, and N/A when there is no ratio', () => {
    expect(targetStatusFor(-0.2)).toBe('below_break_even');
    expect(targetStatusFor(0.99)).toBe('below_break_even');
    expect(targetStatusFor(1)).toBe('below_target');
    expect(targetStatusFor(VALUE_MINIMUM - 0.01)).toBe('below_target');
    expect(targetStatusFor(VALUE_MINIMUM)).toBe('on_target');
    expect(targetStatusFor(null)).toBe('not_available');
    expect(targetStatusFor(Number.NaN)).toBe('not_available');
    expect(targetStatusFor(Infinity)).toBe('not_available');
  });

  it('names the actual reason for a negative value: harm exceeds counted value', () => {
    expect(fraud().why).toMatch(/Harm from misses .* larger than counted value/);
  });

  it('keeps the exact gap in the calculation, not in the headline copy', () => {
    const f = fraud();
    expect(f.calculation.gapToTarget).toBeCloseTo(VALUE_MINIMUM - f.valueRatio!, 9);
    expect(f.problem).not.toMatch(/3\.2/);
    expect(f.why).not.toMatch(/3\.2/);
  });

  it('calculation follows the code order of operations for Fraud Triage', () => {
    const c = fraud().calculation;
    expect(c.grossValue).toBe(6720); // protected revenue + avoided cost
    expect(c.qualityFloorPassRate).toBeCloseTo(0.58, 9); // applied once, to gross value
    expect(c.countedValue).toBeCloseTo(3897.6, 6); // $3,898
    expect(c.harmFromMisses).toBe(4600); // subtracted after: not a second quality deduction
    expect(c.adjustedValue).toBeCloseTo(-702.4, 6); // $-702
    expect(c.cost).toBe(4200);
    expect(c.ratio).toBeCloseTo(-702.4 / 4200, 12); // -0.1672, unrounded
    expect(formatRatio(c.ratio)).toBe('-0.2\u00d7'); // displayed
    expect(c.countedValue).toBeCloseTo(c.grossValue * c.qualityFloorPassRate!, 9);
    expect(c.adjustedValue).toBeCloseTo(c.countedValue - c.harmFromMisses, 9);
    expect(c.ratio).toBeCloseTo(c.adjustedValue / c.cost, 12);
  });

  it('states the cost source honestly: modeled data is a demo assumption, never Billed or Effective', () => {
    const c = fraud().calculation;
    expect(c.costSource).toBe('modeled');
    expect(c.costLabel).toBe('Modeled workload cost');
    expect(c.basis).toBe('Basis: demo assumption');
    expect(c.monthConvention).toBe('30-day month convention');
    expect(JSON.stringify(c)).not.toMatch(/billed|effective/i);
  });

  it('a recorded workload is labeled by its postings, with no month convention', () => {
    const w = structuredClone(WORKLOADS[0]);
    w.costs.recorded_mtd = w.costs.monthly_spend;
    const f = buildFindings([w])[0];
    expect(f.costSource).toBe('recorded');
    expect(f.calculation.costLabel).toBe('Recorded cost to date');
    expect(f.calculation.basis).toBe('Basis: simulation postings');
    expect(f.calculation.monthConvention).toBeNull();
  });

  it('a workload at or above target has no gap', () => {
    const best = buildFindings().at(-1)!;
    expect(best.targetStatus).toBe('on_target');
    expect(best.calculation.gapToTarget).toBeNull();
  });
});

describe('the unrounded ratio drives decisions, not the displayed text', () => {
  // Two workloads whose stored (2-decimal) value_ratio is identical, but whose unrounded ratios straddle the 3x target.
  const make = (id: string, totalValue: number): (typeof WORKLOADS)[number] => {
    const w = structuredClone(WORKLOADS[0]);
    w.id = id;
    w.name = id;
    w.costs.monthly_spend = 10000;
    w.value = { ...w.value, revenue_protected: totalValue, cost_avoided: 0, harm_from_misses: 0, quality_floor_pass_rate: undefined, total_value: Math.round(totalValue), value_ratio: 3 };
    return w;
  };
  const below = make('below', 29996); // 2.9996x: displays 3.0x, stored ratio 3 (rounded)
  const above = make('above', 30004); // 3.0004x

  it('both display as 3.0x, yet only the lower one is below target', () => {
    const f = buildFindings([above, below]);
    expect(f.map((x) => formatRatio(x.valueRatio))).toEqual(['3.0\u00d7', '3.0\u00d7']);
    expect(f[0].workloadId).toBe('below'); // sorted by the unrounded value although stored ratios tie
    expect(f.map((x) => x.targetStatus)).toEqual(['below_target', 'on_target']);
    expect(f[0].calculation.gapToTarget).toBeCloseTo(0.0004, 9);
    expect(f[1].calculation.gapToTarget).toBeNull();
  });
});

describe('N/A when there is no positive cost', () => {
  it('zero cost is N/A with a reason, not 0.0x and not "Below target"', () => {
    const w = structuredClone(WORKLOADS[0]);
    w.costs.monthly_spend = 0;
    const f = buildFindings([w])[0];
    expect(f.valueRatio).toBeNull();
    expect(f.targetStatus).toBe('not_available');
    expect(f.calculation.naReason).toMatch(/No positive workload cost/);
    expect(f.problem).toMatch(/N\/A/);
    expect(f.problem).not.toMatch(/Below target/);
    expect(formatRatio(f.valueRatio)).toBe('N/A');
  });

  it('formatRatio never prints NaN or Infinity', () => {
    for (const bad of [Number.NaN, Infinity, -Infinity, null, undefined]) expect(formatRatio(bad as number)).toBe('N/A');
  });
});
