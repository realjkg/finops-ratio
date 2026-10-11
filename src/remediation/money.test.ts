// Money in minor units: parsing is strict, nothing is rounded, currencies are never mixed.
import { describe, expect, it } from 'vitest';
import { MAX_MINOR, ZERO, addMoney, isCurrency, parseMinor } from './money';

describe('parseMinor', () => {
  it('accepts_bigint_digit_strings_and_safe_integers', () => {
    expect(parseMinor(BigInt(5))).toBe(BigInt(5));
    expect(parseMinor('5')).toBe(BigInt(5));
    expect(parseMinor(5)).toBe(BigInt(5));
    expect(parseMinor(0)).toBe(ZERO);
    expect(parseMinor('0')).toBe(ZERO);
  });
  it('accepts_the_ceiling_and_refuses_one_past_it', () => {
    expect(parseMinor(MAX_MINOR)).toBe(MAX_MINOR);
    expect(parseMinor('1000000000000000')).toBe(MAX_MINOR);
    expect(parseMinor(MAX_MINOR + BigInt(1))).toBeNull();
    expect(parseMinor('1000000000000001')).toBeNull();
  });
  it('never_rounds_fractional_input', () => {
    for (const bad of [1.5, 0.1, '1.5', '1e3', ' 5', '5 ', '+5', '0x10', '05', '', '-0', Number.NaN, Infinity, -Infinity, 2 ** 53]) {
      expect(parseMinor(bad), String(bad)).toBeNull();
    }
  });
  it('refuses_negative_amounts_and_other_types', () => {
    for (const bad of [-1, BigInt(-1), '-1', null, undefined, {}, [], true, Symbol('x')]) expect(parseMinor(bad)).toBeNull();
  });
  it('refuses_digit_strings_longer_than_the_ceiling', () => {
    expect(parseMinor('9'.repeat(17))).toBeNull();
    expect(parseMinor('9'.repeat(5000))).toBeNull();
  });
});

describe('addMoney and currency', () => {
  it('adds_only_within_one_currency', () => {
    expect(addMoney({ currency: 'USD', minor: BigInt(2) }, { currency: 'USD', minor: BigInt(3) })).toEqual({ currency: 'USD', minor: BigInt(5) });
    expect(addMoney({ currency: 'USD', minor: BigInt(2) }, { currency: 'EUR', minor: BigInt(3) })).toBeNull();
  });
  it('refuses_a_total_above_the_ceiling', () => {
    expect(addMoney({ currency: 'USD', minor: MAX_MINOR }, { currency: 'USD', minor: BigInt(1) })).toBeNull();
    expect(addMoney({ currency: 'USD', minor: MAX_MINOR - BigInt(1) }, { currency: 'USD', minor: BigInt(1) })?.minor).toBe(MAX_MINOR);
  });
  it('currency_codes_are_three_uppercase_letters', () => {
    expect(isCurrency('USD')).toBe(true);
    for (const bad of ['usd', 'US', 'USDX', 'U1D', '', null, 5]) expect(isCurrency(bad)).toBe(false);
  });
});
