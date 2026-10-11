import { beforeEach, describe, expect, it } from 'vitest';
import { allocateCosts, type AllocationLedger } from './allocate';
import { AllocationError } from './errors';
import { LIMITS } from './limits';
import { buildChargeback, closePeriod, createChargebackBook, drillDownChargeback, recordAllocation, type ChargebackBook } from './chargeback';
import { buildShowback, drillDown } from './reports';
import type { AllocatableRow } from './rows';
import type { CostRule } from './rules';
import { UNALLOCATED } from './targets';
import { TENANT, resetIds, row, stable } from './testFixtures';

function codeOf(fn: () => unknown): string | undefined {
  try {
    fn();
  } catch (e) {
    if (e instanceof AllocationError) return e.code;
    throw e;
  }
  return undefined;
}

const rules: CostRule[] = [
  { id: 'r-web', precedence: 1, when: [{ field: 'tag', key: 'app', match: { op: 'equals', value: 'web' } }], action: { kind: 'target', target: { costCenter: 'cc-1', team: 'alpha', application: 'web' } } },
  { id: 'r-api', precedence: 2, when: [{ field: 'tag', key: 'app', match: { op: 'equals', value: 'api' } }], action: { kind: 'target', target: { costCenter: 'cc-1', team: 'beta', application: 'api' } } },
  { id: 'r-db', precedence: 3, when: [{ field: 'tag', key: 'app', match: { op: 'equals', value: 'db' } }], action: { kind: 'target', target: { costCenter: 'cc-2', team: 'beta' } } },
];
const MAR = '2026-03-10T00:00:00Z';
const APR = '2026-04-10T00:00:00Z';
const ledgerOf = (rows: AllocatableRow[]): AllocationLedger => allocateCosts(TENANT, rows, { rules });
const ctx = (at = '2026-05-01T00:00:00Z', actor = 'alice') => ({ actor, at });

beforeEach(resetIds);

describe('showback', () => {
  const rows = [
    row({ amount: '10.00', tags: { app: 'web' }, periodStart: MAR }),
    row({ amount: '20.00', tags: { app: 'api' }, periodStart: MAR }),
    row({ amount: '5.50', tags: { app: 'db' }, periodStart: MAR }),
    row({ amount: '7.00', periodStart: MAR }),
    row({ amount: '1.00', tags: { app: 'web' }, periodStart: APR }),
    row({ currency: 'JPY', amount: '500', tags: { app: 'web' }, periodStart: MAR }),
  ];

  it('groups by each dimension and month, UNALLOCATED last, per currency', () => {
    const l = ledgerOf(rows);
    const byTeam = buildShowback(l, { dimension: 'team' });
    expect(byTeam.rows.map((r) => `${r.month}|${r.currency}|${r.group}|${r.amount}`)).toEqual([
      '2026-03|JPY|alpha|500',
      '2026-03|USD|alpha|10.00',
      '2026-03|USD|beta|25.50',
      '2026-03|USD|UNALLOCATED|7.00',
      '2026-04|USD|alpha|1.00',
    ]);
    const byApp = buildShowback(l, { dimension: 'application' });
    // the db rule sets no application, so it falls in UNALLOCATED for this dimension
    expect(byApp.rows.find((r) => r.month === '2026-03' && r.currency === 'USD' && r.isUnallocated)?.amount).toBe('12.50');
    const byCc = buildShowback(l, { dimension: 'costCenter' });
    expect(byCc.rows.filter((r) => r.currency === 'USD' && r.month === '2026-03').map((r) => [r.group, r.amount])).toEqual([['cc-1', '30.00'], ['cc-2', '5.50'], [UNALLOCATED, '7.00']]);
  });

  it('totals are per currency, with per-month subtotals, and equal the ledger', () => {
    const s = buildShowback(ledgerOf(rows), { dimension: 'team' });
    const all = s.totals.filter((t) => t.month === null).map((t) => [t.currency, t.amount]);
    expect(all).toEqual([['JPY', '500'], ['USD', '43.50']]);
    expect(s.totals.filter((t) => t.month === '2026-04').map((t) => t.amount)).toEqual(['1.00']);
  });

  it('every row lists the rule ids behind it, and drill-down returns the lines', () => {
    const l = ledgerOf(rows);
    const s = buildShowback(l, { dimension: 'team' });
    const beta = s.rows.find((r) => r.group === 'beta')!;
    expect(beta.ruleIds).toEqual(['r-api', 'r-db']);
    const lines = drillDown(l, { dimension: 'team', month: '2026-03', currency: 'USD', group: 'beta' });
    expect(lines.map((x) => x.ruleId).sort()).toEqual(['r-api', 'r-db']);
    expect(lines.reduce((a, x) => a + x.minor, BigInt(0))).toBe(beta.minor);
    const un = drillDown(l, { dimension: 'team', month: '2026-03', currency: 'USD', group: UNALLOCATED });
    expect(un[0].ruleId).toBe('$unmatched');
    expect(un[0].rowId).not.toBeNull();
  });

  it('refuses a bad dimension and a malformed ledger', () => {
    const l = ledgerOf(rows);
    expect(codeOf(() => buildShowback(l, { dimension: 'owner' as never }))).toBe('INVALID_REPORT_REQUEST');
    expect(codeOf(() => buildShowback(null as never, { dimension: 'team' }))).toBe('INVALID_REPORT_REQUEST');
    expect(codeOf(() => buildShowback({ ...l, totals: [{ ...l.totals[0], ledgerMinor: BigInt(1) }] }, { dimension: 'team' }))).toBe('RECONCILIATION_FAILED');
  });

  it('an empty ledger gives an empty report', () => {
    const s = buildShowback(ledgerOf([]), { dimension: 'team' });
    expect(s.rows).toEqual([]);
    expect(s.totals).toEqual([]);
  });
});

describe('chargeback period lock and adjustments', () => {
  const base = [row({ amount: '10.00', tags: { app: 'web' }, periodStart: MAR }), row({ amount: '20.00', tags: { app: 'api' }, periodStart: MAR })];

  function open(): ChargebackBook {
    return recordAllocation(createChargebackBook(TENANT, 'team'), ledgerOf(base), ctx());
  }

  it('records allocation per month as open periods with an audit record', () => {
    const b = open();
    expect(b.periods.map((p) => [p.month, p.status])).toEqual([['2026-03', 'open']]);
    expect(b.audit).toEqual([{ seq: 1, action: 'RECORD_ALLOCATION', actor: 'alice', at: '2026-05-01T00:00:00.000Z', month: null, allocationEntries: 2, adjustmentEntries: 0 }]);
  });

  it('an open period is replaced by a recomputed allocation', () => {
    const b2 = recordAllocation(open(), ledgerOf([...base, row({ amount: '5.00', tags: { app: 'web' }, periodStart: MAR })]), ctx());
    const st = buildChargeback(b2);
    expect(st.rows.find((r) => r.group === 'alpha')?.total).toBe('15.00');
    expect(st.adjustments).toEqual([]);
  });

  it('a closed period is never mutated; changes become adjustments in the next open period', () => {
    const closed = closePeriod(open(), '2026-03', ctx('2026-05-02T00:00:00Z', 'bob'));
    const marBefore = closed.periods[0];
    const late = ledgerOf([...base, row({ amount: '4.00', tags: { app: 'web' }, periodStart: MAR })]);
    const b = recordAllocation(closed, late, ctx());
    expect(b.periods[0]).toBe(marBefore); // same frozen object
    expect(b.periods[0].status).toBe('closed');
    expect(b.periods[0].closedBy).toBe('bob');
    const apr = b.periods.find((p) => p.month === '2026-04')!;
    expect(apr.status).toBe('open');
    expect(apr.adjustments).toHaveLength(1);
    expect(apr.adjustments[0]).toMatchObject({ kind: 'adjustment', adjustsMonth: '2026-03', group: 'alpha', amount: '4.00', currency: 'USD' });
    const st = buildChargeback(b);
    expect(st.rows.find((r) => r.month === '2026-03' && r.group === 'alpha')?.total).toBe('10.00');
    expect(st.rows.find((r) => r.month === '2026-04' && r.group === 'alpha')).toMatchObject({ allocation: '0.00', adjustment: '4.00', total: '4.00' });
  });

  it('adjustments can be negative (credits) and re-applying the same ledger adds nothing', () => {
    const closed = closePeriod(open(), '2026-03', ctx());
    const lower = ledgerOf([base[1]]); // web spend vanished
    const b = recordAllocation(closed, lower, ctx());
    expect(b.periods.find((p) => p.month === '2026-04')!.adjustments.map((e) => e.amount)).toEqual(['-10.00']);
    const again = recordAllocation(b, lower, ctx());
    expect(again.periods.find((p) => p.month === '2026-04')!.adjustments).toHaveLength(1);
    // closed + adjustments always equals the latest recorded allocation
    const st = buildChargeback(again);
    const sum = st.rows.filter((r) => r.group === 'alpha').reduce((a, r) => a + r.totalMinor, BigInt(0));
    expect(sum).toBe(BigInt(0));
  });

  it('skips closed months when finding the next open period', () => {
    let b = open();
    b = recordAllocation(b, ledgerOf([row({ amount: '3.00', tags: { app: 'web' }, periodStart: APR })]), ctx());
    b = closePeriod(b, '2026-03', ctx());
    b = closePeriod(b, '2026-04', ctx());
    b = recordAllocation(b, ledgerOf([...base, row({ amount: '1.00', tags: { app: 'web' }, periodStart: MAR })]), ctx());
    expect(b.periods.map((p) => p.month)).toEqual(['2026-03', '2026-04', '2026-05']);
    expect(b.periods[2].adjustments[0].adjustsMonth).toBe('2026-03');
  });

  it('keeps currencies apart in adjustments', () => {
    const closed = closePeriod(open(), '2026-03', ctx());
    const b = recordAllocation(closed, ledgerOf([...base, row({ currency: 'JPY', amount: '300', tags: { app: 'web' }, periodStart: MAR })]), ctx());
    const adj = b.periods.find((p) => p.month === '2026-04')!.adjustments;
    expect(adj.map((e) => [e.currency, e.amount])).toEqual([['JPY', '300']]);
  });

  it('is pure: the input book is unchanged', () => {
    const b = open();
    const snap = stable(b);
    closePeriod(b, '2026-03', ctx());
    recordAllocation(b, ledgerOf([]), ctx());
    expect(stable(b)).toBe(snap);
  });

  it('refuses closing twice, closing an unknown period, and a bad month', () => {
    const closed = closePeriod(open(), '2026-03', ctx());
    expect(codeOf(() => closePeriod(closed, '2026-03', ctx()))).toBe('PERIOD_ALREADY_CLOSED');
    expect(codeOf(() => closePeriod(open(), '2026-09', ctx()))).toBe('PERIOD_NOT_FOUND');
    expect(codeOf(() => closePeriod(open(), '2026-13', ctx()))).toBe('INVALID_REPORT_REQUEST');
  });

  it('requires an actor and an injected valid UTC time', () => {
    expect(codeOf(() => recordAllocation(open(), ledgerOf([]), { actor: '', at: '2026-05-01T00:00:00Z' }))).toBe('INVALID_ACTOR');
    expect(codeOf(() => recordAllocation(open(), ledgerOf([]), { actor: 'a', at: 'yesterday' }))).toBe('INVALID_TIMESTAMP');
    expect(codeOf(() => recordAllocation(open(), ledgerOf([]), null as never))).toBe('INVALID_ACTOR');
  });

  it('is tenant bound', () => {
    const other = allocateCosts('tenant-b', [row({ tenant: 'tenant-b' })], { rules: [] });
    expect(codeOf(() => recordAllocation(open(), other, ctx()))).toBe('TENANT_MISMATCH');
  });

  it('audit log cap: the record at the cap is refused', () => {
    let b = createChargebackBook(TENANT, 'team');
    const empty = ledgerOf([]);
    for (let i = 0; i < LIMITS.maxAuditRecords; i++) b = recordAllocation(b, empty, ctx());
    expect(b.audit).toHaveLength(LIMITS.maxAuditRecords);
    expect(codeOf(() => recordAllocation(b, empty, ctx()))).toBe('AUDIT_LOG_FULL');
  });

  it('closing records who and when; statement drill-down finds lines and adjustments', () => {
    const closed = closePeriod(open(), '2026-03', ctx('2026-05-02T10:00:00Z', 'bob'));
    expect(closed.audit[1]).toMatchObject({ action: 'CLOSE_PERIOD', actor: 'bob', month: '2026-03' });
    const b = recordAllocation(closed, ledgerOf([...base, row({ amount: '4.00', tags: { app: 'web' }, periodStart: MAR })]), ctx());
    const march = drillDownChargeback(b, { month: '2026-03', currency: 'USD', group: 'alpha' });
    expect(march.lines.map((l) => l.ruleId)).toEqual(['r-web']);
    const april = drillDownChargeback(b, { month: '2026-04', currency: 'USD', group: 'alpha' });
    expect(april.adjustments[0].ruleIds).toContain('r-web');
    expect(codeOf(() => drillDownChargeback(b, { month: '2030-01', currency: 'USD', group: 'x' }))).toBe('PERIOD_NOT_FOUND');
  });

  it('statement period totals are per currency', () => {
    const b = recordAllocation(open(), ledgerOf([...base, row({ currency: 'KWD', amount: '1.500', tags: { app: 'web' }, periodStart: MAR })]), ctx());
    const st = buildChargeback(b);
    expect(st.periodTotals.map((t) => [t.currency, t.total])).toEqual([['KWD', '1.500'], ['USD', '30.00']]);
  });
});
