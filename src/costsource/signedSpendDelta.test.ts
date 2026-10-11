import { describe, expect, it } from 'vitest';
import { formatSignedUSD } from './signedSpendDelta';

describe('formatSignedUSD', () => {
  it('prefixes a positive delta with +', () => {
    expect(formatSignedUSD(5)).toBe('+$5.00');
    expect(formatSignedUSD(1234.5)).toBe('+$1,235');
  });

  it('shows zero (and negative zero) as +$0.00', () => {
    expect(formatSignedUSD(0)).toBe('+$0.00');
    expect(formatSignedUSD(-0)).toBe('+$0.00');
  });

  it('shows a negative delta with a single leading minus and no +', () => {
    expect(formatSignedUSD(-5)).toBe('-$5.00');
    expect(formatSignedUSD(-1234.5)).toBe('-$1,235');
  });

  it('never emits +- or +$- sequences', () => {
    for (const v of [-0.5, -5, -250, -99999, 0, 7]) {
      const s = formatSignedUSD(v);
      expect(s).not.toMatch(/\+-|\+\$-|\$-/);
    }
  });
});
