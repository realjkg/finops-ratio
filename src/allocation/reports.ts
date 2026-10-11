// Showback: spend by cost center, team or application, by month, with
// line-level drill-down to the rules (and rows) that produced each amount.
//
// Trust boundary: the report request is validated (dimension must be one of the
// three known values). The input ledger is the output of `allocateCosts`; this
// module only groups and sums it. It is pure and tenant-agnostic (the ledger
// carries its tenant, and callers fetch ledgers tenant-scoped).
//
// Grouping: a line falls into the group named by its target's value for the
// chosen dimension, or into the explicit UNALLOCATED group when it has none
// (no rule matched, a pool had no weight, or the rule's target simply does not
// set that dimension). Groups, months and currencies are kept apart: nothing is
// summed across currencies. Every report is checked against the ledger totals
// before it is returned.

import type { AllocationLedger, AllocationLine } from './allocate';
import { AllocationError } from './errors';
import { compareKeys } from './limits';
import { ZERO, formatMinor } from './money';
import { UNALLOCATED, compareGroups, groupOf, isDimension, type Dimension } from './targets';

export interface ReportRow {
  readonly month: string;
  readonly currency: string;
  readonly group: string;
  readonly isUnallocated: boolean;
  readonly minor: bigint;
  readonly amount: string;
  readonly lineCount: number;
  /** Rule and pool ids behind this amount (direct rule ids, pool ids and feeding rule ids, `$unmatched`), sorted. */
  readonly ruleIds: readonly string[];
}

export interface ReportTotal {
  readonly currency: string;
  /** Null for the all-months total of the currency. */
  readonly month: string | null;
  readonly minor: bigint;
  readonly amount: string;
}

export interface Showback {
  readonly tenant: string;
  readonly dimension: Dimension;
  /** Sorted by month, currency, then group (UNALLOCATED last). */
  readonly rows: readonly ReportRow[];
  readonly totals: readonly ReportTotal[];
}

export interface GroupAggregate {
  month: string;
  currency: string;
  group: string;
  minor: bigint;
  lineCount: number;
  ruleIds: Set<string>;
}

export function checkDimension(d: unknown): Dimension {
  if (!isDimension(d)) throw new AllocationError('INVALID_REPORT_REQUEST');
  return d;
}

export function checkLedger(ledger: unknown): AllocationLedger {
  if (
    typeof ledger !== 'object' ||
    ledger === null ||
    !Array.isArray((ledger as AllocationLedger).lines) ||
    !Array.isArray((ledger as AllocationLedger).totals) ||
    typeof (ledger as AllocationLedger).tenant !== 'string'
  ) {
    throw new AllocationError('INVALID_REPORT_REQUEST');
  }
  return ledger as AllocationLedger;
}

/** Groups lines by (month, currency, group of `dimension`). Insertion-ordered; callers sort. */
export function aggregateLines(lines: readonly AllocationLine[], dimension: Dimension): Map<string, GroupAggregate> {
  const out = new Map<string, GroupAggregate>();
  for (const line of lines) {
    const group = groupOf(line.target, dimension);
    const key = `${line.month}\u0000${line.currency}\u0000${group}`;
    let agg = out.get(key);
    if (!agg) {
      agg = { month: line.month, currency: line.currency, group, minor: ZERO, lineCount: 0, ruleIds: new Set() };
      out.set(key, agg);
    }
    agg.minor += line.minor;
    agg.lineCount += 1;
    agg.ruleIds.add(line.ruleId);
    for (const via of line.viaRuleIds) agg.ruleIds.add(via);
  }
  return out;
}

export function compareAggregates(a: { month: string; currency: string; group: string }, b: { month: string; currency: string; group: string }): number {
  return compareKeys(a.month, b.month) || compareKeys(a.currency, b.currency) || compareGroups(a.group, b.group);
}

/** Showback by `dimension` and month, from an allocation ledger. */
export function buildShowback(ledgerArg: AllocationLedger, request: { dimension: Dimension }): Showback {
  const ledger = checkLedger(ledgerArg);
  const dimension = checkDimension(request?.dimension);
  const aggs = [...aggregateLines(ledger.lines, dimension).values()].sort(compareAggregates);
  const rows: ReportRow[] = aggs.map((a) =>
    Object.freeze({
      month: a.month,
      currency: a.currency,
      group: a.group,
      isUnallocated: a.group === UNALLOCATED,
      minor: a.minor,
      amount: formatMinor(a.minor, a.currency),
      lineCount: a.lineCount,
      ruleIds: Object.freeze([...a.ruleIds].sort(compareKeys)),
    }),
  );

  const byCurrency = new Map<string, bigint>();
  const byMonthCurrency = new Map<string, { month: string; currency: string; minor: bigint }>();
  for (const r of rows) {
    byCurrency.set(r.currency, (byCurrency.get(r.currency) ?? ZERO) + r.minor);
    const key = `${r.month}\u0000${r.currency}`;
    const m = byMonthCurrency.get(key) ?? { month: r.month, currency: r.currency, minor: ZERO };
    m.minor += r.minor;
    byMonthCurrency.set(key, m);
  }
  // Every report must reconcile to the ledger, per currency, before it leaves the module.
  for (const t of ledger.totals) {
    if ((byCurrency.get(t.currency) ?? ZERO) !== t.ledgerMinor) throw new AllocationError('RECONCILIATION_FAILED');
  }
  for (const c of byCurrency.keys()) {
    if (!ledger.totals.some((t) => t.currency === c)) throw new AllocationError('RECONCILIATION_FAILED');
  }

  const totals: ReportTotal[] = [];
  for (const currency of [...byCurrency.keys()].sort(compareKeys)) {
    const minor = byCurrency.get(currency)!;
    totals.push(Object.freeze({ currency, month: null, minor, amount: formatMinor(minor, currency) }));
  }
  for (const m of [...byMonthCurrency.values()].sort((a, b) => compareKeys(a.currency, b.currency) || compareKeys(a.month, b.month))) {
    totals.push(Object.freeze({ currency: m.currency, month: m.month, minor: m.minor, amount: formatMinor(m.minor, m.currency) }));
  }
  return Object.freeze({ tenant: ledger.tenant, dimension, rows: Object.freeze(rows), totals: Object.freeze(totals) });
}

export interface DrillDownQuery {
  dimension: Dimension;
  month: string;
  currency: string;
  /** A group name, or UNALLOCATED. */
  group: string;
}

/** The ledger lines behind one report row, each carrying its `ruleId`, `rowId` or `poolId`. */
export function drillDown(ledgerArg: AllocationLedger, query: DrillDownQuery): AllocationLine[] {
  const ledger = checkLedger(ledgerArg);
  const dimension = checkDimension(query?.dimension);
  return ledger.lines.filter(
    (l) => l.month === query.month && l.currency === query.currency && groupOf(l.target, dimension) === query.group,
  );
}
