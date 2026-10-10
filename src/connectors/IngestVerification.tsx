// IngestVerification — the walk's "data landed" proof panel. Every figure is
// derived from the actual run the seam returned (landingSummary): rows, the
// FOCUS version-shim audit, resolved workloads and teams, cost per currency,
// and findings. Quiet register: this is evidence, not a reward. Reused by the
// ConnectorCard walk and the direct-ingest door card.
//
// When ≥2 sources have landed runs (allRuns), a compact per-workload
// "spend by source" readout makes source variance visible — e.g. the FOCUS
// billing export vs the synthetic ServiceNow ITBM allocation. Lines beyond
// SOURCE_VARIANCE_TOLERANCE are flagged; a full comparison view is a
// documented follow-up, not forced onto this panel.

import Link from 'next/link';
import type { IngestRun } from './ingestLanding';
import {
  SOURCE_VARIANCE_TOLERANCE,
  landingSummary,
  sourceVarianceByWorkload,
  type WorkloadSourceVariance,
} from './ingestLanding';
import { formatMoney } from '@/lib/format';

function Verdict({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="flex flex-col gap-0.5">
      <span className="font-mono text-[10px] uppercase tracking-wider text-dim">{label}</span>
      <span className="font-mono text-[12px] font-bold text-txt">{children}</span>
    </div>
  );
}

/** Compact per-workload source comparison — visible only once ≥2 sources landed. */
function SourceVariance({ rows }: { rows: WorkloadSourceVariance[] }) {
  const comparable = rows.filter((r) => r.lines.length > 0);
  if (comparable.length === 0) return null;
  return (
    <div className="mt-2 rounded border border-edge bg-slab px-2.5 py-2">
      <div className="mb-1 flex items-baseline justify-between gap-2">
        <span className="font-mono text-[10px] uppercase tracking-wider text-dim">
          Spend by source · per workload
        </span>
        <span className="font-mono text-[10px] text-dim">
          variance &gt; {Math.round(SOURCE_VARIANCE_TOLERANCE * 100)}% flagged
        </span>
      </div>
      <div className="flex flex-col gap-1">
        {comparable.map((r) => (
          <div
            key={r.workloadId}
            className="flex flex-wrap items-baseline gap-x-2 font-mono text-[11px]"
          >
            <span className="text-sub">{r.workloadId}</span>
            {r.lines.map((line) => (
              <span key={`${line.sourceName}:${line.currency}`} className="text-dim">
                {formatMoney(line.amount, line.currency)} <span className="text-dim">{line.currency}</span>
                {' · '}
                {line.sourceName}
              </span>
            ))}
            {r.variancePct !== null && (
              <span className={r.flagged ? 'font-bold text-cost' : 'text-dim'}>
                {r.flagged ? '⚠ ' : ''}
                (max−min)/min {(r.variancePct * 100).toFixed(1)}%
              </span>
            )}
          </div>
        ))}
      </div>
    </div>
  );
}

export function IngestVerification({
  run,
  sandbox,
  allRuns,
}: {
  run: IngestRun;
  sandbox: boolean;
  /** Every landed run — enables the per-workload source comparison (≥2 sources). */
  allRuns?: Record<string, IngestRun>;
}) {
  const s = landingSummary(run);
  const passthrough = s.backfilledColumns.length === 0;
  const variance =
    allRuns && Object.keys(allRuns).length >= 2 ? sourceVarianceByWorkload(allRuns) : [];
  return (
    <div
      role="status"
      aria-label="Ingest verification"
      className="rounded border border-value/30 bg-deep px-3 py-2.5"
    >
      <div className="mb-2 flex items-center gap-1.5">
        <span className="font-mono text-[10px] font-bold uppercase tracking-wider text-value">
          ✓ Data landed
        </span>
        {sandbox && (
          <span className="rounded bg-raised px-1.5 py-0.5 font-mono text-[10px] uppercase tracking-wider text-sub">
            seeded demo
          </span>
        )}
      </div>

      <div className="grid grid-cols-2 gap-2 sm:grid-cols-4">
        <Verdict label="Rows ingested">
          {s.rows}
          <span className="ml-1 text-[10px] font-normal text-dim">
            v{s.sourceVersion} → v{s.canonicalVersion}
          </span>
        </Verdict>
        <Verdict label="Workloads resolved">{s.workloadsResolved}</Verdict>
        <Verdict label="Teams covered">{s.teams.length}</Verdict>
        <Verdict label="Findings">{s.findings}</Verdict>
      </div>

      <div className="mt-2 flex flex-wrap items-center gap-x-3 gap-y-1 font-mono text-[11px]">
        {Object.entries(s.costByCurrency).map(([ccy, total]) => (
          <span key={ccy} className="text-cost">
            {formatMoney(total, ccy)} <span className="text-dim">{ccy}</span>
          </span>
        ))}
        <span className="text-dim">
          {passthrough
            ? 'no backfill (canonical already)'
            : `backfilled ${s.backfilledColumns.length} column(s)`}
        </span>
      </div>

      {variance.length > 0 && <SourceVariance rows={variance} />}

      <p className="mt-2 text-[11px] text-dim">
        Landed in{' '}
        <Link href="/workloads" className="text-unit underline decoration-edge hover:decoration-unit">
          Workloads
        </Link>
        {' · '}
        <Link href="/" className="text-unit underline decoration-edge hover:decoration-unit">
          Findings
        </Link>
        {' · '}
        <Link
          href="/attribution"
          className="text-unit underline decoration-edge hover:decoration-unit"
        >
          Attribution
        </Link>
      </p>
    </div>
  );
}
