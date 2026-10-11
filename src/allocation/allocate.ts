// Allocation engine: rows + rules + shared pools -> allocation lines that
// reconcile to the ledger to the minor unit, per currency.
//
// Precision: amounts are carried at the "exact scale" (minor unit plus 12
// fractional digits) through routing and pool splitting, so sub-minor-unit rows
// (for example 1000 rows of 0.004 USD) are never rounded away one by one. Each
// (currency, month) group is rounded ONCE at output: the lines' exact amounts
// are floored to minor units and the leftover units, which make the rounded
// lines sum to the half-even rounding of the exact group total, go to the
// largest fractional remainders (ties by line key, so row order never matters).
// Totals report the exact ledger, the rounded ledger, their difference and
// `roundingResidualMinor`.
//
// Trust boundary: rows, rules and pools are untrusted. The call is tenant
// scoped: every row must carry the caller's tenant or the whole batch is refused
// (TENANT_MISMATCH). Row count is checked before any per-row work. The function
// is pure: no clock, no randomness, no I/O, no mutation of its inputs.
//
// What it does:
//   1. Validates the batch (caps, tenant, unique ids, strict money).
//   2. Routes each row by the first matching rule (see rules.ts). A row either
//      lands on a target (a DIRECT line), joins a shared pool, or matches
//      nothing and becomes an UNALLOCATED line. Nothing is dropped.
//   3. Splits each pool, per currency and month, by its policy (see pools.ts)
//      with the largest-remainder method (SHARED lines).
//   4. Proves the invariant, per currency:
//        ledger total == allocated (direct + shared) + unallocated
//      in integer minor units, and throws RECONCILIATION_FAILED if it ever
//      fails (it cannot, by construction; the check is defense in depth).
//
// Every line records a `ruleId`: the matching rule for a direct line, the pool
// id for a shared line (its feeding rules are in `viaRuleIds`), and the
// reserved `$unmatched` for a row no rule claimed. Money is never summed across
// currencies: pools split per currency and totals are reported per currency.

import { AllocationError } from './errors';
import { LIMITS, compareKeys, isPlainObject, own } from './limits';
import { EXACT_UNIT, EXACT_EXTRA, ONE, ZERO, currencyExponent, divRoundHalfEven, floorDiv, formatMinor, formatScaled, splitByKeys, type KeyedWeight } from './money';
import { compilePools, type CompiledPool } from './pools';
import { checkTenant, normalizeRows, type AllocatableRow, type NormalizedRow } from './rows';
import { compileRules, firstMatch } from './rules';
import type { CostRule } from './rules';
import type { SharedPool } from './pools';
import { UNMATCHED_RULE_ID, type Dimension, type Target } from './targets';

export interface AllocationConfig {
  rules: CostRule[];
  pools?: SharedPool[];
  /**
   * 'exact' (default): sub-minor-unit amounts are carried exactly and rounded once per output group.
   * 'refuse': a row with more fractional digits than the currency allows aborts the batch.
   * 'half-even': accepted as an alias of 'exact' (per-row rounding was lossy and has been removed).
   */
  rounding?: 'exact' | 'refuse' | 'half-even';
}

export type LineKind = 'direct' | 'shared' | 'unallocated';
export type UnallocatedReason = 'NO_RULE_MATCHED' | 'POOL_NO_WEIGHT';

export interface AllocationLine {
  readonly kind: LineKind;
  readonly currency: string;
  /** `YYYY-MM`, UTC. */
  readonly month: string;
  /** Signed integer minor units of `currency`, after the group rounding described above. */
  readonly minor: bigint;
  /** The same amount as plain decimal text (bigint does not serialize to JSON). */
  readonly amount: string;
  /** The line's exact amount before rounding, at the exact scale. */
  readonly exactAmount: string;
  /** Null for an unallocated line. */
  readonly target: Target | null;
  /** Direct: the matching rule. Shared: the pool id. Unallocated: `$unmatched`, or the pool id for POOL_NO_WEIGHT. */
  readonly ruleId: string;
  /** The source row for a direct line or a no-rule unallocated line; null for pool lines. */
  readonly rowId: string | null;
  readonly poolId: string | null;
  /** For pool lines: the rules that routed rows into the pool, sorted. Empty otherwise. */
  readonly viaRuleIds: readonly string[];
  readonly reason: UnallocatedReason | null;
}

export interface CurrencyTotals {
  readonly currency: string;
  readonly rowCount: number;
  /** Rows whose amount has digits beyond the minor unit (they are carried exactly, then rounded once at output). */
  readonly roundedRows: number;
  /** Rows with more digits than even the exact scale holds; those digits were rounded half-even. */
  readonly beyondExactScaleRows: number;
  /** Sum of the per-month rounded exact totals. Direct + shared + unallocated lines sum to exactly this. */
  readonly ledgerMinor: bigint;
  /** Direct + shared lines. */
  readonly allocatedMinor: bigint;
  /** Unallocated lines (no rule matched, or a pool had no positive weight). */
  readonly unallocatedMinor: bigint;
  /** ledgerMinor minus the half-even rounding of the whole-currency exact total. 0 unless months round differently. */
  readonly roundingResidualMinor: bigint;
  readonly ledger: string;
  readonly allocated: string;
  readonly unallocated: string;
  /** The exact ledger total at the exact scale, and exact minus rounded (also at the exact scale). */
  readonly ledgerExact: string;
  readonly roundingDifference: string;
}

export interface AllocationLedger {
  readonly tenant: string;
  readonly lines: readonly AllocationLine[];
  /** One entry per currency present, sorted by currency code. */
  readonly totals: readonly CurrencyTotals[];
}

interface PoolIntake {
  poolId: string;
  currency: string;
  month: string;
  total: bigint;
  via: Set<string>;
}

/** A line before output rounding: its amount is exact. */
interface RawLine {
  kind: LineKind;
  currency: string;
  month: string;
  exact: bigint;
  target: Target | null;
  ruleId: string;
  rowId: string | null;
  poolId: string | null;
  viaRuleIds: readonly string[];
  reason: UnallocatedReason | null;
  /** Deterministic ordering key for rounding ties. */
  sortKey: string;
}

function parseConfig(config: unknown): { rules: unknown; pools: unknown; precision: 'exact' | 'refuse' } {
  if (!isPlainObject(config)) throw new AllocationError('INVALID_CONFIG');
  for (const key of Object.keys(config)) {
    if (key !== 'rules' && key !== 'pools' && key !== 'rounding') throw new AllocationError('INVALID_CONFIG');
  }
  const rounding = own(config, 'rounding') ?? 'exact';
  if (rounding !== 'exact' && rounding !== 'refuse' && rounding !== 'half-even') throw new AllocationError('INVALID_CONFIG');
  return { rules: own(config, 'rules'), pools: own(config, 'pools'), precision: rounding === 'refuse' ? 'refuse' : 'exact' };
}

/** Direct exact spend per (currency|month) per value of `dimension`, from direct raw lines only. */
function directSpendByGroup(lines: readonly RawLine[], dimension: Dimension): Map<string, Map<string, bigint>> {
  const out = new Map<string, Map<string, bigint>>();
  for (const line of lines) {
    if (line.kind !== 'direct' || line.target === null) continue;
    const value = line.target[dimension];
    if (value === undefined) continue;
    const bucket = `${line.currency}|${line.month}`;
    let m = out.get(bucket);
    if (!m) {
      m = new Map();
      out.set(bucket, m);
    }
    m.set(value, (m.get(value) ?? ZERO) + line.exact);
  }
  return out;
}

function splitIntake(
  intake: PoolIntake,
  pool: CompiledPool,
  directLines: readonly RawLine[],
  directCache: Map<Dimension, Map<string, Map<string, bigint>>>,
): RawLine[] {
  const via = [...intake.via].sort(compareKeys);
  const base = { currency: intake.currency, month: intake.month, poolId: pool.id, viaRuleIds: via, rowId: null };
  const keyBase = `~${pool.id}\u0000${intake.currency}\u0000${intake.month}`;

  let weights: KeyedWeight[];
  let targets: Map<string, Target>;
  if (pool.policy.kind === 'proportional') {
    const dim = pool.policy.among;
    let all = directCache.get(dim);
    if (!all) {
      all = directSpendByGroup(directLines, dim);
      directCache.set(dim, all);
    }
    const groups = all.get(`${intake.currency}|${intake.month}`) ?? new Map<string, bigint>();
    weights = [];
    targets = new Map();
    for (const [value, spend] of groups) {
      if (spend <= ZERO) continue; // net-negative or zero direct spend earns no share
      weights.push({ key: value, weight: spend });
      targets.set(value, Object.freeze({ [dim]: value }) as Target);
    }
  } else {
    weights = pool.policy.shares.map((s) => ({ key: s.key, weight: s.weight }));
    targets = new Map(pool.policy.shares.map((s) => [s.key, s.target]));
  }

  const positive = weights.filter((w) => w.weight > ZERO);
  if (positive.length === 0) {
    return [{ ...base, kind: 'unallocated', exact: intake.total, target: null, ruleId: pool.id, reason: 'POOL_NO_WEIGHT', sortKey: `${keyBase}\u0000` }];
  }
  const lines: RawLine[] = [];
  for (const s of splitByKeys(intake.total, positive)) {
    if (s.minor === ZERO) continue;
    lines.push({ ...base, kind: 'shared', exact: s.minor, target: targets.get(s.key) ?? null, ruleId: pool.id, reason: null, sortKey: `${keyBase}\u0000${s.key}` });
  }
  return lines;
}

/**
 * Rounds one (currency, month) group once: floors every line to minor units,
 * then hands leftover units to the largest fractional remainders (ties by
 * sortKey) so the rounded lines sum to the half-even rounding of the exact total.
 */
function roundGroup(group: RawLine[], unit: bigint): { minors: bigint[]; exactTotal: bigint; roundedTotal: bigint } {
  const order = group.map((_, i) => i).sort((a, b) => compareKeys(group[a].sortKey, group[b].sortKey));
  const minors: bigint[] = new Array<bigint>(group.length);
  const rems: bigint[] = new Array<bigint>(group.length);
  let exactTotal = ZERO;
  let floorSum = ZERO;
  for (let i = 0; i < group.length; i++) {
    const f = floorDiv(group[i].exact, unit);
    minors[i] = f;
    rems[i] = group[i].exact - f * unit;
    exactTotal += group[i].exact;
    floorSum += f;
  }
  const roundedTotal = divRoundHalfEven(exactTotal, unit);
  const leftover = roundedTotal - floorSum;
  if (leftover < ZERO) throw new AllocationError('RECONCILIATION_FAILED');
  const candidates = order.filter((i) => rems[i] > ZERO).sort((a, b) => (rems[a] > rems[b] ? -1 : rems[a] < rems[b] ? 1 : 0));
  // Array.prototype.sort is stable, so equal remainders keep the sortKey order from `order`.
  if (leftover > BigInt(candidates.length)) throw new AllocationError('RECONCILIATION_FAILED');
  for (let k = 0; k < Number(leftover); k++) minors[candidates[k]] += ONE;
  return { minors, exactTotal, roundedTotal };
}

/**
 * Allocates a tenant's rows. Throws a fixed-text AllocationError for any
 * malformed, oversized or cross-tenant input; returns lines and per-currency
 * totals that reconcile exactly.
 */
export function allocateCosts(tenantArg: string, rowsArg: readonly AllocatableRow[], configArg: AllocationConfig): AllocationLedger {
  const tenant = checkTenant(tenantArg);
  const config = parseConfig(configArg);
  const pools = compilePools(config.pools);
  const poolIds = new Set(pools.map((p) => p.id));
  const rules = compileRules(config.rules, poolIds);
  const poolById = new Map(pools.map((p) => [p.id, p]));
  const rows: NormalizedRow[] = normalizeRows(tenant, rowsArg, config.precision);
  if (rows.length > LIMITS.maxRows) throw new AllocationError('TOO_MANY_ROWS');

  const raw: RawLine[] = [];
  const intakes = new Map<string, PoolIntake>();
  const ledger = new Map<string, { rows: number; rounded: number; beyond: number; exact: bigint }>();

  for (const row of rows) {
    const t = ledger.get(row.currency) ?? { rows: 0, rounded: 0, beyond: 0, exact: ZERO };
    t.rows += 1;
    if (row.rounded) t.rounded += 1;
    if (row.beyondExactScale) t.beyond += 1;
    t.exact += row.exact;
    ledger.set(row.currency, t);

    const rule = firstMatch(rules, row);
    const common = { currency: row.currency, month: row.month, exact: row.exact, rowId: row.id, poolId: null, viaRuleIds: [] as string[], reason: null, sortKey: `${row.id}` };
    if (rule === null) {
      raw.push({ ...common, kind: 'unallocated', target: null, ruleId: UNMATCHED_RULE_ID, reason: 'NO_RULE_MATCHED' });
    } else if (rule.action.kind === 'target') {
      raw.push({ ...common, kind: 'direct', target: rule.action.target, ruleId: rule.id });
    } else {
      const key = `${rule.action.poolId}\u0000${row.currency}\u0000${row.month}`;
      let intake = intakes.get(key);
      if (!intake) {
        intake = { poolId: rule.action.poolId, currency: row.currency, month: row.month, total: ZERO, via: new Set() };
        intakes.set(key, intake);
      }
      intake.total += row.exact;
      intake.via.add(rule.id);
    }
  }

  const directLines = raw.filter((l) => l.kind === 'direct');
  const directCache = new Map<Dimension, Map<string, Map<string, bigint>>>();
  const ordered = [...intakes.values()].sort(
    (a, b) => compareKeys(a.poolId, b.poolId) || compareKeys(a.currency, b.currency) || compareKeys(a.month, b.month),
  );
  for (const intake of ordered) {
    if (intake.total === ZERO) continue;
    const pool = poolById.get(intake.poolId);
    if (!pool) throw new AllocationError('UNKNOWN_POOL'); // unreachable: rules were compiled against these pools
    for (const l of splitIntake(intake, pool, directLines, directCache)) raw.push(l);
  }

  // Round once per (currency, month) group.
  const groups = new Map<string, RawLine[]>();
  for (const l of raw) {
    const k = `${l.currency}\u0000${l.month}`;
    const g = groups.get(k);
    if (g) g.push(l);
    else groups.set(k, [l]);
  }
  const unit = EXACT_UNIT;
  const lines: AllocationLine[] = [];
  const roundedByCurrency = new Map<string, bigint>();
  for (const k of [...groups.keys()].sort(compareKeys)) {
    const g = groups.get(k)!;
    const { minors, roundedTotal } = roundGroup(g, unit);
    const currency = g[0].currency;
    roundedByCurrency.set(currency, (roundedByCurrency.get(currency) ?? ZERO) + roundedTotal);
    const scale = currencyExponent(currency) + EXACT_EXTRA;
    g.forEach((l, i) => {
      lines.push(
        Object.freeze({
          kind: l.kind,
          currency,
          month: l.month,
          minor: minors[i],
          amount: formatMinor(minors[i], currency),
          exactAmount: formatScaled(l.exact, scale),
          target: l.target,
          ruleId: l.ruleId,
          rowId: l.rowId,
          poolId: l.poolId,
          viaRuleIds: Object.freeze([...l.viaRuleIds]),
          reason: l.reason,
        }),
      );
    });
  }

  const totals: CurrencyTotals[] = [];
  for (const currency of [...ledger.keys()].sort(compareKeys)) {
    const t = ledger.get(currency)!;
    const ledgerMinor = roundedByCurrency.get(currency) ?? ZERO;
    let allocated = ZERO;
    let unallocated = ZERO;
    for (const line of lines) {
      if (line.currency !== currency) continue;
      if (line.kind === 'unallocated') unallocated += line.minor;
      else allocated += line.minor;
    }
    if (allocated + unallocated !== ledgerMinor) throw new AllocationError('RECONCILIATION_FAILED');
    const scale = currencyExponent(currency) + EXACT_EXTRA;
    totals.push(
      Object.freeze({
        currency,
        rowCount: t.rows,
        roundedRows: t.rounded,
        beyondExactScaleRows: t.beyond,
        ledgerMinor,
        allocatedMinor: allocated,
        unallocatedMinor: unallocated,
        roundingResidualMinor: ledgerMinor - divRoundHalfEven(t.exact, unit),
        ledger: formatMinor(ledgerMinor, currency),
        allocated: formatMinor(allocated, currency),
        unallocated: formatMinor(unallocated, currency),
        ledgerExact: formatScaled(t.exact, scale),
        roundingDifference: formatScaled(t.exact - ledgerMinor * unit, scale),
      }),
    );
  }
  return Object.freeze({ tenant, lines: Object.freeze(lines), totals: Object.freeze(totals) });
}
