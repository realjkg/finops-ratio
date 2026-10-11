// Rule engine: ordered rules that route a cost row to a target or a shared pool.
//
// Trust boundary: rule sets are untrusted configuration. A rule set is compiled
// once (`compileRules`) and refused whole if anything is wrong; nothing is
// half-applied. Matching uses only string equality, `startsWith` and set
// membership, so there is no regular-expression surface and no ReDoS: a rule
// that carries a `regex`, `pattern`, `glob` or RegExp value is refused with
// REGEX_NOT_ALLOWED, never interpreted.
//
// Semantics:
//   * A rule matches when ALL its conditions match (AND). A rule needs at least
//     one condition; a catch-all must say so explicitly with { field: 'all' }.
//   * Rules are evaluated in ascending `precedence` (lower number first). FIRST
//     MATCH WINS. Precedence values must be unique integers: a tie is refused
//     (DUPLICATE_PRECEDENCE), because silently picking a winner among equal
//     rules hides a governance mistake.
//   * Matcher values are never empty, so a forgotten value cannot become a
//     catch-all. A row field that is absent (no region, no resource id) never
//     matches a condition on that field.
//   * `ignoreCase` (default false) folds VALUE comparisons with toLowerCase.
//     Tag KEYS always compare exactly.
//   * Rule and pool ids share one namespace, so a line's `ruleId` always names
//     exactly one rule or pool. `UNALLOCATED` and `UNMATCHED` are reserved.
//   * An empty rule set is valid: every row then lands in UNALLOCATED.

import { AllocationError } from './errors';
import { LIMITS, checkText, isPlainObject, own } from './limits';
import type { NormalizedRow } from './rows';
import { validateTarget, type Target } from './targets';

export type Matcher =
  | { op: 'equals'; value: string }
  | { op: 'prefix'; value: string }
  | { op: 'oneOf'; values: string[] };

export type Condition =
  | { field: 'all' }
  | { field: 'tag'; key: string; match: Matcher | { op: 'exists' }; ignoreCase?: boolean }
  | { field: 'account' | 'service' | 'region' | 'resourceId'; match: Matcher; ignoreCase?: boolean };

export type RuleAction = { kind: 'target'; target: Target } | { kind: 'pool'; poolId: string };

export interface CostRule {
  id: string;
  /** Unique integer; lower numbers are evaluated first. */
  precedence: number;
  /** All conditions must match. 1 to LIMITS.maxConditionsPerRule entries. */
  when: Condition[];
  action: RuleAction;
}

export interface CompiledRule {
  readonly id: string;
  readonly precedence: number;
  readonly action: { kind: 'target'; target: Target } | { kind: 'pool'; poolId: string };
  readonly test: (row: NormalizedRow) => boolean;
}

export interface CompiledRules {
  /** Sorted by ascending precedence. */
  readonly rules: readonly CompiledRule[];
}

const ID_RE = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,63}$/;
const RESERVED_IDS = new Set(['UNALLOCATED', 'UNMATCHED']);
const REGEX_WORDS = new Set(['regex', 'regexp', 'pattern', 'matches', 'like', 'glob', 'wildcard']);

/** Validates an id used for a rule or a pool. */
export function checkRuleId(raw: unknown, index?: number): string {
  const id = checkText(raw, 64, 'INVALID_RULE', {}, index);
  if (!ID_RE.test(id)) throw new AllocationError('INVALID_RULE', index);
  if (RESERVED_IDS.has(id.toUpperCase())) throw new AllocationError('RESERVED_ID', index);
  return id;
}

function assertKeys(obj: Record<string, unknown>, allowed: readonly string[], index: number): void {
  for (const key of Object.keys(obj)) {
    if (REGEX_WORDS.has(key.toLowerCase())) throw new AllocationError('REGEX_NOT_ALLOWED', index);
    if (!allowed.includes(key)) throw new AllocationError('INVALID_RULE', index);
  }
}

function matcherText(raw: unknown, index: number): string {
  if (raw instanceof RegExp) throw new AllocationError('REGEX_NOT_ALLOWED', index);
  return checkText(raw, LIMITS.maxMatcherValueLength, 'INVALID_RULE', { requireTrimmed: false }, index);
}

function compileMatcher(raw: unknown, ignoreCase: boolean, index: number): (s: string) => boolean {
  if (!isPlainObject(raw)) throw new AllocationError('INVALID_RULE', index);
  const op = own(raw, 'op');
  if (typeof op === 'string' && REGEX_WORDS.has(op.toLowerCase())) throw new AllocationError('REGEX_NOT_ALLOWED', index);
  const fold = (s: string): string => (ignoreCase ? s.toLowerCase() : s);
  if (op === 'equals' || op === 'prefix') {
    assertKeys(raw, ['op', 'value'], index);
    const v = fold(matcherText(own(raw, 'value'), index));
    return op === 'equals' ? (s) => fold(s) === v : (s) => fold(s).startsWith(v);
  }
  if (op === 'oneOf') {
    assertKeys(raw, ['op', 'values'], index);
    const values = own(raw, 'values');
    if (!Array.isArray(values) || values.length === 0) throw new AllocationError('INVALID_RULE', index);
    if (values.length > LIMITS.maxListValues) throw new AllocationError('TOO_MANY_VALUES', index);
    const set = new Set<string>();
    for (const v of values) set.add(fold(matcherText(v, index)));
    return (s) => set.has(fold(s));
  }
  throw new AllocationError('INVALID_RULE', index);
}

type FieldReader = (row: NormalizedRow) => string | null;
const FIELD_READERS: Readonly<Record<'account' | 'service' | 'region' | 'resourceId', FieldReader>> = {
  account: (r) => r.account,
  service: (r) => r.service,
  region: (r) => r.region,
  resourceId: (r) => r.resourceId,
};

function compileCondition(raw: unknown, index: number): (row: NormalizedRow) => boolean {
  if (!isPlainObject(raw)) throw new AllocationError('INVALID_RULE', index);
  const field = own(raw, 'field');
  if (typeof field === 'string' && REGEX_WORDS.has(field.toLowerCase())) throw new AllocationError('REGEX_NOT_ALLOWED', index);
  if (field === 'all') {
    assertKeys(raw, ['field'], index);
    return () => true;
  }
  const ignoreCaseRaw = own(raw, 'ignoreCase');
  if (ignoreCaseRaw !== undefined && typeof ignoreCaseRaw !== 'boolean') throw new AllocationError('INVALID_RULE', index);
  const ignoreCase = ignoreCaseRaw === true;
  if (field === 'tag') {
    assertKeys(raw, ['field', 'key', 'match', 'ignoreCase'], index);
    const key = checkText(own(raw, 'key'), LIMITS.maxTagKeyLength, 'INVALID_RULE', { requireTrimmed: false }, index);
    const match = own(raw, 'match');
    if (isPlainObject(match) && own(match, 'op') === 'exists') {
      assertKeys(match, ['op'], index);
      return (row) => Object.prototype.hasOwnProperty.call(row.tags, key);
    }
    const test = compileMatcher(match, ignoreCase, index);
    return (row) => (Object.prototype.hasOwnProperty.call(row.tags, key) ? test(row.tags[key]) : false);
  }
  if (field === 'account' || field === 'service' || field === 'region' || field === 'resourceId') {
    assertKeys(raw, ['field', 'match', 'ignoreCase'], index);
    const test = compileMatcher(own(raw, 'match'), ignoreCase, index);
    const read = FIELD_READERS[field];
    return (row) => {
      const v = read(row);
      return v === null ? false : test(v);
    };
  }
  throw new AllocationError('INVALID_RULE', index);
}

function compileAction(raw: unknown, poolIds: ReadonlySet<string>, index: number): CompiledRule['action'] {
  if (!isPlainObject(raw)) throw new AllocationError('INVALID_RULE', index);
  const kind = own(raw, 'kind');
  if (kind === 'target') {
    assertKeys(raw, ['kind', 'target'], index);
    return { kind: 'target', target: validateTarget(own(raw, 'target'), index) };
  }
  if (kind === 'pool') {
    assertKeys(raw, ['kind', 'poolId'], index);
    const poolId = checkRuleId(own(raw, 'poolId'), index);
    if (!poolIds.has(poolId)) throw new AllocationError('UNKNOWN_POOL', index);
    return { kind: 'pool', poolId };
  }
  throw new AllocationError('INVALID_RULE', index);
}

/**
 * Validates and compiles a rule set. `poolIds` are the ids of the pools the
 * caller defined; a rule may route only to one of them. Refuses the whole set
 * on the first problem.
 */
export function compileRules(raw: unknown, poolIds: ReadonlySet<string> = new Set()): CompiledRules {
  if (!Array.isArray(raw)) throw new AllocationError('INVALID_RULE');
  if (raw.length > LIMITS.maxRules) throw new AllocationError('TOO_MANY_RULES');
  const ids = new Set<string>();
  const precedences = new Set<number>();
  const compiled: CompiledRule[] = [];
  for (let i = 0; i < raw.length; i++) {
    const rule: unknown = raw[i];
    if (!isPlainObject(rule)) throw new AllocationError('INVALID_RULE', i);
    assertKeys(rule, ['id', 'precedence', 'when', 'action'], i);
    const id = checkRuleId(own(rule, 'id'), i);
    if (ids.has(id) || poolIds.has(id)) throw new AllocationError('DUPLICATE_RULE_ID', i);
    ids.add(id);
    const precedence = own(rule, 'precedence');
    if (typeof precedence !== 'number' || !Number.isSafeInteger(precedence)) throw new AllocationError('INVALID_RULE', i);
    if (precedences.has(precedence)) throw new AllocationError('DUPLICATE_PRECEDENCE', i);
    precedences.add(precedence);
    const when = own(rule, 'when');
    if (!Array.isArray(when) || when.length === 0) throw new AllocationError('INVALID_RULE', i);
    if (when.length > LIMITS.maxConditionsPerRule) throw new AllocationError('TOO_MANY_CONDITIONS', i);
    const tests = when.map((c: unknown) => compileCondition(c, i));
    const action = compileAction(own(rule, 'action'), poolIds, i);
    compiled.push({
      id,
      precedence,
      action,
      test: (row) => {
        for (const t of tests) if (!t(row)) return false;
        return true;
      },
    });
  }
  compiled.sort((a, b) => a.precedence - b.precedence);
  return Object.freeze({ rules: Object.freeze(compiled) });
}

/** The first rule (by ascending precedence) whose conditions all match, or null. */
export function firstMatch(rules: CompiledRules, row: NormalizedRow): CompiledRule | null {
  for (const rule of rules.rules) if (rule.test(row)) return rule;
  return null;
}
