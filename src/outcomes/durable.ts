// Durable outcome-accounting rules (D3): the pure half of the outcome ledger
// that lives on the `ratio` Postgres schema. `model.ts`/`types.ts` remain the
// simulation workspace's record and rules; this module ports the decision
// rules onto the durable store's shapes (contract v1 outcome fields,
// evidence-backed claims) and adds the quality-gated success rule that the
// durable event ledger makes possible. Zero I/O — callers read rows from the
// governed store and feed them in; every number produced is deterministic.
//
// Honesty invariants (unchanged from the simulation model):
// - the three benefit buckets are strictly disjoint — measured financial,
//   estimated productivity, and unvalidated claims never mix;
// - estimated productivity is never converted to cash;
// - value-to-cost is `null` with human-readable blockers whenever the benefit
//   side is unvalidated or the cost side is incomplete — never a guess.

/** The three benefit buckets. `measured_financial` is the only monetary one. */
export const BENEFIT_KINDS = ['measured_financial', 'estimated_productivity', 'unvalidated'] as const;
export type BenefitKind = (typeof BENEFIT_KINDS)[number];

/** Evidence status of a supplemental-cost or benefit row (contract v1). */
export const EVIDENCE_STATUSES = ['assumed', 'projected', 'measured'] as const;
export type EvidenceStatus = (typeof EVIDENCE_STATUSES)[number];

/** Contract v1 outcome_status values (consumption-trace workflow completions). */
export const OUTCOME_STATUSES = ['successful', 'failed', 'partial'] as const;
export type OutcomeStatus = (typeof OUTCOME_STATUSES)[number];

/** Approved use-case patterns the registry accepts (D3; the four brief patterns). */
export const USE_CASE_PATTERNS = ['support_assistant', 'document_processing', 'engineering_assistant', 'workflow_agent'] as const;
export type UseCasePattern = (typeof USE_CASE_PATTERNS)[number];

/** Supplemental full-cost categories (contract v1), ported from the simulation record. */
export const COST_CATEGORIES = ['infrastructure', 'implementation', 'oversight', 'labor'] as const;
export type AdditionalCostCategory = (typeof COST_CATEGORIES)[number];

export type OutcomeAction = 'continue' | 'expand' | 'change' | 'stop';

/** The approved registration row as read from `ratio.outcome_unit_registrations`. */
export interface ApprovedRegistration {
  projectId: string;
  useCasePattern: UseCasePattern;
  /** useful outcome unit, e.g. 'resolved_ticket' */
  outcomeUnitKey: string;
  metric: string;
  unit: string;
  direction: 'higher' | 'lower';
  target: number;
  thresholds: { stopBelow: number; continueAt: number; expandAt: number };
  baseline: { start: string; end: string; value: number };
  observation: { start: string; end: string; value: number };
  qualityMetric: string;
  qualityDirection: 'higher' | 'lower';
  qualityThreshold: number;
  status: 'pending' | 'approved' | 'superseded';
  approvedAt: string | null;
}

/** A benefit-claim row as read from `ratio.outcome_benefit_evidence`. */
export interface BenefitClaimRow {
  id: string;
  benefitKind: BenefitKind;
  /** numeric text from the store, or null when the claim carries no amount */
  amount: string | null;
  unitLabel: string | null;
  /** numeric text; the productivity unit's amount — never a cash value */
  unitAmount: string | null;
  attributionPct: number | null;
  currency: string;
  recordedBy: string | null;
  verifiedBy: string | null;
  verifiedAt: string | null;
}

/** A supplemental-cost row as read from `ratio.outcome_supplemental_costs`. */
export interface SupplementalCostRow {
  id: string;
  category: AdditionalCostCategory;
  evidenceStatus: EvidenceStatus;
  /** numeric text from the store, or null while unsubstantiated */
  amount: string | null;
  verifiedBy: string | null;
  verifiedAt: string | null;
}

/** An outcome event as read from `ratio.outcome_events` (via the published view or a direct read). */
export interface OutcomeEventRow {
  traceId: string;
  outcomeStatus: OutcomeStatus;
  qualityResult: number | null;
  completionLatency: number | null;
  /** the event's data_as_of / occurred_at day, ISO date */
  occurredAt: string;
}

// ---------------------------------------------------------------------------
// Quality gating — the success rule
// ---------------------------------------------------------------------------

/**
 * Does the event's quality result meet the approved quality condition?
 * An event without a quality result never qualifies (a success cannot be
 * asserted from missing evidence).
 */
export function meetsQualityCondition(
  event: Pick<OutcomeEventRow, 'qualityResult'>,
  approved: Pick<ApprovedRegistration, 'qualityDirection' | 'qualityThreshold'>,
): boolean {
  if (event.qualityResult === null) return false;
  return approved.qualityDirection === 'higher' ? event.qualityResult >= approved.qualityThreshold : event.qualityResult <= approved.qualityThreshold;
}

/**
 * Successful-outcome count for the registered quality condition: an event
 * counts only when its workflow completion succeeded AND its quality result
 * meets the approved condition. Failed and partial events never count, and
 * neither do "successful" events that miss the quality bar.
 */
export function successfulOutcomeCount(events: readonly OutcomeEventRow[], approved: Pick<ApprovedRegistration, 'qualityDirection' | 'qualityThreshold'>): number {
  return events.filter((e) => e.outcomeStatus === 'successful' && meetsQualityCondition(e, approved)).length;
}

// ---------------------------------------------------------------------------
// Performance summary (baseline vs observation) — ported from the simulation
// ---------------------------------------------------------------------------

/** Calendar days in [start, end] inclusive (UTC), ported from the simulation's day count. */
export function periodDays(start: string, end: string): number {
  return Math.round((Date.parse(end) - Date.parse(start)) / 86400000) + 1;
}

/**
 * True when dated evidence rows cover every day of the observation period
 * (the simulation's `ledgerComplete` rule: distinct covered days equal the
 * period length). Rows outside the window do not count.
 */
export function ledgerCoversObservation(dates: readonly string[], observation: { start: string; end: string }): boolean {
  const inWindow = dates.filter((d) => d >= observation.start && d <= observation.end);
  return new Set(inWindow).size === periodDays(observation.start, observation.end);
}

/** Baseline and observation periods have equal duration (the simulation's guard). */
export function equalDuration(baseline: { start: string; end: string }, observation: { start: string; end: string }): boolean {
  return Date.parse(baseline.end) - Date.parse(baseline.start) === Date.parse(observation.end) - Date.parse(observation.start);
}

/** Observation-target comparison under the approved direction. */
export function targetMet(registration: Pick<ApprovedRegistration, 'direction' | 'target' | 'observation'>): boolean {
  return registration.direction === 'higher' ? registration.observation.value >= registration.target : registration.observation.value <= registration.target;
}

/** Absolute movement toward the target direction (units, not percent). */
export function improvement(registration: Pick<ApprovedRegistration, 'direction' | 'baseline' | 'observation'>): number {
  return (registration.observation.value - registration.baseline.value) * (registration.direction === 'higher' ? 1 : -1);
}

/** Percent movement relative to |baseline|, or null when the baseline is zero. */
export function improvementPct(registration: Pick<ApprovedRegistration, 'direction' | 'baseline' | 'observation'>): number | null {
  if (registration.baseline.value === 0) return null;
  return (improvement(registration) / Math.abs(registration.baseline.value)) * 100;
}

// ---------------------------------------------------------------------------
// Benefit buckets — strictly disjoint
// ---------------------------------------------------------------------------

export interface BenefitEvaluation {
  /** attributed monetary value of VERIFIED measured_financial claims, cents */
  measuredCents: number;
  /** count of estimated_productivity claims — never converted to cash */
  productivityClaims: number;
  /** count of unvalidated claims — no value is asserted for them at all */
  unvalidatedClaims: number;
  /** at least one verified measured_financial claim exists */
  hasVerifiedFinancial: boolean;
  /** measured_financial claims still awaiting a separate reviewer */
  unverifiedMeasured: number;
}

/** Attribution-adjusted monetary value of one measured_financial claim, cents. */
export function monetaryBenefit(claim: Pick<BenefitClaimRow, 'benefitKind' | 'amount' | 'attributionPct'>): number {
  if (claim.benefitKind !== 'measured_financial' || claim.amount === null) return 0;
  const cents = Math.round(Number(claim.amount) * 100);
  const attribution = claim.attributionPct ?? 100;
  return Math.round((cents * attribution) / 100);
}

/**
 * Reduce benefit rows into the three disjoint buckets. Only verified
 * measured_financial claims carry monetary weight; estimated productivity is
 * counted, never valued; unvalidated claims are counted and block the ratio.
 */
export function evaluateBenefit(claims: readonly BenefitClaimRow[]): BenefitEvaluation {
  let measuredCents = 0;
  let productivityClaims = 0;
  let unvalidatedClaims = 0;
  let hasVerifiedFinancial = false;
  let unverifiedMeasured = 0;
  for (const c of claims) {
    if (c.benefitKind === 'measured_financial') {
      if (c.verifiedBy) {
        measuredCents += monetaryBenefit(c);
        hasVerifiedFinancial = true;
      } else {
        unverifiedMeasured += 1;
      }
    } else if (c.benefitKind === 'estimated_productivity') {
      productivityClaims += 1;
    } else {
      unvalidatedClaims += 1;
    }
  }
  return { measuredCents, productivityClaims, unvalidatedClaims, hasVerifiedFinancial, unverifiedMeasured };
}

// ---------------------------------------------------------------------------
// Full-cost side
// ---------------------------------------------------------------------------

export interface CostEvaluation {
  /** model-cost rows' days cover the observation period (ledgerComplete) */
  ledgerComplete: boolean;
  /** full cost in cents, or null while the evidence is incomplete */
  totalCents: number | null;
  /** supplemental categories with no amount recorded yet */
  missingCategories: AdditionalCostCategory[];
  /** supplemental categories recorded as measured but unverified */
  unverifiedCategories: AdditionalCostCategory[];
}

/**
 * Full-cost evaluation: model usage cents (per-day rows, caller-supplied as
 * amounts plus their dates) plus every supplemental category with an amount.
 * The total is `null` while any day of the observation window is uncovered or
 * any category lacks an amount — an incomplete cost is not a cost.
 */
export function evaluateCost(
  input: {
    /** one entry per day with model usage: the ISO day and its cost in cents */
    modelUsageDays: ReadonlyArray<{ date: string; cents: number }>;
    supplemental: readonly SupplementalCostRow[];
  },
  observation: { start: string; end: string },
): CostEvaluation {
  const ledgerComplete = ledgerCoversObservation(
    input.modelUsageDays.map((d) => d.date),
    observation,
  );
  const missingCategories = COST_CATEGORIES.filter((k) => !input.supplemental.some((s) => s.category === k && s.amount !== null));
  const unverifiedCategories = COST_CATEGORIES.filter((k) => input.supplemental.some((s) => s.category === k && s.evidenceStatus === 'measured' && !s.verifiedBy));
  // Only usage inside the observation window counts toward the period's cost.
  const modelCents = input.modelUsageDays
    .filter((d) => d.date >= observation.start && d.date <= observation.end)
    .reduce((n, d) => n + d.cents, 0);
  const supplementalCents = input.supplemental.reduce((n, s) => n + (s.amount === null ? 0 : Math.round(Number(s.amount) * 100)), 0);
  const totalCents = ledgerComplete && missingCategories.length === 0 ? modelCents + supplementalCents : null;
  return { ledgerComplete, totalCents, missingCategories, unverifiedCategories };
}

// ---------------------------------------------------------------------------
// Value-to-cost — null with blockers, never a guess
// ---------------------------------------------------------------------------

export interface ValueToCostInput {
  registration: ApprovedRegistration;
  benefit: BenefitEvaluation;
  cost: CostEvaluation;
}

export interface ValueToCost {
  /** validated attributable benefit / full cost — null when not evaluable */
  ratio: number | null;
  netRoiPct: number | null;
  /** human-readable reasons the ratio is unavailable (or empty when it exists) */
  blockers: string[];
}

/**
 * Value-to-cost ratio over durable rows. The ratio exists only when the
 * registration is approved, both comparison periods have equal duration, the
 * full cost is complete and positive, and measured financial benefit is
 * verified. Any unvalidated or unverified state yields `null` plus the
 * blocking reasons — an unvalidated benefit can never produce a ratio.
 */
export function valueToCostRatio(input: ValueToCostInput): ValueToCost {
  const { registration, benefit, cost } = input;
  const blockers: string[] = [];
  if (registration.status !== 'approved' || !registration.approvedAt) blockers.push('An approver must approve the outcome-unit registration (requester ≠ approver).');
  if (!cost.ledgerComplete) blockers.push('Model-cost ledger does not cover every day in the observation period.');
  if (cost.missingCategories.length > 0) blockers.push('Record and substantiate all supplemental cost categories.');
  if (cost.unverifiedCategories.length > 0) blockers.push('A separate reviewer must verify measured supplemental-cost evidence.');
  if (benefit.unverifiedMeasured > 0) blockers.push('Measured benefit claims await evidence review.');
  if (benefit.unvalidatedClaims > 0) blockers.push('Benefit is unvalidated — record measured, reviewable financial evidence.');
  if (!benefit.hasVerifiedFinancial) blockers.push('A reviewer must verify measured financial evidence.');
  if (!equalDuration(registration.baseline, registration.observation)) blockers.push('Use comparison periods of equal duration.');
  if (cost.totalCents !== null && cost.totalCents <= 0) blockers.push('A financial return requires a positive full cost.');
  const ratio = blockers.length === 0 && cost.totalCents !== null && cost.totalCents > 0 ? benefit.measuredCents / cost.totalCents : null;
  return { ratio, netRoiPct: ratio === null ? null : (ratio - 1) * 100, blockers };
}

// ---------------------------------------------------------------------------
// Recommendation ladder — the approved thresholds
// ---------------------------------------------------------------------------

export interface RecommendationInput {
  ratio: number | null;
  blockers: readonly string[];
  registration: Pick<ApprovedRegistration, 'thresholds' | 'observation' | 'target' | 'direction'>;
}

export interface Recommendation {
  action: OutcomeAction | 'review';
  rationale: string;
}

/**
 * Map the value-to-cost ratio onto the approved stop/continue/expand ladder.
 * `review` whenever the ratio is unavailable — the thresholds are only ever
 * applied to a validated ratio.
 */
export function recommend(input: RecommendationInput): Recommendation {
  const { ratio, blockers, registration } = input;
  if (ratio === null || blockers.length > 0) {
    return { action: 'review', rationale: blockers[0] ?? 'Value-to-cost is unavailable — review the evidence.' };
  }
  const met = targetMet(registration);
  const action: OutcomeAction =
    ratio < registration.thresholds.stopBelow ? 'stop' : ratio < registration.thresholds.continueAt ? 'change' : ratio >= registration.thresholds.expandAt && met ? 'expand' : 'continue';
  const finalAction: OutcomeAction = action === 'continue' && !met ? 'change' : action;
  const rationale: Record<OutcomeAction, string> = {
    stop: `Ratio ${ratio.toFixed(2)}× is below the stop-below threshold ${registration.thresholds.stopBelow}×.`,
    change: `Ratio ${ratio.toFixed(2)}× is below the continue threshold ${registration.thresholds.continueAt}×.`,
    continue: `Ratio ${ratio.toFixed(2)}× meets the continue threshold${met ? ' and the target' : ''}.`,
    expand: `Ratio ${ratio.toFixed(2)}× is at or above the expand threshold ${registration.thresholds.expandAt}× with the target met.`,
  };
  return { action: finalAction, rationale: rationale[finalAction] };
}
