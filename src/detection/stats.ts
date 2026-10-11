// Small deterministic statistics helpers (median, quantile, MAD, compensated
// sum). Pure functions over number arrays; no randomness, no I/O. Callers pass
// finite numbers (every public entry point validates its input first).

export function sum(values: readonly number[]): number {
  // Neumaier compensated summation: stable for long, mixed-sign series.
  let total = 0;
  let compensation = 0;
  for (const v of values) {
    const t = total + v;
    if (Math.abs(total) >= Math.abs(v)) compensation += total - t + v;
    else compensation += v - t + total;
    total = t;
  }
  return total + compensation;
}

export function mean(values: readonly number[]): number {
  return values.length === 0 ? 0 : sum(values) / values.length;
}

function sortedCopy(values: readonly number[]): number[] {
  return values.slice().sort((a, b) => a - b);
}

/** Median; 0 for an empty input. */
export function median(values: readonly number[]): number {
  const n = values.length;
  if (n === 0) return 0;
  const s = sortedCopy(values);
  const mid = n >> 1;
  return n % 2 === 1 ? (s[mid] as number) : ((s[mid - 1] as number) + (s[mid] as number)) / 2;
}

/** Linear-interpolated quantile of an ascending-sorted array, p in [0, 1]. */
export function quantileSorted(sorted: readonly number[], p: number): number {
  const n = sorted.length;
  if (n === 0) return 0;
  if (n === 1) return sorted[0] as number;
  const pos = Math.min(Math.max(p, 0), 1) * (n - 1);
  const lo = Math.floor(pos);
  const hi = Math.ceil(pos);
  const frac = pos - lo;
  return (sorted[lo] as number) * (1 - frac) + (sorted[hi] as number) * frac;
}

export function quantile(values: readonly number[], p: number): number {
  return quantileSorted(sortedCopy(values), p);
}

/** Median absolute deviation scaled to estimate a normal standard deviation. */
export function scaledMad(values: readonly number[]): number {
  if (values.length === 0) return 0;
  const m = median(values);
  return 1.4826 * median(values.map((v) => Math.abs(v - m)));
}
