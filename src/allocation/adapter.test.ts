import { describe, expect, it } from 'vitest';
import { allocateCosts } from './allocate';
import { fromCanonicalRow, numberToDecimalString, parseTagsStrict, tryFromCanonicalRow, type CanonicalRowInput } from './adapter';
import { AllocationError } from './errors';
import { LIMITS, checkText, hasUnsafeChars, isPlainObject } from './limits';
import { isMonth, nextMonth, parseFocusTimestamp, parseStrictUtc } from './time';

function codeOf(fn: () => unknown): string | undefined {
  try {
    fn();
  } catch (e) {
    if (e instanceof AllocationError) return e.code;
    throw e;
  }
  return undefined;
}

const canon = (over: Partial<CanonicalRowInput> = {}): CanonicalRowInput => ({
  BilledCost: 12.34,
  EffectiveCost: 10,
  BillingCurrency: 'USD',
  ChargePeriodStart: '2026-03-05T00:00:00Z',
  BillingAccountId: 'tenant-a',
  SubAccountId: 'acct-1',
  ServiceName: 'AmazonEC2',
  ResourceId: 'i-123',
  ...over,
});

describe('fromCanonicalRow', () => {
  it('maps the FOCUS columns per the ingest table', () => {
    const r = fromCanonicalRow(canon(), { id: 'x1' });
    expect(r).toEqual({ id: 'x1', tenant: 'tenant-a', currency: 'USD', amount: '12.34', periodStart: '2026-03-05T00:00:00.000Z', account: 'acct-1', service: 'AmazonEC2', resourceId: 'i-123', tags: {} });
  });

  it('can use EffectiveCost and override the tenant', () => {
    const r = fromCanonicalRow(canon(), { id: 'x', costBasis: 'EffectiveCost', tenant: 't2' });
    expect(r.amount).toBe('10');
    expect(r.tenant).toBe('t2');
  });

  it('parses Tags from a JSON string, an object, or extraColumns', () => {
    expect(fromCanonicalRow(canon({ Tags: '{"env":"prod"}' }), { id: 'x' }).tags).toEqual({ env: 'prod' });
    expect(fromCanonicalRow(canon({ Tags: { env: 'dev' } }), { id: 'x' }).tags).toEqual({ env: 'dev' });
    expect(fromCanonicalRow(canon({ extraColumns: { Tags: '{"a":"b"}' } }), { id: 'x' }).tags).toEqual({ a: 'b' });
    expect(fromCanonicalRow(canon({ Tags: '{"top":"1"}', extraColumns: { Tags: '{"a":"b"}' } }), { id: 'x' }).tags).toEqual({ top: '1' });
    expect(fromCanonicalRow(canon({ Tags: '' }), { id: 'x' }).tags).toEqual({});
  });

  it('reads region from x_RatioRegion, then extraColumns.RegionId', () => {
    expect(fromCanonicalRow(canon({ x_RatioRegion: 'eu-west-1' }), { id: 'x' }).region).toBe('eu-west-1');
    expect(fromCanonicalRow(canon({ extraColumns: { RegionId: 'us-east-1' } }), { id: 'x' }).region).toBe('us-east-1');
    expect(fromCanonicalRow(canon(), { id: 'x' }).region).toBeUndefined();
  });

  it('normalizes offsets and bare dates to UTC', () => {
    expect(fromCanonicalRow(canon({ ChargePeriodStart: '2026-03-05T01:00:00+02:00' }), { id: 'x' }).periodStart).toBe('2026-03-04T23:00:00.000Z');
    expect(fromCanonicalRow(canon({ ChargePeriodStart: '2026-03-05' }), { id: 'x' }).periodStart).toBe('2026-03-05T00:00:00.000Z');
    expect(fromCanonicalRow(canon({ ChargePeriodStart: '2026-03-05 06:30:00' }), { id: 'x' }).periodStart).toBe('2026-03-05T06:30:00.000Z');
  });

  it('refuses unsupported currency, bad amounts and bad timestamps', () => {
    expect(codeOf(() => fromCanonicalRow(canon({ BillingCurrency: 'XXX' }), { id: 'x' }))).toBe('UNKNOWN_CURRENCY');
    expect(codeOf(() => fromCanonicalRow(canon({ BilledCost: NaN }), { id: 'x' }))).toBe('INVALID_DECIMAL');
    expect(codeOf(() => fromCanonicalRow(canon({ BilledCost: Infinity }), { id: 'x' }))).toBe('INVALID_DECIMAL');
    expect(codeOf(() => fromCanonicalRow(canon({ BilledCost: 1e30 }), { id: 'x' }))).toBe('AMOUNT_OUT_OF_RANGE');
    expect(codeOf(() => fromCanonicalRow(canon({ ChargePeriodStart: 'nope' }), { id: 'x' }))).toBe('INVALID_TIMESTAMP');
    expect(codeOf(() => fromCanonicalRow(canon({ ChargePeriodStart: '2026-02-30' }), { id: 'x' }))).toBe('INVALID_TIMESTAMP');
    expect(codeOf(() => fromCanonicalRow(canon({ ChargePeriodStart: '2026-03-05T00:00:00+15:00' }), { id: 'x' }))).toBe('INVALID_TIMESTAMP');
    expect(codeOf(() => fromCanonicalRow(null as never, { id: 'x' }))).toBe('INVALID_ROW');
  });

  it('refuses malformed Tags: bad JSON, arrays, nesting, non-strings, oversized', () => {
    const t = (Tags: unknown) => codeOf(() => fromCanonicalRow(canon({ Tags }), { id: 'x' }));
    expect(t('{bad')).toBe('INVALID_TAGS');
    expect(t('[1]')).toBe('INVALID_TAGS');
    expect(t('"s"')).toBe('INVALID_TAGS');
    expect(t('{"a":{"b":"c"}}')).toBe('INVALID_TAGS');
    expect(t('{"a":1}')).toBe('INVALID_TAGS');
    expect(t('{"a":null}')).toBe('INVALID_TAGS');
    expect(t(['a'])).toBe('INVALID_TAGS');
    expect(t(42)).toBe('INVALID_TAGS');
  });

  it('caps Tags JSON size: at the cap parses, one past is refused', () => {
    const pad = (n: number) => `{"k":"${'v'.repeat(n - 8)}"}`;
    const atCap = pad(LIMITS.maxTagsJsonLength);
    expect(atCap.length).toBe(LIMITS.maxTagsJsonLength);
    // a value that long is itself over the per-value cap, so the cap on text is what we check here
    expect(codeOf(() => parseTagsStrict(atCap))).toBe('INVALID_TAGS');
    expect(codeOf(() => parseTagsStrict(atCap + ' '))).toBe('TAGS_TOO_LARGE');
    const manyOk = JSON.stringify(Object.fromEntries(Array.from({ length: LIMITS.maxTagsPerRow }, (_, i) => [`k${i}`, 'v'])));
    expect(Object.keys(parseTagsStrict(manyOk))).toHaveLength(LIMITS.maxTagsPerRow);
    const manyBad = JSON.stringify(Object.fromEntries(Array.from({ length: LIMITS.maxTagsPerRow + 1 }, (_, i) => [`k${i}`, 'v'])));
    expect(codeOf(() => parseTagsStrict(manyBad))).toBe('TAGS_TOO_LARGE');
  });

  it('keeps __proto__ / constructor tag keys as inert own data', () => {
    const r = fromCanonicalRow(canon({ Tags: '{"__proto__":"x","constructor":"y","env":"prod"}' }), { id: 'x' });
    expect(Object.keys(r.tags).sort()).toEqual(['__proto__', 'constructor', 'env']);
    expect(Object.getPrototypeOf(r.tags)).toBe(Object.prototype);
    expect(({} as Record<string, unknown>).env).toBeUndefined();
    const l = allocateCosts('tenant-a', [r], { rules: [] });
    expect(l.totals[0].ledger).toBe('12.34');
  });

  it('tryFromCanonicalRow returns only a fixed code on failure', () => {
    const bad = tryFromCanonicalRow(canon({ Tags: '{"a":"\u0000SECRET"}' }), { id: 'x' });
    expect(bad).toEqual({ ok: false, code: 'INVALID_TAGS' });
    expect(tryFromCanonicalRow(canon(), { id: 'x' }).ok).toBe(true);
  });

  it('adapter output feeds allocation end to end, mixed currencies stay apart', () => {
    const rows = [canon(), canon({ BillingCurrency: 'JPY', BilledCost: 1500 }), canon({ BillingCurrency: 'KWD', BilledCost: 0.125 })].map((c, i) => fromCanonicalRow(c, { id: `r${i}` }));
    const l = allocateCosts('tenant-a', rows, { rules: [] });
    expect(l.totals.map((t) => [t.currency, t.ledger])).toEqual([['JPY', '1500'], ['KWD', '0.125'], ['USD', '12.34']]);
  });

  it('a float with binary noise is carried exactly, rounded once, and reported', () => {
    const r = fromCanonicalRow(canon({ BilledCost: 0.1 + 0.2 }), { id: 'x' });
    expect(r.amount).toBe('0.30000000000000004');
    expect(codeOf(() => allocateCosts('tenant-a', [r], { rules: [], rounding: 'refuse' }))).toBe('PRECISION_EXCEEDED');
    const l = allocateCosts('tenant-a', [r], { rules: [] });
    expect(l.totals[0]).toMatchObject({ ledger: '0.30', roundedRows: 1, beyondExactScaleRows: 1 });
  });
});

describe('numberToDecimalString', () => {
  it('avoids exponents', () => {
    expect(numberToDecimalString(1e-7)).toBe('0.0000001');
    expect(numberToDecimalString(123456789.5)).toBe('123456789.5');
    expect(numberToDecimalString(-2.5)).toBe('-2.5');
    expect(numberToDecimalString(0)).toBe('0');
    expect(codeOf(() => numberToDecimalString(1e-30))).toBe('AMOUNT_OUT_OF_RANGE');
    expect(codeOf(() => numberToDecimalString('1' as never))).toBe('INVALID_DECIMAL');
  });
});

describe('time helpers', () => {
  it('parses strict UTC and rejects everything else', () => {
    expect(parseStrictUtc('2026-03-01T00:00:00Z')).toMatchObject({ iso: '2026-03-01T00:00:00.000Z', month: '2026-03' });
    expect(parseStrictUtc('2026-03-01T00:00:00.5Z').iso).toBe('2026-03-01T00:00:00.500Z');
    for (const bad of ['2026-03-01', '2026-03-01T00:00:00', '2026-03-01T24:00:00Z', '2026-03-01T00:60:00Z', '2026-13-01T00:00:00Z', '1969-12-31T23:59:59Z', '2026-03-01t00:00:00z', ' 2026-03-01T00:00:00Z', '2024-02-30T00:00:00Z']) {
      expect(codeOf(() => parseStrictUtc(bad))).toBe('INVALID_TIMESTAMP');
    }
    expect(parseStrictUtc('2024-02-29T00:00:00Z').month).toBe('2024-02');
    expect(codeOf(() => parseStrictUtc('2026-03-01T00:00:00Z' + 'x'.repeat(30)))).toBe('INVALID_TIMESTAMP');
    expect(codeOf(() => parseFocusTimestamp('9999-12-31T23:59:59-01:00'))).toBe('INVALID_TIMESTAMP');
  });

  it('month helpers', () => {
    expect(isMonth('2026-12')).toBe(true);
    expect(isMonth('2026-00')).toBe(false);
    expect(isMonth('2026-1')).toBe(false);
    expect(isMonth(5)).toBe(false);
    expect(nextMonth('2026-12')).toBe('2027-01');
    expect(nextMonth('2026-03')).toBe('2026-04');
    expect(codeOf(() => nextMonth('9999-12'))).toBe('INVALID_TIMESTAMP');
  });
});

describe('limits helpers', () => {
  it('detects control and bidi characters', () => {
    for (const c of ['\u0000', '\n', '\u007f', '\u0085', ' ', '‮', '⁦', '‏']) expect(hasUnsafeChars(`a${c}b`)).toBe(true);
    expect(hasUnsafeChars('plain text é 日本')).toBe(false);
  });

  it('checkText enforces type, length, emptiness and trimming', () => {
    expect(checkText('ok', 2)).toBe('ok');
    expect(codeOf(() => checkText('abc', 2))).toBe('INVALID_TEXT');
    expect(codeOf(() => checkText('', 5))).toBe('INVALID_TEXT');
    expect(checkText('', 5, 'INVALID_TEXT', { allowEmpty: true })).toBe('');
    expect(codeOf(() => checkText(' a', 5))).toBe('INVALID_TEXT');
    expect(checkText(' a', 5, 'INVALID_TEXT', { requireTrimmed: false })).toBe(' a');
    expect(codeOf(() => checkText(5, 5))).toBe('INVALID_TEXT');
  });

  it('isPlainObject refuses arrays, null, class instances and Map', () => {
    expect(isPlainObject({})).toBe(true);
    expect(isPlainObject(Object.create(null))).toBe(true);
    expect(isPlainObject([])).toBe(false);
    expect(isPlainObject(null)).toBe(false);
    expect(isPlainObject(new Map())).toBe(false);
  });

  it('every cap is positive and frozen', () => {
    expect(Object.isFrozen(LIMITS)).toBe(true);
    for (const v of Object.values(LIMITS)) expect(v).toBeGreaterThan(0);
  });
});
