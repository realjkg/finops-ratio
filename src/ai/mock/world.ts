// Context -> typed facts. The wire context is untrusted shape (it comes from a
// browser), so every read is defensive: numbers must be finite, strings are
// length-capped, arrays are size-capped. Fields an older client omits are
// filled from the bundled seed BY WORKLOAD ID ONLY for descriptive facts
// (team, provider, model, volume, budget, alerts); value and spend always come
// from the wire's own numbers. Anything still unknown stays null and the
// answers say so instead of guessing.

import { OMITTED_STATUSES, type AIAlertSnapshot, type AIContext, type AIOmittedInitiative } from '../AIClient';
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

/** One range policy for every numeric field of the request context. */
interface Range { min: number; max: number; exMin?: boolean; exMax?: boolean; int?: boolean; floor?: number }
const RANGE = {
  usd: { min: 0, max: MAX_USD, floor: 0.01 },
  signedUsd: { min: -MAX_USD, max: MAX_USD, floor: 0.01 },
  runRate: { min: 0, max: 12 * MAX_USD, floor: 0.01 },
  ratio: { min: -1e6, max: 1e6 },
  count: { min: 0, max: MAX_COUNT, int: true },
  trend: { min: -100, max: 1e6, exMin: true, exMax: true },
  rate: { min: 0, max: 1 },
  pct: { min: 0, max: 1e4, floor: 0.01 },
  gates: { min: 0, max: 4, int: true },
  total: { min: 0, max: 200 * MAX_USD, floor: 0.01 },
  items: { min: 0, max: 1e6, int: true },
} as const satisfies Record<string, Range>;

function within(v: number, r: Range): boolean {
  if (!Number.isFinite(v) || (r.exMin ? v <= r.min : v < r.min) || (r.exMax ? v >= r.max : v > r.max)) return false;
  // Counts are whole numbers; money and percents are exactly 0 or at least a cent (no 1e-300 tails).
  return (!r.int || Number.isSafeInteger(v)) && (!r.floor || v === 0 || Math.abs(v) >= r.floor);
}

// Absent reads as null; a present value that is not an in-range number is recorded in `bad` (the workload is then rejected).
function field(r: Record<string, unknown>, key: string, range: Range, bad: string[]): number | null {
  const v = r[key];
  if (v == null) return null; // absent
  if (typeof v === 'number' && within(v, range)) return v;
  if (!bad.includes(key)) bad.push(key);
  return null;
}

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

/** The valid entries of the optional `omitted` list (status + reason of N/A-budget initiatives). */
export function omittedList(v: unknown): AIOmittedInitiative[] {
  return arr(v).filter((x): x is AIOmittedInitiative => {
    const r = rec(x);
    return typeof r.id === 'string' && typeof r.name === 'string' && typeof r.reason === 'string' && OMITTED_STATUSES.includes(r.status as AIOmittedInitiative['status']);
  });
}

export function buildWorld(ctx: AIContext): World {
  const c = rec(ctx);
  const plain = (x: unknown): x is Record<string, unknown> => typeof x === 'object' && x !== null && typeof rec(x).id === 'string'; // entries without a string id are malformed
  const initiatives = arr(c.initiatives).filter(plain);
  const snaps = new Map(arr(c.workloads).filter(plain).map((w) => [w.id as string, w]));
  const seen = new Set<string>();
  const rows: WorkloadFacts[] = [];
  const rejected: string[] = [];
  const rejectedIds: string[] = [];

  const add = (id: string, init: Record<string, unknown> | undefined, snap: Record<string, unknown> | undefined) => {
    if (seen.has(id)) return;
    seen.add(id);
    const seed = SEED_BY_ID.get(id);
    const i = init ?? {};
    const s = snap ?? {};
    const bad: string[] = [];
    const spendI = field(i, 'monthlyCost', RANGE.usd, bad);
    const spend = field(s, 'monthlySpend', RANGE.usd, bad) ?? spendI ?? 0;
    field(i, 'annualRunRate', RANGE.runRate, bad);
    const ratioI = field(i, 'valueRatio', RANGE.ratio, bad);
    const wireRatio = field(s, 'valueRatio', RANGE.ratio, bad) ?? ratioI;
    const wireValue = field(s, 'monthlyValue', RANGE.signedUsd, bad);
    const value = wireValue ?? (wireRatio !== null ? wireRatio * spend : 0);
    if (!within(value, RANGE.signedUsd) && !bad.includes('valueRatio')) bad.push('valueRatio');
    const name = str(i.name) ?? str(s.name) ?? clean(id, MAX_STR);
    const calls = field(s, 'dailyInferences', RANGE.count, bad) ?? seed?.outputs.daily_inferences ?? null;
    const tokIn = field(s, 'tokensInToday', RANGE.count, bad) ?? seed?.costs.tokens_in_today ?? null;
    const tokOut = field(s, 'tokensOutToday', RANGE.count, bad) ?? seed?.costs.tokens_out_today ?? null;
    const tokCached = field(s, 'tokensCachedToday', RANGE.count, bad) ?? seed?.costs.tokens_cached_today ?? null;
    const trend = field(s, 'costTrendPct', RANGE.trend, bad) ?? seed?.cost_trend_pct ?? null;
    const budget = field(s, 'monthlyBudget', RANGE.usd, bad) ?? seed?.costs.monthly_budget ?? null;
    const cache = field(s, 'cacheHitRate', RANGE.rate, bad);
    const gates = field(s, 'governanceGatesPassed', RANGE.gates, bad);
    const consumed = field(i, 'budgetConsumedPct', RANGE.pct, bad);
    const savings = field(i, 'savingsOpportunity', RANGE.usd, bad);
    if (bad.length > 0) {
      rejected.push(`${name} (${bad.join(', ')})`); rejectedIds.push(id);
      return;
    }
    const status = evidence(s.valueEvidenceStatus) ?? evidence(i.valueEvidenceStatus);
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
      budgetConsumedPct: consumed,
      monthlyBudget: budget,
      savings: savings ?? 0,
      cacheHitRate: cache,
      costTrendPct: trend,
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

  for (const i of initiatives) add(i.id as string, i, snaps.get(i.id as string));
  for (const o of omittedList(c.omitted)) add(o.id, { name: o.name, status: o.status }, snaps.get(o.id));
  for (const [id, s] of snaps) add(id, undefined, s);

  const dropped = arr(c.initiatives).filter((x) => !legacyInit(x) && !rejectedIds.includes(rec(x).id as string)).length + arr(c.workloads).filter((x) => !plain(x)).length; if (dropped) rejected.push(`${dropped} malformed entries`);
  const teams: string[] = [];
  for (const w of rows) if (w.team && !teams.includes(w.team)) teams.push(w.team);
  return { asOf: str(c.asOf) ?? '1970-01-01T00:00:00.000Z', workloads: rows, teams, rejected, rejectedIds };
}

const STATUS_OK: ReadonlySet<string> = new Set(['On Track', 'At Risk', 'Pending Approval']);
const INIT_NUMBERS = { monthlyCost: RANGE.usd, annualRunRate: RANGE.runRate, budgetConsumedPct: RANGE.pct, valueRatio: RANGE.ratio, savingsOpportunity: RANGE.usd } as const;

function legacyInit(raw: unknown): AIContext['initiatives'][number] | null {
  const i = rec(raw);
  const nums = Object.entries(INIT_NUMBERS).map(([k, r]) => [k, typeof i[k] === 'number' && within(i[k], r) ? i[k] : null] as const);
  const [id, name] = [str(i.id), str(i.name)];
  if (!id || !name || !(typeof i.status === 'string' && STATUS_OK.has(i.status)) || nums.some(([, v]) => v === null)) return null;
  return { id, name, status: i.status, valueEvidenceStatus: evidence(i.valueEvidenceStatus), ...Object.fromEntries(nums) } as AIContext['initiatives'][number];
}

export function legacyContext(ctx: AIContext, world: World): AIContext {
  const drop = new Set(world.rejectedIds);
  const initiatives = arr(ctx.initiatives).filter((x) => !drop.has(rec(x).id as string)).map(legacyInit).filter((i) => i !== null);
  const sum = (f: (i: (typeof initiatives)[number]) => number): number => initiatives.reduce((n, i) => n + f(i), 0);
  const sm = rec(ctx.summary);
  const pick = (key: string, range: Range, fallback: number): number => {
    const v = sm[key];
    return drop.size === 0 && initiatives.length === arr(ctx.initiatives).length && typeof v === 'number' && within(v, range) ? v : fallback;
  };
  return {
    initiatives,
    omitted: omittedList(ctx.omitted),
    workloads: world.workloads.map((w) => ({ id: w.id, cacheHitRate: w.cacheHitRate })) as unknown as AIContext['workloads'], // the only fields the legacy answers read
    asOf: str(rec(ctx).asOf) ?? '',
    summary: {
      totalMonthlySpend: pick('totalMonthlySpend', RANGE.total, Math.round(sum((i) => i.monthlyCost))),
      projectedSavings: pick('projectedSavings', RANGE.total, sum((i) => i.savingsOpportunity)),
      initiativesActive: pick('initiativesActive', RANGE.items, initiatives.length),
      pendingApproval: pick('pendingApproval', RANGE.items, initiatives.filter((i) => i.status === 'Pending Approval').length),
    },
  };
}
