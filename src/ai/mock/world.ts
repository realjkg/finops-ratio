// Context -> typed facts. The wire context is untrusted shape (it comes from a
// browser), so every read is defensive: numbers must be finite, strings are
// length-capped, arrays are size-capped. Fields an older client omits are
// filled from the bundled seed BY WORKLOAD ID ONLY for descriptive facts
// (team, provider, model, volume, budget, alerts); value and spend always come
// from the wire's own numbers. Anything still unknown stays null and the
// answers say so instead of guessing.

import type { AIAlertSnapshot, AIContext } from '../AIClient';
import { alertsFor } from '@/data/alerts';
import { WORKLOADS } from '@/data/workloads';
import type { EvidenceStatus } from '@/types';
import type { World, WorkloadFacts } from './types';

const MAX_ITEMS = 200;
const MAX_STR = 60;
const MAX_MESSAGE = 400;
/** Sane bounds for wire figures: USD per month, and counts per day. Beyond them a workload is excluded. */
const MAX_USD = 1e12;
const MAX_COUNT = 1e13;
const SEED_BY_ID = new Map(WORKLOADS.map((w) => [w.id, w]));
const STATUSES: ReadonlySet<string> = new Set(['assumed', 'projected', 'measured']);

function num(v: unknown): number | null {
  return typeof v === 'number' && Number.isFinite(v) ? v : null;
}
/** Wire text -> one safe line: control characters and line breaks become spaces, length capped. */
function clean(v: string, max: number): string {
  let out = '';
  for (const ch of v.slice(0, max * 2)) {
    const c = ch.charCodeAt(0);
    out += c < 32 || (c >= 127 && c <= 159) ? ' ' : ch; // U+2028/2029 are caught by the whitespace collapse below
  }
  return out.replace(/\s+/g, ' ').trim().slice(0, max);
}
function str(v: unknown, max = MAX_STR): string | null {
  if (typeof v !== 'string') return null;
  const t = clean(v, max);
  return t.length > 0 ? t : null;
}
const inRange = (n: number | null, max: number): boolean => n === null || Math.abs(n) <= max;
function evidence(v: unknown): EvidenceStatus | undefined {
  return typeof v === 'string' && STATUSES.has(v) ? (v as EvidenceStatus) : undefined;
}
function arr(v: unknown): unknown[] {
  return Array.isArray(v) ? v.slice(0, MAX_ITEMS) : [];
}
function rec(v: unknown): Record<string, unknown> {
  return typeof v === 'object' && v !== null ? (v as Record<string, unknown>) : {};
}

function alertList(v: unknown): AIAlertSnapshot[] | null {
  if (!Array.isArray(v)) return null;
  return v.slice(0, 50).map((a) => {
    const r = rec(a);
    return {
      type: str(r.type) ?? 'alert',
      severity: str(r.severity) ?? 'info',
      message: str(r.message, MAX_MESSAGE) ?? '',
      acknowledged: r.acknowledged === true,
    };
  });
}

export function buildWorld(ctx: AIContext): World {
  const c = rec(ctx);
  const initiatives = arr(c.initiatives).map(rec);
  const snaps = new Map(arr(c.workloads).map(rec).map((w) => [String(w.id), w]));
  const seen = new Set<string>();
  const rows: WorkloadFacts[] = [];
  const rejected: string[] = [];

  const add = (id: string, init: Record<string, unknown> | undefined, snap: Record<string, unknown> | undefined) => {
    if (seen.has(id)) return;
    seen.add(id);
    const seed = SEED_BY_ID.get(id);
    const i = init ?? {};
    const s = snap ?? {};
    const spend = num(s.monthlySpend) ?? num(i.monthlyCost) ?? 0;
    const wireRatio = num(s.valueRatio) ?? num(i.valueRatio);
    const wireValue = num(s.monthlyValue);
    const value = wireValue ?? (wireRatio !== null ? wireRatio * spend : 0);
    const name = str(i.name) ?? str(s.name) ?? id;
    const calls = num(s.dailyInferences) ?? seed?.outputs.daily_inferences ?? null;
    const tokIn = num(s.tokensInToday) ?? seed?.costs.tokens_in_today ?? null;
    const tokOut = num(s.tokensOutToday) ?? seed?.costs.tokens_out_today ?? null;
    const tokCached = num(s.tokensCachedToday) ?? seed?.costs.tokens_cached_today ?? null;
    if (
      !inRange(spend, MAX_USD) || !inRange(value, MAX_USD) || !Number.isFinite(value) ||
      ![calls, tokIn, tokOut, tokCached].every((n) => inRange(n, MAX_COUNT))
    ) {
      rejected.push(name);
      return;
    }
    const trend = num(s.costTrendPct) ?? seed?.cost_trend_pct ?? null;
    const budget = num(s.monthlyBudget) ?? seed?.costs.monthly_budget ?? null;
    const cache = num(s.cacheHitRate);
    const status = evidence(s.valueEvidenceStatus) ?? evidence(i.valueEvidenceStatus);
    const gates = num(s.governanceGatesPassed);
    rows.push({
      id,
      name,
      team: str(s.team) ?? seed?.team ?? null,
      provider: str(s.provider) ?? seed?.model_provider ?? null,
      model: str(s.model) ?? seed?.model ?? null,
      monthlySpend: spend,
      monthlyValue: value,
      ratio: spend > 0 ? value / spend : null,
      evidence: status,
      status: str(i.status),
      budgetConsumedPct: num(i.budgetConsumedPct),
      monthlyBudget: budget !== null && Math.abs(budget) <= MAX_USD ? budget : null,
      savings: Math.max(0, num(i.savingsOpportunity) ?? 0),
      cacheHitRate: cache !== null && cache >= 0 && cache <= 1 ? cache : null,
      costTrendPct: trend !== null && trend > -100 && trend < 1e6 ? trend : null,
      demandShape: str(s.demandShape),
      gatesPassed: gates,
      calls,
      tokIn,
      tokOut,
      tokCached,
      alerts: alertList(s.alerts) ?? (seed ? alertsFor(id).map((a) => ({
        type: a.type, severity: a.severity, message: a.message, acknowledged: a.acknowledged,
      })) : null),
    });
  };

  for (const i of initiatives) add(String(i.id), i, snaps.get(String(i.id)));
  for (const [id, s] of snaps) add(id, undefined, s);

  const teams: string[] = [];
  for (const w of rows) if (w.team && !teams.includes(w.team)) teams.push(w.team);
  return { asOf: str(c.asOf) ?? '1970-01-01T00:00:00.000Z', workloads: rows, teams, rejected };
}
