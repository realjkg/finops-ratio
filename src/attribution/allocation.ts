// Pure shared-cost allocation and read-time economics derivations (D1, spec
// art_qllcIvXH). Zero I/O and zero DB knowledge: callers hand ledger facts in
// as decimal strings (the repo's money convention) and get allocations plus
// allocation coverage back. Every rule preserves the source control total
// exactly: sum(allocated) + unallocated == sum(sources), at the source's own
// decimal scale, with the remainder distributed deterministically.
//
// Honesty rules (locked): coverage always reports the unattributed share —
// absence of evidence is never imputed into a project; the two Nutanix views
// (incremental opex vs fully-allocated TCO) are separate labeled numbers that
// are never interchangeable; FX conversion happens at read time on the
// arguments given — stored measures are never converted in place.

/** An allocation rule the business has approved for a shared-cost slice. */
export type AllocationRule = 'even_split' | 'keyed_tag' | 'proportional_to_attributed';

/** One ledger cost row as allocation sees it. Money is a decimal string. */
export interface AllocationRow {
  /** Stable row identity (source + artifact + ordinal) carried onto allocations. */
  rowKey: string;
  currency: string;
  /** 'direct' rows are already attributed; 'shared' rows are allocation inputs; null is unattributed. */
  directOrShared: 'direct' | 'shared' | null;
  /** Project identity when evidenced by the export or a keyed tag; null = unattributed. */
  projectId: string | null;
  /** The cost being attributed. Effective-cost basis is the caller's choice. */
  amount: string;
  /** Even-split sharing targets (the projects sharing this cost), when known. */
  targets?: string[];
}

export interface AllocationEntry {
  rowKey: string;
  projectId: string;
  /** Allocated share, decimal string, same currency as the source row. */
  amount: string;
  rule: AllocationRule;
}

export interface AllocationCoverage {
  /** Total attributed after allocation (direct carried through + shared allocated). */
  attributedAmount: string;
  /** Total source cost of the slice (direct + shared + unattributed). */
  totalAmount: string;
  /** Attributed share as a percentage rounded DOWN to one decimal — coverage is never overstated. null when the slice has zero total. */
  attributedPct: number | null;
}

export interface AllocationResult {
  allocations: AllocationEntry[];
  /** Cost that no rule could attribute (no targets, no tag, no denominator). */
  unallocated: string;
  coverage: AllocationCoverage;
}

const scaling = (amount: string): number => {
  const dot = amount.indexOf('.');
  return dot === -1 ? 0 : amount.length - dot - 1;
};

/** Exact decimal-string sum at the union of the inputs' scales. */
function sumScaled(values: bigint[], scale: number): string {
  if (values.length === 0) return (0n).toFixed(scale);
  const total = values.reduce((acc, v) => acc + v, 0n);
  const s = total < 0n ? -total : total;
  const digits = s.toString();
  const whole = digits.slice(0, digits.length - scale) || '0';
  const frac = scale > 0 ? '.' + digits.slice(digits.length - scale).padStart(scale, '0') : '';
  return (total < 0n ? '-' : '') + whole + frac;
}

function toScaled(amount: string, scale: number): bigint {
  const neg = amount.startsWith('-');
  const body = neg ? amount.slice(1) : amount;
  const [whole, frac = ''] = body.split('.');
  const padded = frac.padEnd(scale, '0');
  const v = BigInt((whole || '0') + padded);
  return neg ? -v : v;
}

/**
 * Splits `total` (scaled integer) across `weights` with largest-remainder
 * distribution and a stable tie-break (input order). Zero total weight, or a
 * zero/empty weight list, yields no split — the caller decides what stays
 * unallocated. Sum of the parts equals `total` exactly (sign included).
 */
export function distributeByWeight(total: bigint, weights: bigint[]): bigint[] {
  const n = weights.length;
  if (n === 0) return [];
  const sign = total < 0n ? -1n : 1n;
  const magnitude = total < 0n ? -total : total;
  const weightSum = weights.reduce((a, w) => a + w, 0n);
  if (weightSum === 0n) return weights.map(() => 0n);
  const shares = weights.map((w) => (magnitude * w) / weightSum);
  let remainderUnits = magnitude - shares.reduce((a, s) => a + s, 0n);
  if (remainderUnits < 0n) remainderUnits = -remainderUnits;
  // Largest-remainder: order candidate indices by fractional remainder
  // (descending, stable by index) and hand them one unit each.
  const order = weights
    .map((w, i) => ({ i, rem: magnitude * w - shares[i] * weightSum }))
    .filter(({ rem }) => rem > 0n)
    .sort((a, b) => (a.rem > b.rem ? -1 : a.rem < b.rem ? 1 : a.i - b.i));
  for (let k = 0; k < Number(remainderUnits) && k < order.length; k++) shares[order[k].i] += 1n;
  return shares.map((s) => sign * s);
}

/** One period's cost rows in a single currency, as the allocation rules consume them. */
export interface AllocationSlice {
  currency: string;
  rows: AllocationRow[];
}

/** Rows must share one currency: allocation never mixes or converts (FX is a separate, explicit read-time step). */
function assertSingleCurrency(slice: AllocationSlice): void {
  for (const r of slice.rows) {
    if (r.currency !== slice.currency) throw new Error('allocation slice mixes currencies');
  }
}

function result(slice: AllocationSlice, allocations: AllocationEntry[], unallocatedScaled: bigint, scale: number): AllocationResult {
  const totalScaled = slice.rows.reduce((acc, r) => acc + toScaled(r.amount, scale), 0n);
  const allocatedScaled = allocations.reduce((acc, a) => acc + toScaled(a.amount, scale), 0n);
  const attributed = slice.rows
    .filter((r) => r.directOrShared === 'direct' && r.projectId !== null)
    .reduce((acc, r) => acc + toScaled(r.amount, scale), 0n) + allocatedScaled;
  const fmt = (v: bigint): string => sumScaled([v], scale);
  const totalAbs = totalScaled < 0n ? -totalScaled : totalScaled;
  const attributedAbs = attributed < 0n ? -attributed : attributed;
  const pct = totalAbs === 0n ? null : Math.floor(Number(attributedAbs * 1000n / totalAbs)) / 10;
  return {
    allocations,
    unallocated: fmt(unallocatedScaled),
    coverage: { attributedAmount: fmt(attributed), totalAmount: fmt(totalScaled), attributedPct: pct },
  };
}

/**
 * Allocates one homogeneous slice: direct rows carry through with their
 * evidenced project; shared rows allocate by the approved rule; rows with no
 * project identity (direct_or_shared null) stay unallocated — they are
 * reported in coverage, never imputed.
 */
export function allocateSharedCost(slice: AllocationSlice, rule: AllocationRule): AllocationResult {
  assertSingleCurrency(slice);
  const scale = slice.rows.reduce((m, r) => Math.max(m, scaling(r.amount)), 0);
  const allocations: AllocationEntry[] = [];
  let unallocated = 0n;

  for (const row of slice.rows) {
    const amount = toScaled(row.amount, scale);
    if (row.directOrShared === 'direct') {
      if (row.projectId === null) unallocated += amount;
      // Direct rows need no allocation; their attribution is evidenced.
      continue;
    }
    if (row.directOrShared === null) {
      // No rule can invent identity: unattributed stays unattributed.
      unallocated += amount;
      continue;
    }
    // direct_or_shared === 'shared' below.
    if (rule === 'keyed_tag') {
      // The shared row's own project tag names the consuming project; no tag,
      // no allocation (the rule never guesses).
      if (row.projectId === null) {
        unallocated += amount;
        continue;
      }
      allocations.push({ rowKey: row.rowKey, projectId: row.projectId, amount: sumScaled([amount], scale), rule });
      continue;
    }
    if (rule === 'even_split') {
      const targets = [...new Set(row.targets ?? [])].sort();
      if (targets.length === 0) {
        unallocated += amount;
        continue;
      }
      const shares = distributeByWeight(amount, targets.map(() => 1n));
      targets.forEach((projectId, i) => {
        if (shares[i] !== 0n) allocations.push({ rowKey: row.rowKey, projectId, amount: sumScaled([shares[i]], scale), rule });
      });
      continue;
    }
    // proportional_to_attributed: staged after the loop (needs the slice's
    // full direct base as the denominator).
    unallocated += amount;
  }

  if (rule === 'proportional_to_attributed') {
    const shared = slice.rows.filter((r) => r.directOrShared === 'shared');
    const directByProject = new Map<string, bigint>();
    for (const r of slice.rows) {
      if (r.directOrShared === 'direct' && r.projectId !== null) {
        directByProject.set(r.projectId, (directByProject.get(r.projectId) ?? 0n) + toScaled(r.amount, scale));
      }
    }
    const projects = [...directByProject.keys()].sort();
    const totalWeight = projects.reduce((a, p) => a + (directByProject.get(p) ?? 0n), 0n);
    if (shared.length > 0 && totalWeight !== 0n) {
      for (const row of shared) {
        const amount = toScaled(row.amount, scale);
        const shares = distributeByWeight(amount, projects.map((p) => directByProject.get(p) ?? 0n));
        projects.forEach((projectId, i) => {
          if (shares[i] !== 0n) allocations.push({ rowKey: row.rowKey, projectId, amount: sumScaled([shares[i]], scale), rule });
        });
      }
      // The staged shared weight was fully allocated; remove it from unallocated.
      unallocated -= shared.reduce((a, r) => a + toScaled(r.amount, scale), 0n);
    }
    // totalWeight === 0n: the zero-denominator guard — shared cost has no
    // attributed base to allocate against and stays unallocated (reported).
  }

  return result({ currency: slice.currency, rows: slice.rows }, allocations, unallocated, scale);
}

// --- Read-time derivations ---

/** Exact decimal product (amount x rate). Read-time only: never written back over a stored measure. */
export function convertWithRate(amount: string, rate: string): string {
  const scale = scaling(amount) + scaling(rate);
  const product = toScaled(amount, scaling(amount)) * toScaled(rate, scaling(rate));
  return sumScaled([product], scale);
}

export interface NutanixPeriodFacts {
  /** Billed (incremental opex) cost of the Nutanix rows for the period. */
  billedOpex: string;
  /** Effective cost of the Nutanix rows for the period. */
  effectiveCost: string;
  /** Shared cost allocated to the project by an approved rule (allocation result). */
  allocatedShared: string;
}

export interface NutanixDualView {
  /** View 1 — what the platform incrementally costs to operate this period (billed). */
  incrementalOpex: string;
  /** View 2 — effective cost plus allocated shared cost: the fully-allocated TCO view. */
  fullyAllocatedTco: string;
}

/**
 * The Nutanix dual view: two labeled read-time derivations over the same
 * facts. Incremental opex answers "what does running this cost this period";
 * fully-allocated TCO answers "what does this cost including its share of the
 * shared estate". They are different questions — never summed, averaged or
 * substituted for each other.
 */
export function nutanixDualView(facts: NutanixPeriodFacts): NutanixDualView {
  const scale = Math.max(scaling(facts.billedOpex), scaling(facts.effectiveCost), scaling(facts.allocatedShared));
  const tco = toScaled(facts.effectiveCost, scale) + toScaled(facts.allocatedShared, scale);
  return {
    incrementalOpex: sumScaled([toScaled(facts.billedOpex, scale)], scale),
    fullyAllocatedTco: sumScaled([tco], scale),
  };
}
