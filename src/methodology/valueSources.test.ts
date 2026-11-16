import { describe, expect, it } from 'vitest';
import { WORKLOADS, WORKLOAD_SEED_SPECS } from '@/data/workloads';
import { deriveWorkloadValue } from '@/lib/valueMath';
import { workloadValueRatio } from '@/lib/valueRatio';
import { buildFindings } from '@/findings/findingsModel';
import { seedWorkspace } from '@/simulation/server/workflow';
import { methodologyHref, traceAll, traceWorkload } from './valueSources';

const fraud = () => structuredClone(WORKLOADS.find((w) => w.id === 'wl-fraud')!);

describe('value sources: every figure ties back to its source record', () => {
  it('every demo workload has a dataset record and matches it exactly', () => {
    expect(WORKLOAD_SEED_SPECS.map((s) => s.id)).toEqual(WORKLOADS.map((w) => w.id));
    for (const t of traceAll(WORKLOADS)) {
      expect(t.check.differences, t.id).toEqual([]);
      expect(t.check.matches).toBe(true);
      expect(t.origin).toBe('demo_dataset');
      expect(t.seed?.id).toBe(t.id);
    }
  });

  it('the worked steps are the same numbers as the headline calculation and the findings panel', () => {
    const findings = new Map(buildFindings(WORKLOADS).map((f) => [f.workloadId, f.calculation]));
    for (const w of WORKLOADS) {
      const t = traceWorkload(w);
      const d = deriveWorkloadValue(w);
      const c = findings.get(w.id)!;
      expect(t.steps.map((s) => s.value)).toEqual([d.gross_value, d.counted_value, d.total_value, workloadValueRatio(w)]);
      expect([c.grossValue, c.countedValue, c.adjustedValue, c.ratio]).toEqual(t.steps.map((s) => s.value));
      expect(t.inputs.find((i) => i.key === 'monthly_cost')!.value).toBe(c.cost);
    }
  });

  it('Fraud Triage: the stated inputs give a negative Value / cost, shown as-is', () => {
    const t = traceWorkload(fraud());
    const byKey = Object.fromEntries(t.inputs.map((i) => [i.key, i.value]));
    expect(byKey).toEqual({ revenue_protected: 4704, cost_avoided: 2016, quality_floor_pass_rate: 0.58, harm_from_misses: 4600, monthly_cost: 4200 });
    expect(t.steps[0].value).toBe(6720);
    expect(t.steps[1].value).toBeCloseTo(3897.6, 9);
    expect(t.steps[2].value).toBeCloseTo(-702.4, 9);
    expect(t.steps[3].value).toBeCloseTo(-702.4 / 4200, 12);
    expect(t.inputs[0].origin).toContain('dataset record wl-fraud');
    expect(t.inputs[0].origin).toContain('1.6× the stated monthly cost of $4,200');
  });

  it('every value input is marked assumed in the demo; cost is never given a value mark', () => {
    for (const t of traceAll(WORKLOADS)) {
      for (const i of t.inputs) expect(i.evidence, `${t.id} ${i.key}`).toBe(i.key === 'monthly_cost' ? null : 'assumed');
      expect(t.headlineEvidence).toBe('assumed');
    }
  });

  it('says monthly cost is stated, not derived from tokens, and the daily cost recomputes from tokens × list price', () => {
    for (const w of WORKLOADS) {
      const t = traceWorkload(w);
      expect(t.inputs.find((i) => i.key === 'monthly_cost')!.origin).toMatch(/not derived from the token counts/);
      expect(t.dailyCost!.dailySpend).toBe(w.costs.daily_spend);
    }
  });

  it('flags a value that no longer matches its dataset record instead of hiding it', () => {
    const w = fraud();
    w.value.harm_from_misses = 100;
    w.costs.monthly_spend = 5000;
    const t = traceWorkload(w);
    expect(t.check.matches).toBe(false);
    expect(t.check.differences).toEqual([
      'Harm from misses: $100 in use, $4,600 in the source record.',
      'Modeled monthly cost: $5,000 in use, $4,200 in the source record.',
    ]);
  });

  it('flags a missing pass rate and a workload with no dataset record', () => {
    const w = fraud();
    delete w.value.quality_floor_pass_rate;
    expect(traceWorkload(w).check.differences).toContain('Quality-floor pass rate: missing in use, 58% in the source record.');
    const orphan = { ...fraud(), id: 'wl-unknown' };
    expect(traceWorkload(orphan).check.matches).toBe(false);
    expect(traceWorkload(orphan).seed).toBeNull();
  });

  it('inside a simulation workspace, recorded cost ties to the sum of its ledger postings', () => {
    const s = seedWorkspace();
    for (const t of traceAll(s.workloads, s.ledger)) {
      expect(t.origin).toBe('simulation_workspace');
      expect(t.costSource).toBe('recorded');
      expect(t.check.differences, t.id).toEqual([]);
      expect(t.postings!.count).toBeGreaterThan(0);
      expect(t.dailyCost).toBeNull();
    }
    // A posting the workload's cost does not include is caught.
    s.ledger.push({ ...s.ledger[0], id: 'extra', cents: 999 });
    const t = traceWorkload(s.workloads.find((w) => w.id === s.ledger[0].workloadId)!, s.ledger);
    expect(t.check.matches).toBe(false);
    expect(t.check.differences[0]).toMatch(/^Recorded cost: .* in use, .* in the source record\.$/);
  });

  it('links each workload to its own anchor on the methodology page', () => {
    expect(methodologyHref('wl-fraud')).toBe('/methodology#calc-wl-fraud');
    expect(traceWorkload(fraud()).anchor).toBe('calc-wl-fraud');
  });
});
