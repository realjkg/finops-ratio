// Shared-cost pools: definitions and the split policies that spread a pool over targets.
//
// Trust boundary: pool definitions are untrusted configuration and are
// validated whole before use. All arithmetic is integer (BigInt); percents and
// usage weights are strict decimals scaled to integers.
//
// Policies:
//   proportional  Split in proportion to each target's DIRECT spend in the same
//                 currency and month, grouped by one dimension (`among`). A
//                 target with net-negative direct spend (credits exceed charges)
//                 gets weight zero; it is never given a negative weight. If no
//                 target has positive direct spend the pool cannot be split.
//   even          Equal weights over a fixed target list.
//   fixedPercent  Explicit percents (up to four fractional digits). They must
//                 sum to EXACTLY 100, or the whole configuration is refused.
//   usageWeight   Explicit non-negative weights (up to six fractional digits),
//                 for example measured usage. Static per policy: supply a new
//                 policy for a period whose usage differs.
//
// Pool cost that has no positive weight to follow is NOT dropped and NOT
// pushed onto a guessed target: it becomes an explicit UNALLOCATED line with
// reason POOL_NO_WEIGHT.

import { AllocationError } from './errors';
import { LIMITS, isPlainObject, own } from './limits';
import { ONE, PERCENT_TOTAL, parsePercent, parseUsageWeight, sumBigInt } from './money';
import { checkRuleId } from './rules';
import { isDimension, targetKey, validateTarget, type Dimension, type Target } from './targets';

export type PoolPolicy =
  | { kind: 'proportional'; among: Dimension }
  | { kind: 'even'; targets: Target[] }
  | { kind: 'fixedPercent'; shares: Array<{ target: Target; percent: string }> }
  | { kind: 'usageWeight'; weights: Array<{ target: Target; weight: string }> };

export interface SharedPool {
  /** Shares the rule id namespace. */
  id: string;
  policy: PoolPolicy;
}

export interface StaticShare {
  readonly key: string;
  readonly target: Target;
  readonly weight: bigint;
}

export type CompiledPolicy =
  | { readonly kind: 'proportional'; readonly among: Dimension }
  | { readonly kind: 'static'; readonly policy: 'even' | 'fixedPercent' | 'usageWeight'; readonly shares: readonly StaticShare[] };

export interface CompiledPool {
  readonly id: string;
  readonly policy: CompiledPolicy;
}

function assertOnly(obj: Record<string, unknown>, allowed: readonly string[]): void {
  for (const key of Object.keys(obj)) if (!allowed.includes(key)) throw new AllocationError('INVALID_POOL');
}

function listOf(raw: unknown): unknown[] {
  if (!Array.isArray(raw) || raw.length === 0) throw new AllocationError('INVALID_POOL');
  if (raw.length > LIMITS.maxPoolTargets) throw new AllocationError('TOO_MANY_VALUES');
  return raw as unknown[];
}

function buildShares(items: Array<{ target: Target; weight: bigint }>): StaticShare[] {
  const seen = new Set<string>();
  const shares: StaticShare[] = [];
  for (const it of items) {
    const key = targetKey(it.target);
    if (seen.has(key)) throw new AllocationError('DUPLICATE_KEY');
    seen.add(key);
    shares.push(Object.freeze({ key, target: it.target, weight: it.weight }));
  }
  return shares;
}

function compilePolicy(raw: unknown): CompiledPolicy {
  if (!isPlainObject(raw)) throw new AllocationError('INVALID_POOL');
  const kind = own(raw, 'kind');
  if (kind === 'proportional') {
    assertOnly(raw, ['kind', 'among']);
    const among = own(raw, 'among');
    if (!isDimension(among)) throw new AllocationError('INVALID_POOL');
    return { kind: 'proportional', among };
  }
  if (kind === 'even') {
    assertOnly(raw, ['kind', 'targets']);
    const items = listOf(own(raw, 'targets')).map((t) => ({ target: validateTarget(t), weight: ONE }));
    return { kind: 'static', policy: 'even', shares: buildShares(items) };
  }
  if (kind === 'fixedPercent') {
    assertOnly(raw, ['kind', 'shares']);
    const items = listOf(own(raw, 'shares')).map((s) => {
      if (!isPlainObject(s)) throw new AllocationError('INVALID_POOL');
      assertOnly(s, ['target', 'percent']);
      return { target: validateTarget(own(s, 'target')), weight: parsePercent(own(s, 'percent')) };
    });
    if (sumBigInt(items.map((i) => i.weight)) !== PERCENT_TOTAL) throw new AllocationError('PERCENT_SUM_INVALID');
    return { kind: 'static', policy: 'fixedPercent', shares: buildShares(items) };
  }
  if (kind === 'usageWeight') {
    assertOnly(raw, ['kind', 'weights']);
    const items = listOf(own(raw, 'weights')).map((s) => {
      if (!isPlainObject(s)) throw new AllocationError('INVALID_POOL');
      assertOnly(s, ['target', 'weight']);
      return { target: validateTarget(own(s, 'target')), weight: parseUsageWeight(own(s, 'weight')) };
    });
    if (sumBigInt(items.map((i) => i.weight)) === BigInt(0)) throw new AllocationError('ZERO_WEIGHT');
    return { kind: 'static', policy: 'usageWeight', shares: buildShares(items) };
  }
  throw new AllocationError('INVALID_POOL');
}

/** Validates and compiles pool definitions. Returns pools sorted by id. Refuses the whole set on any problem. */
export function compilePools(raw: unknown): CompiledPool[] {
  if (raw === undefined) return [];
  if (!Array.isArray(raw)) throw new AllocationError('INVALID_POOL');
  if (raw.length > LIMITS.maxPools) throw new AllocationError('TOO_MANY_POOLS');
  const seen = new Set<string>();
  const out: CompiledPool[] = [];
  raw.forEach((p: unknown, i) => {
    if (!isPlainObject(p)) throw new AllocationError('INVALID_POOL', i);
    assertOnly(p, ['id', 'policy']);
    const id = checkRuleId(own(p, 'id'), i);
    if (seen.has(id)) throw new AllocationError('DUPLICATE_POOL_ID', i);
    seen.add(id);
    out.push(Object.freeze({ id, policy: Object.freeze(compilePolicy(own(p, 'policy'))) }));
  });
  return out.sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
}
