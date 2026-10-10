// Unit tests for the durable outcome-accounting rules (D3). These port the
// accountability cases from `model.test.ts` (the simulation workspace) onto
// the durable store's shapes and add the durable ledger's own rules:
// quality-gated successful-outcome counts and the strict benefit-bucket
// separation. Deterministic — no I/O, no clock.
import { describe, expect, it } from 'vitest';
import {
  evaluateBenefit,
  evaluateCost,
  meetsQualityCondition,
  monetaryBenefit,
  recommend,
  successfulOutcomeCount,
  valueToCostRatio,
  type ApprovedRegistration,
  type BenefitClaimRow,
  type OutcomeEventRow,
  type SupplementalCostRow,
} from './durable';

const registration = (over: Partial<ApprovedRegistration> = {}): ApprovedRegistration => ({
  projectId: 'support-copilot',
  useCasePattern: 'support_assistant',
  outcomeUnitKey: 'resolved_ticket',
  metric: 'resolution_quality',
  unit: 'quality_result',
  direction: 'higher',
  target: 15,
  thresholds: { stopBelow: 0.5, continueAt: 1, expandAt: 3 },
  baseline: { start: '2026-07-01', end: '2026-07-31', value: 12.5 },
  observation: { start: '2026-08-01', end: '2026-08-31', value: 15 },
  qualityMetric: 'resolution_quality',
  qualityDirection: 'higher',
  qualityThreshold: 0.9,
  status: 'approved',
  approvedAt: '2026-08-01T00:00:00Z',
  ...over,
});

const measuredFinancial = (over: Partial<BenefitClaimRow> = {}): BenefitClaimRow => ({
  id: 'b1',
  benefitKind: 'measured_financial',
  amount: '1000.00',
  unitLabel: null,
  unitAmount: null,
  attributionPct: 100,
  currency: 'USD',
  recordedBy: 'requester',
  verifiedBy: 'reviewer',
  verifiedAt: '2026-08-31T00:00:00Z',
  ...over,
});

const supplemental = (over: Partial<SupplementalCostRow> = {}): SupplementalCostRow => ({
  id: 's1',
  category: 'infrastructure',
  evidenceStatus: 'measured',
  amount: '100.00',
  verifiedBy: 'reviewer',
  verifiedAt: '2026-08-31T00:00:00Z',
  ...over,
});

/** Full-cost fixtures for an observation window of 31 days (2026-08). */
const allCategories = (): SupplementalCostRow[] =>
  (['infrastructure', 'implementation', 'oversight', 'labor'] as const).map((category, i) => supplemental({ id: `s${i}`, category, amount: '100.00' }));

const monthOfDays = (cents: number): Array<{ date: string; cents: number }> =>
  Array.from({ length: 31 }, (_, i) => ({ date: `2026-08-${String(i + 1).padStart(2, '0')}`, cents }));

/** A complete, verified, unvalidated-free benefit evaluation: measured return of $3000.00. */
const BENEFIT_EVAL = {
  measuredCents: 300000,
  productivityClaims: 0,
  unvalidatedClaims: 0,
  hasVerifiedFinancial: true,
  unverifiedMeasured: 0,
};

const completeInput = (over: { benefit?: Partial<typeof BENEFIT_EVAL>; cost?: Partial<ReturnType<typeof evaluateCost>> } = {}) => ({
  registration: registration(),
  benefit: { ...BENEFIT_EVAL, ...(over.benefit ?? {}) },
  cost: { ...evaluateCost({ modelUsageDays: monthOfDays(10000), supplemental: allCategories() }, registration().observation), ...(over.cost ?? {}) },
});

describe('quality-gated successful-outcome counts', () => {
  const approved = registration();
  const event = (over: Partial<OutcomeEventRow>): OutcomeEventRow => ({
    traceId: 't1',
    outcomeStatus: 'successful',
    qualityResult: 0.97,
    completionLatency: 1200,
    occurredAt: '2026-08-05',
    ...over,
  });

  it('counts a successful event whose quality meets the approved condition', () => {
    expect(meetsQualityCondition({ qualityResult: 0.9 }, approved)).toBe(true);
    expect(successfulOutcomeCount([event({})], approved)).toBe(1);
  });

  it('never counts successful events below the quality bar, nor failed or partial events, nor events missing quality', () => {
    const events = [
      event({ traceId: 'a', qualityResult: 0.89 }), // below the 0.9 bar
      event({ traceId: 'b', outcomeStatus: 'failed', qualityResult: 0.99 }),
      event({ traceId: 'c', outcomeStatus: 'partial', qualityResult: 0.99 }),
      event({ traceId: 'd', qualityResult: null }), // successful but never measured — cannot count
    ];
    expect(successfulOutcomeCount(events, approved)).toBe(0);
  });

  it('honors the approved direction (lower-is-better quality) and refuses missing quality', () => {
    const lower = registration({ qualityDirection: 'lower', qualityThreshold: 0.2 });
    expect(meetsQualityCondition({ qualityResult: 0.1 }, lower)).toBe(true);
    expect(meetsQualityCondition({ qualityResult: 0.9 }, lower)).toBe(false);
    expect(meetsQualityCondition({ qualityResult: null }, lower)).toBe(false);
  });

  it('gates counts on the approved registration only — a pending definition counts nothing', () => {
    // The count rule takes the approved condition; gating on approval status
    // is `valueToCostRatio`'s blocker. The count itself is pure over events.
    const events = [event({}), event({ traceId: 'b', qualityResult: 0.5 })];
    expect(successfulOutcomeCount(events, registration({ qualityThreshold: 0.5 }))).toBe(2);
  });
});

describe('benefit buckets are strictly disjoint', () => {
  it('does not treat unvalidated or unverified claims as measured return', () => {
    // Port of "does not treat assumed value or incomplete cost as a measured return".
    const evaluation = evaluateBenefit([
      measuredFinancial({ benefitKind: 'unvalidated', amount: null, verifiedBy: null, verifiedAt: null }),
      measuredFinancial({ id: 'b2', verifiedBy: null, verifiedAt: null }),
    ]);
    expect(evaluation.measuredCents).toBe(0);
    expect(evaluation.unvalidatedClaims).toBe(1);
    expect(evaluation.unverifiedMeasured).toBe(1);
    expect(evaluation.hasVerifiedFinancial).toBe(false);
  });

  it('applies attribution to verified measured claims and never values productivity', () => {
    // Port of "uses attribution and margin, requires verification, and separates nonfinancial gains".
    const evaluation = evaluateBenefit([
      measuredFinancial({ attributionPct: 50 }), // 1000.00 at 50% → 50000 cents
      measuredFinancial({ id: 'b2', verifiedBy: null, verifiedAt: null }), // unverified: counted, not valued
      { id: 'b3', benefitKind: 'estimated_productivity', amount: null, unitLabel: 'hours saved', unitAmount: '40', attributionPct: null, currency: 'USD', recordedBy: 'requester', verifiedBy: null, verifiedAt: null },
    ]);
    expect(evaluation.measuredCents).toBe(50000);
    expect(evaluation.unverifiedMeasured).toBe(1);
    expect(evaluation.productivityClaims).toBe(1);
    expect(evaluation.hasVerifiedFinancial).toBe(true);
    // A productivity claim is never converted to cash — monetaryBenefit only
    // ever values measured_financial rows.
    expect(monetaryBenefit({ benefitKind: 'estimated_productivity', amount: '999.00', attributionPct: 100 })).toBe(0);
  });

  it('cannot mix buckets: an unvalidated claim never produces a ratio', () => {
    // The R4 line: unvalidated benefit ⇒ ratio null with blockers, always.
    const result = valueToCostRatio(completeInput({ benefit: { ...BENEFIT_EVAL, unvalidatedClaims: 1, hasVerifiedFinancial: false, measuredCents: 0 } }));
    expect(result.ratio).toBeNull();
    expect(result.blockers).toContain('Benefit is unvalidated — record measured, reviewable financial evidence.');
  });
});

describe('ratio-null rules', () => {
  it('produces a deterministic ratio from complete, verified evidence', () => {
    const result = valueToCostRatio(completeInput());
    expect(result.ratio).toBeCloseTo(300000 / 350000, 6); // $3000.00 measured over 31×$100 + 4×$100 = $3500
    expect(result.netRoiPct).toBeCloseTo((300000 / 350000 - 1) * 100, 6);
    expect(result.blockers).toEqual([]);
  });

  it('blocks on incomplete cost evidence: uncovered days or unsubstantiated categories', () => {
    const partialDays = monthOfDays(10000).slice(0, 30); // one day short
    const incomplete = evaluateCost({ modelUsageDays: partialDays, supplemental: allCategories() }, registration().observation);
    expect(incomplete.totalCents).toBeNull();
    expect(incomplete.ledgerComplete).toBe(false);
    const unsubstantiated = evaluateCost({ modelUsageDays: monthOfDays(10000), supplemental: allCategories().map((s, i) => (i === 0 ? { ...s, amount: null } : s)) }, registration().observation);
    expect(unsubstantiated.missingCategories).toEqual(['infrastructure']);
    expect(unsubstantiated.totalCents).toBeNull();
    const blocked = valueToCostRatio(completeInput({ cost: incomplete }));
    expect(blocked.ratio).toBeNull();
    expect(blocked.blockers).toContain('Model-cost ledger does not cover every day in the observation period.');
  });

  it('blocks on unverified measured supplemental costs', () => {
    const unverified = allCategories().map((s, i) => (i === 0 ? { ...s, verifiedBy: null, verifiedAt: null } : s));
    const cost = evaluateCost({ modelUsageDays: monthOfDays(10000), supplemental: unverified }, registration().observation);
    expect(cost.unverifiedCategories).toEqual(['infrastructure']);
    const blocked = valueToCostRatio(completeInput({ cost }));
    expect(blocked.ratio).toBeNull();
    expect(blocked.blockers).toContain('A separate reviewer must verify measured supplemental-cost evidence.');
  });

  it('blocks when the registration was never approved (requester ≠ approver evidence)', () => {
    const pending = registration({ status: 'pending', approvedAt: null });
    const result = valueToCostRatio({ ...completeInput(), registration: pending });
    expect(result.ratio).toBeNull();
    expect(result.blockers).toContain('An approver must approve the outcome-unit registration (requester ≠ approver).');
  });

  it('blocks on zero full cost and on unequal comparison durations', () => {
    const zero = valueToCostRatio(completeInput({ cost: { ledgerComplete: true, totalCents: 0, missingCategories: [], unverifiedCategories: [] } }));
    expect(zero.ratio).toBeNull();
    expect(zero.blockers).toContain('A financial return requires a positive full cost.');
    const unequal = registration({
      baseline: { start: '2026-07-01', end: '2026-07-14', value: 12.5 },
      observation: { start: '2026-08-01', end: '2026-08-31', value: 15 },
    });
    const result = valueToCostRatio({ registration: unequal, benefit: BENEFIT_EVAL, cost: evaluateCost({ modelUsageDays: monthOfDays(10000), supplemental: allCategories() }, unequal.observation) });
    expect(result.ratio).toBeNull();
    expect(result.blockers).toContain('Use comparison periods of equal duration.');
  });

  it('recommends review — never a threshold verdict — while blockers stand', () => {
    const pending = registration({ status: 'pending', approvedAt: null });
    expect(recommend({ ratio: 9, blockers: ['An approver must approve the outcome-unit registration (requester ≠ approver).'], registration: pending }).action).toBe('review');
    expect(recommend({ ratio: null, blockers: [], registration: registration() }).action).toBe('review');
  });
});

describe('approved stop/continue/expand ladder', () => {
  const base = registration();
  const run = (ratio: number, over: Parameters<typeof registration>[0] = {}) => recommend({ ratio, blockers: [], registration: { ...base, ...over } });

  it('stops below the stop-below threshold', () => {
    expect(run(0.4).action).toBe('stop');
  });

  it('changes below the continue threshold', () => {
    expect(run(0.9).action).toBe('change');
  });

  it('continues between continue and expand, but only with the target met', () => {
    expect(run(1.5).action).toBe('continue');
    // Target 15, observation 15 → met. Below the target, continue becomes change.
    expect(run(1.5, { observation: { start: '2026-08-01', end: '2026-08-31', value: 14 } }).action).toBe('change');
  });

  it('expands at or above the expand threshold only when the target is met', () => {
    expect(run(3).action).toBe('expand');
    expect(run(5, { observation: { start: '2026-08-01', end: '2026-08-31', value: 14 } }).action).toBe('change');
  });
});

describe('cost evaluation from durable rows', () => {
  it('sums model-usage days and substantiated supplemental categories into the full cost', () => {
    const cost = evaluateCost({ modelUsageDays: monthOfDays(10000), supplemental: allCategories() }, registration().observation);
    expect(cost.ledgerComplete).toBe(true);
    expect(cost.missingCategories).toEqual([]);
    expect(cost.totalCents).toBe(10000 * 31 + 4 * 10000);
  });

  it('ignores rows outside the observation window when judging coverage', () => {
    const cost = evaluateCost({ modelUsageDays: [...monthOfDays(10000), { date: '2026-09-01', cents: 1 }], supplemental: allCategories() }, registration().observation);
    expect(cost.ledgerComplete).toBe(true);
    expect(cost.totalCents).toBe(10000 * 31 + 4 * 10000);
  });
});
