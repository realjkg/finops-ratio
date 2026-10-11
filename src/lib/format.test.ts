import { describe, expect, it } from 'vitest';
import { formatUSD } from './format';

describe('formatUSD', () => {
  it('formatUSD_negative_whole_dollars_puts_minus_before_the_symbol', () => {
    expect(formatUSD(-702)).toBe('-$702');
    expect(formatUSD(-1500)).toBe('-$1,500');
    expect(formatUSD(-100.4)).toBe('-$100');
  });

  it('formatUSD_negative_cents_renders_minus_dollar_5_00', () => {
    expect(formatUSD(-5)).toBe('-$5.00');
    expect(formatUSD(-2.5)).toBe('-$2.50');
    expect(formatUSD(-99.99)).toBe('-$99.99');
  });

  it('formatUSD_negative_compact_renders_minus_dollar_2_5k', () => {
    expect(formatUSD(-2500, { compact: true })).toBe('-$2.5k');
    expect(formatUSD(-1500, { compact: true })).toBe('-$1.5k');
    expect(formatUSD(-1000, { compact: true })).toBe('-$1.0k');
  });

  it('formatUSD_negative_zero_and_tiny_negative_render_as_dollar_0_00', () => {
    expect(formatUSD(-0)).toBe('$0.00');
    expect(formatUSD(-0.001)).toBe('$0.00');
    expect(formatUSD(-0.004)).toBe('$0.00');
    expect(formatUSD(-0, { compact: true })).toBe('$0.00');
  });

  it('formatUSD_positive_output_matches_main_for_a_table_of_values', () => {
    const table: Array<[number, { compact?: boolean } | undefined, string]> = [
      [0, undefined, '$0.00'],
      [0.5, undefined, '$0.50'],
      [5, undefined, '$5.00'],
      [99.99, undefined, '$99.99'],
      [100, undefined, '$100'],
      [702, undefined, '$702'],
      [999, undefined, '$999'],
      [1234.5, undefined, '$1,235'],
      [1500, undefined, '$1,500'],
      [1000000, undefined, '$1,000,000'],
      [1000, { compact: true }, '$1.0k'],
      [1500, { compact: true }, '$1.5k'],
      [2500, { compact: true }, '$2.5k'],
      [1234, { compact: true }, '$1.2k'],
      [999, { compact: true }, '$999'],
    ];
    for (const [value, opts, expected] of table) {
      expect(formatUSD(value, opts), `formatUSD(${value}, ${JSON.stringify(opts)})`).toBe(expected);
    }
  });
});
