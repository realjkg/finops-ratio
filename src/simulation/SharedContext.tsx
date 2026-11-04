import { useStore } from '@/store/useStore';
import { COPY } from '@/lib/vocabulary';

/** "<Month Year> · <Currency> · <Cost basis>": the shared frame for every figure below it. */
export function contextLine(now: Date, currency = 'USD'): string {
  const month = now.toLocaleString('en-US', { month: 'long', year: 'numeric', timeZone: 'UTC' });
  return `${month} · ${currency} · ${COPY.costBasisNotStated}`;
}

/**
 * Shown once above the cards. The second line replaces any freshness claim ("Updated 06:30"):
 * every figure here is synthetic, so the page says so instead of claiming a refresh time.
 * One currency only: the demo never combines currencies.
 */
export function SharedContext() {
  const now = useStore((s) => s.now);
  return (
    <div data-testid="shared-context" className="leading-snug">
      <p>{contextLine(now)}</p>
      <p>{COPY.sampleData}</p>
    </div>
  );
}
