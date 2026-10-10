// Ratio data model — see `.obvious/obvious.md` Design Guidance (Data-Model Invariants).
// Types are the contract between seed data, forecast math, and the UI.

import type { EvidenceStatus } from '@/outcomes/types';
export type ModelProvider =
  | 'openai'
  | 'anthropic'
  | 'google'
  | 'aws_bedrock'
  | 'azure_openai'
  | 'custom';

export type Environment = 'prod' | 'staging' | 'dev' | 'sandbox';

export type DemandShape =
  | 'always_on'
  | 'business_hours'
  | 'throttled'
  | 'batch_offpeak'
  | 'paused'
  | 'unmanaged';

export type Priority = 'critical' | 'high' | 'medium' | 'low';

export type CostTier = 'economy' | 'standard' | 'premium' | 'ultra';

// --- Workload (§2.1) ---

export interface WorkloadCosts {
  /** Exact recorded MTD when a ledger supplies it; absent in the legacy run-rate demo. */
  recorded_mtd?: number;
  inference_cost_per_call: number;
  monthly_spend: number;
  daily_spend: number;
  daily_budget: number;
  monthly_budget: number;
  compute: number;
  tokens_in_today: number;
  tokens_out_today: number;
  tokens_in_mtd: number;
  tokens_out_mtd: number;
}

export interface WorkloadOutputs {
  daily_inferences: number;
  monthly_inferences: number;
  resolved_queries: number;
  resolution_rate: number;
  active_users_daily: number;
  active_users_monthly: number;
  csat: number | null;
  avg_handle_time_seconds: number;
  deflection_rate: number;
}

// Provenance of value figures (audit C1/C8). Ratio re-uses the outcomes
// module's EvidenceStatus — one vocabulary for evidence rigor codebase-wide.
export type { EvidenceStatus };

/**
 * Per-input provenance for the two value components (audit C1). The derived
 * fields (`total_value`, `value_ratio`) carry no mark of their own — the
 * headline inherits the weakest input's status (see `lib/valueEvidence.ts`).
 */
export interface WorkloadValueEvidence {
  revenue_protected: EvidenceStatus;
  cost_avoided: EvidenceStatus;
}

export interface WorkloadValue {
  revenue_protected: number;
  cost_avoided: number;
  total_value: number;
  value_ratio: number;
  /**
   * Evidence status of the value inputs. Absent on legacy shapes (values built
   * before provenance tracking) — the UI renders such ratios unmarked rather
   * than inventing a status.
   */
  evidence?: WorkloadValueEvidence;
}

export type GovernanceGateId = 'policy' | 'ethics' | 'cost' | 'scale';

export interface WorkloadGovernance {
  policy_check: boolean;
  ethics_review: boolean;
  cost_approval: boolean;
  scale_authorized: boolean;
  last_reviewed: string;
  approved_by: string | null;
}

// Derived unit costs (§2.1 — calculated, not stored on seed rows).
export interface UnitCosts {
  cost_per_call: number;
  cost_per_resolved: number;
  cost_per_user: number | null;
  cost_per_deflection: number | null;
  cost_per_1k_tokens_in: number;
  cost_per_1k_tokens_out: number;
}

export interface Workload {
  id: string;
  name: string;
  model: string;
  model_provider: ModelProvider;
  team: string;
  environment: Environment;
  costs: WorkloadCosts;
  outputs: WorkloadOutputs;
  value: WorkloadValue;
  governance: WorkloadGovernance;
  demand_shape: DemandShape;
  priority: Priority;
  cost_trend_pct: number;
  created_at: string;
  updated_at: string;
}

// --- Model Registry (§2.2) ---

export interface ModelPricing {
  input_per_1m: number;
  output_per_1m: number;
  cached_input_per_1m: number | null;
  batch_input_per_1m: number | null;
  batch_output_per_1m: number | null;
}

export interface ModelEntry {
  id: string;
  provider: ModelProvider;
  model_name: string;
  display_name: string;
  pricing: ModelPricing;
  context_window: number;
  max_output: number;
  supports_vision: boolean;
  supports_tools: boolean;
  supports_streaming: boolean;
  cost_tier: CostTier;
  last_price_update: string;
}

// --- Budget Profile (§2.3) ---

export type ForecastMethod = 'linear' | 'weighted_avg_7d' | 'exponential_smoothing';

export interface DailyAllocation {
  weekday: number;
  weekend: number;
  peak_hour_start: number;
  peak_hour_end: number;
  peak_multiplier: number;
}

export interface BudgetProfile {
  id: string;
  workload_id: string;
  period: 'daily' | 'weekly' | 'monthly';
  budget_amount: number;
  soft_threshold_pct: number;
  hard_threshold_pct: number;
  kill_threshold_pct: number;
  daily_allocation: DailyAllocation;
  forecast_method: ForecastMethod;
  // Recent daily spend history powering the monthly forecast (most recent last).
  daily_spend_history: number[];
  on_soft_breach: 'alert_only' | 'alert_and_log';
  on_hard_breach: 'alert_escalate' | 'throttle_50pct' | 'throttle_75pct';
  on_kill_breach: 'pause_workload' | 'throttle_90pct' | 'alert_only';
}

// --- Alert (§2.4) ---

export type AlertType =
  | 'budget_soft'
  | 'budget_hard'
  | 'budget_kill'
  | 'anomaly_spike'
  | 'value_ratio_drop'
  | 'trend_warning'
  | 'governance_missing'
  | 'forecast_breach'
  | 'model_cost_change';

export type AlertSeverity = 'info' | 'warning' | 'critical';

export type AlertChannel = 'in_app' | 'slack' | 'email' | 'webhook';

export interface Alert {
  id: string;
  workload_id: string;
  type: AlertType;
  severity: AlertSeverity;
  message: string;
  threshold_value: number;
  actual_value: number;
  triggered_at: string;
  acknowledged: boolean;
  acknowledged_by: string | null;
  action_taken: string | null;
  channel: AlertChannel;
}

// --- Agent Query Log (§2.5) ---

export interface AgentQuery {
  id: string;
  user_id: string;
  query: string;
  response: string;
  workloads_referenced: string[];
  tokens_used: { input: number; output: number };
  query_cost: number;
  timestamp: string;
}

