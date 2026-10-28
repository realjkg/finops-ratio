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
    expect(b.failures.map((f) => f.line)).toEqual(['records', 'credits USD']);
    expect(b.failures[1]).toMatchObject({ code: 'BRIDGE_NOT_CLOSED', expected: '-1.50', actual: '-1.00' });
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
    expect(b.failures).toEqual([{ line: 'tax USD', code: 'BRIDGE_SIDE_MISSING', side: 'source' }]);
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
