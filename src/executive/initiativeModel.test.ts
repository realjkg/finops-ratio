// Tests for the executive Initiative view-model (Ratio v2 Wave 2a). Confirms the
// dashboard is a faithful, additive projection of the same engine the Mission
// Board reads: matching counts, mission→executive status mapping, R4 value
// pairing, and a Spend Summary derived from the bundled seed. Pure — no DOM.
import { describe, it, expect } from 'vitest';
import { WORKLOADS } from '@/data/workloads';
import { buildMissionBoard } from '@/mission/missionModel';
import {
  buildInitiativeBoard,
  INITIATIVE_STATUS_META,
  toInitiativeView,
} from './initiativeModel';

describe('initiative view-model', () => {
  const { initiatives, summary } = buildInitiativeBoard();

  it('projects one initiative per workload', () => {
    expect(initiatives).toHaveLength(WORKLOADS.length);
    expect(summary.initiativesActive).toBe(WORKLOADS.length);
  });

  it('totals monthly spend from the seed', () => {
    const expected = Math.round(
      WORKLOADS.reduce((sum, w) => sum + w.costs.monthly_spend, 0),
    );
    expect(summary.totalMonthlySpend).toBe(expected);
  });

  it('maps mission status to the executive status one-to-one', () => {
    const { missions } = buildMissionBoard();
    const expected: Record<string, string> = {
      nominal: 'on_track',
      caution: 'at_risk',
      critical: 'pending_approval',
    };
    for (const mission of missions) {
      const initiative = initiatives.find((i) => i.id === mission.id);
      expect(initiative?.status).toBe(expected[mission.status]);
    }
  });

  it('counts pending approvals consistently with the cards', () => {
    const pending = initiatives.filter((i) => i.status === 'pending_approval').length;
    expect(summary.pendingApproval).toBe(pending);
  });

  it('derives a non-negative projected savings figure', () => {
    expect(summary.projectedSavings).toBeGreaterThanOrEqual(0);
  });

  it('pairs every cost with a value ratio (R4)', () => {
    for (const initiative of initiatives) {
      expect(initiative.monthlyCost).toBeGreaterThan(0);
      // The defensible numerator (quality floor + harm subtraction) may go
      // non-positive; the pairing itself must stay finite and color-coded.
      expect(Number.isFinite(initiative.valueRatio)).toBe(true);
      expect(initiative.valueColor).toMatch(/^#/);
    }
  });

  it('renders the value-negative seed honestly (poor color, finite ratio)', () => {
    const negative = initiatives.filter((i) => i.valueRatio <= 0);
    expect(negative.length).toBeGreaterThan(0);
    for (const initiative of negative) {
      expect(initiative.valueColor).toBe('#ff5c72');
    }
  });

  it('keeps budget consumed within 0..100', () => {
    for (const initiative of initiatives) {
      expect(initiative.budgetConsumedPct).toBeGreaterThanOrEqual(0);
      expect(initiative.budgetConsumedPct).toBeLessThanOrEqual(100);
    }
  });

  it('uses the locked status labels + token colors', () => {
    expect(INITIATIVE_STATUS_META.on_track).toEqual({ label: 'On Track', color: '#00e09e' });
    expect(INITIATIVE_STATUS_META.at_risk).toEqual({ label: 'At Risk', color: '#ffc44d' });
    expect(INITIATIVE_STATUS_META.pending_approval).toEqual({
      label: 'Pending Approval',
      color: '#7c8dff',
    });
  });

  it('toInitiativeView mirrors the workload monthly spend', () => {
    const w = WORKLOADS[0];
    expect(toInitiativeView(w).monthlyCost).toBe(w.costs.monthly_spend);
  });
});

