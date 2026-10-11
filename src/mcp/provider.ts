// The data-provider contract behind the MCP tools. Purpose: the only way a tool reads
// anything. Trust boundary: the core hands a provider a McpScope built from the
// authenticated context (tenant, environment, teams), never from tool arguments, so a
// provider is tenant-bound by construction. Every method is a read that returns plain
// data; the core validates the data against the tool's output schema, so extra or
// missing fields are refused. Money is a decimal string with its currency code and is
// never summed across currencies (checklist definition of done, item 7). There is no
// write method, and the closed registry names no write tool.
import type { DeployEnv } from '@/identity/types';

export type EvidenceStatus = 'measured' | 'assumed' | 'projected' | 'not_applicable';
export type DataOrigin = 'synthetic_seed' | 'synthetic_fleet' | 'tenant_published';

export const EVIDENCE_STATUSES: readonly EvidenceStatus[] = Object.freeze(['measured', 'assumed', 'projected', 'not_applicable'] as const);
export const DATA_ORIGINS: readonly DataOrigin[] = Object.freeze(['synthetic_seed', 'synthetic_fleet', 'tenant_published'] as const);

/** What every provider method returns (DESIGN 4.1 common envelope, minus the core-owned `truncated`). */
export interface ProviderResult<T> {
  readonly data: T;
  /** The source revision or as-of marker of the read. */
  readonly revision: string;
  readonly evidence_status: EvidenceStatus;
  readonly data_origin: DataOrigin;
}

/** Who and where the read is for. Copied from the authenticated context, never from arguments. */
export interface McpScope {
  readonly tenant: string;
  readonly env: DeployEnv;
  readonly subject: string;
  /** '*' for an org-wide principal; otherwise the only teams the provider may return rows for. */
  readonly teams: '*' | readonly string[];
}

export type Money = string; // decimal string, for example "1234.56"
export type CurrencyCode = string; // three uppercase letters

export interface SpendSummaryArgs {
  readonly period?: string;
  readonly group_by?: 'service' | 'team' | 'account' | 'cloud';
  readonly team?: string;
  readonly limit?: number;
}
export interface SpendSummaryData {
  readonly period: string;
  readonly group_by: 'service' | 'team' | 'account' | 'cloud';
  readonly groups: readonly { readonly currency: CurrencyCode; readonly total: Money; readonly rows: readonly { readonly key: string; readonly amount: Money }[] }[];
}

export interface FindingsArgs {
  readonly status?: 'open' | 'resolved' | 'dismissed';
  readonly severity?: 'info' | 'warning' | 'critical';
  readonly team?: string;
  readonly limit?: number;
}
export interface FindingsData {
  readonly total_matching: number;
  readonly findings: readonly {
    readonly id: string;
    readonly category: string;
    readonly title: string;
    readonly severity: 'info' | 'warning' | 'critical';
    readonly status: 'open' | 'resolved' | 'dismissed';
    readonly team?: string;
    readonly monthly_impact: Money;
    readonly currency: CurrencyCode;
    readonly detected_at: string;
  }[];
}

export interface ForecastArgs {
  readonly horizon_days?: number;
  readonly team?: string;
}
export interface ForecastData {
  readonly as_of: string;
  readonly horizon_days: number;
  /** True when the history behind the forecast is short (checklist item 2.1). */
  readonly estimated: boolean;
  readonly groups: readonly {
    readonly currency: CurrencyCode;
    readonly month_end_expected: Money;
    readonly points: readonly { readonly date: string; readonly expected: Money; readonly low: Money; readonly high: Money }[];
  }[];
}

export interface AllocationArgs {
  readonly period?: string;
  readonly dimension?: 'team' | 'cost_center' | 'application';
  readonly team?: string;
}
export interface AllocationData {
  readonly period: string;
  readonly dimension: 'team' | 'cost_center' | 'application';
  readonly groups: readonly {
    readonly currency: CurrencyCode;
    readonly ledger_total: Money;
    readonly allocated_total: Money;
    readonly unallocated_total: Money;
    readonly rows: readonly { readonly key: string; readonly amount: Money }[];
  }[];
}

export interface BudgetArgs {
  readonly team?: string;
  readonly state?: 'ok' | 'soft' | 'hard' | 'kill';
}
export interface BudgetData {
  readonly budgets: readonly {
    readonly id: string;
    readonly name: string;
    readonly team?: string;
    readonly period: 'daily' | 'weekly' | 'monthly';
    readonly currency: CurrencyCode;
    readonly budget_amount: Money;
    readonly spent_amount: Money;
    readonly percent_used: number;
    /** soft at 70 percent, hard at 90, kill at 100 (obvious.md alert rules). */
    readonly state: 'ok' | 'soft' | 'hard' | 'kill';
    readonly forecast_breach: boolean;
  }[];
}

export interface CommitmentArgs {
  readonly period?: string;
}
export interface CommitmentData {
  readonly period: string;
  readonly groups: readonly {
    readonly currency: CurrencyCode;
    readonly on_demand_eligible: Money;
    readonly committed_covered: Money;
    readonly coverage_pct: number;
    readonly unused_commitment_cost: Money;
  }[];
}

/** Every method is a read. The `signal` aborts when the call's time budget is spent. */
export interface McpDataProvider {
  getSpendSummary(scope: McpScope, args: SpendSummaryArgs, signal: AbortSignal): Promise<ProviderResult<SpendSummaryData>>;
  listFindings(scope: McpScope, args: FindingsArgs, signal: AbortSignal): Promise<ProviderResult<FindingsData>>;
  getForecast(scope: McpScope, args: ForecastArgs, signal: AbortSignal): Promise<ProviderResult<ForecastData>>;
  getAllocationSummary(scope: McpScope, args: AllocationArgs, signal: AbortSignal): Promise<ProviderResult<AllocationData>>;
  getBudgetStatus(scope: McpScope, args: BudgetArgs, signal: AbortSignal): Promise<ProviderResult<BudgetData>>;
  getCommitmentCoverage(scope: McpScope, args: CommitmentArgs, signal: AbortSignal): Promise<ProviderResult<CommitmentData>>;
}

/** The provider methods the registry may name. A runtime test proves nothing else is touched. */
export const PROVIDER_READ_METHODS: readonly (keyof McpDataProvider)[] = Object.freeze([
  'getSpendSummary', 'listFindings', 'getForecast', 'getAllocationSummary', 'getBudgetStatus', 'getCommitmentCoverage',
] as const);
