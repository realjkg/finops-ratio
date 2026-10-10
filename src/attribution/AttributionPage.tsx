// Standalone /attribution route — the "Who ran up this cost?" leaderboard.
// Isolated from the main Ratio app; does not touch the store. Presentation
// follows the TokenomicsPage pattern (mock/live toggle + load-state machine).
//
// Two product rules are load-bearing here:
//   - Value-agnostic ranking: rows sort by ABSOLUTE inference cost. The value
//     ratio appears exactly once — as a single line of portfolio context below
//     the header — and never feeds the sort (R4 at display).
//   - Honest bases: each row states what it sums (team = workload MTD totals;
//     user = the sampled demo query log), and the UI renders it verbatim.
import Link from 'next/link';
import { useState, useCallback } from 'react';
import { useStore } from '@/store/useStore';
import { landingSummary } from '@/connectors/ingestLanding';
import { formatTokens, formatUSD } from '@/lib/format';
import { WORKLOADS } from '@/data/workloads';
import { createAttributionClient } from './index';
import type { AttributionDimension, AttributionReport, AttributionRow } from './index';

type LoadState =
  | { status: 'idle' }
  | { status: 'loading' }
  | { status: 'success'; data: AttributionReport }
  | { status: 'error'; message: string };

// One line of value context beside the ranking (R4). Display-only: this number
// is never passed to the sort — the ranking stays value-agnostic by construction.
function portfolioValueRatio(): number {
  const spend = WORKLOADS.reduce((acc, w) => acc + w.costs.monthly_spend, 0);
  const value = WORKLOADS.reduce((acc, w) => acc + w.value.total_value, 0);
  return spend === 0 ? 0 : value / spend;
}

// ---------------------------------------------------------------------------
// Row rendering — a ranked list, not a new signature component
// ---------------------------------------------------------------------------

function LeaderboardRow({ row, rank }: { row: AttributionRow; rank: number }) {
  const sharePct = `${(row.shareOfTotal * 100).toFixed(1)}%`;
  return (
    <li className="rounded-card border border-edge bg-slab p-4">
      <div className="flex items-baseline justify-between gap-4">
        <div className="min-w-0">
          <p className="text-[10px] uppercase tracking-widest text-dim">#{rank} · {row.dimension}</p>
          <h3 className="truncate text-base font-semibold text-txt">{row.key}</h3>
        </div>
        <div className="text-right">
          <p className="font-mono text-lg font-bold text-cost">{formatUSD(row.inferenceCost)}</p>
          <p className="text-xs text-sub">{sharePct} of burn</p>
        </div>
      </div>

      {/* Share bar — share of TOTAL ABSOLUTE burn. Quiet: hairline track, cost fill. */}
      <div className="mt-3 h-1.5 w-full rounded-full bg-raised" role="presentation">
        <div
          className="h-full rounded-full bg-cost"
          style={{ width: `${Math.min(row.shareOfTotal * 100, 100)}%` }}
        />
      </div>

      <dl className="mt-3 flex flex-wrap gap-x-6 gap-y-1 text-xs">
        <div className="flex items-baseline justify-between gap-2">
          <dt className="text-sub">Tokens in (MTD)</dt>
          <dd className="font-mono text-txt">{formatTokens(row.tokensIn)}</dd>
        </div>
        <div className="flex items-baseline justify-between gap-2">
          <dt className="text-sub">Tokens out (MTD)</dt>
          <dd className="font-mono text-txt">{formatTokens(row.tokensOut)}</dd>
        </div>
        <div className="flex items-baseline justify-between gap-2">
          <dt className="text-sub">Workloads</dt>
          <dd className="font-mono text-txt">{row.inputs.workloadIds.length}</dd>
        </div>
      </dl>

      {/* The working, always shown (tokenomics honesty style). */}
      <p className="mt-3 border-t border-edge pt-2 text-[11px] leading-relaxed text-dim">
        <span className="font-mono">{row.formulaLabel}</span> · {row.basis}
      </p>
    </li>
  );
}

// ---------------------------------------------------------------------------
// Page
// ---------------------------------------------------------------------------

export function AttributionPage() {
  // Landed connector runs — provenance only; the report itself stays on the
  // attribution seam (mock/live) and never mixes connector rows into its math.
  const ingestRuns = useStore((s) => s.ingestRuns);
  const landed = Object.values(ingestRuns).map(landingSummary);
  const [dimension, setDimension] = useState<AttributionDimension>('team');
  const [clientMode, setClientMode] = useState<'mock' | 'live'>('mock');
  const [loadState, setLoadState] = useState<LoadState>({ status: 'idle' });

  const runReport = useCallback(async () => {
    setLoadState({ status: 'loading' });
    try {
      const client = createAttributionClient(clientMode);
      const data = await client.getAttributionReport(dimension);
      setLoadState({ status: 'success', data });
    } catch (err) {
      setLoadState({
        status: 'error',
        message: err instanceof Error ? err.message : String(err),
      });
    }
  }, [clientMode, dimension]);

  return (
    <div className="min-h-screen bg-void px-4 py-10 font-body text-txt">
      <div className="mx-auto max-w-4xl">

        {/* Header */}
        <div className="mb-6">
          <h1 className="text-2xl font-semibold tracking-tight text-txt">Cost Attribution</h1>
          <p className="mt-1 text-sm text-sub">
            Who ran up this cost? Ranked by absolute burn — tokens and inference cost, worst burner first.
          </p>
          {/* R4 — the one line of value context. Display-only; never in the sort. */}
          <p className="mt-2 text-xs text-dim">
            Value context: the portfolio returned {portfolioValueRatio().toFixed(1)}× its inference
            cost this month. This list ranks absolute burn only — value never sorts it.
          </p>
        </div>

        {/* Landed connector data — provenance strip; additive, no seam change. */}
        {landed.length > 0 && (
          <div className="mb-6 rounded-card border border-value/30 bg-slab p-4">
            <p className="mb-1.5 font-mono text-[10px] uppercase tracking-wider text-sub">
              Landed via connectors
            </p>
            {landed.map((run) => (
              <p key={run.sourceName + run.at} className="font-mono text-[11px] leading-relaxed text-sub">
                <span style={{ color: 'var(--value)' }}>{run.sourceName}</span>
                {' · '}{run.rows} canonical rows at {run.canonicalVersion}
                {' · '}{run.workloadsResolved} workload{run.workloadsResolved !== 1 ? 's' : ''}
                {run.teams.length > 0 ? ` · teams: ${run.teams.join(', ')}` : ''}
                {' · '}{run.at.slice(11, 16)}Z
              </p>
            ))}
            <Link href="/connectors" className="mt-1.5 inline-block font-mono text-[10px] text-dim underline">
              Manage connectors
            </Link>
          </div>
        )}

        {/* Controls */}
        <div className="mb-6 rounded-card border border-edge bg-slab p-6">
          <p className="mb-3 text-xs font-semibold uppercase tracking-wider text-sub">Dimension</p>
          <div className="mb-5 flex gap-2">
            {(['team', 'user'] as const).map((d) => (
              <button
                key={d}
                onClick={() => {
                  setDimension(d);
                  setLoadState({ status: 'idle' });
                }}
                className={[
                  'rounded-card border px-4 py-1.5 text-sm font-medium capitalize transition-colors',
                  dimension === d
                    ? 'border-unit bg-unit/10 text-unit'
                    : 'border-edge bg-raised text-sub hover:text-txt',
                ].join(' ')}
              >
                {d === 'team' ? 'By team' : 'By user'}
              </button>
            ))}
          </div>

          <p className="mb-3 text-xs font-semibold uppercase tracking-wider text-sub">Client mode</p>
          <div className="mb-5 flex gap-2">
            {(['mock', 'live'] as const).map((m) => (
              <button
                key={m}
                onClick={() => {
                  setClientMode(m);
                  setLoadState({ status: 'idle' });
                }}
                className={[
                  'rounded-card border px-4 py-1.5 text-sm font-medium capitalize transition-colors',
                  clientMode === m
                    ? m === 'mock'
                      ? 'border-shape bg-shape/10 text-shape'
                      : 'border-value bg-value/10 text-value'
                    : 'border-edge bg-raised text-sub hover:text-txt',
                ].join(' ')}
              >
                {m}
              </button>
            ))}
          </div>

          <button
            onClick={() => void runReport()}
            disabled={loadState.status === 'loading'}
            className="w-full rounded-card bg-gate px-4 py-2 text-sm font-semibold text-void transition-opacity disabled:opacity-50"
          >
            {loadState.status === 'loading' ? 'Aggregating…' : 'Run attribution'}
          </button>
        </div>

        {/* Idle */}
        {loadState.status === 'idle' && (
          <p className="text-center text-sm text-dim">
            Pick a dimension and run the report to rank the burners.
          </p>
        )}

        {/* Loading */}
        {loadState.status === 'loading' && (
          <p className="text-center text-sm text-sub">Aggregating attribution rows…</p>
        )}

        {/* Error */}
        {loadState.status === 'error' && (
          <div className="rounded-card border border-cost/40 bg-cost/10 p-4">
            <p className="text-sm font-medium text-cost">Report failed</p>
            <p className="mt-1 text-xs text-sub">{loadState.message}</p>
          </div>
        )}

        {/* Success */}
        {loadState.status === 'success' && (
          <div className="space-y-4">
            <div className="rounded-card border border-edge bg-deep px-4 py-3">
              <p className="text-xs text-sub">
                Portfolio burn {formatUSD(loadState.data.totalInferenceCost)} ·{' '}
                {formatTokens(loadState.data.totalTokensIn)} tokens in ·{' '}
                {formatTokens(loadState.data.totalTokensOut)} tokens out ·{' '}
                {loadState.data.window}
              </p>
            </div>

            {loadState.data.rows.length === 0 ? (
              <p className="rounded-card border border-edge bg-slab p-6 text-center text-sm text-dim">
                Nothing to rank — the report found no records for this dimension.
              </p>
            ) : (
              <ol className="space-y-3">
                {loadState.data.rows.map((row, i) => (
                  <LeaderboardRow key={`${row.dimension}:${row.key}`} row={row} rank={i + 1} />
                ))}
              </ol>
            )}

            <div className="rounded-card border border-edge bg-slab px-4 py-3">
              <dl className="flex flex-wrap gap-x-8 gap-y-1 text-xs">
                <div>
                  <dt className="text-sub">generatedAt</dt>
                  <dd className="font-mono text-dim">{loadState.data.generatedAt}</dd>
                </div>
                <div>
                  <dt className="text-sub">dimension</dt>
                  <dd className="font-mono font-semibold text-unit">{loadState.data.dimension}</dd>
                </div>
                <div>
                  <dt className="text-sub">mode</dt>
                  <dd
                    className={`font-mono font-semibold ${
                      clientMode === 'mock' ? 'text-shape' : 'text-value'
                    }`}
                  >
                    {clientMode}
                  </dd>
                </div>
              </dl>
            </div>
          </div>
        )}

        {/* Back link */}
        <Link href="/" className="mt-8 block text-center text-xs text-dim hover:text-sub">
          ← back to Ratio
        </Link>
      </div>
    </div>
  );
}
