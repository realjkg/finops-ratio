// Spend Summary Bar (Ratio v2 Wave 2a). The board-level headline strip on the
// Initiative Dashboard — total spend, projected savings, active initiatives, and
// pending approvals, all derived from the mock seed. Metrics use JetBrains Mono;
// labels use Instrument Sans (body), per the design tokens.
import { formatInt, formatUSD } from '@/lib/format';
import { TOKEN_COLOR } from '@/lib/scales';
import type { SpendSummary } from './initiativeModel';

interface Metric {
  label: string;
  value: string;
  color?: string;
}

export function SpendSummaryBar({ summary }: { summary: SpendSummary }) {
  const metrics: Metric[] = [
    { label: 'Total cloud spend', value: `${formatUSD(summary.totalMonthlySpend, { compact: true })}/mo` },
    {
      label: 'Projected savings',
      value: formatUSD(summary.projectedSavings, { compact: true }),
      color: TOKEN_COLOR.value,
    },
    { label: 'Initiatives active', value: formatInt(summary.initiativesActive) },
    {
      label: 'Pending approval',
      value: formatInt(summary.pendingApproval),
      color: summary.pendingApproval > 0 ? TOKEN_COLOR.gate : undefined,
    },
  ];

  return (
    <section
      aria-label="Spend summary"
      className="flex flex-wrap items-center gap-x-8 gap-y-4 rounded-card border border-exec-border bg-exec-surface px-6 py-5 shadow-sm"
    >
      {metrics.map((m) => (
        <div key={m.label} className="flex flex-col gap-1">
          <span className="text-xs font-medium uppercase tracking-wide text-exec-muted">
            {m.label}
          </span>
          <span
            className={`font-mono text-xl font-bold ${m.color ? '' : 'text-exec-text'}`}
            style={m.color ? { color: m.color } : undefined}
          >
            {m.value}
          </span>
        </div>
      ))}
      <div className="ml-auto flex items-center gap-2 text-xs text-exec-muted">
        <span aria-hidden className="inline-block h-2 w-2 rounded-full" style={{ backgroundColor: TOKEN_COLOR.value }} />
        Updated 2 min ago
      </div>
    </section>
  );
}


