// Shared types for the Frank mock analytics modules. Pure data shapes only.

import type { AIAlertSnapshot } from '../AIClient';
import type { EvidenceStatus } from '@/types';

/** One workload, joined from the initiative board + workload snapshot (+ seed fallback). */
export interface WorkloadFacts {
  id: string;
  name: string;
  team: string | null;
  provider: string | null;
  model: string | null;
  monthlySpend: number;
  /** Defensible monthly value in USD. */
  monthlyValue: number;
  /** monthlyValue / monthlySpend; null when spend is not positive. */
  ratio: number | null;
  evidence: EvidenceStatus | undefined;
  status: string | null;
  budgetConsumedPct: number | null;
  monthlyBudget: number | null;
  savings: number;
  cacheHitRate: number | null;
  costTrendPct: number | null;
  demandShape: string | null;
  gatesPassed: number | null;
  calls: number | null;
  tokIn: number | null;
  tokOut: number | null;
  tokCached: number | null;
  alerts: AIAlertSnapshot[] | null;
}

export interface World {
  asOf: string;
  workloads: WorkloadFacts[];
  /** Distinct team names, first-seen order; empty when no workload has a team. */
  teams: string[];
}

/** What the conversation is currently about. */
export type Scope =
  | { kind: 'portfolio' }
  | { kind: 'team'; team: string }
  | { kind: 'workload'; id: string }
  | { kind: 'model'; model: string };

export interface Rollup {
  members: WorkloadFacts[];
  spend: number;
  value: number;
  ratio: number | null;
  evidence: EvidenceStatus | undefined;
}

/** An answer body plus the ladder that continues from it. */
export interface Answer {
  /** Header line (exactly one subject entity, so memory can read it back). */
  header: string;
  body: string[];
  /** Assumption lines, echoed verbatim. */
  assumptions?: string[];
  /** Heading for the assumption block; defaults to "Assumptions". */
  assumptionsTitle?: string;
  /** 2-3 concrete questions Frank can answer next. */
  next: string[];
  referenced: string[];
}
