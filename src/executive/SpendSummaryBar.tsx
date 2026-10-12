// Spend Summary Bar (Ratio v2 Wave 2a). The board-level headline strip on the
// Initiative Dashboard — total spend, projected savings, active initiatives, and
// pending approvals, all derived from the mock seed. Metrics use JetBrains Mono;
// labels use Instrument Sans (body), per the design tokens.
import { DEMO_NOW } from '@/data/workloads';
import { formatInt, formatUSD } from '@/lib/format';
import { TOKEN_HEX } from '@/lib/scales';
import type { SpendSummary } from './initiativeModel';

interface Metric {
  label: string;
  value: string;
  color?: string;
}

export function SpendSummaryBar({ summary }: { summary: SpendSummary }) {
  const metrics: Metric[] = [
    { label: 'AI spend', value: `${formatUSD(summary.totalMonthlySpend, { compact: true })}/mo` },
    {
      label: 'Projected savings',
      value: formatUSD(summary.projectedSavings, { compact: true }),
      color: TOKEN_HEX.value,
    },
    { label: 'Initiatives active', value: formatInt(summary.initiativesActive) },
    {
      label: 'Pending approval',
      value: formatInt(summary.pendingApproval),
      color: summary.pendingApproval > 0 ? TOKEN_HEX.gate : undefined,
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
            className="font-mono text-xl font-bold"
            style={{ color: m.color ?? TOKEN_HEX_TEXT }}
          >
            {m.value}
          </span>
        </div>
      ))}
      <div className="ml-auto flex items-center gap-2 text-xs text-exec-muted">
        <span aria-hidden className="inline-block h-2 w-2 rounded-full" style={{ backgroundColor: TOKEN_HEX.value }} />
        Seeded dataset as of {DEMO_NOW.toISOString().slice(0, 10)}
      </div>
    </section>
  );
}

// Primary text on the light surface (kept local so the mono metrics default to
// the executive ink color rather than a token accent).
const TOKEN_HEX_TEXT = '#0f172a';

