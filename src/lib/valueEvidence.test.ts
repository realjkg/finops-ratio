// Value-evidence propagation tests — audit C1/C2 quick-win slice.
// Verifies the weakest-input roll-up (a chain is as weak as its weakest input)
// and that every seeded headline ratio carries an honest mark (never `measured`)
// on every surface that renders it: findings, executive overview, mission
// (technical overview), KPI band inputs, and the agent context.

import { describe, it, expect } from 'vitest';
import {
  weakestStatus,
  headlineEvidence,
  headlineEvidenceStatus,
  EVIDENCE_META,
  VALUE_INPUTS,
} from './valueEvidence';
import { derivePortfolioRatio } from '@/lib/derive';
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

  // Owner decision (value-derivation note §4, §7.2): an unmarked input counts as assumed;
  // it no longer silently drops out of the roll-up.
  it('an unmarked input counts as assumed, so it can pull the result down', () => {
    expect(weakestStatus([undefined, 'measured', undefined])).toBe('assumed');
    expect(weakestStatus([undefined, 'assumed'])).toBe('assumed');
    expect(weakestStatus([undefined, undefined])).toBe('assumed');
    expect(weakestStatus(['measured', undefined])).toBe('assumed');
  });

  it('returns undefined only for an empty list (no input at all)', () => {
    expect(weakestStatus([])).toBeUndefined();
  });
});

describe('headlineEvidenceStatus', () => {
  it('rolls up per-input marks to the weakest input', () => {
    const v = valueWith({ revenue_protected: 'measured', cost_avoided: 'assumed' });
    expect(headlineEvidenceStatus(v)).toBe('assumed');
  });

  it('a legacy value with no evidence block is assumed, and every input is listed as unmarked', () => {
    const legacy: WorkloadValue = {
      revenue_protected: 100,
      cost_avoided: 50,
      total_value: 150,
      value_ratio: 3.0,
    };
    expect(headlineEvidenceStatus(legacy)).toBe('assumed');
    expect(headlineEvidence(legacy)).toEqual({
      status: 'assumed',
      unmarked: ['revenue_protected', 'cost_avoided', 'harm_from_misses', 'quality_floor_pass_rate'],
    });
  });

  it('includes the harm and quality-floor inputs in the weakest-input roll-up (C3/C4)', () => {
    const v: WorkloadValue = {
      revenue_protected: 100,
      cost_avoided: 50,
      harm_from_misses: 10,
      quality_floor_pass_rate: 0.9,
      total_value: 130,
      value_ratio: 2.6,
      evidence: {
        revenue_protected: 'measured',
        cost_avoided: 'measured',
        harm_from_misses: 'assumed',
        quality_floor_pass_rate: 'projected',
      },
    };
    // The two new inputs are the weakest links even though both original
    // components are measured.
    expect(headlineEvidenceStatus(v)).toBe('assumed');
  });

  it('unmarked harm and floor inputs count as assumed and are listed (no silent provenance gap)', () => {
    const v: WorkloadValue = {
      revenue_protected: 100,
      cost_avoided: 50,
      total_value: 150,
      value_ratio: 3.0,
      evidence: {
        revenue_protected: 'projected',
        cost_avoided: 'measured',
      },
    };
    expect(headlineEvidenceStatus(v)).toBe('assumed');
    expect(headlineEvidence(v).unmarked).toEqual(['harm_from_misses', 'quality_floor_pass_rate']);
  });

  it('a fully marked value lists nothing as unmarked', () => {
    const v: WorkloadValue = {
      revenue_protected: 100, cost_avoided: 50, harm_from_misses: 0, quality_floor_pass_rate: 1, total_value: 150, value_ratio: 3,
      evidence: { revenue_protected: 'measured', cost_avoided: 'measured', harm_from_misses: 'measured', quality_floor_pass_rate: 'measured' },
    };
    expect(headlineEvidence(v)).toEqual({ status: 'measured', unmarked: [] });
  });
});

describe('portfolio evidence status (the weakest workload)', () => {
  const marked = (s: EvidenceStatus) => ({ revenue_protected: s, cost_avoided: s, harm_from_misses: s, quality_floor_pass_rate: s });
  const withEvidence = (i: number, evidence: WorkloadValue['evidence']) =>
    ({ ...WORKLOADS[i], value: { ...WORKLOADS[i].value, evidence } });

  it('the seeded portfolio is assumed', () => {
    expect(derivePortfolioRatio(WORKLOADS).evidence_status).toBe('assumed');
  });
  it('all measured is measured; one unmarked workload pulls it to assumed', () => {
    const all = WORKLOADS.map((_, i) => withEvidence(i, marked('measured')));
    expect(derivePortfolioRatio(all).evidence_status).toBe('measured');
    expect(derivePortfolioRatio([...all.slice(1), withEvidence(0, undefined)]).evidence_status).toBe('assumed');
    expect(derivePortfolioRatio([...all.slice(1), withEvidence(0, marked('projected'))]).evidence_status).toBe('projected');
  });
  it('an empty portfolio has no status', () => {
    expect(derivePortfolioRatio([]).evidence_status).toBeUndefined();
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

describe("Frank's context carries the status, never an unmarked value", () => {
  it('a workload with no evidence block reaches the agent context as assumed', () => {
    const legacy = { ...WORKLOADS[0], value: { ...WORKLOADS[0].value, evidence: undefined } };
    const ctx = buildAIContext([legacy, ...WORKLOADS.slice(1)]);
    expect(ctx.workloads?.find((w) => w.id === legacy.id)?.valueEvidenceStatus).toBe('assumed');
    expect(ctx.initiatives.find((i) => i.id === legacy.id)?.valueEvidenceStatus).toBe('assumed');
    // Provenance survives too: which inputs have no mark, and the portfolio status and count.
    expect(ctx.workloads?.find((w) => w.id === legacy.id)?.valueEvidenceUnmarked).toEqual([...VALUE_INPUTS]);
    expect(ctx.initiatives.find((i) => i.id === legacy.id)?.valueEvidenceUnmarked).toEqual([...VALUE_INPUTS]);
    expect(ctx.summary.valueEvidenceStatus).toBe('assumed');
    expect(ctx.summary.valueEvidenceUnmarkedWorkloads).toBe(1);
  });
  it('a fully marked portfolio sends its status and no unmarked lists', () => {
    const ctx = buildAIContext(WORKLOADS);
    expect(ctx.summary.valueEvidenceStatus).toBe(derivePortfolioRatio(WORKLOADS).evidence_status);
    expect(ctx.summary.valueEvidenceUnmarkedWorkloads).toBe(0);
    expect(ctx.workloads?.some((w) => 'valueEvidenceUnmarked' in w)).toBe(false);
    expect(ctx.initiatives.some((i) => 'valueEvidenceUnmarked' in i)).toBe(false);
  });
});

describe('a status that is not a known one counts as assumed (review M1)', () => {
  it.each([[''], ['Measured'], ['toString'], [null], [42]])('%j never strengthens the roll-up', (bad) => {
    expect(weakestStatus(['measured', bad, 'measured'])).toBe('assumed');
    expect(weakestStatus([bad, 'measured'])).toBe('assumed');
  });
  it('an invalid input mark is listed as unmarked', () => {
    const value = { evidence: { revenue_protected: 'measured', cost_avoided: 'Measured', harm_from_misses: 'measured', quality_floor_pass_rate: '' } } as never;
    expect(headlineEvidence(value)).toEqual({ status: 'assumed', unmarked: ['cost_avoided', 'quality_floor_pass_rate'] });
  });
});

describe('evidenceAriaText', () => {
  it('names the status and the unmarked inputs, and never repeats the mark button’s own name', async () => {
    const { evidenceAriaText } = await import('./valueEvidence');
    expect(evidenceAriaText('assumed')).toBe('value evidence: estimated');
    expect(evidenceAriaText('measured', [])).toBe('value evidence: measured');
    expect(evidenceAriaText('assumed', ['harm_from_misses'])).toBe('value evidence: estimated, no valid provenance recorded for harm from misses');
    for (const s of ['measured', 'projected', 'assumed'] as const) expect(evidenceAriaText(s).toLowerCase()).not.toContain(EVIDENCE_META[s].label.toLowerCase());
  });
});
