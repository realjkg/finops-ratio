// Value-evidence propagation tests — audit C1/C2 quick-win slice.
// Verifies the weakest-input roll-up (a chain is as weak as its weakest input)
// and that every seeded headline ratio carries an honest mark (never `measured`)
// on every surface that renders it: findings, executive overview, mission
// (technical overview), KPI band inputs, and the agent context.

import { describe, it, expect } from 'vitest';
import {
  weakestStatus,
  headlineEvidenceStatus,
  EVIDENCE_META,
} from './valueEvidence';
import { WORKLOADS } from '@/data/workloads';
import { buildFindings } from '@/findings/findingsModel';
import { buildInitiativeBoard } from '@/executive/initiativeModel';
import { buildMissionBoard } from '@/mission/missionModel';
import { buildAIContext } from '@/ai/buildAIContext';
import type { EvidenceStatus, WorkloadValue } from '@/types';

function valueWith(
  marks: Partial<Record<'revenue_protected' | 'cost_avoided', EvidenceStatus>>,
): WorkloadValue {
  return {
    revenue_protected: 100,
    cost_avoided: 50,
    total_value: 150,
    value_ratio: 3.0,
    evidence: {
      revenue_protected: marks.revenue_protected ?? 'measured',
      cost_avoided: marks.cost_avoided ?? 'measured',
    },
  };
}

describe('weakestStatus', () => {
  it('measured + assumed propagates to assumed (weakest input wins)', () => {
    expect(weakestStatus(['measured', 'assumed'])).toBe('assumed');
  });

  it('measured + projected propagates to projected', () => {
    expect(weakestStatus(['measured', 'projected'])).toBe('projected');
  });

  it('all-measured inputs propagate to measured', () => {
    expect(weakestStatus(['measured', 'measured'])).toBe('measured');
  });

  it('identical marks propagate to themselves', () => {
    expect(weakestStatus(['projected', 'projected'])).toBe('projected');
    expect(weakestStatus(['assumed', 'assumed'])).toBe('assumed');
  });

  it('ignores unmarked inputs and returns the weakest marked one', () => {
    expect(weakestStatus([undefined, 'measured', undefined])).toBe('measured');
    expect(weakestStatus([undefined, 'assumed'])).toBe('assumed');
  });

  it('returns undefined only when no input carries a mark', () => {
    expect(weakestStatus([])).toBeUndefined();
    expect(weakestStatus([undefined, undefined])).toBeUndefined();
  });
});

describe('headlineEvidenceStatus', () => {
  it('rolls up per-input marks to the weakest input', () => {
    const v = valueWith({ revenue_protected: 'measured', cost_avoided: 'assumed' });
    expect(headlineEvidenceStatus(v)).toBe('assumed');
  });

  it('returns undefined for a legacy value with no evidence block', () => {
    const legacy: WorkloadValue = {
      revenue_protected: 100,
      cost_avoided: 50,
      total_value: 150,
      value_ratio: 3.0,
    };
    expect(headlineEvidenceStatus(legacy)).toBeUndefined();
  });
});

describe('seed provenance (honesty: never measured)', () => {
  it('every seeded workload marks both value inputs and headlines the weakest', () => {
    expect(WORKLOADS.length).toBeGreaterThan(0);
    for (const w of WORKLOADS) {
      expect(w.value.evidence).toBeDefined();
      expect(w.value.evidence?.revenue_protected).not.toBe('measured');
      expect(w.value.evidence?.cost_avoided).not.toBe('measured');
      expect(headlineEvidenceStatus(w.value)).toBe('assumed');
    }
  });
});

describe('provenance rides the surface view-models', () => {
  it('findings carry the propagated mark', () => {
    for (const f of buildFindings()) {
      expect(f.valueEvidenceStatus).toBe('assumed');
    }
  });

  it('executive initiative views carry the propagated mark', () => {
    const { initiatives } = buildInitiativeBoard();
    expect(initiatives.length).toBeGreaterThan(0);
    for (const i of initiatives) {
      expect(i.valueEvidenceStatus).toBe('assumed');
    }
  });

  it('mission (technical overview) views carry the propagated mark', () => {
    const { missions } = buildMissionBoard();
    expect(missions.length).toBeGreaterThan(0);
    for (const m of missions) {
      expect(m.valueEvidenceStatus).toBe('assumed');
    }
  });

  it('agent context snapshots (initiative + workload) carry the mark', () => {
    const ctx = buildAIContext(WORKLOADS);
    expect(ctx.initiatives.length).toBeGreaterThan(0);
    for (const i of ctx.initiatives) {
      expect(i.valueEvidenceStatus).toBe('assumed');
    }
    expect(ctx.workloads?.length).toBeGreaterThan(0);
    for (const w of ctx.workloads ?? []) {
      expect(w.valueEvidenceStatus).toBe('assumed');
    }
  });
});

describe('EVIDENCE_META display contract', () => {
  it('gives every status a distinct token color and label', () => {
    const colors = new Set(Object.values(EVIDENCE_META).map((m) => m.color));
    const labels = new Set(Object.values(EVIDENCE_META).map((m) => m.label));
    expect(colors.size).toBe(3);
    expect(labels.size).toBe(3);
    // The honesty anchor: measured is the only green (value) mark.
    expect(EVIDENCE_META.measured.color).not.toBe(EVIDENCE_META.assumed.color);
  });
});
