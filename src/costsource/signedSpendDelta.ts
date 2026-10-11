import { formatUSD } from '@/lib/format';

/**
 * Signed dollar display for an observed spend delta. The delta may be
 * negative (a drop below baseline), so the sign is applied here on the
 * absolute value rather than relying on formatUSD's handling of negatives.
 * Zero renders as "+$0.00"; negatives render as "-$X".
 */
export function formatSignedUSD(value: number): string {
  return `${value < 0 ? '-' : '+'}${formatUSD(Math.abs(value))}`;
}
