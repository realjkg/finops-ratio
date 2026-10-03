// Formatting helpers — all currency/number display flows through here so the
// UI stays consistent and the mock agent can reuse the same strings.

export function formatUSD(value: number, opts: { compact?: boolean } = {}): string {
  if (opts.compact && Math.abs(value) >= 1000) {
    return `$${(value / 1000).toFixed(1)}k`;
  }
  if (Math.abs(value) >= 100) {
    return `$${value.toLocaleString('en-US', { maximumFractionDigits: 0 })}`;
  }
  return `$${value.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
}

export function formatCents(value: number): string {
  return `$${value.toLocaleString('en-US', { minimumFractionDigits: 3, maximumFractionDigits: 3 })}`;
}

export function formatRatio(ratio: number): string {
  return `${ratio.toFixed(1)}\u00d7`;
}

export function formatPct(fraction: number, digits = 0): string {
  return `${(fraction * 100).toFixed(digits)}%`;
}

export function formatSignedPct(pct: number, digits = 0): string {
  const sign = pct > 0 ? '+' : '';
  return `${sign}${pct.toFixed(digits)}%`;
}

export function formatTokens(tokens: number): string {
  if (tokens >= 1_000_000) return `${(tokens / 1_000_000).toFixed(2)}M`;
  if (tokens >= 1000) return `${(tokens / 1000).toFixed(0)}k`;
  return `${tokens}`;
}

export function formatInt(value: number): string {
  return value.toLocaleString('en-US', { maximumFractionDigits: 0 });
}

export function timeAgo(iso: string, now: Date = new Date()): string {
  const then = new Date(iso).getTime();
  const diffMs = now.getTime() - then;
  const mins = Math.round(diffMs / 60000);
  if (mins < 1) return 'just now';
  if (mins < 60) return `${mins}m ago`;
  const hours = Math.round(mins / 60);
  if (hours < 24) return `${hours}h ago`;
  const days = Math.round(hours / 24);
  return `${days}d ago`;
}


/**
 * Format an amount in its own ISO-4217 currency (never assumes USD). Falls back
 * to `<amount> <CODE>` for a code Intl does not know.
 */
export function formatMoney(value: number, currency: string): string {
  const digits = Math.abs(value) >= 100 ? 0 : 2;
  try {
    return new Intl.NumberFormat('en-US', {
      style: 'currency',
      currency,
      minimumFractionDigits: digits,
      maximumFractionDigits: digits,
    }).format(value);
  } catch {
    return `${value.toLocaleString('en-US', { maximumFractionDigits: 2 })} ${currency}`;
  }
}
