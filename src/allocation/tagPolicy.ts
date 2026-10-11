// Tag-policy governance: required keys, allowed values, normalization and typo
// suggestions, compliance percentages, and a violation list with spend at risk.
//
// Trust boundary: the policy and the rows are untrusted. The policy is compiled
// whole and refused on any problem (caps, duplicates, aliases that point at a
// value that is not allowed). Rows go through the same validation and tenant
// scoping as allocation (tags are null-prototype copies, so `__proto__` and
// `constructor` keys are inert data). Suggestions are computed with a bounded
// edit distance on strings of at most LIMITS.maxEditDistanceLength characters,
// and the total number of distance computations per call is budgeted
// (SUGGESTION_BUDGET), so hostile input cannot force quadratic work; when the
// budget runs out the report says so (`suggestionsTruncated`) and goes on
// without further suggestions. Compliance numbers are never affected.
//
// Semantics:
//   * A REQUIRED key must be present with a non-blank value. An OPTIONAL key is
//     checked only when present (blank is flagged only if it has allowed values).
//   * If a rule has `allowedValues`, the value must equal one of them. Matching
//     is EXACT by default; `valueMatching: 'ignoreCase'` makes case-only
//     differences compliant. Either way a near miss gets a suggestion.
//   * Suggestions, in priority order: ALIAS (policy-declared), CASE ('prod' vs
//     'Prod'), FORMAT (equal after Unicode NFKC, lowercase and removal of
//     whitespace and `_-./:`), ABBREVIATION (a unique prefix of at least three
//     characters, e.g. 'prod' for 'Production'), TYPO (bounded
//     optimal-string-alignment edit distance, tolerance min(maxEditDistance,
//     max(1, floor(candidateLength / 4)))). Ties go to the smallest candidate by
//     code-unit order. A missing required key may get a RENAME_KEY suggestion
//     from the row's own keys (CASE, FORMAT or TYPO of the required key).
//   * Spend is measured GROSS (absolute value of each row), per currency, so a
//     credit cannot offset a violation and currencies are never summed.
//     Percentages are rounded DOWN to basis points, so compliance is never
//     overstated.
//   * Resource count: a resource is its `resourceId` (a row without one counts
//     as its own resource). A resource is compliant only if every one of its
//     rows is.
//   * The violation list is sorted by currency, then spend at risk (largest
//     first), then row id, and returned up to LIMITS.maxViolationsReturned;
//     `violationCount` is always the true count.

import { AllocationError } from './errors';
import { LIMITS, checkText, compareKeys, isPlainObject, own } from './limits';
import { ZERO, formatMinor, type RoundingMode } from './money';
import { checkTenant, normalizeRows, type AllocatableRow, type NormalizedRow } from './rows';

export interface TagKeyRule {
  key: string;
  required: boolean;
  allowedValues?: string[];
  /** Known wrong spellings -> the allowed value they should become, e.g. { prd: 'Production' }. */
  aliases?: Record<string, string>;
}

export interface TagPolicy {
  rules: TagKeyRule[];
  /** 'exact' (default) or 'ignoreCase'. */
  valueMatching?: 'exact' | 'ignoreCase';
  /** Edit-distance bound for typo suggestions, 1 to 3 (default 2). */
  maxEditDistance?: number;
}

export type IssueKind = 'MISSING_KEY' | 'EMPTY_VALUE' | 'INVALID_VALUE';
export type SuggestionReason = 'ALIAS' | 'CASE' | 'FORMAT' | 'ABBREVIATION' | 'TYPO';

export interface TagSuggestion {
  type: 'RENAME_KEY' | 'REPLACE_VALUE';
  /** The key or value found on the row. */
  from: string;
  to: string;
  reason: SuggestionReason;
}

export interface TagIssue {
  kind: IssueKind;
  key: string;
  /** The offending value, or null for a missing key. */
  value: string | null;
  suggestion: TagSuggestion | null;
}

export interface TagViolation {
  rowId: string;
  resourceId: string | null;
  currency: string;
  month: string;
  /** Gross (absolute) minor units of the row: the spend at risk. */
  atRiskMinor: bigint;
  atRisk: string;
  issues: readonly TagIssue[];
}

export interface TagComplianceCurrency {
  currency: string;
  rowCount: number;
  grossMinor: bigint;
  compliantGrossMinor: bigint;
  atRiskGrossMinor: bigint;
  gross: string;
  atRisk: string;
  /** Basis points (0 to 10000), rounded down; null when there is no spend. */
  complianceBpsBySpend: number | null;
  compliancePctBySpend: string | null;
  resourceCount: number;
  compliantResourceCount: number;
  complianceBpsByResourceCount: number | null;
  compliancePctByResourceCount: string | null;
}

export interface TagComplianceReport {
  tenant: string;
  rowCount: number;
  currencies: readonly TagComplianceCurrency[];
  /** Resource counts across all currencies (a count, not money). */
  resources: {
    total: number;
    compliant: number;
    nonCompliant: number;
    complianceBps: number | null;
    compliancePct: string | null;
  };
  violationCount: number;
  violations: readonly TagViolation[];
  /** True when more violations exist than were returned. */
  truncated: boolean;
  issueCounts: ReadonlyArray<{ key: string; kind: IssueKind; count: number }>;
  /** True when the suggestion budget ran out; some issues then have no suggestion. */
  suggestionsTruncated: boolean;
}

/** Edit-distance computations allowed per evaluation. */
export const SUGGESTION_BUDGET = 200_000;

// ---------------------------------------------------------------- edit distance

/**
 * Optimal-string-alignment (restricted Damerau-Levenshtein) distance, bounded.
 * Returns null when the distance exceeds `max` or either string is longer than
 * LIMITS.maxEditDistanceLength. Early exit keeps it near O(max * length).
 */
export function boundedEditDistance(a: string, b: string, max: number): number | null {
  const cap = LIMITS.maxEditDistanceLength;
  if (a.length > cap || b.length > cap) return null;
  if (Math.abs(a.length - b.length) > max) return null;
  if (a === b) return 0;
  const n = a.length;
  const m = b.length;
  let prev2: number[] = new Array<number>(m + 1).fill(0);
  let prev: number[] = new Array<number>(m + 1);
  let cur: number[] = new Array<number>(m + 1);
  for (let j = 0; j <= m; j++) prev[j] = j;
  for (let i = 1; i <= n; i++) {
    cur[0] = i;
    let rowMin = cur[0];
    for (let j = 1; j <= m; j++) {
      const cost = a.charCodeAt(i - 1) === b.charCodeAt(j - 1) ? 0 : 1;
      let v = Math.min(prev[j] + 1, cur[j - 1] + 1, prev[j - 1] + cost);
      if (i > 1 && j > 1 && a.charCodeAt(i - 1) === b.charCodeAt(j - 2) && a.charCodeAt(i - 2) === b.charCodeAt(j - 1)) {
        v = Math.min(v, prev2[j - 2] + 1);
      }
      cur[j] = v;
      if (v < rowMin) rowMin = v;
    }
    if (rowMin > max) return null;
    const t = prev2;
    prev2 = prev;
    prev = cur;
    cur = t;
  }
  return prev[m] <= max ? prev[m] : null;
}

/** NFKC, lowercase, and removal of whitespace and `_-./:` separators. */
export function normalizeToken(s: string): string {
  return s.normalize('NFKC').toLowerCase().replace(/[\s_\-./:]+/g, '');
}

function tolerance(candidateLength: number, maxDistance: number): number {
  return Math.min(maxDistance, Math.max(1, Math.floor(candidateLength / 4)));
}

// ---------------------------------------------------------------- compiled policy

interface CompiledKeyRule {
  key: string;
  required: boolean;
  allowed: readonly string[] | null; // sorted by code-unit order
  allowedSet: ReadonlySet<string>;
  allowedByLower: ReadonlyMap<string, string>;
  allowedByNormalized: ReadonlyMap<string, string>;
  aliasByNormalized: ReadonlyMap<string, string>;
}

interface CompiledTagPolicy {
  rules: readonly CompiledKeyRule[];
  ignoreCase: boolean;
  maxEditDistance: number;
  keyNames: ReadonlySet<string>;
}

function compileTagPolicy(raw: unknown): CompiledTagPolicy {
  if (!isPlainObject(raw)) throw new AllocationError('INVALID_POLICY');
  for (const k of Object.keys(raw)) {
    if (k !== 'rules' && k !== 'valueMatching' && k !== 'maxEditDistance') throw new AllocationError('INVALID_POLICY');
  }
  const rulesRaw = own(raw, 'rules');
  if (!Array.isArray(rulesRaw)) throw new AllocationError('INVALID_POLICY');
  if (rulesRaw.length > LIMITS.maxPolicyKeys) throw new AllocationError('TOO_MANY_POLICY_ENTRIES');
  const matching = own(raw, 'valueMatching') ?? 'exact';
  if (matching !== 'exact' && matching !== 'ignoreCase') throw new AllocationError('INVALID_POLICY');
  const ignoreCase = matching === 'ignoreCase';
  const maxDistRaw = own(raw, 'maxEditDistance') ?? 2;
  if (typeof maxDistRaw !== 'number' || !Number.isInteger(maxDistRaw) || maxDistRaw < 1 || maxDistRaw > 3) {
    throw new AllocationError('INVALID_POLICY');
  }

  const seenKeys = new Set<string>();
  const rules: CompiledKeyRule[] = [];
  for (const entry of rulesRaw as unknown[]) {
    if (!isPlainObject(entry)) throw new AllocationError('INVALID_POLICY');
    for (const k of Object.keys(entry)) {
      if (k !== 'key' && k !== 'required' && k !== 'allowedValues' && k !== 'aliases') throw new AllocationError('INVALID_POLICY');
    }
    const key = checkText(own(entry, 'key'), LIMITS.maxTagKeyLength, 'INVALID_POLICY');
    if (seenKeys.has(key)) throw new AllocationError('INVALID_POLICY');
    seenKeys.add(key);
    const required = own(entry, 'required');
    if (typeof required !== 'boolean') throw new AllocationError('INVALID_POLICY');

    let allowed: string[] | null = null;
    const allowedRaw = own(entry, 'allowedValues');
    if (allowedRaw !== undefined) {
      if (!Array.isArray(allowedRaw) || allowedRaw.length === 0) throw new AllocationError('INVALID_POLICY');
      if (allowedRaw.length > LIMITS.maxAllowedValues) throw new AllocationError('TOO_MANY_POLICY_ENTRIES');
      const uniq = new Set<string>();
      const lowerSeen = new Set<string>();
      for (const v of allowedRaw as unknown[]) {
        const value = checkText(v, LIMITS.maxTagValueLength, 'INVALID_POLICY');
        if (uniq.has(value)) throw new AllocationError('INVALID_POLICY');
        uniq.add(value);
        if (ignoreCase) {
          // Case-insensitive matching needs a single canonical spelling per value.
          const lower = value.toLowerCase();
          if (lowerSeen.has(lower)) throw new AllocationError('INVALID_POLICY');
          lowerSeen.add(lower);
        }
      }
      allowed = [...uniq].sort(compareKeys);
    }

    const aliasByNormalized = new Map<string, string>();
    const aliasesRaw = own(entry, 'aliases');
    if (aliasesRaw !== undefined) {
      if (!isPlainObject(aliasesRaw) || allowed === null) throw new AllocationError('INVALID_POLICY');
      const aliasKeys = Object.keys(aliasesRaw);
      if (aliasKeys.length > LIMITS.maxAliases) throw new AllocationError('TOO_MANY_POLICY_ENTRIES');
      for (const alias of aliasKeys) {
        checkText(alias, LIMITS.maxTagValueLength, 'INVALID_POLICY');
        const target = checkText(own(aliasesRaw, alias), LIMITS.maxTagValueLength, 'INVALID_POLICY');
        if (!allowed.includes(target)) throw new AllocationError('INVALID_POLICY');
        const norm = normalizeToken(alias);
        if (norm === '' || aliasByNormalized.has(norm)) throw new AllocationError('INVALID_POLICY');
        aliasByNormalized.set(norm, target);
      }
    }

    const allowedByLower = new Map<string, string>();
    const allowedByNormalized = new Map<string, string>();
    for (const v of allowed ?? []) {
      if (!allowedByLower.has(v.toLowerCase())) allowedByLower.set(v.toLowerCase(), v);
      const norm = normalizeToken(v);
      if (norm !== '' && !allowedByNormalized.has(norm)) allowedByNormalized.set(norm, v);
    }
    rules.push({
      key,
      required,
      allowed,
      allowedSet: new Set(allowed ?? []),
      allowedByLower,
      allowedByNormalized,
      aliasByNormalized,
    });
  }
  return { rules, ignoreCase, maxEditDistance: maxDistRaw, keyNames: seenKeys };
}

// ---------------------------------------------------------------- suggestions

class Budget {
  remaining = SUGGESTION_BUDGET;
  exhausted = false;
  take(): boolean {
    if (this.remaining <= 0) {
      this.exhausted = true;
      return false;
    }
    this.remaining -= 1;
    return true;
  }
}

function suggestValue(rule: CompiledKeyRule, value: string, maxDist: number, budget: Budget): TagSuggestion | null {
  const allowed = rule.allowed;
  if (allowed === null) return null;
  const nv = normalizeToken(value);
  const make = (to: string, reason: SuggestionReason): TagSuggestion => ({ type: 'REPLACE_VALUE', from: value, to, reason });
  const alias = rule.aliasByNormalized.get(nv);
  if (alias !== undefined) return make(alias, 'ALIAS');
  const byCase = rule.allowedByLower.get(value.toLowerCase());
  if (byCase !== undefined) return make(byCase, 'CASE');
  const byFormat = rule.allowedByNormalized.get(nv);
  if (byFormat !== undefined) return make(byFormat, 'FORMAT');
  if (nv.length >= 3) {
    const hits: string[] = [];
    for (const [norm, canonical] of rule.allowedByNormalized) if (norm.startsWith(nv)) hits.push(canonical);
    if (hits.length === 1) return make(hits[0], 'ABBREVIATION');
  }
  if (nv.length === 0 || nv.length > LIMITS.maxEditDistanceLength) return null;
  let best: { to: string; d: number } | null = null;
  for (const [norm, canonical] of rule.allowedByNormalized) {
    const tol = tolerance(norm.length, maxDist);
    if (Math.abs(norm.length - nv.length) > tol) continue;
    if (!budget.take()) return null;
    const d = boundedEditDistance(nv, norm, tol);
    if (d === null) continue;
    if (best === null || d < best.d || (d === best.d && compareKeys(canonical, best.to) < 0)) best = { to: canonical, d };
  }
  return best ? make(best.to, 'TYPO') : null;
}

function suggestKey(
  rule: CompiledKeyRule,
  presentKeys: readonly string[],
  policyKeys: ReadonlySet<string>,
  maxDist: number,
  budget: Budget,
): TagSuggestion | null {
  const nk = normalizeToken(rule.key);
  const make = (from: string, reason: SuggestionReason): TagSuggestion => ({ type: 'RENAME_KEY', from, to: rule.key, reason });
  const state: { best: { from: string; rank: number; d: number } | null } = { best: null };
  const consider = (from: string, rank: number, d: number): void => {
    const b = state.best;
    if (b === null || rank < b.rank || (rank === b.rank && d < b.d) || (rank === b.rank && d === b.d && compareKeys(from, b.from) < 0)) {
      state.best = { from, rank, d };
    }
  };
  const tol = tolerance(nk.length, maxDist);
  for (const present of presentKeys) {
    if (policyKeys.has(present)) continue; // another policy key; never suggest renaming it
    if (present.toLowerCase() === rule.key.toLowerCase()) {
      consider(present, 0, 0);
      continue;
    }
    const np = normalizeToken(present);
    if (np === nk && np !== '') {
      consider(present, 1, 0);
      continue;
    }
    if (np.length === 0 || np.length > LIMITS.maxEditDistanceLength) continue;
    if (Math.abs(np.length - nk.length) > tol) continue;
    if (!budget.take()) return null;
    const d = boundedEditDistance(np, nk, tol);
    if (d !== null) consider(present, 2, d);
  }
  const found = state.best;
  if (found === null) return null;
  return make(found.from, found.rank === 0 ? 'CASE' : found.rank === 1 ? 'FORMAT' : 'TYPO');
}

// ---------------------------------------------------------------- evaluation

export function formatBps(bps: number): string {
  const whole = Math.floor(bps / 100);
  const frac = bps % 100;
  return `${whole}.${String(frac).padStart(2, '0')}`;
}

function bpsOf(part: bigint, whole: bigint): number | null {
  if (whole <= ZERO) return null;
  return Number((part * BigInt(10000)) / whole);
}

function bpsOfCount(part: number, whole: number): number | null {
  if (whole <= 0) return null;
  return Math.floor((part * 10000) / whole);
}

function abs(v: bigint): bigint {
  return v < ZERO ? -v : v;
}

function evaluateRow(
  row: NormalizedRow,
  policy: CompiledTagPolicy,
  budget: Budget,
  valueCache: Map<string, TagSuggestion | null>,
): TagIssue[] {
  const issues: TagIssue[] = [];
  let presentKeys: string[] | null = null;
  for (let ri = 0; ri < policy.rules.length; ri++) {
    const rule = policy.rules[ri];
    const has = Object.prototype.hasOwnProperty.call(row.tags, rule.key);
    if (!has) {
      if (!rule.required) continue;
      presentKeys ??= Object.keys(row.tags);
      issues.push({
        kind: 'MISSING_KEY',
        key: rule.key,
        value: null,
        suggestion: suggestKey(rule, presentKeys, policy.keyNames, policy.maxEditDistance, budget),
      });
      continue;
    }
    const value = row.tags[rule.key];
    if (value.trim() === '') {
      if (rule.required || rule.allowed !== null) issues.push({ kind: 'EMPTY_VALUE', key: rule.key, value, suggestion: null });
      continue;
    }
    if (rule.allowed === null || rule.allowedSet.has(value)) continue;
    if (policy.ignoreCase && rule.allowedByLower.has(value.toLowerCase())) continue;
    const cacheKey = `${ri}\u0000${value}`;
    let suggestion = valueCache.get(cacheKey);
    if (suggestion === undefined) {
      suggestion = suggestValue(rule, value, policy.maxEditDistance, budget);
      valueCache.set(cacheKey, suggestion);
    }
    issues.push({ kind: 'INVALID_VALUE', key: rule.key, value, suggestion });
  }
  return issues;
}

/**
 * Evaluates tag compliance for a tenant's rows against a policy. Throws a
 * fixed-text AllocationError for malformed, oversized or cross-tenant input.
 */
export function evaluateTagPolicy(
  tenantArg: string,
  rowsArg: readonly AllocatableRow[],
  policyArg: TagPolicy,
  options: { rounding?: RoundingMode } = {},
): TagComplianceReport {
  const tenant = checkTenant(tenantArg);
  const policy = compileTagPolicy(policyArg);
  const rows = normalizeRows(tenant, rowsArg, options.rounding ?? 'refuse');

  const budget = new Budget();
  const valueCache = new Map<string, TagSuggestion | null>();
  const perCurrency = new Map<
    string,
    {
      rows: number;
      gross: bigint;
      compliantGross: bigint;
      resources: Map<string, boolean>; // resource key -> compliant so far
    }
  >();
  const allResources = new Map<string, boolean>();
  const violations: TagViolation[] = [];
  const issueCounts = new Map<string, { key: string; kind: IssueKind; count: number }>();

  for (const row of rows) {
    const issues = evaluateRow(row, policy, budget, valueCache);
    const compliant = issues.length === 0;
    const gross = abs(row.minor);
    let c = perCurrency.get(row.currency);
    if (!c) {
      c = { rows: 0, gross: ZERO, compliantGross: ZERO, resources: new Map() };
      perCurrency.set(row.currency, c);
    }
    c.rows += 1;
    c.gross += gross;
    if (compliant) c.compliantGross += gross;
    const resKey = row.resourceId !== null ? `r\u0000${row.resourceId}` : `w\u0000${row.id}`;
    c.resources.set(resKey, (c.resources.get(resKey) ?? true) && compliant);
    allResources.set(resKey, (allResources.get(resKey) ?? true) && compliant);
    if (!compliant) {
      violations.push({
        rowId: row.id,
        resourceId: row.resourceId,
        currency: row.currency,
        month: row.month,
        atRiskMinor: gross,
        atRisk: formatMinor(gross, row.currency),
        issues,
      });
      for (const issue of issues) {
        const k = `${issue.key}\u0000${issue.kind}`;
        const rec = issueCounts.get(k) ?? { key: issue.key, kind: issue.kind, count: 0 };
        rec.count += 1;
        issueCounts.set(k, rec);
      }
    }
  }

  const currencies: TagComplianceCurrency[] = [];
  for (const currency of [...perCurrency.keys()].sort(compareKeys)) {
    const c = perCurrency.get(currency)!;
    const atRisk = c.gross - c.compliantGross;
    const spendBps = bpsOf(c.compliantGross, c.gross);
    let compliantResources = 0;
    for (const ok of c.resources.values()) if (ok) compliantResources += 1;
    const countBps = bpsOfCount(compliantResources, c.resources.size);
    currencies.push({
      currency,
      rowCount: c.rows,
      grossMinor: c.gross,
      compliantGrossMinor: c.compliantGross,
      atRiskGrossMinor: atRisk,
      gross: formatMinor(c.gross, currency),
      atRisk: formatMinor(atRisk, currency),
      complianceBpsBySpend: spendBps,
      compliancePctBySpend: spendBps === null ? null : formatBps(spendBps),
      resourceCount: c.resources.size,
      compliantResourceCount: compliantResources,
      complianceBpsByResourceCount: countBps,
      compliancePctByResourceCount: countBps === null ? null : formatBps(countBps),
    });
  }

  let compliantAll = 0;
  for (const ok of allResources.values()) if (ok) compliantAll += 1;
  const allBps = bpsOfCount(compliantAll, allResources.size);

  violations.sort(
    (a, b) =>
      compareKeys(a.currency, b.currency) ||
      (a.atRiskMinor > b.atRiskMinor ? -1 : a.atRiskMinor < b.atRiskMinor ? 1 : 0) ||
      compareKeys(a.rowId, b.rowId),
  );
  const returned = violations.slice(0, LIMITS.maxViolationsReturned);

  return {
    tenant,
    rowCount: rows.length,
    currencies,
    resources: {
      total: allResources.size,
      compliant: compliantAll,
      nonCompliant: allResources.size - compliantAll,
      complianceBps: allBps,
      compliancePct: allBps === null ? null : formatBps(allBps),
    },
    violationCount: violations.length,
    violations: returned,
    truncated: violations.length > returned.length,
    issueCounts: [...issueCounts.values()].sort((a, b) => compareKeys(a.key, b.key) || compareKeys(a.kind, b.kind)),
    suggestionsTruncated: budget.exhausted,
  };
}
