import { describe, expect, it } from 'vitest';
import { WORKLOADS, WORKLOAD_SEED_SPECS } from '@/data/workloads';
import { deriveWorkloadValue } from '@/lib/valueMath';
import { workloadValueRatio } from '@/lib/valueRatio';
import { buildFindings } from '@/findings/findingsModel';
import { seedWorkspace } from '@/simulation/server/workflow';
import { methodologyHref, traceAll, traceWorkload } from './valueSources';
import type { Workload } from '@/types';

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

  // One case per compared field, each a sub-dollar (or sub-percent) change, so every comparison is pinned.
  it.each([
    ['revenue_protected', (w: Workload) => { w.value.revenue_protected += 0.01; }, /^Protected revenue: \$4,704\.01 in use, \$4,704 in the source record\.$/],
    ['cost_avoided', (w: Workload) => { w.value.cost_avoided -= 0.01; }, /^Avoided cost: \$2,015\.99 in use, \$2,016 in the source record\.$/],
    ['harm_from_misses', (w: Workload) => { w.value.harm_from_misses = 4600.01; }, /^Harm from misses: \$4,600\.01 in use, \$4,600 in the source record\.$/],
    ['quality_floor_pass_rate', (w: Workload) => { w.value.quality_floor_pass_rate = 0.581; }, /^Quality-floor pass rate: 58\.1% in use, 58% in the source record\.$/],
    ['monthly_spend', (w: Workload) => { w.costs.monthly_spend = 4200.01; }, /^Modeled monthly cost: \$4,200\.01 in use, \$4,200 in the source record\.$/],
    ['daily_spend', (w: Workload) => { w.costs.daily_spend += 0.01; }, /^Modeled daily cost: .* in use, .* in the source record\.$/],
    ['total_value', (w: Workload) => { w.value.total_value = 1; }, /^Stored estimated value: \$1 in use, -\$702 in the source record\.$/],
    ['value_ratio by 0.01', (w: Workload) => { w.value.value_ratio = -0.18; }, /^Stored Value \/ cost: -0\.18 in use, -0\.17 from the inputs\.$/],
    ['value_ratio', (w: Workload) => { w.value.value_ratio = 99; }, /^Stored Value \/ cost: 99 in use, -0\.17 from the inputs\.$/],
  ])('flags a change to %s, however small', (_field, change, message) => {
    const w = fraud();
    change(w);
    const t = traceWorkload(w);
    expect(t.check.matches).toBe(false);
    expect(t.check.differences.some((d) => message.test(d)), t.check.differences.join(' | ')).toBe(true);
  });

  it('treats a sub-cent difference as a match, and says the check is to the cent', () => {
    const w = fraud();
    w.value.revenue_protected += 0.004;
    const t = traceWorkload(w);
    expect(t.check.matches).toBe(true);
    expect(t.check.checked).toMatch(/to the cent/);
    expect(t.check.checked).toContain('stored Value / cost against the inputs, to 0.01');
    const free = fraud();
    free.costs.monthly_spend = 0;
    expect(traceWorkload(free).check.checked).not.toContain('Value / cost');
  });

  it('an input with no evidence mark counts as assumed and is flagged as unmarked; marks are read, not hard-coded', () => {
    const w = fraud();
    delete (w.value as { evidence?: unknown }).evidence;
    const unmarked = traceWorkload(w);
    for (const i of unmarked.inputs.filter((x) => x.key !== 'monthly_cost')) expect([i.key, i.evidence, i.unmarked]).toEqual([i.key, 'assumed', true]);
    const measured = fraud();
    measured.value.evidence = { revenue_protected: 'measured', cost_avoided: 'measured', harm_from_misses: 'measured', quality_floor_pass_rate: 'measured' };
    const t = traceWorkload(measured);
    expect(t.inputs.filter((x) => x.key !== 'monthly_cost').map((i) => i.evidence)).toEqual(['measured', 'measured', 'measured', 'measured']);
    expect(t.headlineEvidence).toBe('measured');
  });

  it('describes a missing pass rate and missing harm honestly', () => {
    const w = fraud();
    delete w.value.quality_floor_pass_rate;
    delete (w.value as { harm_from_misses?: number }).harm_from_misses;
    const t = traceWorkload(w);
    expect(t.steps[1].formula).toBe('gross value (no pass rate recorded, so all outputs count)');
    expect(t.inputs.find((i) => i.key === 'harm_from_misses')!.origin).toBe('Not recorded, so counted as $0.');
    expect(traceWorkload(fraud()).steps[1].formula).toBe('gross value \u00d7 quality-floor pass rate');
  });

  it('labels modeled and recorded cost correctly', () => {
    expect(traceWorkload(fraud()).inputs.find((i) => i.key === 'monthly_cost')!.label).toBe('Modeled monthly cost');
    const s = seedWorkspace();
    const w = s.workloads.find((x) => x.id === 'wl-fraud')!;
    expect(traceWorkload(w, s.ledger).inputs.find((i) => i.key === 'monthly_cost')!.label).toBe('Recorded cost, month to date');
    expect(traceWorkload(w, []).inputs.find((i) => i.key === 'monthly_cost')!.origin).toBe('No cost postings are recorded in this workspace for this workload.');
  });

  it('the modeled daily cost reproduces by hand from its components', () => {
    for (const w of WORKLOADS) {
      const d = traceWorkload(w).dailyCost!;
      expect(d.compute).toBeCloseTo((d.inputCost + d.outputCost) * 0.05, 12);
      expect(Math.round((d.inputCost + d.outputCost + d.cachedCost + d.compute) * 100) / 100).toBe(d.dailySpend);
      expect(d.dailySpend).toBe(w.costs.daily_spend);
    }
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
