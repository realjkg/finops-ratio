export type EvidenceStatus = "assumed" | "projected" | "measured";
export type ValueCategory = "revenue" | "cost_savings" | "quality" | "risk";
export const COST_CATEGORIES = [
  "infrastructure",
  "implementation",
  "oversight",
  "labor",
] as const;
export type AdditionalCostCategory = (typeof COST_CATEGORIES)[number];
export interface PerformanceSample {
  value: number;
  start: string;
  end: string;
  reference: string;
}
export interface ValueMeasure {
  id: string;
  category: ValueCategory;
  title: string;
  status: EvidenceStatus;
  amountCents: number | null;
  contributionMarginPct: number;
  attributionPct: number;
  reference: string;
  method: string;
  recordedBy: string;
  verified?: { by: string; at: string };
}
export interface AdditionalCost {
  cents: number | null;
  status: EvidenceStatus;
  reference: string;
  recordedBy?: string;
  verified?: { by: string; at: string };
}
export type OutcomeAction = "continue" | "expand" | "change" | "stop";
export interface OutcomeDecision {
  action: OutcomeAction;
  rationale: string;
  by: string;
  at: string;
  basis: string;
  recommendation: OutcomeAction | "review";
}
export interface OutcomeRecord {
  workloadId: string;
  owner: string;
  ownerRole: string;
  planRecordedBy?: string;
  planVerified?: { by: string; at: string };
  metric: string;
  unit: string;
  baseline: PerformanceSample;
  observation: PerformanceSample;
  direction: "higher" | "lower";
  target: number;
  thresholds: { stopBelow: number; continueAt: number; expandAt: number };
  costs: Record<AdditionalCostCategory, AdditionalCost>;
  measures: ValueMeasure[];
  decisions: OutcomeDecision[];
}
