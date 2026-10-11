// Test support for src/mcp, not part of the public API and not exported from index.ts.
// Purpose: deterministic fakes so every MCP test is offline: a manual clock, a memory
// audit sink, a recording data provider with valid sample data, and request builders.
// Trust boundary: none; it is used only by *.test.ts files.
import type { DeployEnv, Principal, Role } from '@/identity/types';
import type { McpClock } from './clock';
import type { McpAuditRecord, McpAuditSink, McpContext } from './context';
import type { JsonRpcResponse } from './jsonrpc';
import type { McpDataProvider, McpScope, ProviderResult } from './provider';
import { createRateLimiter, type McpRateLimiter } from './rateLimit';

export const START_MS = 1_800_000_000_000;
export const FAR_FUTURE_S = 4_102_444_800;

export class FakeClock implements McpClock {
  private t: number;
  private timers: { at: number; fn: () => void; live: boolean }[] = [];
  constructor(start = START_MS) {
    this.t = start;
  }
  now(): number {
    return this.t;
  }
  after(ms: number, fn: () => void): () => void {
    const timer = { at: this.t + ms, fn, live: true };
    this.timers.push(timer);
    return () => {
      timer.live = false;
    };
  }
  /** Move time forward and run every live timer that came due. */
  advance(ms: number): void {
    this.t += ms;
    for (const timer of [...this.timers]) {
      if (timer.live && timer.at <= this.t) {
        timer.live = false;
        timer.fn();
      }
    }
  }
  pending(): number {
    return this.timers.filter((x) => x.live).length;
  }
}

/** Let queued promise callbacks run (no timers involved). */
export async function flush(times = 10): Promise<void> {
  for (let i = 0; i < times; i += 1) await Promise.resolve();
}

/** Wait until the clock has a pending timer (the handler reached a deadline), then return. */
export async function untilTimer(clock: FakeClock, tries = 200): Promise<void> {
  // The handler hashes arguments with real (threadpool) crypto first, so yield to real macrotasks.
  for (let i = 0; i < tries && clock.pending() === 0; i += 1) await new Promise<void>((r) => setTimeout(r, 1));
}

export interface MemoryAudit extends McpAuditSink {
  records: McpAuditRecord[];
}
export function memoryAudit(): MemoryAudit {
  const records: McpAuditRecord[] = [];
  return { records, record: (r) => void records.push(r) };
}

export const TEAM_PLATFORM = 'Platform Eng';
export const TEAM_CX = 'CX Engineering';

export function makePrincipal(role: Role = 'finops_lead', over: Partial<Principal> = {}): Principal {
  return {
    sub: `sub-${role}`,
    role,
    teams: role === 'eng_lead' ? [TEAM_PLATFORM] : '*',
    envs: ['dev', 'test', 'prod'],
    tenant: 't-1',
    tokenId: `jti-${role}`,
    expiresAt: FAR_FUTURE_S,
    authMethod: role === 'legacy_service' ? 'legacy-shared-token' : 'mock-idp',
    ...over,
  };
}

const meta = <T>(data: T): ProviderResult<T> => ({ data, revision: 'rev-2026-10-01', evidence_status: 'measured', data_origin: 'synthetic_seed' });

/** Valid sample data for each provider method. */
export const SAMPLE = {
  spend: () => meta({
    period: '2026-09', group_by: 'service' as const,
    groups: [{ currency: 'USD', total: '300.00', rows: [{ key: 'Compute', amount: '200.00' }, { key: 'Storage', amount: '100.00' }] }],
  }),
  findings: () => meta({
    total_matching: 1,
    findings: [{ id: 'fnd-1', category: 'rightsizing', title: 'Idle GPU nodes in staging', severity: 'warning' as const, status: 'open' as const, monthly_impact: '1200.00', currency: 'USD', detected_at: '2026-09-30' }],
  }),
  forecast: () => meta({
    as_of: '2026-10-01', horizon_days: 2, estimated: true,
    groups: [{ currency: 'USD', month_end_expected: '9000.00', points: [
      { date: '2026-10-02', expected: '300.00', low: '280.00', high: '320.00' },
      { date: '2026-10-03', expected: '301.00', low: '281.00', high: '321.00' },
    ] }],
  }),
  allocation: () => meta({
    period: '2026-09', dimension: 'team' as const,
    groups: [{ currency: 'USD', ledger_total: '300.00', allocated_total: '250.00', unallocated_total: '50.00', rows: [{ key: 'untagged', amount: '50.00' }, { key: TEAM_PLATFORM, amount: '250.00' }] }],
  }),
  budgets: () => meta({
    budgets: [{ id: 'bud-1', name: 'Platform monthly', team: TEAM_PLATFORM, period: 'monthly' as const, currency: 'USD', budget_amount: '10000.00', spent_amount: '7200.00', percent_used: 72, state: 'soft' as const, forecast_breach: false }],
  }),
  commitments: () => meta({
    period: '2026-09',
    groups: [{ currency: 'USD', on_demand_eligible: '5000.00', committed_covered: '3500.00', coverage_pct: 70, unused_commitment_cost: '120.00' }],
  }),
};

export interface ProviderCall {
  method: string;
  scope: McpScope;
  args: unknown;
}
export interface RecordingProvider extends McpDataProvider {
  calls: ProviderCall[];
}

export function makeProvider(overrides: Partial<McpDataProvider> = {}): RecordingProvider {
  const calls: ProviderCall[] = [];
  const rec = <A, R>(method: string, make: () => R) => async (scope: McpScope, args: A): Promise<R> => {
    calls.push({ method, scope, args });
    return make();
  };
  const base: McpDataProvider = {
    getSpendSummary: rec('getSpendSummary', SAMPLE.spend),
    listFindings: rec('listFindings', SAMPLE.findings),
    getForecast: rec('getForecast', SAMPLE.forecast),
    getAllocationSummary: rec('getAllocationSummary', SAMPLE.allocation),
    getBudgetStatus: rec('getBudgetStatus', SAMPLE.budgets),
    getCommitmentCoverage: rec('getCommitmentCoverage', SAMPLE.commitments),
  };
  return Object.assign({ calls }, base, overrides);
}

export interface TestCtx extends McpContext {
  clock: FakeClock;
  audit: MemoryAudit;
  provider: RecordingProvider;
  rateLimiter: McpRateLimiter;
}

export function makeCtx(over: Partial<McpContext> = {}): TestCtx {
  const base = {
    principal: makePrincipal(),
    deployEnv: 'dev' as DeployEnv,
    tenant: 't-1',
    clock: new FakeClock(),
    provider: makeProvider(),
    audit: memoryAudit(),
    rateLimiter: createRateLimiter({ limit: 1000, windowMs: 60_000 }),
  };
  return { ...base, ...over } as TestCtx;
}

export const msg = (method: string, params?: unknown, id: string | number = 1): string =>
  JSON.stringify(params === undefined ? { jsonrpc: '2.0', id, method } : { jsonrpc: '2.0', id, method, params });

export const callMsg = (name: string, args?: unknown, id: string | number = 1): string =>
  msg('tools/call', args === undefined ? { name } : { name, arguments: args }, id);

export const INIT_PARAMS = { protocolVersion: '2025-11-25', capabilities: {}, clientInfo: { name: 'test-client', version: '1.0.0' } };

type Failure = Extract<JsonRpcResponse, { error: unknown }>;
type Success = Extract<JsonRpcResponse, { result: unknown }>;

export function asFailure(res: JsonRpcResponse | null): Failure {
  if (res === null || !('error' in res)) throw new Error(`expected a JSON-RPC failure, got ${JSON.stringify(res)}`);
  return res;
}
export function asSuccess(res: JsonRpcResponse | null): Success {
  if (res === null || !('result' in res)) throw new Error(`expected a JSON-RPC success, got ${JSON.stringify(res)}`);
  return res;
}

export interface ToolResult {
  content: { type: string; text: string }[];
  isError: boolean;
}
/** The tool result of a successful tools/call response. */
export function toolResult(res: JsonRpcResponse | null): ToolResult {
  return asSuccess(res).result as unknown as ToolResult;
}
/** The JSON body inside a successful (isError false) tool result. */
export function toolBody(res: JsonRpcResponse | null): Record<string, unknown> {
  const r = toolResult(res);
  if (r.isError) throw new Error(`expected a tool success, got error text: ${r.content[0]?.text}`);
  return JSON.parse(r.content[0].text) as Record<string, unknown>;
}
export const toolNames = (res: JsonRpcResponse | null): string[] =>
  (asSuccess(res).result.tools as { name: string }[]).map((t) => t.name);

/** Valid, minimal arguments per tool. */
export const MIN_ARGS: Record<string, Record<string, unknown>> = {
  get_spend_summary: {},
  list_findings: {},
  get_forecast: {},
  get_allocation_summary: {},
  get_budget_status: {},
  get_commitment_coverage: {},
};
