import { describe, expect, it } from 'vitest';
import { findingsFor } from './seed';
import { WORKLOADS } from '@/data/workloads';
import { presentFinding } from './findingPresentation';

describe('seeded finding presentation', () => {
  const all = findingsFor('pointfive-live');
  const rightsizing = all.filter((f) => f.type === 'opportunity' && f.category === 'rightsizing');

  it('the API contract title is unchanged (golden string still carries the old wording)', () => {
    expect(rightsizing.find((f) => f.id.endsWith('wl-fraud'))!.title).toBe('Fraud Triage Agent returning -0.2× — below 3× value floor');
  });

  it('shows the owner wording for the seeded target finding, with break-even, target and source apart', () => {
    const f = rightsizing.find((x) => x.id.endsWith('wl-fraud'))!;
    const p = presentFinding(f);
    expect(p.title).toBe('Fraud Triage Agent is below the configured 3× value / cost target.');
    expect(p.details).toEqual(['Break-even: 1×', 'Policy target: 3×', 'Target source: Demo configuration (Set in demo configuration)']);
  });

  it('is keyed by the stable id, not by the title text', () => {
    const f = { ...rightsizing[0], id: 'other-source:opportunity:other-kind' };
    expect(presentFinding(f)).toEqual({ title: f.title, details: [] });
    const lookalike = { id: 'x', type: 'anomaly', category: 'spend_spike', title: 'Fraud Triage Agent returning -0.2× — below 3× value floor' };
    expect(presentFinding(lookalike).title).toBe(lookalike.title);
  });

  it('leaves every non-target finding exactly as the contract has it', () => {
    for (const f of all.filter((x) => !rightsizing.includes(x))) expect(presentFinding(f)).toEqual({ title: f.title, details: [] });
  });

  it('the type and category guard matters: a matching id with another type or category is not rewritten', () => {
    const f = rightsizing.find((x) => x.id.endsWith('wl-fraud'))!;
    expect(presentFinding({ ...f, type: 'anomaly' }).title).toBe(f.title);
    expect(presentFinding({ ...f, category: 'spend_spike' }).title).toBe(f.title);
    expect(presentFinding({ ...f, type: 'anomaly' }).details).toEqual([]);
  });

  it('below/above wording follows the live ratio of the workload, not a static claim', () => {
    const f = rightsizing.find((x) => x.id.endsWith('wl-fraud'))!;
    const high = structuredClone(WORKLOADS.find((w) => w.id === 'wl-fraud')!);
    high.value = { ...high.value, revenue_protected: 100000, cost_avoided: 0, harm_from_misses: 0, quality_floor_pass_rate: 1 };
    expect(presentFinding(f, [high]).title).toBe('Fraud Triage Agent is at or above the configured 3× value / cost target.');
    const none = structuredClone(high);
    none.costs.monthly_spend = 0;
    expect(presentFinding(f, [none]).title).toMatch(/has no Value \/ cost/);
  });
});
