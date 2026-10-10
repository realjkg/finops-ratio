// IngestVerification — the walk's "data landed" proof panel. Every figure is
// derived from the actual run the seam returned (landingSummary): rows, the
// FOCUS version-shim audit, resolved workloads and teams, cost per currency,
// and findings. Quiet register: this is evidence, not a reward. Reused by the
// ConnectorCard walk and the direct-ingest door card.

import Link from 'next/link';
import type { IngestRun } from './ingestLanding';
import { landingSummary } from './ingestLanding';
import { formatMoney } from '@/lib/format';

function Verdict({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="flex flex-col gap-0.5">
      <span className="font-mono text-[10px] uppercase tracking-wider text-dim">{label}</span>
      <span className="font-mono text-[12px] font-bold text-txt">{children}</span>
    </div>
  );
}

export function IngestVerification({ run, sandbox }: { run: IngestRun; sandbox: boolean }) {
  const s = landingSummary(run);
  const passthrough = s.backfilledColumns.length === 0;
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
