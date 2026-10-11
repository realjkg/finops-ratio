import { describe, expect, it } from 'vitest';
import {
  ceilDiv, currencyExponent, divRound, formatMinor, isCurrencyCode, minorToNumber,
  parseDecimalToMinor, percentFloor, toJsonSafe, toMinorUnits,
} from './money';

const B = (n: number | string) => BigInt(n);

describe('money', () => {
  it('exponents and currency codes', () => {
    expect(currencyExponent('USD')).toBe(2);
    expect(currencyExponent('JPY')).toBe(0);
    expect(currencyExponent('KWD')).toBe(3);
    expect(currencyExponent('CLF')).toBe(4);
    expect(isCurrencyCode('USD')).toBe(true);
    for (const bad of ['usd', 'US', 'USDX', '', null, 5]) expect(isCurrencyCode(bad)).toBe(false);
  });
  it('toMinorUnits rounds half away from zero and refuses bad input', () => {
    expect(toMinorUnits(0.125, 'USD')).toBe(B(13));
    expect(toMinorUnits(-0.125, 'USD')).toBe(B(-13));
    expect(toMinorUnits(70.08, 'USD')).toBe(B(7008));
    expect(toMinorUnits(1234.5, 'JPY')).toBe(B(1235));
    expect(toMinorUnits(1e12, 'USD')).toBe(B('100000000000000'));
    expect(toMinorUnits(1e12 + 1, 'USD')).toBeNull();
    for (const bad of [NaN, Infinity, '12.5', null, undefined, B(5)]) expect(toMinorUnits(bad, 'USD')).toBeNull();
  });
  it('parseDecimalToMinor is strict and exact', () => {
    expect(parseDecimalToMinor('12.345', 'USD')).toBe(B(1235));
    expect(parseDecimalToMinor('-12.345', 'USD')).toBe(B(-1235));
    expect(parseDecimalToMinor('0.30', 'USD')).toBe(B(30));
    for (const bad of ['1e3', ' 1', '1,000', '', '.5', '12.', '+5', '0x10', 'NaN', '12345678901234', null, {}]) {
      expect(parseDecimalToMinor(bad, 'USD')).toBeNull();
    }
  });
  it('integer helpers', () => {
    expect(divRound(B(5), B(2))).toBe(B(3));
    expect(divRound(B(-5), B(2))).toBe(B(-3));
    expect(divRound(B(1), B(3))).toBe(B(0));
    expect(ceilDiv(B(10), B(3))).toBe(B(4));
    expect(ceilDiv(B(9), B(3))).toBe(B(3));
  });
  it('formatting', () => {
    expect(formatMinor(B(12345), 'USD')).toBe('123.45');
    expect(formatMinor(B(-5), 'USD')).toBe('-0.05');
    expect(formatMinor(B(1235), 'KWD')).toBe('1.235');
    expect(minorToNumber(B(7008), 'USD')).toBe(70.08);
    expect(minorToNumber(B(Number.MAX_SAFE_INTEGER) + B(1), 'USD')).toBeNull();
  });
  it('percentFloor floors, clamps and handles undefined ratios', () => {
    expect(percentFloor(B(2), B(3))).toEqual({ pct: 66.66, bps: 6666, clamped: false });
    expect(percentFloor(B(150), B(100))).toEqual({ pct: 100, bps: 10000, clamped: true });
    expect(percentFloor(B(100), B(100))?.clamped).toBe(false);
    expect(percentFloor(B(1), B(0))).toBeNull();
    expect(percentFloor(B(-1), B(5))).toBeNull();
  });
  it('toJsonSafe handles bigint and cycles', () => {
    expect(JSON.parse(JSON.stringify(toJsonSafe({ a: B(5), b: [B(1)] })))).toEqual({ a: '5', b: ['1'] });
    const c: Record<string, unknown> = {};
    c.self = c;
    expect(() => JSON.stringify(toJsonSafe(c))).not.toThrow();
  });
});

describe('unknown currencies and number/string parity', () => {
  it('refuses unknown but well-shaped codes instead of defaulting to exponent 2', () => {
    for (const code of ['ZZZ', 'AAA', 'QQQ']) {
      expect(isCurrencyCode(code)).toBe(false);
      expect(() => currencyExponent(code)).toThrow(/not in the expected shape/);
      expect(parseDecimalToMinor('1.00', code)).toBeNull();
      expect(toMinorUnits(1, code)).toBeNull();
    }
  });
  it('JPY and KWD use their own exponents on both input kinds', () => {
    expect(toMinorUnits(1234.5, 'JPY')).toBe(B(1235));
    expect(parseDecimalToMinor('1234.5', 'JPY')).toBe(B(1235));
    expect(toMinorUnits(1.2345, 'KWD')).toBe(B(1235));
    expect(parseDecimalToMinor('1.2345', 'KWD')).toBe(B(1235));
  });
  it('a number and its string agree, including 1.005', () => {
    expect(toMinorUnits(1.005, 'USD')).toBe(B(101));
    expect(parseDecimalToMinor('1.005', 'USD')).toBe(B(101));
    for (const n of [0.125, 2.675, 70.08, 0.1, 1e-7, 123456.789, -2.675, 999999999999.99]) {
      expect(toMinorUnits(n, 'USD')).toBe(parseDecimalToMinor(String(n).includes('e') ? n.toFixed(20) : String(n), 'USD'));
    }
    expect(toMinorUnits(1e-7, 'USD')).toBe(B(0));
  });
});

