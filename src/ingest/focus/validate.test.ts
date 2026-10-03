import { describe, expect, it } from 'vitest';
import { isDecimalString } from './decimal';
import { parseFocusTimestamp } from './timestamp';
import { REQUIRED_COLUMNS, indexHeader, validateRow } from './validate';
import { FOCUS_HEADER, focusRow } from '../testing/focusCsv';

const P = '2026-07-01';

function values(row: Record<string, string>, header: readonly string[] = FOCUS_HEADER): string[] {
  return header.map((h) => row[h] ?? '');
}

function okIndex(header: readonly string[] = FOCUS_HEADER) {
  const r = indexHeader([...header]);
  if (!r.ok) throw new Error('header should be valid: ' + JSON.stringify(r.errors));
  return r.index;
}

describe('isDecimalString', () => {
  it('accepts plain, signed, fractional and exponent decimals', () => {
    for (const s of ['0', '1', '-1', '+2', '0.1', '.5', '5.', '123456789012345678901234567890.123456789', '1e-5', '1.2E+10', '-0.0000000001']) {
      expect(isDecimalString(s), s).toBe(true);
    }
  });
  it('rejects non-decimals, NaN and Infinity', () => {
    for (const s of ['', ' ', 'NaN', 'nan', 'Infinity', '-Infinity', 'inf', '1,000', '0x10', '1e', 'e5', '1.2.3', '1 000', '$5', '1e99999', '--1', '1_000', '١']) {
      expect(isDecimalString(s), JSON.stringify(s)).toBe(false);
    }
  });
});

describe('parseFocusTimestamp', () => {
  it('accepts ISO 8601 forms and normalizes offset-less values to UTC', () => {
    expect(parseFocusTimestamp('2026-07-01T00:00:00Z')?.iso).toBe('2026-07-01T00:00:00Z');
    expect(parseFocusTimestamp('2026-07-01T00:00:00.123Z')?.iso).toBe('2026-07-01T00:00:00.123Z');
    expect(parseFocusTimestamp('2026-07-01T02:00:00+02:00')?.epochMs).toBe(Date.UTC(2026, 6, 1, 0, 0, 0));
    expect(parseFocusTimestamp('2026-07-01 00:00:00')?.iso).toBe('2026-07-01T00:00:00Z');
    expect(parseFocusTimestamp('2026-07-01T00:00')?.iso).toBe('2026-07-01T00:00:00Z');
    expect(parseFocusTimestamp('2026-07-01')?.iso).toBe('2026-07-01T00:00:00Z');
  });
  it('rejects malformed and impossible timestamps', () => {
    for (const s of ['', 'yesterday', '0000-07-02T00:00:00Z', '0000-01-01', '2026-13-01T00:00:00Z', '2026-02-30T00:00:00Z', '2026-07-01T24:00:00Z', '2026-07-01T00:60:00Z', '07/01/2026', '2026-7-1', '2026-07-01T00:00:00+25:00']) {
      expect(parseFocusTimestamp(s), s).toBeNull();
    }
  });
});

describe('indexHeader', () => {
  it('reports every missing required column', () => {
    expect([...REQUIRED_COLUMNS].sort()).toEqual(['BilledCost', 'BillingCurrency', 'BillingPeriodStart', 'ChargePeriodEnd', 'ChargePeriodStart']);
    for (const col of REQUIRED_COLUMNS) {
      const r = indexHeader(FOCUS_HEADER.filter((h) => h !== col));
      expect(r.ok).toBe(false);
      if (!r.ok) expect(r.errors).toEqual([expect.objectContaining({ column: col, code: 'MISSING_REQUIRED_COLUMN' })]);
    }
    const none = indexHeader(['Foo']);
    expect(none.ok).toBe(false);
    if (!none.ok) expect(none.errors.map((e) => e.column).sort()).toEqual([...REQUIRED_COLUMNS].sort());
  });
  it('rejects control characters in header names (M-2)', () => {
    const r = indexHeader([...FOCUS_HEADER, 'Bad\u0000Name']);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.errors).toContainEqual(expect.objectContaining({ code: 'INVALID_CHARACTER' }));
  });

  it('rejects duplicate column names', () => {
    const r = indexHeader([...FOCUS_HEADER, 'BilledCost']);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.errors).toContainEqual(expect.objectContaining({ column: 'BilledCost', code: 'DUPLICATE_COLUMN' }));
  });
});

describe('validateRow', () => {
  const index = okIndex();

  it('maps a valid FOCUS 1.0 row; money stays the exact source string', () => {
    const r = validateRow(values(focusRow(P, { BilledCost: '0.1000000001', EffectiveCost: '' , Tags: '{"a":"b"}' })), index, P);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.fact.billedCost).toBe('0.1000000001');
    expect(typeof r.fact.billedCost).toBe('string');
    expect(r.fact.effectiveCost).toBeNull();
    expect(r.fact.listCost).toBe('1.50');
    expect(r.fact.billingCurrency).toBe('USD');
    expect(r.fact.chargePeriodStart).toBe('2026-07-02T00:00:00Z');
    expect(r.fact.usageQuantity).toBe('1');
    expect(r.fact.usageUnit).toBe('Hours');
    expect(r.fact.providerName).toBe('SyntheticCloud');
    expect(r.fact.extraColumns).toEqual({ BillingPeriodEnd: '2026-08-01T00:00:00Z', Tags: '{"a":"b"}' });
  });

  it('maps FOCUS 0.5 UsageQuantity/UsageUnit when ConsumedQuantity is absent', () => {
    const header = [...FOCUS_HEADER.filter((h) => h !== 'ConsumedQuantity' && h !== 'ConsumedUnit'), 'UsageQuantity', 'UsageUnit'];
    const r = validateRow(values({ ...focusRow(P), UsageQuantity: '7.5', UsageUnit: 'GB' }, header), okIndex(header), P);
    expect(r.ok && r.fact.usageQuantity).toBe('7.5');
    expect(r.ok && r.fact.usageUnit).toBe('GB');
  });

  const bad: Array<[string, Record<string, string>, string, string]> = [
    ['empty BilledCost', { BilledCost: '' }, 'BilledCost', 'MISSING_VALUE'],
    ['unparseable BilledCost', { BilledCost: '12,50' }, 'BilledCost', 'UNPARSEABLE_NUMBER'],
    ['NaN BilledCost', { BilledCost: 'NaN' }, 'BilledCost', 'UNPARSEABLE_NUMBER'],
    ['Infinity EffectiveCost', { EffectiveCost: 'Infinity' }, 'EffectiveCost', 'UNPARSEABLE_NUMBER'],
    ['unparseable quantity', { ConsumedQuantity: 'lots' }, 'ConsumedQuantity', 'UNPARSEABLE_NUMBER'],
    ['unparseable ChargePeriodStart', { ChargePeriodStart: 'soon' }, 'ChargePeriodStart', 'UNPARSEABLE_TIMESTAMP'],
    ['impossible ChargePeriodEnd', { ChargePeriodEnd: '2026-02-30T00:00:00Z' }, 'ChargePeriodEnd', 'UNPARSEABLE_TIMESTAMP'],
    ['BillingPeriodStart of another period', { BillingPeriodStart: '2026-06-01T00:00:00Z' }, 'BillingPeriodStart', 'PERIOD_MISMATCH'],
    ['BillingPeriodStart not at midnight', { BillingPeriodStart: '2026-07-01T05:00:00Z' }, 'BillingPeriodStart', 'PERIOD_MISMATCH'],
    ['ChargePeriodEnd before start', { ChargePeriodStart: '2026-07-03T00:00:00Z', ChargePeriodEnd: '2026-07-02T00:00:00Z' }, 'ChargePeriodEnd', 'CHARGE_PERIOD_INVERTED'],
    ['lower-case currency', { BillingCurrency: 'usd' }, 'BillingCurrency', 'INVALID_CURRENCY'],
    ['empty currency', { BillingCurrency: '' }, 'BillingCurrency', 'MISSING_VALUE'],
  ];
  for (const [name, overrides, column, code] of bad) {
    it(`rejects ${name} without echoing the cell value`, () => {
      const r = validateRow(values(focusRow(P, overrides)), index, P);
      expect(r.ok).toBe(false);
      if (r.ok) return;
      expect(r.errors).toContainEqual(expect.objectContaining({ column, code }));
      for (const e of r.errors) {
        for (const v of Object.values(overrides)) if (v.length > 2) expect(e.message).not.toContain(v);
        expect(e.message.length).toBeLessThanOrEqual(1000);
      }
    });
  }

  it('rejects year 0000 timestamps (Postgres cannot store them) (M-2)', () => {
    const r = validateRow(values(focusRow(P, { ChargePeriodStart: '0000-07-02T00:00:00Z' })), index, P);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.errors).toContainEqual(expect.objectContaining({ column: 'ChargePeriodStart', code: 'UNPARSEABLE_TIMESTAMP' }));
  });

  it('rejects NUL and other C0 control characters in any cell; allows TAB, CR and LF (M-2)', () => {
    for (const [col, v] of [
      ['ResourceId', 'res\u0000x'],
      ['Tags', '{"a":"\u0000"}'],
      ['ServiceName', 'svc\u0007'],
      ['ChargeCategory', 'Us\u001fage'],
    ]) {
      const r = validateRow(values(focusRow(P, { [col]: v })), index, P);
      expect(r.ok, col).toBe(false);
      if (!r.ok) {
        expect(r.errors).toContainEqual(expect.objectContaining({ column: col, code: 'INVALID_CHARACTER' }));
        for (const e of r.errors) expect(e.message).not.toContain(v);
      }
    }
    const ok = validateRow(values(focusRow(P, { ResourceId: 'multi\tline\r\nvalue' })), index, P);
    expect(ok.ok).toBe(true);
  });

  it('accepts BillingPeriodStart expressed with an equivalent offset', () => {
    const r = validateRow(values(focusRow(P, { BillingPeriodStart: '2026-07-01T00:00:00+00:00' })), index, P);
    expect(r.ok).toBe(true);
  });

  it('rejects a row with the wrong number of cells', () => {
    const r = validateRow(['1'], index, P);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.errors[0].code).toBe('COLUMN_COUNT_MISMATCH');
  });
});
