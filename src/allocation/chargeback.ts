// Chargeback with a period lock: closed periods are immutable, and later
// restatements are booked as adjustment lines in the next open period.
//
// Trust boundary: the book is state the caller keeps; every function here is
// PURE and returns a NEW book, never mutating its input. Closed periods are
// carried over by reference (the very same frozen object), so a closed period
// cannot change by construction. Time and the acting subject are injected
// (`ctx.at`, `ctx.actor`), never read from the system, and every state change
// appends an audit record naming the actor, the injected time and the counts.
// The book is tenant-bound: a ledger from another tenant is refused.
//
// Lock-and-adjust rules:
//   * `recordAllocation` takes a fresh ledger (typically recomputed with
//     late-arriving rows). For each month in it:
//       - month absent or OPEN: the month's allocation entries are replaced by
//         the new ones (adjustments already booked in that month are kept);
//       - month CLOSED: nothing in it changes. The new allocation is compared
//         with what the closed month stands at (its entries plus every
//         adjustment that restates it), and any difference per currency and
//         group becomes an adjustment entry in the first open period after it.
//         Re-applying the same ledger produces no further adjustments.
//   * `closePeriod` locks an open period. It cannot be reopened.
//   * An adjustment entry names the period it restates (`adjustsMonth`) and is
//     signed; per currency, closed allocation plus its adjustments always sums
//     to the latest recorded allocation for that month.
//   * Months not present in a ledger are untouched.
// Caps: LIMITS.maxPeriods periods, LIMITS.maxAuditRecords audit records,
// LIMITS.maxPeriodLookahead months searched for an open period.

import type { AllocationLedger, AllocationLine } from './allocate';
import { AllocationError } from './errors';
import { LIMITS, checkText, compareKeys } from './limits';
import { ZERO, formatMinor } from './money';
import { aggregateLines, checkDimension, checkLedger } from './reports';
import { compareGroups, groupOf, type Dimension } from './targets';
import { isMonth, nextMonth, parseStrictUtc } from './time';

export interface ChargebackEntry {
  readonly kind: 'allocation' | 'adjustment';
  /** The period the entry is booked in. */
  readonly month: string;
  /** For an adjustment: the closed period it restates. Null for allocation entries. */
  readonly adjustsMonth: string | null;
  readonly currency: string;
  readonly group: string;
  /** Signed integer minor units. Adjustments may be negative. */
  readonly minor: bigint;
  readonly amount: string;
  readonly lineCount: number;
  readonly ruleIds: readonly string[];
}

export interface ChargebackPeriod {
  readonly month: string;
  readonly status: 'open' | 'closed';
  readonly allocation: readonly ChargebackEntry[];
  readonly adjustments: readonly ChargebackEntry[];
  /** Source ledger lines of the allocation entries, for drill-down to rule ids. */
  readonly lines: readonly AllocationLine[];
  readonly closedBy: string | null;
  readonly closedAt: string | null;
}

export interface AuditRecord {
  readonly seq: number;
  readonly action: 'RECORD_ALLOCATION' | 'CLOSE_PERIOD';
  readonly actor: string;
  readonly at: string;
  /** The period closed, or null for a record that spans months. */
  readonly month: string | null;
  readonly allocationEntries: number;
  readonly adjustmentEntries: number;
}

export interface ChargebackBook {
  readonly tenant: string;
  readonly dimension: Dimension;
  /** Sorted by month. */
  readonly periods: readonly ChargebackPeriod[];
  /** Append-only. */
  readonly audit: readonly AuditRecord[];
}

export interface ChangeContext {
  /** The acting subject (user or service) making the change. */
  actor: string;
  /** Injected time, strict UTC (`YYYY-MM-DDTHH:MM:SS[.fff]Z`). */
  at: string;
}

export function createChargebackBook(tenant: string, dimension: Dimension): ChargebackBook {
  const t = checkText(tenant, LIMITS.maxTenantLength, 'INVALID_TENANT');
  return Object.freeze({
    tenant: t,
    dimension: checkDimension(dimension),
    periods: Object.freeze([]),
    audit: Object.freeze([]),
  });
}

function checkContext(ctx: ChangeContext): { actor: string; at: string } {
  if (typeof ctx !== 'object' || ctx === null) throw new AllocationError('INVALID_ACTOR');
  const actor = checkText(ctx.actor, LIMITS.maxIdLength, 'INVALID_ACTOR');
  return { actor, at: parseStrictUtc(ctx.at).iso };
}

function entryOf(
  kind: 'allocation' | 'adjustment',
  month: string,
  adjustsMonth: string | null,
  currency: string,
  group: string,
  minor: bigint,
  lineCount: number,
  ruleIds: Iterable<string>,
): ChargebackEntry {
  return Object.freeze({
    kind,
    month,
    adjustsMonth,
    currency,
    group,
    minor,
    amount: formatMinor(minor, currency),
    lineCount,
    ruleIds: Object.freeze([...ruleIds].sort(compareKeys)),
  });
}

function cellKey(currency: string, group: string): string {
  return `${currency}\u0000${group}`;
}

function appendAudit(
  book: ChargebackBook,
  action: AuditRecord['action'],
  who: { actor: string; at: string },
  month: string | null,
  allocationEntries: number,
  adjustmentEntries: number,
): readonly AuditRecord[] {
  return Object.freeze([
    ...book.audit,
    Object.freeze({ seq: book.audit.length + 1, action, actor: who.actor, at: who.at, month, allocationEntries, adjustmentEntries }),
  ]);
}

function sortedPeriods(periods: Map<string, ChargebackPeriod>): readonly ChargebackPeriod[] {
  return Object.freeze([...periods.values()].sort((a, b) => compareKeys(a.month, b.month)));
}

function emptyOpenPeriod(month: string): ChargebackPeriod {
  return Object.freeze({
    month,
    status: 'open' as const,
    allocation: Object.freeze([]),
    adjustments: Object.freeze([]),
    lines: Object.freeze([]),
    closedBy: null,
    closedAt: null,
  });
}

/** First period after `month` that is not closed (absent counts as open). */
function firstOpenAfter(periods: Map<string, ChargebackPeriod>, month: string): string {
  let m = month;
  for (let i = 0; i < LIMITS.maxPeriodLookahead; i++) {
    m = nextMonth(m);
    const p = periods.get(m);
    if (!p || p.status === 'open') return m;
  }
  throw new AllocationError('NO_OPEN_PERIOD');
}

/** What a closed month stands at: its own entries plus every adjustment, in any period, that restates it. */
function effectiveTotals(periods: Map<string, ChargebackPeriod>, month: string): Map<string, bigint> {
  const totals = new Map<string, bigint>();
  const add = (e: ChargebackEntry): void => {
    const k = cellKey(e.currency, e.group);
    totals.set(k, (totals.get(k) ?? ZERO) + e.minor);
  };
  const own = periods.get(month);
  if (own) for (const e of own.allocation) add(e);
  for (const p of periods.values()) for (const e of p.adjustments) if (e.adjustsMonth === month) add(e);
  return totals;
}

/**
 * Records a (re)computed allocation. Open and new months take the allocation;
 * closed months are left untouched and any difference becomes adjustment
 * entries in the next open period. Returns a new book.
 */
export function recordAllocation(book: ChargebackBook, ledgerArg: AllocationLedger, ctx: ChangeContext): ChargebackBook {
  const who = checkContext(ctx);
  const ledger = checkLedger(ledgerArg);
  if (ledger.tenant !== book.tenant) throw new AllocationError('TENANT_MISMATCH');
  if (book.audit.length >= LIMITS.maxAuditRecords) throw new AllocationError('AUDIT_LOG_FULL');

  const dimension = book.dimension;
  const linesByMonth = new Map<string, AllocationLine[]>();
  for (const line of ledger.lines) {
    const list = linesByMonth.get(line.month);
    if (list) list.push(line);
    else linesByMonth.set(line.month, [line]);
  }

  const periods = new Map(book.periods.map((p) => [p.month, p]));
  let allocationEntries = 0;
  let adjustmentEntries = 0;

  for (const month of [...linesByMonth.keys()].sort(compareKeys)) {
    const monthLines = linesByMonth.get(month)!;
    const aggs = [...aggregateLines(monthLines, dimension).values()].sort((a, b) =>
      compareKeys(a.currency, b.currency) || compareGroups(a.group, b.group),
    );
    const existing = periods.get(month);

    if (!existing || existing.status === 'open') {
      const entries = aggs.map((a) => entryOf('allocation', month, null, a.currency, a.group, a.minor, a.lineCount, a.ruleIds));
      allocationEntries += entries.length;
      periods.set(
        month,
        Object.freeze({
          month,
          status: 'open' as const,
          allocation: Object.freeze(entries),
          adjustments: existing ? existing.adjustments : Object.freeze([]),
          lines: Object.freeze([...monthLines]),
          closedBy: null,
          closedAt: null,
        }),
      );
      continue;
    }

    // Closed: compute the restatement as signed differences per (currency, group).
    const standing = effectiveTotals(periods, month);
    const incoming = new Map<string, (typeof aggs)[number]>();
    for (const a of aggs) incoming.set(cellKey(a.currency, a.group), a);
    const keys = new Set<string>([...standing.keys(), ...incoming.keys()]);
    const raw: Array<{ currency: string; group: string; delta: bigint; inc: (typeof aggs)[number] | undefined }> = [];
    for (const key of [...keys].sort(compareKeys)) {
      const inc = incoming.get(key);
      const delta = (inc?.minor ?? ZERO) - (standing.get(key) ?? ZERO);
      if (delta === ZERO) continue;
      const [currency, group] = key.split('\u0000');
      raw.push({ currency, group, delta, inc });
    }
    if (raw.length > 0) {
      const target = firstOpenAfter(periods, month);
      const deltas = raw.map((r) =>
        entryOf('adjustment', target, month, r.currency, r.group, r.delta, r.inc?.lineCount ?? 0, r.inc?.ruleIds ?? []),
      );
      const tp = periods.get(target) ?? emptyOpenPeriod(target);
      periods.set(target, Object.freeze({ ...tp, adjustments: Object.freeze([...tp.adjustments, ...deltas]) }));
      adjustmentEntries += deltas.length;
    }
  }

  if (periods.size > LIMITS.maxPeriods) throw new AllocationError('TOO_MANY_PERIODS');
  return Object.freeze({
    tenant: book.tenant,
    dimension: book.dimension,
    periods: sortedPeriods(periods),
    audit: appendAudit(book, 'RECORD_ALLOCATION', who, null, allocationEntries, adjustmentEntries),
  });
}

/** Locks an open period. Returns a new book; every other period is carried over by reference. */
export function closePeriod(book: ChargebackBook, month: string, ctx: ChangeContext): ChargebackBook {
  const who = checkContext(ctx);
  if (!isMonth(month)) throw new AllocationError('INVALID_REPORT_REQUEST');
  if (book.audit.length >= LIMITS.maxAuditRecords) throw new AllocationError('AUDIT_LOG_FULL');
  const period = book.periods.find((p) => p.month === month);
  if (!period) throw new AllocationError('PERIOD_NOT_FOUND');
  if (period.status === 'closed') throw new AllocationError('PERIOD_ALREADY_CLOSED');
  const closed: ChargebackPeriod = Object.freeze({ ...period, status: 'closed' as const, closedBy: who.actor, closedAt: who.at });
  const periods = new Map(book.periods.map((p) => [p.month, p]));
  periods.set(month, closed);
  return Object.freeze({
    tenant: book.tenant,
    dimension: book.dimension,
    periods: sortedPeriods(periods),
    audit: appendAudit(book, 'CLOSE_PERIOD', who, month, 0, 0),
  });
}

export interface ChargebackRow {
  readonly month: string;
  readonly currency: string;
  readonly group: string;
  readonly status: 'open' | 'closed';
  readonly allocationMinor: bigint;
  readonly adjustmentMinor: bigint;
  /** allocation + adjustments booked in this period. */
  readonly totalMinor: bigint;
  readonly allocation: string;
  readonly adjustment: string;
  readonly total: string;
  readonly lineCount: number;
  readonly ruleIds: readonly string[];
}

export interface ChargebackStatement {
  readonly tenant: string;
  readonly dimension: Dimension;
  /** Sorted by month, currency, group (UNALLOCATED last). */
  readonly rows: readonly ChargebackRow[];
  /** Per period and currency. */
  readonly periodTotals: ReadonlyArray<{
    readonly month: string;
    readonly currency: string;
    readonly status: 'open' | 'closed';
    readonly totalMinor: bigint;
    readonly total: string;
  }>;
  /** Every adjustment entry, with the period it restates. */
  readonly adjustments: readonly ChargebackEntry[];
}

/** The chargeback statement of a book: per period, currency and group, allocation plus adjustments. */
export function buildChargeback(book: ChargebackBook): ChargebackStatement {
  if (typeof book !== 'object' || book === null || !Array.isArray(book.periods)) {
    throw new AllocationError('INVALID_REPORT_REQUEST');
  }
  const rows: ChargebackRow[] = [];
  const periodTotals: Array<{ month: string; currency: string; status: 'open' | 'closed'; totalMinor: bigint; total: string }> = [];
  const adjustments: ChargebackEntry[] = [];

  for (const p of book.periods) {
    const cells = new Map<string, { currency: string; group: string; alloc: bigint; adj: bigint; lines: number; ruleIds: Set<string> }>();
    const cell = (currency: string, group: string) => {
      const k = cellKey(currency, group);
      let c = cells.get(k);
      if (!c) {
        c = { currency, group, alloc: ZERO, adj: ZERO, lines: 0, ruleIds: new Set() };
        cells.set(k, c);
      }
      return c;
    };
    for (const e of p.allocation) {
      const c = cell(e.currency, e.group);
      c.alloc += e.minor;
      c.lines += e.lineCount;
      for (const r of e.ruleIds) c.ruleIds.add(r);
    }
    for (const e of p.adjustments) {
      const c = cell(e.currency, e.group);
      c.adj += e.minor;
      for (const r of e.ruleIds) c.ruleIds.add(r);
      adjustments.push(e);
    }
    const perCurrency = new Map<string, bigint>();
    for (const c of [...cells.values()].sort((a, b) => compareKeys(a.currency, b.currency) || compareGroups(a.group, b.group))) {
      const total = c.alloc + c.adj;
      perCurrency.set(c.currency, (perCurrency.get(c.currency) ?? ZERO) + total);
      rows.push(
        Object.freeze({
          month: p.month,
          currency: c.currency,
          group: c.group,
          status: p.status,
          allocationMinor: c.alloc,
          adjustmentMinor: c.adj,
          totalMinor: total,
          allocation: formatMinor(c.alloc, c.currency),
          adjustment: formatMinor(c.adj, c.currency),
          total: formatMinor(total, c.currency),
          lineCount: c.lines,
          ruleIds: Object.freeze([...c.ruleIds].sort(compareKeys)),
        }),
      );
    }
    for (const currency of [...perCurrency.keys()].sort(compareKeys)) {
      const totalMinor = perCurrency.get(currency)!;
      periodTotals.push(Object.freeze({ month: p.month, currency, status: p.status, totalMinor, total: formatMinor(totalMinor, currency) }));
    }
  }
  adjustments.sort(
    (a, b) =>
      compareKeys(a.month, b.month) ||
      compareKeys(a.adjustsMonth ?? '', b.adjustsMonth ?? '') ||
      compareKeys(a.currency, b.currency) ||
      compareGroups(a.group, b.group),
  );
  return Object.freeze({
    tenant: book.tenant,
    dimension: book.dimension,
    rows: Object.freeze(rows),
    periodTotals: Object.freeze(periodTotals),
    adjustments: Object.freeze(adjustments),
  });
}

export interface ChargebackDrillQuery {
  month: string;
  currency: string;
  group: string;
}

/** The source lines and the adjustment entries behind one chargeback row. */
export function drillDownChargeback(
  book: ChargebackBook,
  query: ChargebackDrillQuery,
): { lines: AllocationLine[]; adjustments: ChargebackEntry[] } {
  const period = book.periods.find((p) => p.month === query?.month);
  if (!period) throw new AllocationError('PERIOD_NOT_FOUND');
  return {
    lines: period.lines.filter((l) => l.currency === query.currency && groupOf(l.target, book.dimension) === query.group),
    adjustments: period.adjustments.filter((e) => e.currency === query.currency && e.group === query.group),
  };
}
