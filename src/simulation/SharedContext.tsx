import { useStore } from '@/store/useStore';
import { costLabel, portfolioCostSource, type CostSource } from '@/lib/vocabulary';

/** "<Month Year> · <Currency> · <Cost label>": the shared frame for every figure below it. */
export function contextLine(now: Date, source: CostSource = 'modeled', currency = 'USD'): string {
  const month = now.toLocaleString('en-US', { month: 'long', year: 'numeric', timeZone: 'UTC' });
  return `${month} \u00b7 ${currency} \u00b7 ${costLabel(source)}`;
}

/**
 * Shown once above the cards. It makes no freshness claim ("Updated 06:30"): the top bar's Demo
 * badge says the figures are illustrative, so the data is not labeled again here.
 * One currency only: the demo never combines currencies.
 */
export function SharedContext() {
  const now = useStore((s) => s.now);
  const source = useStore((s) => portfolioCostSource(s.workloads));
  return (
    <div data-testid="shared-context" className="leading-snug">
      <p>{contextLine(now, source)}</p>
    </div>
  );
}
