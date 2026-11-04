import { useStore } from '@/store/useStore';
import { COPY, basisLine, portfolioCostSource, type CostSource } from '@/lib/vocabulary';

/** "<Month Year> · <Currency> · <Cost basis>": the shared frame for every figure below it. */
export function contextLine(now: Date, source: CostSource = 'modeled', currency = 'USD'): string {
  const month = now.toLocaleString('en-US', { month: 'long', year: 'numeric', timeZone: 'UTC' });
  return `${month} \u00b7 ${currency} \u00b7 ${basisLine(source)}`;
}

/**
 * Shown once above the cards. The second line replaces any freshness claim ("Updated 06:30"):
 * every figure here is synthetic, so the page says so instead of claiming a refresh time.
 * One currency only: the demo never combines currencies.
 */
export function SharedContext() {
  const now = useStore((s) => s.now);
  const source = useStore((s) => portfolioCostSource(s.workloads));
  return (
    <div data-testid="shared-context" className="leading-snug">
      <p>{contextLine(now, source)}</p>
      <p>{COPY.sampleData}</p>
    </div>
  );
}
