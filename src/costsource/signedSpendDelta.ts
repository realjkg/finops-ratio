import { formatUSD } from '@/lib/format';

/**
 * Signed dollar display for an observed spend delta. The delta may be
 * negative (a drop below baseline), so the sign is applied here on the
 * absolute value rather than relying on formatUSD's handling of negatives.
 * A magnitude that displays as zero (0, -0, or a tiny value that rounds to
 * $0.00) renders as "+$0.00" with no minus sign; negatives render as "-$X".
 * Non-finite input is not special-cased: NaN gives "+$NaN", Infinity gives
 * "+$∞", and -Infinity gives "-$∞".
 */
export function formatSignedUSD(value: number): string {
  const magnitude = formatUSD(Math.abs(value));
  const negative = value < 0 && magnitude !== formatUSD(0);
  return `${negative ? '-' : '+'}${magnitude}`;
}
