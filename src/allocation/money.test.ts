import { describe, expect, it } from 'vitest';
import { AllocationError } from './errors';
import { LIMITS } from './limits';
import {
  PERCENT_TOTAL,
  assertPercentsSumTo100,
  currencyExponent,
  formatMinor,
  formatScaled,
  parseDecimalScaled,
  parseDecimalToMinor,
  parseDecimalToMinorChecked,
  parsePercent,
  parseUsageWeight,
  splitByKeys,
  splitLargestRemainder,
  supportedCurrencies,
} from './money';
import { mulberry32 } from './testFixtures';

const B = (n: number | string): bigint => BigInt(n);

function codeOf(fn: () => unknown): string | undefined {
  try {
    fn();
  } catch (e) {
    if (e instanceof AllocationError) return e.code;
    throw e;
  }
  return undefined;
}

describe('currency exponents (ISO 4217)', () => {
  it('knows the common exponents', () => {
    expect(currencyExponent('USD')).toBe(2);
    expect(currencyExponent('EUR')).toBe(2);
    expect(currencyExponent('JPY')).toBe(0);
    expect(currencyExponent('KRW')).toBe(0);
    expect(currencyExponent('KWD')).toBe(3);
    expect(currencyExponent('BHD')).toBe(3);
    expect(currencyExponent('CLF')).toBe(4);
  });

  it.each(['XXX', 'usd', 'Usd', '', 'US', 'USDD', 'BTC', 'XAU', ' USD', 'USD '])('refuses unknown currency %j', (c) => {
    expect(codeOf(() => currencyExponent(c))).toBe('UNKNOWN_CURRENCY');
  });

  it.each([null, undefined, 840, {}, [], true])('refuses non-string currency %j', (c) => {
    expect(codeOf(() => currencyExponent(c))).toBe('UNKNOWN_CURRENCY');
  });

  it('has a sorted, duplicate-free supported list that includes the exponents under test', () => {
    const list = supportedCurrencies();
    expect(new Set(list).size).toBe(list.length);
    expect([...list].sort()).toEqual(list);
    for (const c of ['USD', 'JPY', 'KWD', 'CLF']) expect(list).toContain(c);
    for (const c of list) expect(c).toMatch(/^[A-Z]{3}$/);
  });
});

describe('parseDecimalToMinor: strict grammar', () => {
  it('parses plain decimals into minor units', () => {
    expect(parseDecimalToMinor('12.34', 'USD')).toBe(B(1234));
    expect(parseDecimalToMinor('0', 'USD')).toBe(B(0));
    expect(parseDecimalToMinor('0.00', 'USD')).toBe(B(0));
    expect(parseDecimalToMinor('-5.5', 'USD')).toBe(B(-550));
    expect(parseDecimalToMinor('1234', 'JPY')).toBe(B(1234));
    expect(parseDecimalToMinor('12.345', 'KWD')).toBe(B(12345));
    expect(parseDecimalToMinor('1.2345', 'CLF')).toBe(B(12345));
    expect(parseDecimalToMinor('100', 'USD')).toBe(B(10000));
  });

  it('accepts trailing zeros beyond the exponent because they are exact', () => {
    expect(parseDecimalToMinor('12.3400', 'USD')).toBe(B(1234));
    expect(parseDecimalToMinor('1.000', 'JPY')).toBe(B(1));
    expect(parseDecimalToMinor('5.0000', 'KWD')).toBe(B(5000));
  });

  it('accepts leading zeros and negative zero as zero', () => {
    expect(parseDecimalToMinor('007.50', 'USD')).toBe(B(750));
    expect(parseDecimalToMinor('-0', 'USD')).toBe(B(0));
    expect(parseDecimalToMinor('-0.00', 'USD')).toBe(B(0));
  });

  it.each([
    '1e3',
    '1E3',
    '1.5e2',
    '1,000.00',
    '1.000,00',
    '1 000.00',
    ' 1',
    '1 ',
    '\t1',
    '1\n',
    '+1',
    '.5',
    '5.',
    '--1',
    '-',
    '1.2.3',
    '',
    'NaN',
    'Infinity',
    '-Infinity',
    '0x10',
    '1_000',
    '１２', // fullwidth digits
    '٣', // Arabic-Indic digit
    '1/2',
    '$5',
    '5 USD',
  ])('refuses %j', (text) => {
    expect(codeOf(() => parseDecimalToMinor(text, 'USD'))).toBe('INVALID_DECIMAL');
  });

  it.each([null, undefined, 12, 12.5, {}, [], true])('refuses non-string amount, case %#', (v) => {
    expect(codeOf(() => parseDecimalToMinor(v, 'USD'))).toBe('INVALID_DECIMAL');
  });

  it('caps text length at 64 and integer digits at 24', () => {
    expect(parseDecimalToMinor('9'.repeat(24), 'JPY')).toBe(B('9'.repeat(24)));
    expect(codeOf(() => parseDecimalToMinor('9'.repeat(25), 'JPY'))).toBe('AMOUNT_OUT_OF_RANGE');
    expect(codeOf(() => parseDecimalToMinor('1'.repeat(65), 'USD'))).toBe('INVALID_DECIMAL');
    expect(codeOf(() => parseDecimalToMinor(`1.${'0'.repeat(62)}`, 'USD'))).toBeUndefined(); // 64 chars, all-zero fraction
    expect(codeOf(() => parseDecimalToMinor(`1.${'0'.repeat(63)}`, 'USD'))).toBe('INVALID_DECIMAL'); // 65 chars
  });

  it('refuses an unknown currency before looking at the amount', () => {
    expect(codeOf(() => parseDecimalToMinor('1.00', 'XXX'))).toBe('UNKNOWN_CURRENCY');
  });
});

describe('parseDecimalToMinor: precision and rounding rules', () => {
  it('refuses more fractional digits than the currency allows (default)', () => {
    expect(codeOf(() => parseDecimalToMinor('12.345', 'USD'))).toBe('PRECISION_EXCEEDED');
    expect(codeOf(() => parseDecimalToMinor('1.5', 'JPY'))).toBe('PRECISION_EXCEEDED');
    expect(codeOf(() => parseDecimalToMinor('1.2345', 'KWD'))).toBe('PRECISION_EXCEEDED');
    expect(codeOf(() => parseDecimalToMinor('0.000001', 'USD'))).toBe('PRECISION_EXCEEDED');
  });

  it('rounds half to even on the magnitude in half-even mode', () => {
    const r = (t: string, c = 'USD'): bigint => parseDecimalToMinor(t, c, 'half-even');
    expect(r('0.125')).toBe(B(12)); // tie, 12 is even
    expect(r('0.135')).toBe(B(14)); // tie, 13 is odd -> 14
    expect(r('0.126')).toBe(B(13));
    expect(r('0.124')).toBe(B(12));
    expect(r('0.005')).toBe(B(0)); // tie, 0 is even
    expect(r('0.015')).toBe(B(2));
    expect(r('0.0050001')).toBe(B(1)); // above the tie
    expect(r('-0.125')).toBe(B(-12)); // symmetric
    expect(r('-0.135')).toBe(B(-14));
    expect(r('2.5', 'JPY')).toBe(B(2));
    expect(r('3.5', 'JPY')).toBe(B(4));
    expect(r('2.4999', 'JPY')).toBe(B(2));
    expect(r('2.5001', 'JPY')).toBe(B(3));
    expect(r('1.0005', 'KWD')).toBe(B(1000)); // tie at the 4th digit, 1000 is even
    expect(r('1.0015', 'KWD')).toBe(B(1002));
  });

  it('reports whether rounding happened', () => {
    expect(parseDecimalToMinorChecked('1.2300', 'USD', 'half-even')).toEqual({ minor: B(123), rounded: false });
    expect(parseDecimalToMinorChecked('1.236', 'USD', 'half-even')).toEqual({ minor: B(124), rounded: true });
    expect(parseDecimalToMinorChecked('1.236', 'JPY', 'half-even')).toEqual({ minor: B(1), rounded: true });
  });

  it('never rounds an exact value even in half-even mode', () => {
    expect(parseDecimalToMinorChecked('5.50', 'USD', 'half-even').rounded).toBe(false);
  });
});

describe('parseDecimalScaled', () => {
  it('can forbid negatives', () => {
    expect(codeOf(() => parseDecimalScaled('-1', 2, 'refuse', false))).toBe('NEGATIVE_AMOUNT');
    expect(parseDecimalScaled('1', 2, 'refuse', false).value).toBe(B(100));
  });

  it('refuses an out-of-range scale', () => {
    expect(codeOf(() => parseDecimalScaled('1', -1))).toBe('AMOUNT_OUT_OF_RANGE');
    expect(codeOf(() => parseDecimalScaled('1', 31))).toBe('AMOUNT_OUT_OF_RANGE');
    expect(codeOf(() => parseDecimalScaled('1', 1.5))).toBe('AMOUNT_OUT_OF_RANGE');
  });
});

describe('formatMinor', () => {
  it('formats with the currency exponent', () => {
    expect(formatMinor(B(1050), 'USD')).toBe('10.50');
    expect(formatMinor(B(5), 'USD')).toBe('0.05');
    expect(formatMinor(B(0), 'USD')).toBe('0.00');
    expect(formatMinor(B(-5), 'USD')).toBe('-0.05');
    expect(formatMinor(B(1050), 'JPY')).toBe('1050');
    expect(formatMinor(B(-1050), 'JPY')).toBe('-1050');
    expect(formatMinor(B(0), 'JPY')).toBe('0');
    expect(formatMinor(B(1), 'KWD')).toBe('0.001');
    expect(formatMinor(B(-1234567), 'KWD')).toBe('-1234.567');
    expect(formatMinor(B(12345), 'CLF')).toBe('1.2345');
    expect(formatMinor(B('123456789012345678901234567890'), 'USD')).toBe('1234567890123456789012345678.90');
  });

  it('never prints exponents, separators or negative zero', () => {
    for (const v of [B(0), B(1), B(-1), B('100000000000000000000000'), B('-100000000000000000000000')]) {
      expect(formatMinor(v, 'USD')).toMatch(/^-?\d+\.\d{2}$/);
    }
    expect(formatMinor(-B(0), 'USD')).toBe('0.00');
  });

  it('refuses a non-bigint and an unknown currency', () => {
    expect(codeOf(() => formatMinor(12 as unknown as bigint, 'USD'))).toBe('INVALID_DECIMAL');
    expect(codeOf(() => formatMinor(B(1), 'XXX'))).toBe('UNKNOWN_CURRENCY');
    expect(codeOf(() => formatScaled(B(1), -1))).toBe('INVALID_DECIMAL');
  });
});

describe('parse/format round trip (seeded property test)', () => {
  it('parse(format(x)) === x for random minor amounts in every exponent', () => {
    const rnd = mulberry32(20260401);
    const currencies = ['USD', 'JPY', 'KWD', 'CLF', 'EUR', 'KRW', 'BHD'];
    for (let i = 0; i < 2000; i++) {
      const currency = currencies[Math.floor(rnd() * currencies.length)];
      const digits = 1 + Math.floor(rnd() * 18);
      let s = '';
      for (let d = 0; d < digits; d++) s += String(Math.floor(rnd() * 10));
      let minor = BigInt(s);
      if (rnd() < 0.4) minor = -minor;
      expect(parseDecimalToMinor(formatMinor(minor, currency), currency)).toBe(minor);
    }
  });
});

describe('fixed error text never echoes input', () => {
  it('uses the same message for different bad inputs of one code', () => {
    const secret = 'SECRET-TOKEN-12345';
    let a = '';
    let b = '';
    try {
      parseDecimalToMinor(`${secret}`, 'USD');
    } catch (e) {
      a = (e as Error).message;
    }
    try {
      parseDecimalToMinor('other-bad-input', 'USD');
    } catch (e) {
      b = (e as Error).message;
    }
    expect(a).toBe(b);
    expect(a).not.toContain(secret);
    expect(a.length).toBeGreaterThan(0);
  });
});

describe('splitLargestRemainder', () => {
  const split = (total: number | string, weights: number[]): bigint[] => splitLargestRemainder(B(total), weights.map(B));

  it('splits evenly with the remainder going to the lowest indexes on ties', () => {
    expect(split(100, [1, 1, 1])).toEqual([B(34), B(33), B(33)]);
    expect(split(101, [1, 1, 1])).toEqual([B(34), B(34), B(33)]);
    expect(split(2, [1, 1, 1, 1])).toEqual([B(1), B(1), B(0), B(0)]);
    expect(split(1, [1, 1])).toEqual([B(1), B(0)]);
  });

  it('gives leftover units to the largest fractional remainders', () => {
    // 100 over 1:2:3 -> exact 16.67, 33.33, 50.00 -> floors 16, 33, 50 -> one leftover to the 0.67
    expect(split(100, [1, 2, 3])).toEqual([B(17), B(33), B(50)]);
    // 10 over 3:3:4 -> exact 3, 3, 4 (no remainder)
    expect(split(10, [3, 3, 4])).toEqual([B(3), B(3), B(4)]);
    // 7 over 1:1:5 -> 1.0, 1.0, 5.0
    expect(split(7, [1, 1, 5])).toEqual([B(1), B(1), B(5)]);
    // 5 over 2:3:5 -> 1, 1.5, 2.5 -> floors 1,1,2 = 4; leftover 1 -> remainders 0, .5, .5 -> tie -> lower index (1)
    expect(split(5, [2, 3, 5])).toEqual([B(1), B(2), B(2)]);
  });

  it('splits a negative total by magnitude and restores the sign', () => {
    expect(split(-100, [1, 1, 1])).toEqual([B(-34), B(-33), B(-33)]);
    expect(split(-101, [1, 2, 3])).toEqual(split(101, [1, 2, 3]).map((x) => -x));
  });

  it('splits zero into zeros and gives a zero weight a zero share', () => {
    expect(split(0, [1, 2])).toEqual([B(0), B(0)]);
    expect(split(5, [0, 1])).toEqual([B(0), B(5)]);
    expect(split(5, [0, 0, 3])).toEqual([B(0), B(0), B(5)]);
  });

  it('handles a single target and very large values exactly', () => {
    expect(split(12345, [7])).toEqual([B(12345)]);
    const big = B('123456789012345678901234567890');
    const parts = splitLargestRemainder(big, [B(1), B(1), B(1)]);
    expect(parts.reduce((a, b) => a + b, B(0))).toBe(big);
  });

  it('refuses empty, all-zero, negative and non-bigint weights', () => {
    expect(codeOf(() => split(1, []))).toBe('EMPTY_SPLIT');
    expect(codeOf(() => split(1, [0, 0]))).toBe('ZERO_WEIGHT');
    expect(codeOf(() => splitLargestRemainder(B(1), [B(1), B(-1)]))).toBe('INVALID_WEIGHT');
    expect(codeOf(() => splitLargestRemainder(B(1), [1 as unknown as bigint]))).toBe('INVALID_WEIGHT');
    expect(codeOf(() => splitLargestRemainder(1 as unknown as bigint, [B(1)]))).toBe('INVALID_WEIGHT');
    expect(codeOf(() => splitLargestRemainder(B(1), 'x' as unknown as bigint[]))).toBe('INVALID_WEIGHT');
  });

  it('enforces the parts cap: at the cap works, one past is refused', () => {
    const atCap = new Array<bigint>(LIMITS.maxSplitParts).fill(B(1));
    const parts = splitLargestRemainder(B(LIMITS.maxSplitParts + 7), atCap);
    expect(parts.reduce((a, b) => a + b, B(0))).toBe(B(LIMITS.maxSplitParts + 7));
    expect(codeOf(() => splitLargestRemainder(B(1), [...atCap, B(1)]))).toBe('TOO_MANY_PARTS');
  });

  it('is deterministic: the same call always gives the same answer', () => {
    const a = split(1000003, [3, 7, 11, 13, 17]);
    const b = split(1000003, [3, 7, 11, 13, 17]);
    expect(a).toEqual(b);
  });

  it('sums to the total and stays within one unit of the exact share (seeded property test)', () => {
    const rnd = mulberry32(42);
    for (let i = 0; i < 1500; i++) {
      const n = 1 + Math.floor(rnd() * 12);
      const weights: bigint[] = [];
      for (let k = 0; k < n; k++) weights.push(B(Math.floor(rnd() * 1000)));
      if (weights.every((w) => w === B(0))) weights[0] = B(1);
      let total = B(Math.floor(rnd() * 1_000_000));
      if (rnd() < 0.3) total = -total;
      const parts = splitLargestRemainder(total, weights);
      expect(parts.reduce((a, b) => a + b, B(0))).toBe(total);
      const sum = weights.reduce((a, b) => a + b, B(0));
      const mag = total < B(0) ? -total : total;
      parts.forEach((p, k) => {
        const exactFloor = (mag * weights[k]) / sum;
        const magnitude = p < B(0) ? -p : p;
        expect(magnitude === exactFloor || magnitude === exactFloor + B(1)).toBe(true);
        if (weights[k] === B(0)) expect(p).toBe(B(0));
      });
    }
  });
});

describe('splitByKeys', () => {
  it('does not depend on input order and breaks remainder ties by smaller key', () => {
    const a = splitByKeys(B(100), [
      { key: 'c', weight: B(1) },
      { key: 'a', weight: B(1) },
      { key: 'b', weight: B(1) },
    ]);
    const b = splitByKeys(B(100), [
      { key: 'a', weight: B(1) },
      { key: 'b', weight: B(1) },
      { key: 'c', weight: B(1) },
    ]);
    expect(a).toEqual(b);
    expect(a).toEqual([
      { key: 'a', minor: B(34) },
      { key: 'b', minor: B(33) },
      { key: 'c', minor: B(33) },
    ]);
  });

  it('orders keys by code unit, not by locale', () => {
    const r = splitByKeys(B(1), [
      { key: 'b', weight: B(1) },
      { key: 'B', weight: B(1) },
    ]);
    expect(r[0]).toEqual({ key: 'B', minor: B(1) }); // uppercase sorts first in code-unit order
  });

  it('refuses duplicates, empty input and non-arrays', () => {
    expect(
      codeOf(() =>
        splitByKeys(B(1), [
          { key: 'a', weight: B(1) },
          { key: 'a', weight: B(1) },
        ]),
      ),
    ).toBe('DUPLICATE_KEY');
    expect(codeOf(() => splitByKeys(B(1), []))).toBe('EMPTY_SPLIT');
    expect(codeOf(() => splitByKeys(B(1), 'x' as unknown as []))).toBe('INVALID_WEIGHT');
  });
});

describe('percent and weight parsing', () => {
  it('parses percents to four fractional digits', () => {
    expect(parsePercent('100')).toBe(PERCENT_TOTAL);
    expect(parsePercent('33.3333')).toBe(B(333333));
    expect(parsePercent('0')).toBe(B(0));
  });

  it('refuses negatives, excess precision, over 100 and junk', () => {
    expect(codeOf(() => parsePercent('-1'))).toBe('NEGATIVE_AMOUNT');
    expect(codeOf(() => parsePercent('33.33333'))).toBe('PRECISION_EXCEEDED');
    expect(codeOf(() => parsePercent('100.0001'))).toBe('PERCENT_SUM_INVALID');
    expect(codeOf(() => parsePercent('1e2'))).toBe('INVALID_DECIMAL');
    expect(codeOf(() => parsePercent('50%'))).toBe('INVALID_DECIMAL');
  });

  it('checks that percents sum to exactly 100', () => {
    expect(() => assertPercentsSumTo100([parsePercent('33.3333'), parsePercent('33.3333'), parsePercent('33.3334')])).not.toThrow();
    expect(codeOf(() => assertPercentsSumTo100([parsePercent('33.3333'), parsePercent('33.3333'), parsePercent('33.3333')]))).toBe(
      'PERCENT_SUM_INVALID',
    );
    expect(codeOf(() => assertPercentsSumTo100([parsePercent('60'), parsePercent('40.0001')]))).toBe('PERCENT_SUM_INVALID');
  });

  it('parses usage weights to six fractional digits and refuses negatives', () => {
    expect(parseUsageWeight('1.5')).toBe(B(1500000));
    expect(parseUsageWeight('0')).toBe(B(0));
    expect(codeOf(() => parseUsageWeight('-1'))).toBe('NEGATIVE_AMOUNT');
    expect(codeOf(() => parseUsageWeight('1.1234567'))).toBe('PRECISION_EXCEEDED');
  });
});
