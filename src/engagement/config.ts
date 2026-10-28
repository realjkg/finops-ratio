// R1: the engagement config. One validated JSON file per instance declares
// the engagement: the single tenant the reader is bound to, its sources (with
// typed provenance metadata), allocation rules, budgets, model-switch
// scenarios and an optional outcomes file. Other rows consume this module and
// must not redefine the schema.
//
//   RATIO_MODE=engagement            selects engagement mode (one engagement per instance)
//   RATIO_ENGAGEMENT_CONFIG=/abs.json read-only JSON file, validated at startup
//
// Hand-written guards, no dependency. Problems name the KEY (a path such as
// `budgets[0].monthly`), never the value; map keys that are customer
// identifiers (allocation.subAccountMap) are reported by index.
import { createHash } from 'crypto';
import fs from 'fs';
import path from 'path';
import { MODEL_REGISTRY } from '@/data/models';

type Env = Record<string, string | undefined>;

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------
export const FOCUS_PROVIDER_NAMES = ['AWS', 'Microsoft', 'Google Cloud', 'Oracle'] as const;
export type FocusProviderName = (typeof FOCUS_PROVIDER_NAMES)[number];
export const SOURCE_LAYOUTS = ['aws-data-exports', 'single-file'] as const;
export type SourceLayout = (typeof SOURCE_LAYOUTS)[number];
export const ALLOCATION_RULES = ['even_split', 'keyed_tag', 'proportional_to_attributed'] as const;
export type SharedCostRuleName = (typeof ALLOCATION_RULES)[number];

export type Tri = 'included' | 'excluded' | 'unknown';
/** Per-currency exact decimal strings, or the explicit 'not_available'. */
export type CurrencyTotals = Record<string, string> | 'not_available';

export interface SourceMetadata {
  provider: 'AWS' | 'Azure' | 'GCP' | 'OCI' | 'other';
  source_kind: 'focus-export' | 'native-export' | 'api';
  schema_version: string;
  provenance: 'authorized-real-export' | 'official-example';
  sanitization: string;
  scope: {
    accounts: 'pseudonymized-identifiers' | 'unknown' | 'not_available' | string[];
    period_start: string;
    period_end: string;
    period_end_semantics: 'inclusive' | 'exclusive';
    timezone: string;
    completeness: 'full-period' | 'explicit-subset';
    subset_description?: string;
  };
  delivery: {
    format: 'csv' | 'csv-gzip' | 'parquet' | 'ndjson';
    compression: string;
    manifest: string; // a file name, or 'not-provided'
    refresh_behavior: string; // observed text, or 'unknown'
  };
  financial: {
    currencies: string[];
    billed_cost_total: CurrencyTotals;
    effective_cost_total: CurrencyTotals;
    credits_coverage: Tri;
    tax_coverage: Tri;
    control_total_source: 'export-query' | 'console' | 'invoice' | 'not_available';
    known_differences: string;
  };
  overlap: {
    also_present_in_other_source: 'yes' | 'no' | 'unknown';
    related_source: string; // a source id from this config, or 'none'
  };
}

export interface EngagementSource {
  id: string;
  providers: FocusProviderName[];
  layout: SourceLayout;
  metadata: SourceMetadata;
}

export interface SharedCostRule {
  id: string;
  /** An allocation.ts method name (src/attribution/allocation.ts AllocationRule). */
  rule: SharedCostRuleName;
  /** Optional ServiceName the rule applies to. */
  serviceName?: string;
  /** Workload ids sharing the cost (required for even_split). */
  targets?: string[];
}

export interface EngagementWorkload {
  id: string;
  owner: string;
}

export interface ScenarioAssumptions {
  inputTokensPerMonth: number;
  outputTokensPerMonth: number;
  /** Share (0..1) of input tokens served from cache. Default 0. */
  cachedInputShare: number;
  /** Share (0..1) of tokens run as batch. Default 0. */
  batchShare: number;
}

export interface EngagementScenario {
  id: string;
  workload: string;
  /** MODEL_REGISTRY ids (src/data/models.ts). */
  currentModel: string;
  candidateModel: string;
  assumptions: ScenarioAssumptions;
}

export interface EngagementBudget {
  workload: string;
  /** Monthly amount, positive decimal string, at least one cent, in `currency`. */
  monthly: string;
}

export interface EngagementConfig {
  engagementId: string;
  /** The single tenant the reader is bound to (canonical lowercase UUID). */
  tenantId: string;
  displayName: string;
  /** ISO-shaped currency of budgets and reports. No FX is applied. */
  currency: string;
  sources: EngagementSource[];
  allocation: {
    workloadTagKey: string;
    ownerTagKey: string;
    /** SubAccountId -> workload id. */
    subAccountMap: Record<string, string>;
    workloads: EngagementWorkload[];
    sharedCostRules: SharedCostRule[];
  };
  budgets: EngagementBudget[];
  scenarios: EngagementScenario[];
  outcomesFile?: string;
}

export type ValidateResult = { ok: true; config: EngagementConfig } | { ok: false; problems: string[] };
export type LoadResult = { ok: true; config: EngagementConfig; sha256: string } | { ok: false; problems: string[] };

export class EngagementConfigError extends Error {
  readonly problems: string[];
  constructor(problems: string[]) {
    super(`invalid engagement configuration: ${problems.join('; ')}`);
    this.name = 'EngagementConfigError';
    this.problems = problems;
  }
}

// ---------------------------------------------------------------------------
// Guards
// ---------------------------------------------------------------------------
const MAX_BYTES = 1024 * 1024;
// Same canonical-UUID rule as src/ingest/db/tenant.ts isTenantId; not imported because
// src/ingest is off-limits to app code outside the reviewed read-API island (importBoundary).
const UUID_RE = /^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$/;
const isTenantId = (v: string) => UUID_RE.test(v);
const ID_RE = /^[a-z0-9][a-z0-9-]{0,62}$/;
const SOURCE_ID_RE = /^[a-z0-9][a-z0-9._-]{0,62}$/;
const CURRENCY_RE = /^[A-Z]{3}$/;
const DECIMAL_RE = /^\d+(\.\d+)?$/;
const SIGNED_DECIMAL_RE = /^-?\d+(\.\d+)?$/;
const ISO_TS_RE = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(\.\d+)?(Z|[+-]\d{2}:\d{2})$/;
// eslint-disable-next-line no-control-regex
const CONTROL_RE = /[\u0000-\u001f\u007f]/;

type Obj = Record<string, unknown>;
const isObj = (v: unknown): v is Obj => typeof v === 'object' && v !== null && !Array.isArray(v);
const has = (o: Obj, k: string) => Object.prototype.hasOwnProperty.call(o, k);

class Ctx {
  readonly problems: string[] = [];
  bad(key: string, why: string) {
    this.problems.push(`${key}: ${why}`);
  }
}

function safeKey(k: string): string {
  return k.replace(/[^A-Za-z0-9_.-]/g, '?').slice(0, 40);
}

/** Checks a plain object and rejects keys outside `allowed` (key name only). */
function object(c: Ctx, v: unknown, key: string, allowed: readonly string[]): Obj | null {
  if (!isObj(v)) {
    c.bad(key, 'must be an object');
    return null;
  }
  for (const k of Object.keys(v)) if (!allowed.includes(k)) c.bad(key === '' ? safeKey(k) : `${key}.${safeKey(k)}`, 'unknown key');
  return v;
}
const at = (parent: string, k: string) => (parent === '' ? k : `${parent}.${k}`);

function text(c: Ctx, o: Obj, parent: string, k: string, max = 200): string | null {
  const key = at(parent, k);
  const v = o[k];
  if (typeof v !== 'string' || v.trim() === '' || v.length > max || CONTROL_RE.test(v)) {
    c.bad(key, `must be a non-empty single-line string of at most ${max} characters`);
    return null;
  }
  return v;
}
function oneOf<T extends string>(c: Ctx, o: Obj, parent: string, k: string, allowed: readonly T[]): T | null {
  const v = o[k];
  if (typeof v === 'string' && (allowed as readonly string[]).includes(v)) return v as T;
  c.bad(at(parent, k), `must be one of: ${allowed.join(', ')}`);
  return null;
}
function array(c: Ctx, o: Obj, parent: string, k: string, min = 0, max = 1000): unknown[] | null {
  const v = o[k];
  if (!Array.isArray(v) || v.length < min || v.length > max) {
    c.bad(at(parent, k), min > 0 ? `must be an array of ${min} to ${max} items` : `must be an array of at most ${max} items`);
    return null;
  }
  return v;
}
function validIsoTimestamp(v: unknown): number | null {
  if (typeof v !== 'string') return null;
  const m = ISO_TS_RE.exec(v);
  if (!m) return null;
  const [y, mo, d, h, mi, s] = [1, 2, 3, 4, 5, 6].map((i) => Number(m[i]));
  if (mo < 1 || mo > 12 || d < 1 || d > new Date(Date.UTC(y, mo, 0)).getUTCDate() || h > 23 || mi > 59 || s > 59) return null;
  const t = Date.parse(v);
  return Number.isNaN(t) ? null : t;
}
/** Budget validity (positive, at least one cent), the repo's rule (metricContracts: below $0.01 is N/A). */
function atLeastOneCent(v: string): boolean {
  const [int, frac = ''] = v.split('.');
  return /[1-9]/.test(int) || /[1-9]/.test(frac.padEnd(2, '0').slice(0, 2));
}

const PROVIDER_VALUES = ['AWS', 'Azure', 'GCP', 'OCI', 'other'] as const;
const META_KEYS = ['provider', 'source_kind', 'schema_version', 'provenance', 'sanitization', 'scope', 'delivery', 'financial', 'overlap'] as const;
const TRI = ['included', 'excluded', 'unknown'] as const;

function currencyTotals(c: Ctx, o: Obj, parent: string, k: string, currencies: string[]): CurrencyTotals | null {
  const key = at(parent, k);
  const v = o[k];
  if (v === 'not_available') return v;
  if (!isObj(v)) {
    c.bad(key, "must be an object of exact decimal strings per currency, or 'not_available'");
    return null;
  }
  const keys = Object.keys(v);
  let ok = keys.length === currencies.length && keys.every((x) => currencies.includes(x));
  for (const x of keys) if (typeof v[x] !== 'string' || !SIGNED_DECIMAL_RE.test(v[x] as string) || (v[x] as string).length > 40) ok = false;
  if (!ok) {
    c.bad(key, 'must have exactly one exact decimal string per declared currency');
    return null;
  }
  return v as Record<string, string>;
}

function metadata(c: Ctx, v: unknown, key: string, sourceIds: Set<string>, selfId: string | null): SourceMetadata | null {
  const m = object(c, v, key, META_KEYS);
  if (!m) return null;
  const before = c.problems.length;
  const provider = oneOf(c, m, key, 'provider', PROVIDER_VALUES);
  const source_kind = oneOf(c, m, key, 'source_kind', ['focus-export', 'native-export', 'api'] as const);
  const schema_version = text(c, m, key, 'schema_version', 32);
  const provenance = oneOf(c, m, key, 'provenance', ['authorized-real-export', 'official-example'] as const);
  const sanitization = text(c, m, key, 'sanitization', 500);

  // scope
  const sk = at(key, 'scope');
  const s = object(c, m.scope, sk, ['accounts', 'period_start', 'period_end', 'period_end_semantics', 'timezone', 'completeness', 'subset_description']) ?? {};
  let accounts: SourceMetadata['scope']['accounts'] | null = null;
  if (s.accounts === 'pseudonymized-identifiers' || s.accounts === 'unknown' || s.accounts === 'not_available') accounts = s.accounts;
  else if (Array.isArray(s.accounts) && s.accounts.length > 0 && s.accounts.length <= 10000 && s.accounts.every((a) => typeof a === 'string' && a !== '' && a.length <= 128 && !CONTROL_RE.test(a))) accounts = s.accounts as string[];
  else c.bad(at(sk, 'accounts'), "must be 'pseudonymized-identifiers', 'unknown', 'not_available' or a list of account identifiers");
  const t0 = validIsoTimestamp(s.period_start);
  const t1 = validIsoTimestamp(s.period_end);
  if (t0 === null) c.bad(at(sk, 'period_start'), 'must be an exact ISO 8601 timestamp with a UTC offset');
  if (t1 === null) c.bad(at(sk, 'period_end'), 'must be an exact ISO 8601 timestamp with a UTC offset');
  if (t0 !== null && t1 !== null && !(t0 < t1)) c.bad(at(sk, 'period_start'), 'must be earlier than period_end');
  const period_end_semantics = oneOf(c, s, sk, 'period_end_semantics', ['inclusive', 'exclusive'] as const);
  let timezone: string | null = null;
  if (typeof s.timezone === 'string' && s.timezone.length <= 64) {
    try {
      new Intl.DateTimeFormat('en-US', { timeZone: s.timezone });
      timezone = s.timezone;
    } catch {
      /* reported below */
    }
  }
  if (timezone === null) c.bad(at(sk, 'timezone'), "must be an IANA time zone name or 'UTC'");
  const completeness = oneOf(c, s, sk, 'completeness', ['full-period', 'explicit-subset'] as const);
  let subset_description: string | undefined;
  if (completeness === 'explicit-subset') subset_description = text(c, s, sk, 'subset_description', 500) ?? undefined;
  else if (completeness === 'full-period' && has(s, 'subset_description')) c.bad(at(sk, 'subset_description'), 'only allowed with completeness explicit-subset');

  // delivery
  const dk = at(key, 'delivery');
  const d = object(c, m.delivery, dk, ['format', 'compression', 'manifest', 'refresh_behavior']) ?? {};
  const format = oneOf(c, d, dk, 'format', ['csv', 'csv-gzip', 'parquet', 'ndjson'] as const);
  const compression = text(c, d, dk, 'compression', 40);
  const manifest = text(c, d, dk, 'manifest', 255);
  if (manifest !== null && manifest !== 'not-provided' && (/[\\/]/.test(manifest) || manifest === '.' || manifest === '..')) c.bad(at(dk, 'manifest'), "must be a plain file name or 'not-provided'");
  const refresh_behavior = text(c, d, dk, 'refresh_behavior', 500);

  // financial
  const fk = at(key, 'financial');
  const f = object(c, m.financial, fk, ['currencies', 'billed_cost_total', 'effective_cost_total', 'credits_coverage', 'tax_coverage', 'control_total_source', 'known_differences']) ?? {};
  let currencies: string[] = [];
  const ca = array(c, f, fk, 'currencies', 1, 20);
  if (ca) {
    ca.forEach((x, i) => {
      if (typeof x !== 'string' || !CURRENCY_RE.test(x)) c.bad(`${at(fk, 'currencies')}[${i}]`, 'must be an ISO 4217 style code of three capital letters');
    });
    currencies = ca.filter((x): x is string => typeof x === 'string' && CURRENCY_RE.test(x));
    if (new Set(currencies).size !== currencies.length) c.bad(at(fk, 'currencies'), 'must not repeat a currency');
  }
  const billed = currencyTotals(c, f, fk, 'billed_cost_total', currencies);
  const effective = currencyTotals(c, f, fk, 'effective_cost_total', currencies);
  const credits_coverage = oneOf(c, f, fk, 'credits_coverage', TRI);
  const tax_coverage = oneOf(c, f, fk, 'tax_coverage', TRI);
  const control_total_source = oneOf(c, f, fk, 'control_total_source', ['export-query', 'console', 'invoice', 'not_available'] as const);
  if (control_total_source === 'not_available' && (billed !== 'not_available' || effective !== 'not_available') && billed !== null && effective !== null) c.bad(at(fk, 'control_total_source'), 'totals are given but their source is not_available');
  if (control_total_source && control_total_source !== 'not_available' && billed === 'not_available' && effective === 'not_available') c.bad(at(fk, 'control_total_source'), 'a control total source is named but no totals are given');
  const known_differences = text(c, f, fk, 'known_differences', 1000);

  // overlap
  const ok_ = at(key, 'overlap');
  const o = object(c, m.overlap, ok_, ['also_present_in_other_source', 'related_source']) ?? {};
  const also = oneOf(c, o, ok_, 'also_present_in_other_source', ['yes', 'no', 'unknown'] as const);
  const related = text(c, o, ok_, 'related_source', 63);
  if (related !== null && also !== null) {
    const resolves = related !== selfId && sourceIds.has(related);
    if (also === 'yes' && !resolves) c.bad(at(ok_, 'related_source'), 'must name another source id from this config when also_present_in_other_source is yes');
    else if (also !== 'yes' && related !== 'none' && !resolves) c.bad(at(ok_, 'related_source'), "must be 'none' or another source id from this config");
  }

  if (c.problems.length > before) return null;
  return {
    provider: provider!, source_kind: source_kind!, schema_version: schema_version!, provenance: provenance!, sanitization: sanitization!,
    scope: { accounts: accounts!, period_start: s.period_start as string, period_end: s.period_end as string, period_end_semantics: period_end_semantics!, timezone: timezone!, completeness: completeness!, ...(subset_description ? { subset_description } : {}) },
    delivery: { format: format!, compression: compression!, manifest: manifest!, refresh_behavior: refresh_behavior! },
    financial: { currencies, billed_cost_total: billed!, effective_cost_total: effective!, credits_coverage: credits_coverage!, tax_coverage: tax_coverage!, control_total_source: control_total_source!, known_differences: known_differences! },
    overlap: { also_present_in_other_source: also!, related_source: related! },
  };
}

const TOP_KEYS = ['engagementId', 'tenantId', 'displayName', 'currency', 'sources', 'allocation', 'budgets', 'scenarios', 'outcomesFile'] as const;

/** Schema validation of an already parsed value. Never echoes values. */
export function validateEngagementConfig(input: unknown): ValidateResult {
  const c = new Ctx();
  const root = object(c, input, '', TOP_KEYS);
  if (!root) return { ok: false, problems: ['config: must be a JSON object'] };

  const engagementId = typeof root.engagementId === 'string' && ID_RE.test(root.engagementId) ? root.engagementId : null;
  if (!engagementId) c.bad('engagementId', 'must be 1 to 63 characters of lowercase letters, digits and hyphens');
  const tenantId = typeof root.tenantId === 'string' && isTenantId(root.tenantId) ? root.tenantId.toLowerCase() : null;
  if (!tenantId) c.bad('tenantId', 'must be a canonical UUID');
  const displayName = text(c, root, '', 'displayName', 120);
  const currency = typeof root.currency === 'string' && CURRENCY_RE.test(root.currency) ? root.currency : null;
  if (!currency) c.bad('currency', 'must be an ISO 4217 style code of three capital letters');

  // sources
  const sources: EngagementSource[] = [];
  const srcRaw = array(c, root, '', 'sources', 1, 50);
  const ids = new Set<string>();
  if (srcRaw) {
    srcRaw.forEach((s) => {
      if (isObj(s) && typeof s.id === 'string' && SOURCE_ID_RE.test(s.id)) ids.add(s.id);
    });
    const seen = new Set<string>();
    srcRaw.forEach((s, i) => {
      const k = `sources[${i}]`;
      const o = object(c, s, k, ['id', 'providers', 'layout', 'metadata']);
      if (!o) return;
      const idOk = typeof o.id === 'string' && SOURCE_ID_RE.test(o.id);
      if (!idOk) c.bad(`${k}.id`, 'must be 1 to 63 characters of lowercase letters, digits, dot, underscore and hyphen');
      else if (seen.has(o.id as string)) c.bad(`${k}.id`, 'duplicate source id');
      else seen.add(o.id as string);
      const provs = array(c, o, k, 'providers', 1, 4);
      const providers: FocusProviderName[] = [];
      provs?.forEach((p, j) => {
        if (typeof p === 'string' && (FOCUS_PROVIDER_NAMES as readonly string[]).includes(p)) providers.push(p as FocusProviderName);
        else c.bad(`${k}.providers[${j}]`, `must be one of: ${FOCUS_PROVIDER_NAMES.join(', ')}`);
      });
      if (provs && new Set(providers).size !== providers.length) c.bad(`${k}.providers`, 'must not repeat a provider');
      const layout = oneOf(c, o, k, 'layout', SOURCE_LAYOUTS);
      const md = metadata(c, o.metadata, `${k}.metadata`, ids, idOk ? (o.id as string) : null);
      if (idOk && layout && md && provs) sources.push({ id: o.id as string, providers, layout, metadata: md });
    });
  }

  // allocation
  const ak = 'allocation';
  const a = object(c, root.allocation, ak, ['workloadTagKey', 'ownerTagKey', 'subAccountMap', 'workloads', 'sharedCostRules']) ?? {};
  const workloadTagKey = text(c, a, ak, 'workloadTagKey', 128);
  const ownerTagKey = text(c, a, ak, 'ownerTagKey', 128);
  const workloads: EngagementWorkload[] = [];
  const wl = array(c, a, ak, 'workloads', 1, 1000);
  const wids = new Set<string>();
  wl?.forEach((w, i) => {
    const k = `${ak}.workloads[${i}]`;
    const o = object(c, w, k, ['id', 'owner']);
    if (!o) return;
    const id = text(c, o, k, 'id', 128);
    const owner = text(c, o, k, 'owner', 128);
    if (id && wids.has(id)) c.bad(`${k}.id`, 'duplicate workload id');
    if (id && owner) {
      wids.add(id);
      workloads.push({ id, owner });
    }
  });
  const subAccountMap: Record<string, string> = {};
  const sm = a.subAccountMap;
  if (!isObj(sm) || Object.keys(sm).length > 10000) c.bad(`${ak}.subAccountMap`, 'must be an object mapping sub-account ids to workload ids');
  else
    Object.keys(sm).forEach((acct, i) => {
      const w = sm[acct];
      if (acct === '' || acct.length > 128 || CONTROL_RE.test(acct)) c.bad(`${ak}.subAccountMap[${i}]`, 'sub-account id must be a non-empty single-line string of at most 128 characters');
      else if (typeof w !== 'string' || !wids.has(w)) c.bad(`${ak}.subAccountMap[${i}]`, 'must map to a declared workload id');
      else subAccountMap[acct] = w;
    });
  const sharedCostRules: SharedCostRule[] = [];
  const sr = array(c, a, ak, 'sharedCostRules', 0, 100);
  const ruleIds = new Set<string>();
  sr?.forEach((r, i) => {
    const k = `${ak}.sharedCostRules[${i}]`;
    const o = object(c, r, k, ['id', 'rule', 'serviceName', 'targets']);
    if (!o) return;
    const id = text(c, o, k, 'id', 63);
    if (id && ruleIds.has(id)) c.bad(`${k}.id`, 'duplicate rule id');
    if (id) ruleIds.add(id);
    const rule = oneOf(c, o, k, 'rule', ALLOCATION_RULES);
    const serviceName = has(o, 'serviceName') ? text(c, o, k, 'serviceName', 200) : null;
    let targets: string[] | undefined;
    if (rule === 'even_split' || has(o, 'targets')) {
      const t = array(c, o, k, 'targets', 1, 1000);
      if (t && t.every((x) => typeof x === 'string' && wids.has(x))) targets = t as string[];
      else if (t) c.bad(`${k}.targets`, 'must list declared workload ids');
    }
    if (id && rule) sharedCostRules.push({ id, rule, ...(serviceName ? { serviceName } : {}), ...(targets ? { targets } : {}) });
  });

  // budgets
  const budgets: EngagementBudget[] = [];
  const bd = array(c, root, '', 'budgets', 0, 1000);
  const bw = new Set<string>();
  bd?.forEach((b, i) => {
    const k = `budgets[${i}]`;
    const o = object(c, b, k, ['workload', 'monthly']);
    if (!o) return;
    const workload = typeof o.workload === 'string' && wids.has(o.workload) ? o.workload : null;
    if (!workload) c.bad(`${k}.workload`, 'must be a declared workload id');
    else if (bw.has(workload)) c.bad(`${k}.workload`, 'duplicate budget for this workload');
    const monthly = typeof o.monthly === 'string' && o.monthly.length <= 40 && DECIMAL_RE.test(o.monthly) && atLeastOneCent(o.monthly) ? o.monthly : null;
    if (!monthly) c.bad(`${k}.monthly`, 'must be a decimal string of at least one cent (0.01)');
    if (workload && !bw.has(workload) && monthly) {
      bw.add(workload);
      budgets.push({ workload, monthly });
    }
  });

  // scenarios
  const scenarios: EngagementScenario[] = [];
  const sc = array(c, root, '', 'scenarios', 0, 100);
  const modelIds = MODEL_REGISTRY.map((m) => m.id);
  const scIds = new Set<string>();
  sc?.forEach((s, i) => {
    const k = `scenarios[${i}]`;
    const o = object(c, s, k, ['id', 'workload', 'currentModel', 'candidateModel', 'assumptions']);
    if (!o) return;
    const id = text(c, o, k, 'id', 63);
    if (id && scIds.has(id)) c.bad(`${k}.id`, 'duplicate scenario id');
    if (id) scIds.add(id);
    const workload = typeof o.workload === 'string' && wids.has(o.workload) ? o.workload : null;
    if (!workload) c.bad(`${k}.workload`, 'must be a declared workload id');
    const currentModel = oneOf(c, o, k, 'currentModel', modelIds);
    const candidateModel = oneOf(c, o, k, 'candidateModel', modelIds);
    if (currentModel && candidateModel && currentModel === candidateModel) c.bad(`${k}.candidateModel`, 'must differ from currentModel');
    const ak2 = `${k}.assumptions`;
    const as = object(c, o.assumptions, ak2, ['inputTokensPerMonth', 'outputTokensPerMonth', 'cachedInputShare', 'batchShare']) ?? {};
    const tokens = (key: string) => {
      const v = as[key];
      if (typeof v === 'number' && Number.isSafeInteger(v) && v >= 0) return v;
      c.bad(at(ak2, key), 'must be a non-negative integer');
      return null;
    };
    const share = (key: string) => {
      if (!has(as, key)) return 0;
      const v = as[key];
      if (typeof v === 'number' && v >= 0 && v <= 1) return v;
      c.bad(at(ak2, key), 'must be a number from 0 to 1');
      return null;
    };
    const inT = tokens('inputTokensPerMonth');
    const outT = tokens('outputTokensPerMonth');
    const cached = share('cachedInputShare');
    const batch = share('batchShare');
    if (id && workload && currentModel && candidateModel && inT !== null && outT !== null && cached !== null && batch !== null)
      scenarios.push({ id, workload, currentModel, candidateModel, assumptions: { inputTokensPerMonth: inT, outputTokensPerMonth: outT, cachedInputShare: cached, batchShare: batch } });
  });

  let outcomesFile: string | undefined;
  if (has(root, 'outcomesFile')) {
    const v = root.outcomesFile;
    if (typeof v === 'string' && v !== '' && v.length <= 1024 && !v.includes('\0')) outcomesFile = v;
    else c.bad('outcomesFile', 'must be a non-empty file path string');
  }

  if (c.problems.length > 0 || !engagementId || !tenantId || !displayName || !currency || !workloadTagKey || !ownerTagKey) return { ok: false, problems: c.problems.length ? c.problems : ['config: invalid'] };
  return {
    ok: true,
    config: {
      engagementId, tenantId, displayName, currency, sources,
      allocation: { workloadTagKey, ownerTagKey, subAccountMap, workloads, sharedCostRules },
      budgets, scenarios, ...(outcomesFile ? { outcomesFile } : {}),
    },
  };
}

/** What this release can actually import (file import of CSV only). */
function releasePolicy(config: EngagementConfig): string[] {
  const p: string[] = [];
  config.sources.forEach((s, i) => {
    const k = `sources[${i}].metadata`;
    if (s.metadata.source_kind === 'api') p.push(`${k}.source_kind: api sources are not supported in this release (file import only)`);
    if (s.metadata.delivery.format !== 'csv' && s.metadata.delivery.format !== 'csv-gzip') p.push(`${k}.delivery.format: not supported in this release (csv, csv-gzip only)`);
  });
  return p;
}

/** Reads, hashes and validates the config file, then applies the release policy. */
export function loadEngagementConfig(file: string): LoadResult {
  const V = 'RATIO_ENGAGEMENT_CONFIG';
  if (typeof file !== 'string' || file.trim() === '') return { ok: false, problems: [`${V}: is missing`] };
  if (!path.isAbsolute(file)) return { ok: false, problems: [`${V}: must be an absolute path`] };
  let bytes: Buffer;
  try {
    bytes = fs.readFileSync(file);
  } catch {
    return { ok: false, problems: [`${V}: file is missing or unreadable`] };
  }
  if (bytes.length > MAX_BYTES) return { ok: false, problems: [`${V}: file is larger than 1 MiB`] };
  let parsed: unknown;
  try {
    parsed = JSON.parse(bytes.toString('utf8'));
  } catch {
    return { ok: false, problems: [`${V}: file is not valid JSON`] };
  }
  const v = validateEngagementConfig(parsed);
  if (!v.ok) return v;
  const policy = releasePolicy(v.config);
  if (policy.length) return { ok: false, problems: policy };
  return { ok: true, config: v.config, sha256: createHash('sha256').update(bytes).digest('hex') };
}

// ---------------------------------------------------------------------------
// Mode and startup
// ---------------------------------------------------------------------------
/** True only for RATIO_MODE=engagement. Empty/unset is off; any other value is an error (typo must not fall back to the demo). */
export function engagementMode(env: Env): boolean {
  const m = env.RATIO_MODE;
  if (m === undefined || m === '') return false;
  if (m === 'engagement') return true;
  throw new Error('RATIO_MODE: must be unset or "engagement"');
}

/** Loads the config named by RATIO_ENGAGEMENT_CONFIG (engagement mode only; the caller has checked the mode). */
export function engagementConfigFromEnv(env: Env): LoadResult {
  return loadEngagementConfig(env.RATIO_ENGAGEMENT_CONFIG ?? '');
}

/**
 * Startup check (instrumentation). null outside engagement mode; in engagement
 * mode returns the config plus its sha256 or THROWS EngagementConfigError
 * (keys only), so the server refuses to start.
 */
export function checkEngagementStartup(env: Env): { config: EngagementConfig; sha256: string } | null {
  if (!engagementMode(env)) return null;
  const r = engagementConfigFromEnv(env);
  if (!r.ok) throw new EngagementConfigError(r.problems);
  return { config: r.config, sha256: r.sha256 };
}

// ---------------------------------------------------------------------------
// Display
// ---------------------------------------------------------------------------
export interface MetadataRow {
  label: string;
  value: string;
}

const totals = (t: CurrencyTotals) => (t === 'not_available' ? 'not_available' : Object.entries(t).map(([cur, amt]) => `${cur} ${amt}`).join(', '));

/** Flat, display-ready (label, value) list for the status page and report provenance footer. */
export function describeSourceMetadata(m: SourceMetadata): MetadataRow[] {
  const a = m.scope.accounts;
  return [
    { label: 'Provider', value: m.provider },
    { label: 'Source kind', value: m.source_kind },
    { label: 'Schema version', value: m.schema_version },
    { label: 'Provenance', value: m.provenance },
    { label: 'Sanitization', value: m.sanitization },
    { label: 'Accounts', value: Array.isArray(a) ? `${a.length} listed` : a },
    { label: 'Period start', value: m.scope.period_start },
    { label: 'Period end', value: m.scope.period_end },
    { label: 'Period end semantics', value: m.scope.period_end_semantics },
    { label: 'Time zone', value: m.scope.timezone },
    { label: 'Completeness', value: m.scope.completeness },
    ...(m.scope.subset_description ? [{ label: 'Subset description', value: m.scope.subset_description }] : []),
    { label: 'Format', value: m.delivery.format },
    { label: 'Compression', value: m.delivery.compression },
    { label: 'Manifest', value: m.delivery.manifest },
    { label: 'Refresh behavior', value: m.delivery.refresh_behavior },
    { label: 'Currencies', value: m.financial.currencies.join(', ') },
    { label: 'Billed cost total', value: totals(m.financial.billed_cost_total) },
    { label: 'Effective cost total', value: totals(m.financial.effective_cost_total) },
    { label: 'Credits coverage', value: m.financial.credits_coverage },
    { label: 'Tax coverage', value: m.financial.tax_coverage },
    { label: 'Control total source', value: m.financial.control_total_source },
    { label: 'Known differences', value: m.financial.known_differences },
    { label: 'Also present in another source', value: m.overlap.also_present_in_other_source },
    { label: 'Related source', value: m.overlap.related_source },
  ];
}
