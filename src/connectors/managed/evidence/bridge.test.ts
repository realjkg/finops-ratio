// M0b: the accounting bridge closes exactly, line by line (source -> named
// deltas -> normalized), per currency; it never sums across currencies and
// never invents a zero for a missing side. SYNTHETIC amounts.
import { describe, expect, it } from 'vitest';
import { addDecimal, buildBridge, type Measure } from './bridge';

const key = { scope: 'billing-account:SYNTHETIC-1', period: '2026-09-01', costBasis: 'billed' };

// One native source row of 10.00 USD with two nested credits (-1.00, -0.50),
// split into 3 FOCUS rows: usage + 2 credit rows.
const source: Measure[] = [
  { measure: 'records', amount: '1' },
  { measure: 'billed', currency: 'USD', amount: '10.00' },
  { measure: 'credits', currency: 'USD', amount: '-1.50' },
];
const normalized: Measure[] = [
  { measure: 'records', amount: '3' },
  { measure: 'billed', currency: 'USD', amount: '8.50' },
  { measure: 'credits', currency: 'USD', amount: '-1.50' },
];
const deltas = [
  { measure: 'records', amount: '2', reason: 'split: each nested credit becomes its own row' },
  { measure: 'billed', currency: 'USD', amount: '-1.50', reason: 'split: credit rows carry their own BilledCost' },
];

describe('accounting bridge', () => {
  it('a split transform (1 source row -> usage + 2 credit rows) closes exactly', () => {
    const b = buildBridge({ key, source, normalized, deltas });
    expect(b.closed).toBe(true);
    expect(b.failures).toEqual([]);
    expect(b.lines.find((l) => l.measure === 'billed')).toEqual({
      measure: 'billed', currency: 'USD', source: '10.00', deltas: [{ amount: '-1.50', reason: 'split: credit rows carry their own BilledCost' }], normalized: '8.50', closes: true,
    });
  });

  it('dropping a credit fails the bridge and names the line', () => {
    const dropped = normalized.map((m) => (m.measure === 'credits' ? { ...m, amount: '-1.00' } : m.measure === 'records' ? { ...m, amount: '2' } : m));
    const b = buildBridge({ key, source, normalized: dropped, deltas });
    expect(b.closed).toBe(false);
    expect(b.failures.map((f) => f.line)).toEqual(['credits USD', 'records']);
    expect(b.failures[0]).toMatchObject({ code: 'BRIDGE_NOT_CLOSED', expected: '-1.5', actual: '-1.00' });
  });

  it('never sums across currencies: each currency is its own line', () => {
    const b = buildBridge({
      key,
      source: [{ measure: 'billed', currency: 'USD', amount: '5' }, { measure: 'billed', currency: 'EUR', amount: '7' }],
      normalized: [{ measure: 'billed', currency: 'USD', amount: '5' }, { measure: 'billed', currency: 'EUR', amount: '7' }],
      deltas: [],
    });
    expect(b.closed).toBe(true);
    expect(b.lines.map((l) => [l.measure, l.currency, l.normalized])).toEqual([['billed', 'EUR', '7'], ['billed', 'USD', '5']]);
    // A USD delta cannot explain a EUR difference.
    const bad = buildBridge({
      key,
      source: [{ measure: 'billed', currency: 'USD', amount: '5' }, { measure: 'billed', currency: 'EUR', amount: '7' }],
      normalized: [{ measure: 'billed', currency: 'USD', amount: '5' }, { measure: 'billed', currency: 'EUR', amount: '6' }],
      deltas: [{ measure: 'billed', currency: 'USD', amount: '-1', reason: 'wrong currency' }],
    });
    expect(bad.failures.map((f) => f.line)).toEqual(['billed EUR', 'billed USD']);
  });

  it('a measure present on one side only fails (never an invented zero)', () => {
    const b = buildBridge({ key, source: [{ measure: 'billed', currency: 'USD', amount: '1' }], normalized: [{ measure: 'billed', currency: 'USD', amount: '1' }, { measure: 'tax', currency: 'USD', amount: '0.10' }], deltas: [] });
    expect(b.closed).toBe(false);
    expect(b.failures).toEqual([{ line: 'tax USD', measure: 'tax', currency: 'USD', code: 'BRIDGE_SIDE_MISSING', side: 'source' }]);
  });

  it('a delta without a reason, a duplicate measure or a non-decimal amount is refused', () => {
    expect(() => buildBridge({ key, source, normalized, deltas: [{ measure: 'records', amount: '2', reason: ' ' }] })).toThrow(/reason/);
    expect(() => buildBridge({ key, source: [...source, { measure: 'records', amount: '1' }], normalized, deltas })).toThrow(/twice/);
    expect(() => buildBridge({ key, source: [{ measure: 'billed', currency: 'USD', amount: '1e3' }], normalized, deltas })).toThrow(/decimal/);
  });

  it('aggregate controls are compared but are never completeness proof', () => {
    const b = buildBridge({ key, source, normalized, deltas, controls: [{ measure: 'billed', currency: 'USD', amount: '8.50', origin: 'provider aggregate query' }] });
    expect(b.controls).toEqual([{ measure: 'billed', currency: 'USD', amount: '8.50', origin: 'provider aggregate query', kind: 'control:aggregate', status: 'matched' }]);
    const v = buildBridge({ key, source, normalized, deltas, controls: [{ measure: 'billed', currency: 'USD', amount: '8.49', origin: 'provider aggregate query' }] });
    expect(v.controls[0].status).toBe('variance');
    expect(v.closed).toBe(true); // a control variance is reported, never used to correct or to close
    const missing = buildBridge({ key, source, normalized, deltas, controls: [{ measure: 'billed', currency: 'EUR', amount: '1', origin: 'q' }] });
    expect(missing.controls[0].status).toBe('not-comparable');
  });

  it('decimal addition is exact (no float)', () => {
    expect(addDecimal('0.1', '0.2')).toBe('0.3');
    expect(addDecimal('123456789012345678.000001', '-0.000001')).toBe('123456789012345678');
    expect(addDecimal('-1.50', '1.5')).toBe('0');
  });
});

describe('accounting bridge: review round (#148)', () => {
  const usd = (amount: string) => [{ measure: 'billed', currency: 'USD', amount }];

  it('an orphan delta (no matching line) fails and names its line', () => {
    const b = buildBridge({ key, source: usd('100'), normalized: usd('100'), deltas: [{ measure: 'billed', currency: 'EUR', amount: '-5', reason: 'dropped rows' }, { measure: 'bileld', currency: 'USD', amount: '-7', reason: 'typo' }] });
    expect(b.closed).toBe(false);
    expect(b.failures).toEqual([
      { line: 'billed EUR', measure: 'billed', currency: 'EUR', code: 'BRIDGE_ORPHAN_DELTA', amount: '-5', reason: 'dropped rows' },
      { line: 'bileld USD', measure: 'bileld', currency: 'USD', code: 'BRIDGE_ORPHAN_DELTA', amount: '-7', reason: 'typo' },
    ]);
  });

  it('an empty bridge, or one without a money line, never closes; every declared currency needs a money line', () => {
    expect(buildBridge({ key, source: [], normalized: [], deltas: [] })).toMatchObject({ closed: false, failures: [{ code: 'BRIDGE_NO_MONEY_LINE' }] });
    expect(buildBridge({ key, source: [{ measure: 'records', amount: '1' }], normalized: [{ measure: 'records', amount: '1' }], deltas: [] }).closed).toBe(false);
    const ctl = buildBridge({ key, source: [], normalized: [], deltas: [], controls: [{ measure: 'billed', currency: 'USD', amount: '5', origin: 'provider aggregate query' }] });
    expect(ctl.closed).toBe(false);
    expect(ctl.failures.map((f) => f.code)).toEqual(['BRIDGE_NO_MONEY_LINE', 'BRIDGE_CURRENCY_UNCOVERED']);
    const decl = buildBridge({ key, currencies: ['USD', 'EUR'], source: usd('1'), normalized: usd('1'), deltas: [] });
    expect(decl.failures).toEqual([{ line: 'EUR', currency: 'EUR', code: 'BRIDGE_CURRENCY_UNCOVERED' }]);
  });

  it('a monetary measure without an ISO currency is refused; line keys are structured, not concatenated', () => {
    for (const measure of ['billed', 'effective', 'credits', 'tax', 'listCost']) {
      expect(() => buildBridge({ key, source: [{ measure, amount: '10' }], normalized: [{ measure, amount: '10' }], deltas: [] })).toThrow(/currency/);
    }
    expect(() => buildBridge({ key, source: [{ measure: 'billed', currency: 'usd', amount: '1' }], normalized: usd('1'), deltas: [] })).toThrow(/currency/);
    expect(() => buildBridge({ key, source: [{ measure: 'billed USD', amount: '10' }], normalized: usd('10'), deltas: [] })).toThrow(/measure/);
    const b = buildBridge({ key, source: [...usd('1'), { measure: 'usage', unit: 'USD', amount: '10' }], normalized: [...usd('1'), { measure: 'usage', currency: 'USD', amount: '10' }], deltas: [] });
    expect(b.closed).toBe(false);
    expect(b.failures.map((f) => [f.code, f.line])).toEqual([['BRIDGE_SIDE_MISSING', 'usage USD'], ['BRIDGE_SIDE_MISSING', 'usage [USD]']]);
  });

  it('a bridge that does not close reports the residual (normalized - expected) explicitly', () => {
    const b = buildBridge({ key, source: usd('100.00'), normalized: usd('99.99'), deltas: [{ measure: 'billed', currency: 'USD', amount: '-0.005', reason: 'rounding' }] });
    expect(b.failures).toEqual([{ line: 'billed USD', measure: 'billed', currency: 'USD', code: 'BRIDGE_NOT_CLOSED', expected: '99.995', actual: '99.99', residual: '-0.005' }]);
  });
});
