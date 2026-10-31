import { describe, expect, it } from 'vitest';
import { WORKLOADS } from '@/data/workloads';
import { formatCents, sampleView } from './sampleWorkspace';

describe('sample workspace view-models', () => {
  it('formats integer cents without floats', () => {
    expect([formatCents(0), formatCents(5), formatCents(1363200), formatCents(-250), formatCents(100000000)]).toEqual(['$0.00', '$0.05', '$13,632.00', '-$2.50', '$1,000,000.00']);
  });
  it('executive total is the exact sum of the workloads', () => {
    const cents = WORKLOADS.reduce((s, w) => s + Math.round(w.costs.monthly_spend * 100), 0);
    expect(sampleView('executive').stats[0]).toEqual({ label: 'Monthly AI spend', value: formatCents(cents) });
  });
  it('technical lists the largest drivers first and procurement the cheapest model first', () => {
    const tech = sampleView('technical').rows.map((r) => r.value.replace(/[$,]/g, ''));
    expect(tech.map(Number)).toEqual([...tech.map(Number)].sort((a, b) => b - a));
    const prices = sampleView('procurement').rows.map((r) => Number(r.value.split(' / ')[0].slice(1)));
    expect(prices).toEqual([...prices].sort((a, b) => a - b));
  });
  it('every persona has stats and rows', () => {
    for (const p of ['executive', 'technical', 'procurement'] as const) {
      const v = sampleView(p);
      expect([v.stats.length, v.rows.length > 0]).toEqual([3, true]);
    }
  });
});
