import type { CostEntry } from "@/simulation/types";
import type { Workload } from "@/types";
import {
  COST_CATEGORIES,
  type OutcomeRecord,
  type ValueMeasure,
  type OutcomeAction,
} from "./types";

export function seedOutcome(w: Workload): OutcomeRecord {
  return {
    workloadId: w.id,
    owner: `${w.team} owner (simulated)`,
    ownerRole: "Business outcome owner",
    metric: "Successful task completion",
    unit: "%",
    direction: "higher",
    target: 85,
    baseline: {
      value: 70,
      start: "2026-05-01",
      end: "2026-05-25",
      reference: "Simulated pre-AI comparison sample",
    },
    observation: {
      value: 83,
      start: "2026-06-01",
      end: "2026-06-25",
      reference: "Simulated AI-assisted comparison sample",
    },
    thresholds: { stopBelow: 0.5, continueAt: 1, expandAt: 3 },
    costs: Object.fromEntries(
      COST_CATEGORIES.map((k) => [
        k,
        { cents: null, status: "assumed", reference: "" },
      ]),
    ) as OutcomeRecord["costs"],
    measures: [
      {
        id: "seed-value",
        category: "cost_savings",
        title: "Seeded business-value assumption",
        status: "assumed",
        amountCents: Math.round(w.value.total_value * 100),
        contributionMarginPct: 100,
        attributionPct: 100,
        recordedBy: "Simulation fixture",
        reference: "Bundled simulation fixture",
        method:
          "Illustrative value assumption; validate with finance before use",
      },
    ],
    decisions: [],
  };
}
export function monetaryBenefit(m: ValueMeasure): number {
  if (
    !["revenue", "cost_savings"].includes(m.category) ||
    m.amountCents === null
  )
    return 0;
  return Math.round(
    ((m.amountCents * m.attributionPct) / 100) *
      (m.category === "revenue" ? m.contributionMarginPct / 100 : 1),
  );
}
export function evaluateOutcome(record: OutcomeRecord, ledger: CostEntry[]) {
  const performanceReviewed = Boolean(record.planVerified);
  const modelRows = ledger.filter(
    (r) =>
      r.category === "model_usage" &&
      r.workloadId === record.workloadId &&
      r.date >= record.observation.start &&
      r.date <= record.observation.end,
  );
  const modelCents = modelRows.reduce((n, r) => n + r.cents, 0);
  const days =
    Math.round(
      (Date.parse(record.observation.end) -
        Date.parse(record.observation.start)) /
        86400000,
    ) + 1;
  const ledgerComplete = new Set(modelRows.map((r) => r.date)).size === days;
  const missingCosts = COST_CATEGORIES.filter(
    (k) => record.costs[k].cents === null,
  );
  const estimatedCostCents =
    modelCents +
    COST_CATEGORIES.reduce((n, k) => n + (record.costs[k].cents ?? 0), 0);
  const costsMeasured =
    ledgerComplete &&
    missingCosts.length === 0 &&
    COST_CATEGORIES.every(
      (k) => record.costs[k].status === "measured" && record.costs[k].verified,
    );
  const unverifiedCosts = COST_CATEGORIES.filter(
    (k) => record.costs[k].status === "measured" && !record.costs[k].verified,
  );
  const totalCostCents =
    ledgerComplete && missingCosts.length === 0 ? estimatedCostCents : null;
  const measuredBenefitCents = record.measures
    .filter((m) => m.status === "measured" && m.verified)
    .reduce((n, m) => n + monetaryBenefit(m), 0);
  const projectedBenefitCents = record.measures
    .filter((m) => m.status === "projected")
    .reduce((n, m) => n + monetaryBenefit(m), 0);
  const assumedBenefitCents = record.measures
    .filter((m) => m.status === "assumed")
    .reduce((n, m) => n + monetaryBenefit(m), 0);
  const hasVerifiedFinancial = record.measures.some(
    (m) =>
      m.status === "measured" &&
      m.verified &&
      ["revenue", "cost_savings"].includes(m.category),
  );
  const measuredRatio =
    costsMeasured &&
    totalCostCents !== null &&
    totalCostCents > 0 &&
    hasVerifiedFinancial
      ? measuredBenefitCents / totalCostCents
      : null;
  const improvement =
    (record.observation.value - record.baseline.value) *
    (record.direction === "higher" ? 1 : -1);
  const improvementPct =
    record.baseline.value === 0
      ? null
      : (improvement / Math.abs(record.baseline.value)) * 100;
  const targetMet =
    record.direction === "higher"
      ? record.observation.value >= record.target
      : record.observation.value <= record.target;
  const equalDuration =
    Date.parse(record.baseline.end) - Date.parse(record.baseline.start) ===
    Date.parse(record.observation.end) - Date.parse(record.observation.start);
  const blockers: string[] = [];
  if (!ledgerComplete)
    blockers.push(
      "Model-cost ledger does not cover every day in the observation period.",
    );
  if (!costsMeasured)
    blockers.push("Record and substantiate all full-cost categories.");
  if (unverifiedCosts.length > 0)
    blockers.push("A separate reviewer must verify measured full-cost evidence.");
  if (!hasVerifiedFinancial)
    blockers.push("A reviewer must verify measured financial evidence.");
  if (record.measures.some((m) => m.status === "measured" && !m.verified))
    blockers.push("Measured claims await evidence review.");
  if (!equalDuration)
    blockers.push("Use comparison periods of equal duration.");
  if (!performanceReviewed)
    blockers.push("A separate reviewer must verify the baseline and observation evidence.");
  if (totalCostCents === 0)
    blockers.push("A financial return requires a positive full cost.");
  let recommendation: OutcomeAction | "review" = "review";
  if (performanceReviewed && measuredRatio !== null && blockers.length === 0) {
    recommendation =
      measuredRatio < record.thresholds.stopBelow
        ? "stop"
        : measuredRatio < record.thresholds.continueAt
          ? "change"
          : measuredRatio >= record.thresholds.expandAt && targetMet
            ? "expand"
            : "continue";
    if (!targetMet && recommendation === "continue") recommendation = "change";
  }
  return {
    modelCents,
    ledgerComplete,
    missingCosts,
    estimatedCostCents,
    totalCostCents,
    costsMeasured,
    unverifiedCosts,
    measuredBenefitCents,
    projectedBenefitCents,
    assumedBenefitCents,
    measuredRatio,
    netRoiPct: measuredRatio === null ? null : (measuredRatio - 1) * 100,
    improvement,
    improvementPct,
    targetMet,
    equalDuration,
    performanceReviewed,
    recommendation,
    blockers,
  };
}
// Stable input signature keeps historic decisions visible when their evidence or costs change.
export function outcomeBasis(
  record: OutcomeRecord,
  ledger: CostEntry[],
  governance?: Workload["governance"],
): string {
  const inputs = { ...record, decisions: undefined };
  return JSON.stringify({
    inputs,
    governance,
    ledger: ledger.filter(
      (r) =>
        r.workloadId === record.workloadId &&
        r.date >= record.observation.start &&
        r.date <= record.observation.end,
    ),
  });
}
