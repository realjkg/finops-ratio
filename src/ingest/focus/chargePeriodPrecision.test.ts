// PR #69 Copilot r4178626016: CHARGE_PERIOD_INVERTED must be judged at the precision
// Postgres stores (microseconds), because cost_facts_charge_period
// CHECK (charge_period_end >= charge_period_start) compares the stored values. Fraction
// digits beyond 6 are rounded as Postgres does (rint of the double: half to even).
import { describe, expect, it } from 'vitest';
import { parseFocusTimestamp } from './timestamp';
import { indexHeader, validateRow } from './validate';
import { FOCUS_HEADER, focusRow } from '../testing/focusCsv';

const P = '2026-07-01';
const BASE = '2026-07-02T00:00:00';

function chargeCodes(start: string, end: string): string[] {
  const r = indexHeader([...FOCUS_HEADER]);
  if (!r.ok) throw new Error('header');
  const row = focusRow(P, { ChargePeriodStart: start, ChargePeriodEnd: end });
  const v = validateRow(FOCUS_HEADER.map((h) => (row as Record<string, string>)[h] ?? ''), r.index, P);
  return v.ok ? [] : v.errors.map((e) => e.code);
}

describe('epochUs: the instant at Postgres microsecond precision', () => {
  it('matches what PG16 stores for 7-9 fraction digits (probed on a scratch PG16: rint, half to even)', () => {
    // [input fraction, microseconds Postgres stores] — from SELECT '…'::timestamptz on PG 16.14.
    const pg: Array<[string, bigint]> = [
      ['.0000005', BigInt(0)],
      ['.0000015', BigInt(2)],
      ['.0000025', BigInt(2)],
      ['.0000035', BigInt(4)],
      ['.0000045', BigInt(4)],
      ['.000000499', BigInt(0)], // 9 digits (the worker accepts at most 9; 10 are refused as UNPARSEABLE_TIMESTAMP)
      ['.9999995', BigInt(1_000_000)],
    ];
    const whole = parseFocusTimestamp(`${BASE}Z`)!.epochUs;
    for (const [frac, us] of pg) expect(parseFocusTimestamp(`${BASE}${frac}Z`)!.epochUs - whole, frac).toBe(us);
  });

  it('keeps 1-6 digits exactly and applies the offset', () => {
    expect(parseFocusTimestamp(`${BASE}.000500Z`)!.epochUs).toBe(BigInt(Date.UTC(2026, 6, 2)) * BigInt(1000) + BigInt(500));
    expect(parseFocusTimestamp('2026-07-02T02:00:00.5+02:00')!.epochUs).toBe(BigInt(Date.UTC(2026, 6, 2)) * BigInt(1000) + BigInt(500_000));
  });
});

describe('validateRow: CHARGE_PERIOD_INVERTED at microsecond precision', () => {
  it('a sub-millisecond inversion is refused (it would violate cost_facts_charge_period at insert)', () => {
    expect(chargeCodes(`${BASE}.000500Z`, `${BASE}.000100Z`)).toEqual(['CHARGE_PERIOD_INVERTED']);
    expect(chargeCodes(`${BASE}.000002Z`, `${BASE}.000001Z`)).toEqual(['CHARGE_PERIOD_INVERTED']);
  });

  it('equal to the microsecond is accepted, including values Postgres rounds to the same microsecond', () => {
    expect(chargeCodes(`${BASE}.000500Z`, `${BASE}.000500Z`)).toEqual([]);
    expect(chargeCodes(`${BASE}.000002Z`, `${BASE}.0000015Z`)).toEqual([]); // 1.5 → 2
    expect(chargeCodes(`${BASE}.000002Z`, `${BASE}.0000025Z`)).toEqual([]); // 2.5 → 2 (half to even)
    expect(chargeCodes(`${BASE}.000100Z`, `${BASE}.000500Z`)).toEqual([]);
  });

  it('rounding decides: .0000026 (→3) after .0000025 (→2) is inverted the other way round', () => {
    expect(chargeCodes(`${BASE}.0000026Z`, `${BASE}.0000025Z`)).toEqual(['CHARGE_PERIOD_INVERTED']);
  });
});
