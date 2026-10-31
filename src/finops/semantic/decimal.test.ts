import { describe, expect, it } from 'vitest';
import { isDecimal, isZeroDecimal, subDecimal, sumDecimal } from './decimal';
// Test-only cross-check against the M0b bridge arithmetic (worker-only tree; tests are not bundled).
import { addDecimal } from '../../connectors/managed/evidence/bridge';

describe('exact decimal helper', () => {
  it('sums exactly at the largest input scale (as Postgres sum(numeric))', () => {
    expect(sumDecimal(['7.0', '4.5', '3.2', '3.30663861840'])).toBe('18.00663861840');
    expect(sumDecimal(['0.1', '0.2'])).toBe('0.3'); // float gives 0.30000000000000004
    expect(sumDecimal(['-2.61370000000', '20.62033861840'])).toBe('18.00663861840');
    expect(sumDecimal(['-0.5', '0.25'])).toBe('-0.25');
    expect(sumDecimal(['5'])).toBe('5');
  });

  it('subtracts with the sign of a - b, never rounding', () => {
    expect(subDecimal('18.00663861840', '18.00663861841')).toBe('-0.00000000001');
    expect(subDecimal('18.00663861841', '18.00663861840')).toBe('0.00000000001');
    expect(subDecimal('18.00663861840', '18.00663861840')).toBe('0.00000000000');
    expect(subDecimal('0', '-3')).toBe('3');
  });

  it('agrees with the M0b bridge addDecimal on value (bridge strips trailing zeros)', () => {
    const cases = [['7.0', '4.5', '3.2', '3.30663861840'], ['-2.6137', '20.62033861840'], ['1', '-1'], ['0.00000000001', '-0.00000000002']];
    for (const c of cases) expect(isZeroDecimal(subDecimal(sumDecimal(c), addDecimal(...c)))).toBe(true);
  });

  it('refuses non-decimals, floats in exponent form, huge strings and an empty sum (missing is never 0)', () => {
    for (const bad of ['1e3', '1.', '.5', '+1', ' 1', 'NaN', '1,0', '', '9'.repeat(41)]) {
      expect(isDecimal(bad), bad).toBe(false);
      expect(() => sumDecimal([bad])).toThrow('amount is not a plain decimal string');
    }
    expect(isDecimal(1 as unknown)).toBe(false);
    expect(() => sumDecimal([])).toThrow('an empty sum is not zero');
    expect(isZeroDecimal('-0.000')).toBe(true);
    expect(isZeroDecimal('0.00000000001')).toBe(false);
  });
});
