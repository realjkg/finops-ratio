// Workload seed — spec §2.1, §12 (11 workloads across 7 teams; four teams run
// more than one workload so a team rollup is a real rollup, not a copy of the
// workload list). Rather than hand-author every
// derived figure (and risk drift), each workload is described by a compact spec
// of real drivers; `buildWorkload` computes token costs, daily/MTD spend, and
// value from the model registry so the numbers are guaranteed consistent.

import type {
  DemandShape,
  Environment,
  ModelProvider,
  Priority,
  Workload,
  WorkloadGovernance,
} from '@/types';
import { findModel } from './models';

// Deterministic demo clock so forecasts + budget bars are stable across reloads.
export const DEMO_NOW = new Date('2026-06-25T17:42:00Z');
const CURRENT_DAY = DEMO_NOW.getUTCDate(); // 25

// Fixed jitter pattern gives each daily-spend history realistic volatility
// (weekday peaks, weekend dips) without any randomness — reloads are identical.
const HISTORY_PATTERN = [0.92, 1.05, 0.98, 1.1, 0.88, 0.62, 0.65, 1.02, 1.07, 0.95, 1.12, 0.9];

interface WorkloadSeedSpec {
  id: string;
  name: string;
  model: string;
  provider: ModelProvider;
  team: string;
  environment: Environment;
  priority: Priority;
  demand_shape: DemandShape;
  // Volume so far today (partial day).
  callsToday: number;
  avgInputTokens: number;
  avgOutputTokens: number;
  cachedTokensToday: number;
  // Budget framing.
  dailyBudget: number;
  monthlyBudget: number;
  // Full-month run-rate spend (drives value ratio + forecast base).
  monthlySpend: number;
  // Value framing.
  valueRatio: number;
  revenueSplit: number; // fraction of total value that is revenue_protected
  // Outputs.
  resolutionRate: number;
  activeUsersDaily: number;
  activeUsersMonthly: number;
  csat: number | null;
  avgHandleTimeSeconds: number;
  deflectionRate: number;
  // Governance gates (sequential).
  gates: WorkloadGovernance;
  costTrendPct: number;
  volatility: number; // 0–1 amplitude of history jitter
}

function buildWorkload(spec: WorkloadSeedSpec): Workload {
  const model = findModel(spec.model);
  if (!model) throw new Error(`Unknown model in seed: ${spec.model}`);

  const inputCost = (spec.callsToday * spec.avgInputTokens) / 1_000_000 * model.pricing.input_per_1m;
  const outputCost =
    (spec.callsToday * spec.avgOutputTokens) / 1_000_000 * model.pricing.output_per_1m;
  const cachedRate = model.pricing.cached_input_per_1m ?? model.pricing.input_per_1m * 0.25;
  const cachedCost = (spec.cachedTokensToday / 1_000_000) * cachedRate;
  const compute = (inputCost + outputCost) * 0.05; // small infra overhead
  const dailySpend = round2(inputCost + outputCost + cachedCost + compute);

  const tokensInToday = spec.callsToday * spec.avgInputTokens;
  const tokensOutToday = spec.callsToday * spec.avgOutputTokens;

  const totalValue = Math.round(spec.valueRatio * spec.monthlySpend);
  const revenueProtected = Math.round(totalValue * spec.revenueSplit);
  const costAvoided = totalValue - revenueProtected;

  const monthlyInferences = Math.round(spec.callsToday * 0.85 * CURRENT_DAY);
  const resolvedQueries = Math.round(spec.callsToday * spec.resolutionRate);

  return {
    id: spec.id,
    name: spec.name,
    model: spec.model,
    model_provider: spec.provider,
    team: spec.team,
    environment: spec.environment,
    costs: {
      inference_cost_per_call: round4(dailySpend / Math.max(spec.callsToday, 1)),
      monthly_spend: spec.monthlySpend,
      daily_spend: dailySpend,
      daily_budget: spec.dailyBudget,
      monthly_budget: spec.monthlyBudget,
      compute: round2(compute),
      tokens_in_today: tokensInToday,
      tokens_out_today: tokensOutToday,
      tokens_in_mtd: tokensInToday * CURRENT_DAY,
      tokens_out_mtd: tokensOutToday * CURRENT_DAY,
    },
    outputs: {
      daily_inferences: spec.callsToday,
      monthly_inferences: monthlyInferences,
      resolved_queries: resolvedQueries,
      resolution_rate: spec.resolutionRate,
      active_users_daily: spec.activeUsersDaily,
      active_users_monthly: spec.activeUsersMonthly,
      csat: spec.csat,
      avg_handle_time_seconds: spec.avgHandleTimeSeconds,
      deflection_rate: spec.deflectionRate,
    },
    value: {
      revenue_protected: revenueProtected,
      cost_avoided: costAvoided,
      total_value: totalValue,
      value_ratio: round2(totalValue / spec.monthlySpend),
      // Honesty (audit C1): seed values are asserted demo inputs, not ledger
      // measurements — both components marked `assumed`; the headline inherits
      // the weakest mark (never `measured` — no fabricated provenance).
      evidence: { revenue_protected: 'assumed', cost_avoided: 'assumed' },
    },
    governance: spec.gates,
    demand_shape: spec.demand_shape,
    priority: spec.priority,
    cost_trend_pct: spec.costTrendPct,
    created_at: '2026-01-12T09:00:00Z',
    updated_at: DEMO_NOW.toISOString(),
  };
}

// Daily-spend history (most recent last) derived deterministically from the
// run-rate base + the workload's volatility. Used by the monthly forecast.
export function historyFor(monthlySpend: number, volatility: number, length = 12): number[] {
  const base = monthlySpend / 30;
  return HISTORY_PATTERN.slice(0, length).map((p) => {
    const swing = 1 + (p - 1) * volatility;
    return round2(base * swing);
  });
}

function round2(n: number): number {
  return Math.round(n * 100) / 100;
}
function round4(n: number): number {
  return Math.round(n * 10000) / 10000;
}

function gates(
  policy: boolean,
  ethics: boolean,
  cost: boolean,
  scale: boolean,
  approvedBy: string | null,
  lastReviewed: string,
): WorkloadGovernance {
  return {
    policy_check: policy,
    ethics_review: ethics,
    cost_approval: cost,
    scale_authorized: scale,
    last_reviewed: lastReviewed,
    approved_by: approvedBy,
  };
}

export const WORKLOAD_SEED_SPECS: WorkloadSeedSpec[] = [
  {
    id: 'wl-support',
    name: 'Customer Support Agent',
    model: 'claude-sonnet-4-20250514',
    provider: 'anthropic',
    team: 'CX Engineering',
    environment: 'prod',
    priority: 'critical',
    demand_shape: 'always_on',
    callsToday: 40000,
    avgInputTokens: 1200,
    avgOutputTokens: 340,
    cachedTokensToday: 9_500_000,
    dailyBudget: 500,
    monthlyBudget: 15000,
    monthlySpend: 13632,
    valueRatio: 14.9,
    revenueSplit: 0.56,
    resolutionRate: 0.831,
    activeUsersDaily: 7400,
    activeUsersMonthly: 22100,
    csat: 4.2,
    avgHandleTimeSeconds: 48,
    deflectionRate: 0.62,
    gates: gates(true, true, true, true, 'm.po', '2026-06-18T14:00:00Z'),
    costTrendPct: 4.1,
    volatility: 0.5,
  },
  {
    id: 'wl-sales',
    name: 'Sales Copilot',
    model: 'gpt-4o',
    provider: 'openai',
    team: 'Revenue',
    environment: 'prod',
    priority: 'high',
    demand_shape: 'business_hours',
    callsToday: 9800,
    avgInputTokens: 900,
    avgOutputTokens: 480,
    cachedTokensToday: 1_800_000,
    dailyBudget: 320,
    monthlyBudget: 8000,
    monthlySpend: 6800,
    valueRatio: 8.4,
    revenueSplit: 0.78,
    resolutionRate: 0.74,
    activeUsersDaily: 410,
    activeUsersMonthly: 1280,
    csat: 4.5,
    avgHandleTimeSeconds: 95,
    deflectionRate: 0.0,
    gates: gates(true, true, true, false, 'j.reviewer', '2026-06-15T11:00:00Z'),
    costTrendPct: 9.7,
    volatility: 0.7,
  },
  {
    id: 'wl-codereview',
    name: 'Code Review Bot',
    model: 'claude-haiku-3.5',
    provider: 'anthropic',
    team: 'Platform Eng',
    environment: 'prod',
    priority: 'medium',
    demand_shape: 'throttled',
    callsToday: 18500,
    avgInputTokens: 2400,
    avgOutputTokens: 520,
    cachedTokensToday: 6_200_000,
    dailyBudget: 110,
    monthlyBudget: 3000,
    monthlySpend: 2400,
    valueRatio: 21.5,
    revenueSplit: 0.18,
    resolutionRate: 0.91,
    activeUsersDaily: 320,
    activeUsersMonthly: 540,
    csat: null,
    avgHandleTimeSeconds: 22,
    deflectionRate: 0.0,
    gates: gates(true, true, true, true, 'k.user', '2026-06-20T16:30:00Z'),
    costTrendPct: -3.2,
    volatility: 0.4,
  },
  {
    id: 'wl-docsum',
    name: 'Document Summarizer',
    model: 'gemini-2.5-flash',
    provider: 'google',
    team: 'Legal',
    environment: 'staging',
    priority: 'medium',
    demand_shape: 'batch_offpeak',
    callsToday: 22000,
    avgInputTokens: 6500,
    avgOutputTokens: 650,
    cachedTokensToday: 3_100_000,
    dailyBudget: 60,
    monthlyBudget: 1500,
    monthlySpend: 1150,
    valueRatio: 6.2,
    revenueSplit: 0.25,
    resolutionRate: 0.88,
    activeUsersDaily: 95,
    activeUsersMonthly: 240,
    csat: 4.0,
    avgHandleTimeSeconds: 12,
    deflectionRate: 0.0,
    gates: gates(true, true, false, false, 'j.reviewer', '2026-06-10T10:00:00Z'),
    costTrendPct: 1.4,
    volatility: 0.9,
  },
  {
    id: 'wl-marketing',
    name: 'Marketing Content Gen',
    model: 'gpt-4o',
    provider: 'openai',
    team: 'Marketing',
    environment: 'prod',
    priority: 'low',
    demand_shape: 'unmanaged',
    callsToday: 6400,
    avgInputTokens: 1100,
    avgOutputTokens: 1400,
    cachedTokensToday: 220_000,
    dailyBudget: 180,
    monthlyBudget: 4000,
    monthlySpend: 4900,
    valueRatio: 3.4,
    revenueSplit: 0.62,
    resolutionRate: 0.69,
    activeUsersDaily: 64,
    activeUsersMonthly: 180,
    csat: 3.7,
    avgHandleTimeSeconds: 140,
    deflectionRate: 0.0,
    gates: gates(true, false, false, false, null, '2026-05-28T09:00:00Z'),
    costTrendPct: 23.6,
    volatility: 1.1,
  },
  {
    id: 'wl-fraud',
    name: 'Fraud Triage Agent',
    model: 'claude-opus-4-20250514',
    provider: 'anthropic',
    team: 'Risk & Trust',
    environment: 'prod',
    priority: 'critical',
    demand_shape: 'always_on',
    callsToday: 3100,
    avgInputTokens: 1800,
    avgOutputTokens: 900,
    cachedTokensToday: 480_000,
    dailyBudget: 160,
    monthlyBudget: 4500,
    monthlySpend: 4200,
    valueRatio: 1.6,
    revenueSplit: 0.7,
    resolutionRate: 0.58,
    activeUsersDaily: 40,
    activeUsersMonthly: 95,
    csat: null,
    avgHandleTimeSeconds: 210,
    deflectionRate: 0.0,
    gates: gates(true, true, true, true, 'm.po', '2026-06-02T13:00:00Z'),
    costTrendPct: 18.2,
    volatility: 0.8,
  },
  {
    id: 'wl-knowledge',
    name: 'Internal Knowledge Bot',
    model: 'gpt-4o-mini',
    provider: 'openai',
    team: 'IT',
    environment: 'dev',
    priority: 'low',
    demand_shape: 'business_hours',
    callsToday: 14200,
    avgInputTokens: 1500,
    avgOutputTokens: 380,
    cachedTokensToday: 2_400_000,
    dailyBudget: 40,
    monthlyBudget: 1000,
    monthlySpend: 880,
    valueRatio: 5.1,
    revenueSplit: 0.1,
    resolutionRate: 0.79,
    activeUsersDaily: 230,
    activeUsersMonthly: 610,
    csat: 4.1,
    avgHandleTimeSeconds: 30,
    deflectionRate: 0.41,
    gates: gates(true, true, false, false, 'j.reviewer', '2026-06-12T15:00:00Z'),
    costTrendPct: 6.3,
    volatility: 0.6,
  },
  // Four more workloads sharing existing teams. With one workload per team a
  // team rollup is identical to the workload list (findings gap G4); these
  // give every rollup a real multi-workload story while keeping the seeds
  // inside the derived-consistency regime (no hand-authored figures).
  {
    id: 'wl-triage',
    name: 'Support Triage Router',
    model: 'gemini-2.5-flash',
    provider: 'google',
    team: 'CX Engineering',
    environment: 'prod',
    priority: 'high',
    demand_shape: 'business_hours',
    callsToday: 52000,
    avgInputTokens: 900,
    avgOutputTokens: 160,
    cachedTokensToday: 4_100_000,
    dailyBudget: 60,
    monthlyBudget: 1600,
    monthlySpend: 1440,
    valueRatio: 11.2,
    revenueSplit: 0.5,
    resolutionRate: 0.86,
    activeUsersDaily: 7600,
    activeUsersMonthly: 21800,
    csat: 4.0,
    avgHandleTimeSeconds: 9,
    deflectionRate: 0.18,
    gates: gates(true, true, true, true, 'm.po', '2026-06-19T12:00:00Z'),
    costTrendPct: 2.2,
    volatility: 0.4,
  },
  {
    id: 'wl-redline',
    name: 'Contract Redliner',
    model: 'claude-sonnet-4-20250514',
    provider: 'anthropic',
    team: 'Legal',
    environment: 'prod',
    priority: 'high',
    demand_shape: 'business_hours',
    callsToday: 850,
    avgInputTokens: 9200,
    avgOutputTokens: 2100,
    cachedTokensToday: 300_000,
    dailyBudget: 120,
    monthlyBudget: 3600,
    monthlySpend: 3120,
    valueRatio: 4.4,
    revenueSplit: 0.66,
    resolutionRate: 0.77,
    activeUsersDaily: 22,
    activeUsersMonthly: 48,
    csat: 4.3,
    avgHandleTimeSeconds: 240,
    deflectionRate: 0.0,
    gates: gates(true, true, true, false, 'j.reviewer', '2026-06-11T09:30:00Z'),
    costTrendPct: 12.5,
    volatility: 0.6,
  },
  {
    id: 'wl-forecast',
    name: 'Pipeline Forecast Analyst',
    model: 'gpt-4o',
    provider: 'openai',
    team: 'Revenue',
    environment: 'prod',
    priority: 'medium',
    demand_shape: 'batch_offpeak',
    callsToday: 1200,
    avgInputTokens: 5200,
    avgOutputTokens: 1800,
    cachedTokensToday: 90_000,
    dailyBudget: 90,
    monthlyBudget: 2400,
    monthlySpend: 2050,
    valueRatio: 6.8,
    revenueSplit: 0.8,
    resolutionRate: 0.72,
    activeUsersDaily: 18,
    activeUsersMonthly: 55,
    csat: 3.9,
    avgHandleTimeSeconds: 420,
    deflectionRate: 0.0,
    gates: gates(true, true, false, false, 'j.reviewer', '2026-06-08T10:15:00Z'),
    costTrendPct: -1.8,
    volatility: 0.5,
  },
  {
    id: 'wl-infrabot',
    name: 'Infra Runbook Assistant',
    model: 'gpt-4o-mini',
    provider: 'openai',
    team: 'Platform Eng',
    environment: 'staging',
    priority: 'medium',
    demand_shape: 'business_hours',
    callsToday: 8300,
    avgInputTokens: 1700,
    avgOutputTokens: 450,
    cachedTokensToday: 1_100_000,
    dailyBudget: 30,
    monthlyBudget: 750,
    monthlySpend: 640,
    valueRatio: 7.7,
    revenueSplit: 0.12,
    resolutionRate: 0.83,
    activeUsersDaily: 140,
    activeUsersMonthly: 380,
    csat: 4.0,
    avgHandleTimeSeconds: 26,
    deflectionRate: 0.35,
    gates: gates(true, true, true, false, 'k.user', '2026-06-17T14:45:00Z'),
    costTrendPct: 5.5,
    volatility: 0.7,
  },
];

export const WORKLOADS: Workload[] = WORKLOAD_SEED_SPECS.map(buildWorkload);

